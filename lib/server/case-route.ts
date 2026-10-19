/**
 * 判例检索的**路由**：一个问题该走哪条链路。
 *
 * 单独成文件，是因为"走哪条"是产品决定，不是某条链路自己的事。
 * 把它藏在 `searchCompanyCases` 里，就会变成"公司链路偷偷帮你查了别的东西"——
 * 调用方读不出来，改起来也要翻三个文件。
 *
 * ## 优先级（2026-09-20 用户确定）
 *
 * ```
 * ① 点名了公司？
 *      ├─ 同时点了主题 → 公司+主题组合检索
 *      │                    ├─ 有结果 → 就是它
 *      │                    └─ 0 条  → **退主题**：查其他企业的同类判例
 *      └─ 只点了公司   → 公司全集
 * ② 没点公司、但主题在本地案例库是空白 → 主题检索
 * ③ 都不是 → 不走这条链路，交回普通问答（`case-search.ts` 的补充判例）
 * ```
 *
 * ## 为什么 0 条时退的是「主题」而不是「这家公司的其他案例」
 *
 * 用户问"三星的代持案例"，三星没有代持案例时：
 * - 退回"三星的 GST 案例、转让定价案例" → **答非所问的噪音**，他没在研究这些
 * - 退回"其他企业的代持案例"            → 主题这条轴保住了，正是他在研究的东西
 *
 * 两条轴里，**主题是他的研究对象，公司只是一个限定条件**。限定条件落空时
 * 该放宽的是限定条件，不是换掉研究对象。
 *
 * ## 一条纪律
 *
 * 退到主题之后，**必须明说公司那一层落空了**：
 * 「未检索到三星在代持这一主题上的判例。以下是其他企业的同类判例。」
 * 不说这一句，用户会把列表里的案子当成三星的——那比不给结果严重得多。
 */

import type { RelatedCase } from "../contracts";
import type { StoredCase } from "./case-store";
import {
  describeCompanySearch,
  searchCompanyCases,
  type CompanyCaseResult,
} from "./company-case-search";
import {
  detectCompanyCaseIntent,
  isCompanyCaseSearchEnabled,
  type CompanyCaseIntent,
} from "./company-case-query";
import {
  describeTopicSearch,
  detectTopicCaseIntent,
  isTopicCaseSearchEnabled,
  searchTopicCases,
  type TopicCaseResult,
} from "./topic-case-search";

export type CaseRouteKind =
  /** 按公司（可带主题）检索到的结果。 */
  | "company"
  /** 按主题检索到的结果。可能是直接走的，也可能是公司落空后退过来的。 */
  | "topic"
  /** 这条链路不适用，交回普通问答。 */
  | "none";

export interface CaseRouteResult {
  kind: CaseRouteKind;
  cases: RelatedCase[];
  /** 展示在判例区块顶部的一句话。**它承担"如实交代检索口径"的责任，不能省。** */
  note: string;
  /** 公司那一层是否落空后退到了主题。界面据此决定要不要额外强调。 */
  fellBackFromCompany: boolean;
  company?: CompanyCaseIntent;
  companyResult?: CompanyCaseResult;
  topicResult?: TopicCaseResult;
  diagnostics: string[];
}

const NONE: CaseRouteResult = {
  kind: "none", cases: [], note: "", fellBackFromCompany: false, diagnostics: [],
};

/**
 * 公司实时链路落空、退到主题链路之后，判例区块顶部那句话。
 *
 * **必须明说公司那一层落空了**，否则用户会把别家的案子当成三星的——这是纪律。
 * 但 2026-10-13 实测说明还有另一半：主题链路捞回来的 cases 里**可能包含这家
 * 公司自己的案子**（本地案例库沉淀过它的同主题判例——用户自己上传的三星 AMP 案
 * 就是这么被捞出来的）。这时再说"以下不是三星的案例"就是假话：note 和它脚下的
 * 判例列表当场打架。
 *
 * 所以这句话分两种写法，用数据判（topic.cases 里有没有这家公司的案子），
 * 不靠猜：
 * - 有 → 如实说"实时检索未找到它作为当事人的判例，但以下包含它的案例"
 * - 没有 → 原口径"以下是其他企业的…它们不是X的案例"（这句话此时是真的）
 *
 * 抽成纯函数是为了能单测——这句话承担"如实交代检索口径"的责任，
 * 写错了比不写更糟（用户会把 Pepsico 的调整结论当成三星的）。
 */
