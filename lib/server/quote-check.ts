import type { AnswerResponse } from "../contracts";
import type { RetrievedKnowledgeChunk } from "./retrieval";
import { t, type AnswerLanguage } from "./answer-language";

/**
 * 原句核验：模型给每条法规要求附的英文原句，必须真的出现在它引用的证据原文里。
 *
 * 起因是线上核实到的一个错误：回答里写"根据《Consolidated FDI Policy Circular, 2020》
 * 第5.2条……中资股东须遵守 Press Note 3 限制，即投资须经政府审批路径"，
 * 而第5.2条的原文只讲行业上限和自动路线的口径，**一个字都没提接壤国家**。
 * 结论本身是对的（对中资股东还特别关键），但引用指错了地方——
 * 这种"结论对、引用错"比完全不引用更危险：它看起来有出处，经不起核对。
 *
 * 根因是过去的校验只覆盖"数字类"主张（表格编号 / 天数 / 百分比），
 * 因为数字能做字符串比对；而"须经政府审批"这种**命题**没法直接机械验证。
 * 让模型附上支持这句话的英文原句之后，问题就转化成了"这句话在不在原文里"——
 * 这是可以精确匹配的。模型没法从一段只讲行业上限的原文里，
 * 编出一句在讲接壤国家的英文原文而不被发现。
 *
 * 匹配前要做归一化：知识库正文是从 PDF 提取的，同一个句子里经常带硬换行、
 * 连字符断词、弯引号，直接 includes 会大面积误报。归一化只处理这些**排版差异**，
 * 不改动词句本身——不做同义词、不做模糊匹配，否则就退回到"看起来验过了"的假象。
 */

type Step = AnswerResponse["action_steps"][number];
type QuoteStatus = NonNullable<Step["quote_status"]>;

/**
 * 归一化：小写，然后**只保留字母和数字**，其余（空格、换行、连字符、引号、标点）全部去掉。
 *
 * 为什么这么狠：知识库正文是从 PDF 提取的，同一句话里会出现硬换行、
 * 行末断词（"regist-\nrar"）、弯引号、双空格。想靠"分别处理每种排版差异"来对齐，
 * 每漏一种就是一次误报——而误报的代价很高：把一条正确的引用标成"可能指错条款"，
 * 用户会开始不信任所有的警示。全部剥掉之后，两边只剩下字母数字，排版差异不复存在。
 *
 * 会不会因此产生误判（本来不该匹配的匹配上了）？25个字符以上的英文法条原句，
 * 剥掉标点后仍然是高度特异的字符串，撞车的概率可以忽略。
 * 而且这一步只是**收紧**：匹配上不代表结论正确，只代表这句话确实来自被引用的条文。
 */
/**
 * India Code 系列 PDF 把**修订脚注编号直接嵌在正文里**，紧贴着方括号：
 *
 *     shall make entry thereof by presenting 4[electronically] 5[on the customs
 *     automated system] to the proper officer a bill of entry 6[in such form...]
 *
 * 那个 `4`、`5`、`6` 不是条文的一部分，是"这段文字由第4号修正案加入"的标记。
 * 模型引用时当然写干净的原句（`presenting electronically on the customs...`），
 * 于是两边归一化之后变成
 *
 *     原文：presenting4electronically5onthecustoms...
 *     原句：presentingelectronicallyonthecustoms...
 *
 * ——**被几个孤零零的数字切断**。2026-09-18 补进海关法后实测，s46(1) 这一条
 * 最长连续吻合只剩 65%，刚好压在 50% 门槛上；标记更密或引文更短的条文就直接判负，
 * 界面上弹出红色的"引用可能指错条款"。这是**假警报**，而假警报的代价很高：
 * 用户会开始不信任所有的警示。
 *
 * 受影响的不止海关法——公司法、IBC、LLP Act、竞争法、合伙法、PMLA
 * 全都来自 India Code，全是这个排版。
 *
 * 为什么不干脆"把数字也一起剥掉"：那样 `within 30 days` 和 `within 60 days`
 * 会归一化成同一个字符串，原句核验就从"精确匹配"退化成"看起来验过了"——
 * 而条文里的天数、百分比、表格号恰恰是最需要验的东西。
 *
 * 所以只删**紧跟在 `[` 前面的 1–3 位数字**。这个位置除了脚注标记不会是别的东西，
 * 条文正文里的任何其他数字都不受影响。
 */
