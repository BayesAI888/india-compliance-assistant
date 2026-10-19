/**
 * 判例综述：把检索到的若干份判例**横向归纳成风险主题**，而不是一条条把案例记录倒出来。
 *
 * 起因（2026-09-16 真实反馈）：用户问"印度公司的广告费有什么判例、怎样才能合规"，
 * 判例区块直接把案例库里存的九字段原样拼出来——单个案例几千字、三个案例上万字，
 * 而且字段里是判决书级别的长篇论证。用户的原话是"信息是无用的、零散的"。
 *
 * 目标格式由用户指定（见对话中提供的《广告费支出_合规挑战_案例库检索.md》）：
 *   一、若干个**风险主题簇**，每簇＝挑战是什么 + 哪些案例佐证（带 docid/金额/胜负）
 *       + 法院倾向或可作抗辩的依据
 *   二、**应对要点**（可直接执行的几条）
 *   三、**案例索引**（docid / 案件名 / 这个案子是从哪个角度相关）
 *
 * 三条纪律（和知识库那套证据校验是同一个原则：能确定性兜底就不指望提示词）：
 *   1. **判例不是引用来源**。法规要求与实务建议的 citation 只能来自已发布知识库的
 *      法条原文；这里归纳出来的内容独立成块展示，不参与 citation_ids，也不得被
 *      改写成"法规要求"。
 *   2. **不得引入案例记录里没有的东西**。生成后逐条核验：提到的 docid 必须在这次
 *      检索到的集合里；提到的金额必须能在对应案例记录原文里逐字找到。核验不过的
 *      那一条直接丢弃（不是整块丢弃，也不是留着打个问号）——逻辑同 quote-check.ts。
 *   3. **失败必须静默降级**。模型没配置、调用失败、返回结构不对、核验后什么都不剩，
 *      一律返回 undefined，让前端退回"简短的案例列表"，绝不能因为综述生成不出来
 *      就让整个回答失败。判例始终是补充信息。
 */

import type { CaseDigest, CaseDigestCluster, RelatedCase } from "../contracts";
import { isDeepSeekConfigured, requestStructuredJson } from "./deepseek";

/** 每份案例送进模型的记录长度上限。三份案例合计约 1.8 万字符，控制成本和延迟。 */
const PER_CASE_MAX_CHARS = Number(process.env.CASE_DIGEST_PER_CASE_CHARS?.trim()) || 6_000;

export function isCaseDigestEnabled(): boolean {
  const flag = process.env.CASE_DIGEST?.trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return false;
  return isDeepSeekConfigured();
}

/** 金额写法五花八门（Rs.1,338 crore / ₹10,38,263 / Rs. 26,09,19,423），统一成只留数字来比对。 */
function normalizeAmount(text: string): string {
  return text.replace(/[^\d]/g, "");
}

/**
 * 从一段文本里抓出所有"像金额的数字串"。印度记数法用的是 2,2,3 分组
 * （1,338,82,19,250 这种），所以不能按三位一组的通用正则去抓。
 * 导出供单测：这是防编造那道核验的基础，必须能单独验证。
 */
export function extractAmounts(text: string): string[] {
  const matches = text.match(/\d[\d,]{3,}/g) ?? [];
  return matches
    // 只认"带千分位逗号的"或"六位以上的纯数字"。
    // 否则 2014、2026 这类**年份**会被当成金额，导致"法院于2014年认定……"这种
    // 完全正常的句子因为原文里没有"2014"这串数字而被误判为编造、整条丢掉——
    // 核验过严造成的误伤，比漏过一个编造的金额更常见也更难发现（复盘第2条的教训）。
    .filter((raw) => raw.includes(",") || normalizeAmount(raw).length >= 6)
    .map(normalizeAmount)
    .filter((value) => value.length >= 4);
}

function caseRecordText(item: RelatedCase): string {
  return [
    item.caseName,
    item.court_and_year,
    item.tax_type_and_authority,
    ...(item.revenue_position ?? []),
    ...(item.assessee_argument ?? []),
    ...(item.final_ruling ?? []),
    ...(item.evidence_support ?? []),
    item.reference_value_note,
    item.snippet,
  ].filter(Boolean).join("\n");
}