export function buildTopicFallbackNote(
  companyResult: CompanyCaseResult,
  mention: string,
  aliases: string[],
  topicCases: Array<{ caseName?: string }>,
): string {
  const includesCompany = topicCases.some((item) =>
    aliases.some((alias) => (item.caseName ?? "").toLowerCase().includes(alias.toLowerCase())));
  if (includesCompany) {
    return `实时检索未找到${mention}在该主题上作为当事人的判例；`
      + `以下是该主题的相关判例，其中包含${mention}的案例。`;
  }
  return `${describeCompanySearch(companyResult, mention)}`
    + `以下是其他企业在同一主题上的判例，供参考——它们不是${mention}的案例。`;
}

/**
 * 路由入口。
 *
 * 任何一步失败都降级而不是抛错——判例始终是补充信息，
 * 和整条判例链路其余部分保持同一原则。
 */
export async function routeCaseRequest(options: {
  question: string;
  modelEnglishQuery?: string;
  publishedCases: StoredCase[];
  guessAliases?: (mention: string) => string[] | undefined;
}): Promise<CaseRouteResult> {
  const { question, modelEnglishQuery, publishedCases, guessAliases } = options;
  const diagnostics: string[] = [];

  // ① 公司优先
  const company = isCompanyCaseSearchEnabled()
    ? detectCompanyCaseIntent(question, guessAliases)
    : undefined;

  if (company) {
    diagnostics.push(
      `公司链路：${company.mention}（别名来源 ${company.aliasSource}）`
      + (company.topicTerms.length ? `，主题 ${company.topicTerms.slice(0, 2).join("/")}` : "，无主题"),
    );
    let result: CompanyCaseResult | undefined;
    try {
      result = await searchCompanyCases({
        aliases: company.aliases,
        topicTerms: company.topicTerms.length > 0 ? company.topicTerms : undefined,
      });
    } catch (error) {
      // 带上具体原因（网络/token/接口变更），它会随 routed.diagnostics 落进 trace 日志。
      diagnostics.push(`公司链路检索失败：${error instanceof Error ? error.message : String(error)}`);
    }

    const companyEmptyOnTopic = result?.topicFilter?.status === "empty";
    if (result && result.cases.length > 0) {
      return {
        kind: "company",
        cases: result.cases,
        note: describeCompanySearch(result, company.mention),
        fellBackFromCompany: false,
        company,
        companyResult: result,
        diagnostics: [...diagnostics, ...result.diagnostics],
      };
    }

    // 公司+主题 0 条 → 退主题。注意这里**不**要求"本地主题空白"：
    // 用户已经明确在找这个主题了，本地有没有都该给他看全（本地那些会由
    // 普通链路一并展示；这里补的是本地没有的部分）。
    if (companyEmptyOnTopic && isTopicCaseSearchEnabled()) {
      diagnostics.push(`${company.mention} 在该主题上无判例，退主题链路`);
      const topicIntent = detectTopicCaseIntent({
        question, modelEnglishQuery, publishedCases,
        // 强制放行本地覆盖检查：公司落空时就是要去查别家的
        forceWhenCovered: true,
      });
      if (topicIntent) {
        const topic = await searchTopicCases(topicIntent);
        if (topic && topic.cases.length > 0) {
          return {
            kind: "topic",
            cases: topic.cases,
            note: buildTopicFallbackNote(result!, company.mention, company.aliases, topic.cases),
            fellBackFromCompany: true,
            company,
            companyResult: result,
            topicResult: topic,
            diagnostics: [...diagnostics, ...(result?.diagnostics ?? [])],
          };
        }
      }
    }

    // 公司链路走了但什么都没查到：如实说，不要装作没查过。
    if (result) {
      return {
        kind: "company",
        cases: [],
        note: describeCompanySearch(result, company.mention),
        fellBackFromCompany: false,
        company,
        companyResult: result,
        diagnostics: [...diagnostics, ...result.diagnostics],
      };
    }
    return { ...NONE, diagnostics };
  }

  // ② 没点公司：主题在本地空白时才查
  if (isTopicCaseSearchEnabled()) {
    const topicIntent = detectTopicCaseIntent({ question, modelEnglishQuery, publishedCases });
    if (topicIntent) {
      diagnostics.push(`主题链路：${topicIntent.query.formInput}`);
      const topic = await searchTopicCases(topicIntent);
      if (topic && topic.cases.length > 0) {
        return {
          kind: "topic",
          cases: topic.cases,
          note: describeTopicSearch(topic),
          fellBackFromCompany: false,
          topicResult: topic,
          diagnostics,
        };
      }
    }
  }

  // ③ 交回普通问答
  return { ...NONE, diagnostics };
}
