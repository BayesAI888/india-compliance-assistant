/**
 * 阶段三：判例检索——本地案例库优先，本地没有相关案例才实时查 Indian Kanoon 兜底。
 *
 * 触发判断（要不要查）在 `case-relevance.ts`；这个文件只负责"查得到查不到、
 * 查到了哪些"。整条链路任何一步失败（本地打分出错、embedding API挂了、
 * Indian Kanoon 请求失败）都必须静默降级返回空数组，不能让问答主流程跟着挂——
 * 判例是锦上添花的补充信息，不是回答能不能生成的前提条件，这一点和其余所有
 * "宁可少一路召回、不能拖垮主流程"的降级设计（dense-retrieval.ts、
 * relevance-check.ts）是同一个原则。
 *
 * 本地排序目前用关键词重合度打分（纯函数、无依赖、任何时候都能跑），
 * 配置了 EMBEDDING_API_KEY 时会额外用向量相似度重新排序——案例库预期量级
 * 不大（几十到几百条），这里选择"每次触发时现算全部已发布案例的向量"，
 * 不像知识库 chunk 那样为每条预先算好存进 vector-store.ts。如果以后案例
 * 数量涨到成百上千条，这个现算的开销会变得不划算，需要改成入库缓存的方案。
 */

import type { RelatedCase } from "../contracts";
import type { StoredCase } from "./case-store";
import { cacheLiveCases } from "./case-cache";
import { isSearchableByIndianKanoon } from "./case-query-language";
import { cosineSimilarity, embedQuery, embedTexts, isEmbeddingConfigured } from "./embeddings";
import { isCaseOnTopic } from "./case-domain";

/**
 * 与 legal-answer.ts 的 `isAnswerTraceEnabled` 同口径（ANSWER_TRACE 未设 = 开）。
 * 不直接 import 它是为了避免反向依赖——legal-answer → case-search 已经存在，
 * 再反手 import 回去就成环了。两边判据必须保持一致，改动时同步。
 */
function traceEnabled(): boolean {
  const flag = process.env.ANSWER_TRACE?.trim().toLowerCase();
  return !(flag === "off" || flag === "false" || flag === "0");
}

const IK_BASE = (process.env.INDIANKANOON_API_BASE?.trim() || "https://api.indiankanoon.org").replace(/\/$/, "");
const MAX_LOCAL_RESULTS = 3;
const MAX_LIVE_RESULTS = 3;
/**
 * 用户明确在“找判例”时，不应只给三条样本：要把本地命中的案例完整列出。
 *
 * 这里是展示上限，不是检索候选池上限；传 Infinity 会被收敛为本次所有相关本地记录。
 */
const ALL_LOCAL_RESULTS = Number.POSITIVE_INFINITY;
/**
 * 用户明确需要判例、且本地库覆盖不足时，向 Indian Kanoon 至少尝试取回的条数。
 *
 * 这是“外部补充的检索目标”，不是保证一定有五份真实相关判例；检索结果不足时，
 * 必须如实展示实际命中的数量，不能用不相关案例凑数。
 */
export const CASE_SEEKING_LIVE_TARGET = Number(process.env.CASE_SEEKING_LIVE_TARGET?.trim()) || 5;
/**
 * 本地案例库至少要拿出几条，才算"够用、不必再花钱查实时的"。
 *
 * 2026-09-17 用户反馈：问广告费判例时本地只匹配上 1 条，答案里的判例部分单薄到没有参考价值，
 * 但旧逻辑只有在本地**一条都没有**时才兜底查 Indian Kanoon，于是这种"有一点但不够"的情况
 * 永远走不到兜底。改成按条数判断：本地不足这个数就补查实时的，用实时结果把缺口填满。
 *
 * 为什么定在 3：`buildCaseDigest` 归纳风险主题需要横向比对，一两条判例归纳不出"主题"，
 * 只会把单条案例换个说法复述一遍——那正是用户当初说"信息无用、零散"的那个问题。
 */