/**
 * 核验一段生成文本：提到的金额必须能在**允许的原文**里找到。
 * 找不到就判定这条是编的。返回 true 表示通过。导出供单测。
 */
export function amountsAreGrounded(text: string, allowedAmounts: Set<string>): boolean {
  return extractAmounts(text).every((amount) => allowedAmounts.has(amount));
}

interface RawDigest {
  clusters?: Array<{
    title?: string;
    challenge?: string;
    evidence?: Array<{ docid?: string; text?: string }>;
    takeaway?: string;
  }>;
  action_points?: string[];
  index?: Array<{ docid?: string; case_name?: string; angle?: string }>;
}

/**
 * 生成判例综述。任何一步不成立都返回 undefined（调用方据此退回简单列表）。
 */
/**
 * 「模型看过了，判定这些判例与问题没有实质关联」的哨兵值。
 *
 * 用一个独立的对象而不是 `null`：调用方必须**显式**写出对它的处理，
 * 写成 `if (!digest)` 会把它和"调用失败"一起吞掉——那正是要避免的那个 bug。
 */
export const CASE_DIGEST_IRRELEVANT = { irrelevant: true } as const;

export type CaseDigestResult = CaseDigest | typeof CASE_DIGEST_IRRELEVANT | undefined;

/**
 * 这个返回值是不是"判定不相关"。
 *
 * 写成类型守卫（`result is ...`）而不是返回 boolean：这样 TypeScript 能在
 * else 分支里把类型收窄成真正的 CaseDigest，调用方漏处理哨兵值会直接编译不过。
 * 这道闸的整个意义就是"不许把否定结论和失败混为一谈"，让编译器来盯着它。
 */
export function isCaseDigestIrrelevant(
  result: CaseDigestResult,
): result is typeof CASE_DIGEST_IRRELEVANT {
  return result === CASE_DIGEST_IRRELEVANT;
}

