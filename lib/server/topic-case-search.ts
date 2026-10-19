/**
 * 第二个触发条件：**本地案例库对这个主题是空白时，直接拿英文术语去 Indian Kanoon 搜。**
 *
 * 用户的原话场景：搜 benami 的案件，而我们案例库里一条代持案例都没有，
 * 这时候要用「代持」对应的英文术语去数据库直接搜。
 *
 * ## 和已有两条链路的分工
 *
 * | 链路 | 触发 | 规模 | 文件 |
 * |---|---|---|---|
 * | 业务问题顺带给判例 | 本地不足 3 条 | 补齐到 3 条 | `case-search.ts` |
 * | 点名某公司要案例 | 识别出公司主体 | 多路召回 ≈₹13 | `company-case-search.ts` |
 * | **本主题本地空白** | 求取判例 + 主题命中术语表 + 本地 0 条 | 单主题 2~3 路 ≈₹2 | 本文件 |
 *
 * 为什么不并进 `case-search.ts` 的兜底：那条链路是"补齐缺口"，按 `gap` 条数去取，
 * 本地有 2 条时只补 1 条。而这里是"本地完全没有这个主题"——用户明确在找这类判例，
 * 应该给他一批看得出规律的结果，不是补一条了事。两者的**意图不同**，混在一起
 * 会让"补缺口"的成本控制和"专门找一类"的覆盖要求互相拖累。
 *
 * ## 语言：只用英文，且优先用法律术语而非直译
 *
 * 见 `case-query-language.ts`。这里再强调一次原因：用户说"代持"，直译是
 * nominee shareholding，而印度判决书里的词是 **benami**。直译搜不到东西，
 * 而且是静默搜不到——所以术语表的优先级高于模型翻译，且没有术语对应时
 * **宁可不搜**，也不拿一个可能错的译法去花钱。
 */

import type { RelatedCase } from "../contracts";
import type { StoredCase } from "./case-store";
import { isCaseSeekingQuestion } from "./case-relevance";
import { matchCaseTerms, toEnglishCaseQuery, type EnglishCaseQuery } from "./case-query-language";
import { keywordOverlapScore, searchLiveCases } from "./case-search";

/**
 * 本地案例库对某个主题算不算"有覆盖"。
 *
 * ## 为什么**不能**用 `rankCasesByKeyword`（IDF 加权那个）
 *
 * 第一版就是这么写的，自测当场抓出来：案例正文里明明有 benami、benamidar，
 * 打分却是 **0**，于是判成"本地空白"，库里有也会去花钱现查。
 *
 * 根因是 IDF 的定义：`log((N+1)/(df+1))`。案例库只有 1 条时，
 * 这条里出现过的每个词 df=1、N=1，IDF 全部塌成 0，总权重也是 0 → 分数恒为 0。
 * 案例库大一些也有同样的毛病：一个词只要在多数案例里出现过，权重就趋近 0。
 *
 * **IDF 是给「排序」用的工具——它回答"哪条更相关"；
 * 而这里问的是"有没有"，是存在性判断，加权只会帮倒忙。**
 * 两件事长得像，用的工具不一样。所以这里用不加权的命中率
 * （`keywordOverlapScore`，`case-search.ts` 里一直保留着的那个纯函数版本）。
 *
 * ## 阈值方向
 *
 * 0.10 定得很松，是刻意的：判断"完全空白"要**宁可认为有**。
 * 错判"没覆盖"会让已经人工审核过的本地案例，被现查回来的未审摘录顶掉——
 * 那是质量损失；而漏判"有覆盖"最多是少查一次，代价只是少给几条。
 */
const LOCAL_COVERAGE_MIN_SCORE = Number(process.env.TOPIC_CASE_COVERAGE_MIN?.trim()) || 0.10;

/** 和 `case-search.ts` 的 `caseTopicText` 同一口径：只取有主题区分度的字段。 */
function caseTopicText(item: StoredCase): string {
  return [item.caseName, item.taxTypeAndAuthority, item.referenceValueNote, ...item.finalRuling]
    .filter(Boolean).join(". ");
}

export function hasLocalTopicCoverage(
  englishTerms: string[],
  publishedCases: StoredCase[],
): boolean {
  if (publishedCases.length === 0) return false;
  if (englishTerms.length === 0) return true;   // 说不清主题就别判它空白
  const probe = englishTerms.join(" ");
  return publishedCases.some(
    (item) => keywordOverlapScore(probe, caseTopicText(item)) >= LOCAL_COVERAGE_MIN_SCORE,
  );
}