export const MIN_SUFFICIENT_LOCAL_RESULTS = Number(process.env.CASE_SEARCH_MIN_LOCAL?.trim()) || 3;
/** 实时检索一次抓多少条候选回来再排序。抓多一点才有得排，但别把 API 额度当水用。 */
const LIVE_CANDIDATE_POOL = 20;
/** 关键词重合度打分低于这个值，不当成"本地有相关案例"。没有实测调过，是估的初始值。 */
const KEYWORD_MIN_SCORE = Number(process.env.CASE_SEARCH_MIN_SCORE?.trim()) || 0.18;
/** 配了向量密钥时，相似度低于这个值也不算数。 */
const SIMILARITY_MIN_SCORE = Number(process.env.CASE_SEARCH_SIMILARITY_THRESHOLD?.trim()) || 0.35;

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "was", "were",
  "this", "that", "with", "as", "by", "at", "from", "be", "it", "its", "into", "under", "not",
  "shall", "may", "can", "will", "has", "have", "had", "which", "whether", "there",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((token) => !STOPWORDS.has(token));
}

/**
 * 关键词重合度打分（纯函数）：queryText 里有多少比例的独立词，
 * 也出现在 caseText 里。queryText 没有可用词时返回 0。
 *
 * 保留这个不加权版本是因为它语义简单、便于单测；真正参与排序的是下面
 * 带 IDF 权重的 `rankCasesByKeyword`。
 */
export function keywordOverlapScore(queryText: string, caseText: string): number {
  const queryTerms = new Set(tokenize(queryText));
  if (queryTerms.size === 0) return 0;
  const caseTerms = new Set(tokenize(caseText));
  let hit = 0;
  for (const term of queryTerms) {
    if (caseTerms.has(term)) hit += 1;
  }
  return hit / queryTerms.size;
}

/**
 * 参与相关性匹配的"主题文本"：只取有主题区分度的字段，且有长度上限。
 *
 * 真实事故（2026-09-16）：问"印度公司的广告费有什么判例"，召回的第一条是
 * Standard Chartered Bank 那份讲外资银行总部费用、分行利息、外汇重估的判决，
 * 与广告费毫无关系。根因是这里原本把 **税局主张＋企业抗辩＋裁定结果全文**
 * 拼起来做匹配，而大案例记录动辄六万字、横跨十几个税务主题，**几乎任何一个
 * 税务词都能在里面找到**——打分实际上奖励的是"记录写得长"，不是"主题对得上"。
 *
 * 两道修正：① 只拿案件名、税种与主管机关、参考价值、裁判要旨（且截断），
 * 不拿双方主张的长篇论证；② 见下面的 IDF 加权。
 */
const TOPIC_TEXT_MAX_CHARS = 1_500;

function caseTopicText(item: StoredCase): string {
  return [
    item.caseName,
    item.taxTypeAndAuthority,
    item.referenceValueNote,
    ...item.finalRuling,
  ].filter(Boolean).join(". ").slice(0, TOPIC_TEXT_MAX_CHARS);
}

/** 送去算向量的文本，和关键词匹配用的是同一份主题文本，口径保持一致。 */
function caseSummaryText(item: StoredCase): string {
  return caseTopicText(item);
}

/**
 * 长度归一的强度。0 = 不归一（回到 2026-09-22 之前），1 = 完全按长度线性折算。
 * 0.75 是 BM25 的经典取值，这里沿用，没有单独调过。
 */
const LENGTH_NORM_B = 0.75;

/**
 * 长度惩罚系数：主题文本越长，命中一个词越不值钱。
 *
 * 形式取自 BM25 的分母，但**封顶在 1**——只罚长文档，不奖短文档。
 *
 * 为什么封顶：BM25 的完整公式里，短文档会拿到 >1 的加成，靠词频饱和项来平衡。
 * 而我们这边是"词出现过没有"的集合匹配（没有词频），少了那道平衡，
 * 短文档的加成会失控——一份只有 18 个词的案例只要撞上一个生僻查询词，
 * 分数就能翻倍冲过阈值。那是把现在这个问题反过来再犯一遍。
 *
 * 封顶还有个好处：分数**只可能比改之前低**，所以 CASE_SEARCH_MIN_SCORE
 * 这个阈值的含义没有被推翻，改动只会少召回、不会凭空多召回。
 */