export async function buildCaseDigest(options: {
  question: string;
  cases: RelatedCase[];
  signal?: AbortSignal;
}): Promise<CaseDigestResult> {
  const { question, cases } = options;
  if (!isCaseDigestEnabled() || cases.length === 0) return undefined;

  const knownDocids = new Set(cases.map((item) => item.docid));
  // 每份案例各自的合法金额集合，外加一个全集——归纳时允许跨案例对比，
  // 但金额必须至少出自某一份记录，不能凭空出现。
  const allowedAmounts = new Set<string>();
  for (const item of cases) {
    for (const amount of extractAmounts(caseRecordText(item))) allowedAmounts.add(amount);
  }

  const corpus = cases
    .map((item, index) => `【案例${index + 1}】docid=${item.docid}\n案件名称：${item.caseName}\n`
      + `${caseRecordText(item).slice(0, PER_CASE_MAX_CHARS)}`)
    .join("\n\n----\n\n");

  let raw: RawDigest;
  try {
    const response = await requestStructuredJson<RawDigest>({
      role: "answer",
      maxTokens: 2_600,
      signal: options.signal,
      messages: [
        {
          role: "system",
          content: [
            "你在为中资企业的印度合规助手整理「相关判例」区块。",
            "任务不是逐个复述案例，而是把这些判例**横向归纳成风险主题**，让用户看完知道：",
            "这件事在印度会遇到哪几类挑战、每类挑战有哪些判例佐证、法院倾向如何、自己该做什么。",
            "",
            "硬性要求：",
            "1. 只能使用下面提供的案例记录里已有的内容。**不得引入记录里没有的案件、金额、条款或结论**。",
            "2. 每条实证必须标明它出自哪个 docid，且 docid 必须是下面出现过的。",
            "3. 金额必须与记录中的写法一致，不得换算、不得估算、不得四舍五入。记录里没有金额就不要写金额。",
            "4. 判例只是参考，**不是法律依据**。不要把判例结论写成「法规要求」或「必须如何」，",
            "   要写成「法院在某案中如何认定」「可作为抗辩依据」这样的口吻。",
            "5. 风险主题按与用户问题的相关度排序，最多 5 个；每个主题的实证最多 4 条。",
            "6. 全部用中文。案件名、法条编号、英文术语保留原文。",
            "7. 如果这些案例与用户的问题实在没有实质关联，返回空的 clusters 数组，不要硬凑。",
            "",
            "只返回 JSON，结构：",
            "{\"clusters\":[{\"title\":\"主题名\",\"challenge\":\"挑战是什么\",",
            "\"evidence\":[{\"docid\":\"...\",\"text\":\"某案中……金额……结果……\"}],",
            "\"takeaway\":\"法院倾向/可作抗辩的依据\"}],",
            "\"action_points\":[\"应对要点\"],",
            "\"index\":[{\"docid\":\"...\",\"case_name\":\"...\",\"angle\":\"这个案子从哪个角度相关\"}]}",
          ].join("\n"),
        },
        {
          role: "user",
          content: `用户的问题：${question}\n\n可用的案例记录：\n\n${corpus}`,
        },
      ],
    });
    raw = response.data;
  } catch {
    // ⚠这里返回 undefined 的含义是「**不知道**」：模型没跑成，我们对这些判例
    // 到底相不相关毫无判断。调用方应当照常展示原始列表。
    // 和下面 `CASE_DIGEST_IRRELEVANT`（跑成了、结论是"不相关"）**必须区分开**。
    return undefined;
  }

  // ---- 确定性核验：把编造的内容剔掉 ----
  const clusters: CaseDigestCluster[] = [];
  for (const cluster of raw.clusters ?? []) {
    const title = cluster.title?.trim();
    const challenge = cluster.challenge?.trim();
    if (!title || !challenge) continue;
    // 挑战描述本身也要过金额核验——它常常顺手带上"动辄上亿"这类数字。
    if (!amountsAreGrounded(challenge, allowedAmounts)) continue;

    const evidence = (cluster.evidence ?? [])
      .map((entry) => ({ docid: entry.docid?.trim() ?? "", text: entry.text?.trim() ?? "" }))
      .filter((entry) => entry.docid && entry.text)
      // docid 必须真的是这次检索到的案例；金额必须能在记录里找到。
      .filter((entry) => knownDocids.has(entry.docid))
      .filter((entry) => amountsAreGrounded(entry.text, allowedAmounts));

    if (evidence.length === 0) continue;

    const takeaway = cluster.takeaway?.trim();
    clusters.push({
      title,
      challenge,
      evidence,
      ...(takeaway && amountsAreGrounded(takeaway, allowedAmounts) ? { takeaway } : {}),
    });
  }

  // 归纳不出任何风险主题 → 这是**模型给出的否定结论**，不是失败。
  //
  // 提示词第 7 条明写着"如果这些案例与用户的问题实在没有实质关联，返回空的
  // clusters 数组，不要硬凑"。模型照做了，而 2026-09-22 之前这里把它的答复
  // 和"调用失败"一样返回 undefined，于是上游分不清，照样把原始列表端了上去。
  //
  // 这和 `case-search.ts` 里向量重排那处是**同一个 bug 形状**：
  // 一个成功的否定判断，被编码成了和失败相同的返回值。
  //
  // （clusters 被金额核验、docid 核验全部刷掉也会走到这里。那种情况下判例内容
  //  本身站不住，不展示同样是对的。）
  if (clusters.length === 0) return CASE_DIGEST_IRRELEVANT;

  const actionPoints = (raw.action_points ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => amountsAreGrounded(item, allowedAmounts))
    .slice(0, 8);

  // 索引表只保留真实存在的案例，案件名以我们自己的记录为准，不用模型写的。
  const index = (raw.index ?? [])
    .map((entry) => ({ docid: entry.docid?.trim() ?? "", angle: entry.angle?.trim() ?? "" }))
    .filter((entry) => knownDocids.has(entry.docid))
    .map((entry) => {
      const source = cases.find((item) => item.docid === entry.docid);
      return {
        docid: entry.docid,
        case_name: source?.caseName ?? entry.docid,
        official_url: source?.official_url ?? `https://indiankanoon.org/doc/${entry.docid}/`,
        angle: entry.angle,
      };
    });

  return {
    clusters,
    action_points: actionPoints,
    index,
  };
}