export interface TopicCaseIntent {
  query: EnglishCaseQuery;
  /** 用户原话里触发的中文/英文说法，用于向用户交代"我们按哪个术语去查的"。 */
  question: string;
}

/**
 * 要不要走这条链路。三个条件全部满足才触发：
 *   ① 句式上是在求取判例（`isCaseSeekingQuestion`，和已有链路同一判据）
 *   ② 主题能映射到英文（术语表命中，或用户本来就用英文问）
 *   ③ 本地案例库对这个主题完全空白
 *
 * ②③ 的顺序不能反：先确认能映射到英文，再去判本地覆盖——
 * 因为判覆盖用的就是那些英文词，没有英文词就无从判起。
 */
export function detectTopicCaseIntent(options: {
  question: string;
  modelEnglishQuery?: string;
  publishedCases: StoredCase[];
  /**
   * 跳过"本地空白"这道条件。
   *
   * 用在**公司链路落空后退到主题**的场景（`case-route.ts`）：用户已经明确在找
   * 这个主题了，本地有没有都该给他看全——本地那几条会由普通链路一并展示，
   * 这里补的是本地没有的部分。
   *
   * 只有这一个调用方该传 true。默认路径下"本地空白"是必要条件，
   * 否则每次问判例都要去花钱现查。
   */
  forceWhenCovered?: boolean;
}): TopicCaseIntent | undefined {
  const { question, modelEnglishQuery, publishedCases } = options;
  if (!isCaseSeekingQuestion(question)) return undefined;

  const query = toEnglishCaseQuery(question, modelEnglishQuery);
  if (!query) return undefined;   // 转不成英文就不搜——拿中文去搜只会静默拿到空

  if (!options.forceWhenCovered) {
    const terms = query.matchedTerms.length > 0
      ? query.matchedTerms
      : query.formInput.split(/\s+/).filter((w) => w.length > 3);
    if (hasLocalTopicCoverage(terms, publishedCases)) return undefined;
  }

  return { query, question };
}

/** 本地空白时一次取多少条。比"补缺口"那条链路多，因为用户是专门在找这一类。 */
const TOPIC_LIVE_LIMIT = Number(process.env.TOPIC_CASE_LIMIT?.trim()) || 5;

export interface TopicCaseResult {
  cases: RelatedCase[];
  /** 实际发给 Indian Kanoon 的检索式——要如实告诉用户，因为术语可能和他说的不一样。 */
  usedQuery: string;
  /** 命中的印度法律术语，例如用户说"代持"→ 我们搜的是 benami。 */
  matchedTerms: string[];
  /** 术语从哪来的：术语表 / 模型 / 用户本来就用英文。 */
  querySource: EnglishCaseQuery["source"];
}

/**
 * 执行。失败一律返回 undefined 静默降级——判例始终是补充信息，
 * 和整条判例链路的其余部分保持同一原则。
 */
export async function searchTopicCases(
  intent: TopicCaseIntent,
  limit = TOPIC_LIVE_LIMIT,
): Promise<TopicCaseResult | undefined> {
  try {
    const cases = await searchLiveCases(intent.query.formInput, limit);
    if (cases.length === 0) return undefined;
    return {
      cases,
      usedQuery: intent.query.formInput,
      matchedTerms: intent.query.matchedTerms,
      querySource: intent.query.source,
    };
  } catch {
    return undefined;
  }
}

/**
 * 给用户看的一句话说明。
 *
 * **必须说出我们实际用的是哪个词**：用户问"代持"，我们搜的是 benami，
 * 结果列表里全是 Benami Transactions 的案子——不解释一句，用户会以为答非所问。
 * 这和判例区块其余部分"说清楚信息从哪来"是同一个要求。
 */
export function describeTopicSearch(result: TopicCaseResult): string {
  if (result.querySource === "glossary" && result.matchedTerms.length > 0) {
    return `本地案例库暂无此类判例，已按印度法上的对应术语「${result.matchedTerms.slice(0, 3).join(" / ")}」`
      + `实时检索 Indian Kanoon。以下判例未经人工复核，请点开原文核对。`;
  }
  return "本地案例库暂无此类判例，已实时检索 Indian Kanoon。以下判例未经人工复核，请点开原文核对。";
}

export function isTopicCaseSearchEnabled(): boolean {
  const flag = process.env.TOPIC_CASE_SEARCH?.trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return false;
  return Boolean(process.env.INDIANKANOON_API_TOKEN?.trim());
}

/** 只为单测导出：让测试能构造"术语命中但本地空白"的场景而不依赖真实案例库。 */
export const __testing = { matchCaseTerms, LOCAL_COVERAGE_MIN_SCORE };