function lengthPenalty(termCount: number, averageTermCount: number): number {
  if (averageTermCount <= 0 || termCount <= 0) return 1;
  const ratio = termCount / averageTermCount;
  return Math.min(1, 1 / (1 - LENGTH_NORM_B + LENGTH_NORM_B * ratio));
}

/**
 * 按 IDF 加权 + 长度归一，给候选案例排序（纯函数，不做任何IO）。
 *
 * ## 为什么要 IDF 加权
 *
 * 不加权时 "tax"、"india"、"income"、"assessee" 这类几乎每份判决都有的词，
 * 和 "advertisement"、"amp"、"promotion" 这种真正决定主题的词，权重一样。
 * 结果就是"命中了几个万能词"也能凑够分数。IDF（逆文档频率）让**越少见的词越值钱**。
 *
 * ## 为什么还要长度归一（2026-09-22 补）
 *
 * 光有 IDF 不够。真实事故：用户问「所得税案件中保证金计算的基数」，
 * 三种不同写法的英文检索式跑下来，**同一件 Vodafone 案三次都排第一**，
 * 而它讲的是 80-IA 扣除、license fee 性质、TP 调整，和保证金毫无关系。
 *
 * 原因是它的「争议税种以及主管税局」字段被填成了两千多字的大杂烩，
 * 列了二三十个 section。在真实的 119 件案例库里：
 *
 *     主题文本词数   中位数 52 词，最长 396 词 —— 最长的是中位数的 7.6 倍
 *
 * 而原来的公式 `命中词IDF之和 ÷ 全部查询词IDF之和`，**分母只和查询有关，
 * 和文档多长完全无关**。于是 396 词的文档和 18 词的文档站在同一条起跑线上，
 * 前者撞上任何查询词的概率高 7.6 倍。**最长的那件赢下几乎所有检索。**
 *
 * 这正是真实检索系统用 BM25（带长度归一）而不是用裸覆盖率的原因。
 *
 * 顺带说明：这掩盖的其实是案例库的数据质量问题（那个字段不该塞两千字）。
 * 但打分函数不能假设数据是干净的——库是人工整理的，一定会有长短不齐。
 *
 * 分数仍然落在 0~1，且**只可能比归一之前低**（惩罚系数封顶在 1），
 * 所以 CASE_SEARCH_MIN_SCORE 的量纲没变。阈值本来就标着"估的初始值"，
 * 上线后要用真实问题重新调。
 */
export function rankCasesByKeyword(
  queryText: string,
  cases: StoredCase[],
): Array<{ item: StoredCase; score: number }> {
  const queryTerms = [...new Set(tokenize(queryText))];
  if (queryTerms.length === 0 || cases.length === 0) {
    return cases.map((item) => ({ item, score: 0 }));
  }

  const caseTermSets = cases.map((item) => new Set(tokenize(caseTopicText(item))));

  // 每个查询词的文档频率 → IDF。加 1 防止除零，也让"全库都有的词"权重趋近于 0。
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const documentFrequency = caseTermSets.reduce(
      (count, terms) => count + (terms.has(term) ? 1 : 0),
      0,
    );
    idf.set(term, Math.log((cases.length + 1) / (documentFrequency + 1)));
  }

  const totalWeight = queryTerms.reduce((sum, term) => sum + (idf.get(term) ?? 0), 0);

  // 长度基准取**本次候选集**的平均词数，而不是写死一个常数：
  // 案例库会一直长大、字段填写习惯也会变，写死的基准迟早和现实脱节。
  const averageTermCount = caseTermSets.reduce((sum, terms) => sum + terms.size, 0) / caseTermSets.length;

  return cases
    .map((item, index) => {
      if (totalWeight <= 0) return { item, score: 0 };
      const terms = caseTermSets[index];
      const hitWeight = queryTerms.reduce(
        (sum, term) => sum + (terms.has(term) ? (idf.get(term) ?? 0) : 0),
        0,
      );
      return { item, score: (hitWeight / totalWeight) * lengthPenalty(terms.size, averageTermCount) };
    })
    .sort((a, b) => b.score - a.score);
}