function stripFootnoteMarkers(value: string): string {
  return value.replace(/\d{1,3}(?=\[)/g, "");
}

export function normalizeForQuoteMatch(value: string): string {
  return stripFootnoteMarkers(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 原句太短就没有验证意义（"shall" 这种在哪都能匹配上）。按归一化前的长度算。 */
const MIN_QUOTE_LENGTH = 25;

/**
 * 锚点匹配的两条门槛，必须同时满足。
 *
 * 为什么不再要求"整段原句连续完全匹配"：线上实测到一次误伤——年度申报那条引的是
 * Section 92，原句前 321 个归一化字符和条文**逐字一致**（占全句76%），
 * 只因为模型把跨 chunk 的内容连着引了（"由董事和公司秘书签署"那半句被切到了另一个 chunk），
 * 整条就被判成"引用可能指错条款"。长引文里任何一处断裂都会整条判负，这个太严了。
 *
 * 改成看**最长连续吻合片段**：
 * - `MIN_ANCHOR_CHARS`：至少要有这么长的一段逐字吻合，防止靠几个常见词蒙混过关
 * - `MIN_MATCH_RATIO`：吻合部分还要占到全句的这个比例，防止"一句真话 + 一大段编造"
 *
 * 同一次实测里，真正引错条款的那条（引 Section 133 却在讲 Section 134 的董事会报告）
 * 最长吻合只有 5 个字符（1%），两条门槛都过不去——该抓的照样抓得住。
 */
const MIN_ANCHOR_CHARS = 40;
const MIN_MATCH_RATIO = 0.5;

/**
 * 原句与正文之间最长的连续吻合片段长度（都已归一化）。
 * 从每个起点用二分法往后探，`best` 用来剪枝，长度到不了当前最好成绩的起点直接跳过。
 */
export function longestMatchLength(needle: string, haystack: string): number {
  let best = 0;
  for (let start = 0; start < needle.length; start += 1) {
    if (needle.length - start <= best) break;
    let low = best + 1;
    let high = needle.length - start;
    let current = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (haystack.includes(needle.slice(start, start + mid))) {
        current = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (current > best) best = current;
  }
  return best;
}

/**
 * 这个 chunk 是不是**表格型条文**。
 *
 * 2026-09-20 用户实测：问印度公司所得税率，界面对「新设制造公司 15%」那条弹出
 * 红字"引用可能指错条款"。但用户自己在法里找到了 15%——**引用是对的，警告是错的**。
 *
 * 根因不在这个模块，在数据：Income-tax Act 2025 的 s201 是一张四栏表，
 * 从 PDF 抽出来之后列与列交错成这样——
 *
 *     (b) has been set-up and reg-      ← D 栏
 *     (b) 22% (without any              ← C 栏插进来了
 *     istered on or after the 1st       ← D 栏续
 *     deduction or allow-               ← C 栏续
 *     October, 2019;
 *
 * 实测四条模型会写的原句，最长连续吻合分别只有 22 / 40 / 17 / 16 字符，全部判负。
 * 而正确答案里那句"engaged in business of manufacture or production of any article"
 * 在原文里是**竖着读一整栏**，每行之间都夹着别栏文字，连 5 个词的窗口都凑不齐。
 *
 * 试过三种放宽办法，都不行，记在这里免得以后再走一遍：
 * - 行末断词比例：s201 只有 0.11，落在正常 chunk 的分布里，分不开；
 * - 词袋覆盖率：法律英语词汇高度重复，无关条文也能到 75–86%，分不开；
 * - 5 词滑窗覆盖率：竖排那一栏连窗口都凑不齐，仍然 0%。
 *
 * 结论：**数据在线性顺序上读不通，校验器救不回来**。再放宽就是把精确核验
 * 变成"看起来验过了"——那正是这个模块开头明确拒绝的事。
 *
 * 所以这里不去猜"到底对不对"，只陈述一个事实：**这条出自表格，没法自动核验**。
 * 不说"可能指错条款"，因为系统确实分不清；乱扣帽子的代价是用户以后不信任何警示。
 *
 * 判据用表格自身的排版标记（独立一行的 TABLE、Sl. No. / S. No. 表头）。
 * 全库 5650 个 chunk 里命中 275 个（4.9%），够特异；s201 正好命中。
 *
 * 真正的修法是把这些表格重新抽一遍，让列按顺序读得通——那是知识库侧的事。
 */
const TABLE_MARKER = /^\s*TABLE\s*$|^\s*Sl\.?\s*(?:No\.?)?\s|^\s*S\.?\s*No\.?\s/m;

export function isTableLikeChunk(body: string): boolean {
  return TABLE_MARKER.test(body);
}

export function verifyQuote(options: {
  quote: string | undefined;
  citationRefs: number[];
  evidence: RetrievedKnowledgeChunk[];
}): QuoteStatus {
  const { quote, citationRefs, evidence } = options;
  if (!quote || quote.trim().length < MIN_QUOTE_LENGTH) return "MISSING";

  const needle = normalizeForQuoteMatch(quote);
  if (!needle) return "MISSING";

  // 只在这条步骤自己引用的证据里找。在全部证据里找会放过"张冠李戴"——
  // 原句确实来自知识库，但来自另一部法律的另一条，这正是要抓的错误类型。
  const scoped = citationRefs
    .map((ref) => evidence[ref - 1])
    .filter((chunk): chunk is RetrievedKnowledgeChunk => Boolean(chunk));
  if (scoped.length === 0) return "MISSING";

  const anchorFloor = Math.max(MIN_ANCHOR_CHARS, Math.ceil(needle.length * MIN_MATCH_RATIO));
  const hit = scoped.some((chunk) => {
    const body = normalizeForQuoteMatch(chunk.body);
    // 先试整句：绝大多数情况一次就过，省掉下面的逐位探查。
    if (body.includes(needle)) return true;
    return longestMatchLength(needle, body) >= anchorFloor;
  });
  if (hit) return "VERIFIED";
  // 没匹配上。如果它引的**全部**是表格型 chunk，那就不是"引错了"，
  // 而是这种正文根本没法做字符串核验——照实说，别扣帽子。
  // 要求"全部"而不是"任一"：只要还有一个是正常正文的 chunk 没匹配上，
  // 那条引用就仍然可疑，该报警还得报。
  if (scoped.every((chunk) => isTableLikeChunk(chunk.body))) return "TABLE_UNVERIFIABLE";
  return "NOT_FOUND";
}

/**
 * 给全部步骤打上原句核验结果。
 * 只要求 MANDATORY 附原句；PRACTICAL 是操作建议，按 SKIPPED 处理，不强求。
 */
export function checkQuotes(options: {
  steps: Step[];
  evidence: RetrievedKnowledgeChunk[];
}): Step[] {
  const { steps, evidence } = options;
  return steps.map((step) => {
    if (step.kind !== "MANDATORY") return { ...step, quote_status: "SKIPPED" as const };
    return {
      ...step,
      quote_status: verifyQuote({
        quote: step.source_quote,
        citationRefs: step.citation_refs,
        evidence,
      }),
    };
  });
}

/**
 * 汇总成写给用户的提示。全部通过时返回空数组。
 *
 * 文案走 `answer-language.ts` 的目录：这几句是**服务端直接拼进 risks_and_exceptions** 的，
 * 绕过模型——英文回答里混一句中文警告，比全中文还糟。
 */
export function quoteNotes(steps: Step[], language: AnswerLanguage = "zh"): string[] {
  const notFound = steps.filter((step) => step.quote_status === "NOT_FOUND").length;
  const missing = steps.filter((step) => step.quote_status === "MISSING").length;
  const tableOnly = steps.filter((step) => step.quote_status === "TABLE_UNVERIFIABLE").length;
  const notes: string[] = [];
  if (tableOnly > 0) notes.push(t("quoteTableUnverifiable", language, { n: tableOnly }));
  if (notFound > 0) notes.push(t("quoteNotFound", language, { n: notFound }));
  if (missing > 0) notes.push(t("quoteMissing", language, { n: missing }));
  return notes;
}