function toRelatedCase(item: StoredCase): RelatedCase {
  return {
    caseName: item.caseName,
    docid: item.docid,
    official_url: item.officialUrl,
    court_and_year: item.courtAndYear,
    tax_type_and_authority: item.taxTypeAndAuthority,
    revenue_position: item.revenuePosition,
    assessee_argument: item.assesseeArgument,
    final_ruling: item.finalRuling,
    evidence_support: item.evidenceSupport,
    reference_value_note: item.referenceValueNote,
  };
}

/**
 * 本地案例库检索：关键词打分，配置了向量密钥时再用 embedding 相似度重排一次。
 *
 * ## 三种"没有重排结果"，含义完全不同（2026-09-22 理清）
 *
 * 原来这三种情况都回退到关键词结果，于是**唯一能说"库里没有这个主题"的信号
 * 被当成故障扔掉了**。真实事故：用户问所得税上诉保证金，库里一件相关的都没有，
 * 向量跑完判定全部不相关，代码照样把关键词凑出来的 3 件不相干判例端了上去
 * （讲常设机构的、讲 80-IA 扣除的、还有一件刑事冻结资产的）。
 *
 *   ① 没配密钥        → **不知道**。只有关键词分数可用，回退。
 *   ② 调用抛异常      → **不知道**。网络/额度问题，不能因此判定没有，回退。
 *   ③ 跑完了，一件都没过相似度线 → **知道，而且答案是"没有"**。返回空。
 *
 * ③ 和前两种的区别是：向量模型**成功地表达了意见**，只是意见是否定的。
 * 把一个成功的否定判断当成失败来兜底，等于花钱问了专家又把专家的话扔掉。
 *
 * 关键词打分只看字面重合，分不开"security deposit（客户押金）"和
 * "pre-deposit（上诉预缴）"——中文都叫"保证金"。向量是这条链路上唯一
 * 能分开它们的东西。
 */
export async function searchLocalCases(
  englishQuery: string,
  cases: StoredCase[],
  limit = MAX_LOCAL_RESULTS,
): Promise<RelatedCase[]> {
  if (cases.length === 0 || !englishQuery.trim()) return [];

  const ranked = rankCasesByKeyword(englishQuery, cases);
  const keywordRanked = ranked.filter((entry) => entry.score >= KEYWORD_MIN_SCORE);
  // Infinity 是“完整列出”的语义，不让它一路传进 slice / 候选池计算。
  const requestedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.floor(limit), keywordRanked.length))
    : keywordRanked.length;
  if (traceEnabled()) {
    // "库里有案却检索为空"的第一嫌疑就是这里：english_query 为空或纯中文时
    // tokenize 一个英文词都吐不出来，全员 0 分，整个函数直接走空。
    const top3 = ranked.slice(0, 3)
      .map((entry) => `${entry.score.toFixed(3)}《${entry.item.caseName.slice(0, 48)}》`)
      .join(" / ");
    console.info(
      `[trace] case-local: 库=${cases.length}`
      + ` 查询词=${new Set(tokenize(englishQuery)).size}`
      + ` 关键词过线(≥${KEYWORD_MIN_SCORE})=${keywordRanked.length}`
      + ` top3: ${top3 || "无"}`,
    );
  }
  if (keywordRanked.length === 0) return [];

  if (!isEmbeddingConfigured()) {
    return keywordRanked.slice(0, requestedLimit).map((entry) => toRelatedCase(entry.item));
  }

  try {
    // 普通业务问答只需要三条参考案例，最多重排十条候选；
    // 用户明确来找案例时，才对所有关键词相关的本地案例做重排并完整列出。
    const candidates = keywordRanked.slice(
      0,
      requestedLimit === keywordRanked.length
        ? keywordRanked.length
        : Math.max(MAX_LOCAL_RESULTS * 3, 10),
    );
    const [queryVector, caseVectors] = await Promise.all([
      embedQuery(englishQuery),
      embedTexts(candidates.map((entry) => caseSummaryText(entry.item))),
    ]);
    const scored = candidates
      .map((entry, index) => {
        const vector = caseVectors[index];
        const similarity = vector ? cosineSimilarity(queryVector, vector) : 0;
        return { item: entry.item, similarity };
      });
    if (traceEnabled()) {
      const top = [...scored].sort((a, b) => b.similarity - a.similarity).slice(0, 3)
        .map((entry) => `${entry.similarity.toFixed(3)}《${entry.item.caseName.slice(0, 48)}》`)
        .join(" / ");
      console.info(`[trace] case-local: 向量重排 相似度线=${SIMILARITY_MIN_SCORE} top3: ${top || "无"}`);
    }
    const reranked = scored
      .filter((entry) => entry.similarity >= SIMILARITY_MIN_SCORE)
      .sort((a, b) => b.similarity - a.similarity);
    // ③ 跑完了、一件都没过线 → 这是**向量给出的否定结论**，采信它，返回空。
    // 不要退回关键词结果：那些结果正是因为字面凑巧重合才进的候选池。
    return reranked.slice(0, requestedLimit).map((entry) => toRelatedCase(entry.item));
  } catch {
    // ② 调用失败 → 不知道，只能退回关键词结果。
    return keywordRanked.slice(0, requestedLimit).map((entry) => toRelatedCase(entry.item));
  }
}

function stripHtml(html: string | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Indian Kanoon 搜索结果的原始条目（只列我们真正会读的字段）。 */
export interface LiveCaseDoc {
  tid: number | string;
  title?: string;
  docsource?: string;
  headline?: string;
  publishdate?: string;
}

/**
 * 从一条实时检索结果里判断判决年份，用于"按时间排序"。
 *
 * 取值顺序：API 自带的 publishdate → 标题里的四位年份 → 来源栏里的四位年份。
 * 一个都找不到时返回 undefined（调用方按"最旧"处理，不猜）。
 * 只认 1900–2099，避免把案号、金额里的数字当成年份。
 */
export function extractCaseYear(doc: LiveCaseDoc): number | undefined {
  const fromDate = doc.publishdate?.match(/\b(19|20)\d{2}\b/)?.[0];
  if (fromDate) return Number(fromDate);
  for (const field of [doc.title, doc.docsource]) {
    const found = field?.match(/\b(19|20)\d{2}\b/)?.[0];
    if (found) return Number(found);
  }
  return undefined;
}

/**
 * 实时检索结果排序：**相关度为主，时间为辅**。
 *
 * 用户的要求是"按相关度和时间排序"。两者冲突时必须有明确的主次，否则
 * "一条新但不相关的案子"会排到"一条老但正对题的判例"前面——那比不排序还糟。
 * 所以时间只作为**有上限的加分**（最多 RECENCY_WEIGHT），相关度差距一旦超过这个上限，
 * 再新也翻不了盘；相关度接近时，新判例优先。
 *
 * 判决年份的价值衰减按 20 年计：20 年前及更早的判例拿不到时间分。印度税务判例
 * 的法条基础在这个跨度里通常已经改过，老判例参考价值确实更低。
 */
const RECENCY_WEIGHT = 0.2;
const RECENCY_WINDOW_YEARS = 20;

export function rankLiveDocs(englishQuery: string, docs: LiveCaseDoc[], now = new Date()): LiveCaseDoc[] {
  const currentYear = now.getFullYear();
  return docs
    .map((doc, index) => {
      const relevance = keywordOverlapScore(englishQuery, `${doc.title ?? ""} ${stripHtml(doc.headline)}`);
      const year = extractCaseYear(doc);
      const age = year === undefined ? RECENCY_WINDOW_YEARS : Math.max(0, currentYear - year);
      const recency = Math.max(0, 1 - age / RECENCY_WINDOW_YEARS) * RECENCY_WEIGHT;
      return { doc, score: relevance + recency, index };
    })
    // 分数相同时保持 Indian Kanoon 自己的返回顺序（它的排序本身就带相关度信息），
    // 不要让 sort 的不稳定性造成同一个问题两次检索结果顺序不一样。
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.doc);
}

/**
 * 实时兜底：调用 Indian Kanoon Search API，只取标题/来源/摘录片段，
 * 不做结构化提炼（省一次模型调用），所以字段比本地案例库命中的要少。
 * 需要服务器自己的 INDIANKANOON_API_TOKEN（和 scripts/*.mjs 用的是同一个环境变量名，
 * 但这里是服务器在生产环境里直接花钱调用，要在服务器的 .env.local 里单独配一份，
 * 不是本地脚本那份token自动生效）。
 */
export async function searchLiveCases(englishQuery: string, limit = MAX_LIVE_RESULTS): Promise<RelatedCase[]> {
  const token = process.env.INDIANKANOON_API_TOKEN?.trim();
  if (!token || !englishQuery.trim() || limit <= 0) return [];
  // **语言闸门**：Indian Kanoon 库里只有英文，塞中文进去不报错、只返回空，
  // 用户看到的是"没有找到相关判例"，而真相是我们压根没查。
  //
  // 这不是假设性风险：`retrieval.ts` 里 `english_query` 的最后一档兜底是**中文原问题**
  //     english_query: englishQuery || glossary.searchTerms.join(" ") || question
  // 模型调用失败、词典又没命中时，中文就顺着这个参数名叫 englishQuery 的字段流到这里了。
  // 名字叫 english 不等于内容是 english。
  //
  // 不去改 retrieval.ts 那行：那个兜底对**本地知识库检索**是对的（中文原文确实还能
  // 匹配上中文 chunk），改了会削弱本地召回。正确的位置是在国界上拦，见 case-query-language.ts。
  if (!isSearchableByIndianKanoon(englishQuery)) return [];

  const params = new URLSearchParams({ formInput: englishQuery, pagenum: "0" });
  const response = await fetch(`${IK_BASE}/search/?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Token ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Indian Kanoon 搜索失败：HTTP ${response.status}`);
  const data = await response.json() as { docs?: LiveCaseDoc[] };
  const docs = rankLiveDocs(englishQuery, (data.docs ?? []).slice(0, LIVE_CANDIDATE_POOL));

  return docs.slice(0, limit).map((doc) => ({
    // stripHtml：IK 的 title 和 headline 一样带 `<b>` 高亮标签，
    // 直接透出会把标签渲染到「案例索引」里（2026-10-13 线上实测，
    // 公司链路同款问题已修，这条实时兜底路一并堵上）。
    caseName: doc.title ? stripHtml(doc.title) : `Indian Kanoon 文档 ${doc.tid}`,
    docid: String(doc.tid),
    official_url: `https://indiankanoon.org/doc/${doc.tid}/`,
    court_and_year: [doc.docsource, extractCaseYear(doc)].filter(Boolean).join(" · ") || undefined,
    snippet: stripHtml(doc.headline).slice(0, 240),
  }));
}

export function isCaseSearchEnabled(): boolean {
  const flag = process.env.CASE_SEARCH?.trim().toLowerCase();
  return flag !== "off" && flag !== "false" && flag !== "0";
}

export function isCaseLiveFallbackEnabled(): boolean {
  const flag = process.env.CASE_LIVE_FALLBACK?.trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return false;
  return Boolean(process.env.INDIANKANOON_API_TOKEN?.trim());
}

/**
 * 本地结果 + 实时结果合并：**本地优先**（已经过人工审核，可信度高于现查的摘录），
 * 实时结果只用来把缺口填满；docid 重复的以本地那条为准。
 *
 * 单独抽成纯函数是为了能单测——合并顺序和去重这两件事一旦错了，
 * 表现是"答案里同一个案子出现两遍"或"审核过的案例被现查的摘录顶掉"，
 * 都很难从线上答案里一眼看出来。
 */
export function mergeCaseResults(local: RelatedCase[], live: RelatedCase[], limit: number): RelatedCase[] {
  const merged = [...local];
  const seen = new Set(local.map((item) => item.docid));
  for (const item of live) {
    if (merged.length >= limit) break;
    if (seen.has(item.docid)) continue;
    seen.add(item.docid);
    merged.push(item);
  }
  return merged.slice(0, limit);
}

/**
 * 整条判例检索链路的入口。
 *
 * 2026-09-17 改动：判断标准从"本地一条都没有"改成"本地不足 MIN_SUFFICIENT_LOCAL_RESULTS 条"。
 * 本地有 1 条而已时，旧逻辑认为"有就够了"，直接把这一条孤零零地摆给用户——
 * 归纳不出风险主题，参考价值很低。现在这种情况会去补查实时判例把缺口填满。
 *
 * 同时触发**后台自动缓存**（见 `case-cache.ts`）：现查回来的判例顺手提炼进案例库待审核，
 * 下次同类问题本地就够用了。这一步刻意不 await——它要下载全文再调模型，
 * 放进关键路径会让用户多等好几秒，而它的收益是"下次省钱"，不是"这次答得更好"。
 *
 * 任何一步失败都吞掉异常——判例是补充信息，不能拖垮主答案。
 */
export async function retrieveRelatedCases(
  englishQuery: string,
  publishedCases: StoredCase[],
  /**
   * 问题指向的法律类别（`domain-scope.ts` 的 `detectQuestionCategories()`）。
   * 空数组 = 认不出问题的法域 → 法域闸门不生效，全部放行。
   */
  questionCategories: string[] = [],
  requestId = "",
  options: {
    /** 需要检索判例时，展示所有通过相关性筛选的本地案例。 */
    includeAllLocal?: boolean;
    /** 本地覆盖不足时，对 Indian Kanoon 的最低取回目标。 */
    liveResultTarget?: number;
    /** 只读取本地案例库；由调用方决定是否、以及怎样补充外部案例。 */
    localOnly?: boolean;
  } = {},
): Promise<RelatedCase[]> {
  // ⚠**闸门只能装在这一个出口上。**
  //
  // 2026-09-29 实测事故：第一版把 `filterCasesByDomain` 写在了函数末尾那条 return 上，
  // 而这个函数有**三条 return**：
  //
  //     if (gap <= 0 || !isCaseLiveFallbackEnabled()) return local;   ← 没过闸
  //     catch { return local; }                                       ← 没过闸
  //     return filterCasesByDomain(merged, ...);                      ← 只有这条过了
  //
  // 而 `gap <= 0`（本地结果够 3 条）是**最常见**的那条路——119 件的案例库几乎总能凑够，
  // 于是这道闸从上线起就基本没生效过，一件 Service Tax 的判例照样排在所得税答案第一条。
  //
  // 讽刺的是参数注释里当时就写着"装在下游能堵住所有上游，装在某一条路上
  // 迟早会被第二条路绕过去"——然后就装在了三条路里的一条上。
  //
  // 所以现在把检索主体整个收进 `gatherCases`，让它爱怎么提前返回就怎么返回，
  // **过闸这件事由唯一的出口负责**。以后再加第四条返回路径也漏不掉。
  const gathered = await gatherCases(englishQuery, publishedCases, questionCategories, requestId, options);
  const filtered = filterCasesByDomain(gathered, questionCategories);
  if (traceEnabled()) {
    // "案例库明明有相关案却不出"时的定位起点：库大小、查询串实际内容、
    // 法域闸门前后各剩几条。english_query 若是空的或纯中文，这里一眼就能看出来。
    console.info(
      `[trace ${requestId}] case-local: published=${publishedCases.length}`
      + ` query=${JSON.stringify(englishQuery.slice(0, 160))}`
      + ` categories=[${questionCategories.join(",")}]`
      + ` 入闸=${gathered.length} 出闸=${filtered.length}`,
    );
  }
  return filtered;
}

/** 纯检索：本地 + 不够时补实时。**不做任何过滤**，过滤由唯一出口负责。 */
async function gatherCases(
  englishQuery: string,
  publishedCases: StoredCase[],
  questionCategories: string[] = [],
  requestId = "",
  options: { includeAllLocal?: boolean; liveResultTarget?: number; localOnly?: boolean } = {},
): Promise<RelatedCase[]> {
  if (!isCaseSearchEnabled()) {
    if (traceEnabled()) console.info(`[trace ${requestId}] case-local: CASE_SEARCH 未启用，整条跳过`);
    return [];
  }

  let local: RelatedCase[] = [];
  try {
    local = await searchLocalCases(
      englishQuery,
      publishedCases,
      options.includeAllLocal ? ALL_LOCAL_RESULTS : MAX_LOCAL_RESULTS,
    );
  } catch {
    // 本地检索理论上不该抛错（关键词打分是纯函数），但 embedding 调用失败已经在
    // searchLocalCases 内部吞掉了；这里再兜一层，防止未来改动引入新的失败路径。
  }

  // 用“过法域闸门后的本地结果”判断覆盖是否足够。否则三件海关案例会让
  // 所得税问题误以为本地已有三件，最后界面却被闸门清空、一条外部补充也不查。
  const localForCoverage = filterCasesByDomain(local, questionCategories);
  if (options.localOnly) return local;
  const gap = MIN_SUFFICIENT_LOCAL_RESULTS - localForCoverage.length;
  if (gap <= 0 || !isCaseLiveFallbackEnabled()) {
    if (traceEnabled()) {
      console.info(`[trace ${requestId}] case-local: 本地命中=${localForCoverage.length} (够用或实时兜底未启用, gap=${gap})`);
    }
    return local;
  }

  if (traceEnabled()) {
    // 本地不足补实时——english_query 的真实内容和语言闸门结果在这里完全暴露：
    // 查询串是中文时 isSearchableByIndianKanoon=false，实时这路必空。
    console.info(
      `[trace ${requestId}] case-local: 本地命中=${localForCoverage.length} < ${MIN_SUFFICIENT_LOCAL_RESULTS}，补查实时`
      + ` query=${JSON.stringify(englishQuery.slice(0, 160))}`
      + ` 语言放行=${isSearchableByIndianKanoon(englishQuery)}`,
    );
  }

  let live: RelatedCase[] = [];
  try {
    // 普通问答只补到三条；明确查案例时，本地不足才向外部数据库尝试取至少五条。
    const liveTarget = options.includeAllLocal
      ? Math.max(CASE_SEEKING_LIVE_TARGET, options.liveResultTarget ?? 0)
      : Math.max(gap, options.liveResultTarget ?? 0);
    live = await searchLiveCases(englishQuery, liveTarget);
  } catch {
    // 现查失败就用本地那几条，有多少给多少。
    if (traceEnabled()) console.info(`[trace ${requestId}] case-local: 实时兜底抛错，用本地 ${local.length} 条`);
    return local;
  }

  // “完整列出本地案例”时不能再用 3 条总上限截断；外部结果只按本次目标附加。
  const mergedLimit = options.includeAllLocal
    ? local.length + live.length
    : MIN_SUFFICIENT_LOCAL_RESULTS;
  const merged = mergeCaseResults(local, live, mergedLimit);
  if (traceEnabled()) {
    console.info(`[trace ${requestId}] case-local: 实时召回=${live.length} 合并后=${merged.length}`);
  }
  const freshlyFetched = merged.filter((item) => !local.some((existing) => existing.docid === item.docid));
  if (freshlyFetched.length > 0) {
    // 缓存的是**过闸之前**的原始结果：闸门是按"这一道问题"判的，
    // 换一道问题同一件判例可能就该出现了，没道理因为这次不对题就不缓存。
    void cacheLiveCases(freshlyFetched).catch(() => undefined);
  }
  return merged;
}

/**
 * 法域闸门：判例讲的税种和问题问的税种对不上就不出。
 *
 * 真实事故（2026-09-22）：问所得税上诉保证金，列出来的是讲常设机构的、
 * 讲 80-IA 扣除的、还有一件刑事冻结资产的。判定逻辑见 `case-domain.ts`。
 */
function filterCasesByDomain(cases: RelatedCase[], questionCategories: string[]): RelatedCase[] {
  if (questionCategories.length === 0) return cases;
  return cases.filter((item) => isCaseOnTopic({
    caseName: item.caseName,
    taxTypeAndAuthority: item.tax_type_and_authority,
    snippet: item.snippet,
  }, questionCategories));
}
