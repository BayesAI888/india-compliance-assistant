import type { PublishedKnowledgeChunk } from "./knowledge-store";
import { resolveAmbiguousTerms, type TermReading } from "./term-ambiguity";
import { readApprovedGlossary } from "./terms-store";
import { filterLayersByRelevance } from "./layer-relevance";
import { scopeByQuestionDomain } from "./domain-scope";
import { scopeBySupersession } from "./law-supersession";
import { ensureHierarchyCoverage } from "./legal-hierarchy";
import { resolveHierarchy } from "./knowledge-store";
import { EVIDENCE_QUOTA, type JurisdictionCode } from "../contracts";

export interface LegalQueryPackage {
  domain: string;
  english_query: string;
  must_terms: string[];
  optional_terms: string[];
  /**
   * 《AI检索与回答规范 V1.4》§3.2：先列出结论依赖的法律要件，每个要件单独检索。
   * 要件数上限 4——注意这个 4 是**每个法律层**的名额，不是整题的名额。
   */
  legal_elements: string[];
  /**
   * 按法律层分组的要件。跨层问题（如"公司法增发程序"+"FEMA/FDI外汇管制"）
   * 每层各自享有 4 个要件名额和 12 条证据额度，防止其中一层把另一层挤出结果。
   * 留空时按单层处理，行为与之前完全一致。
   *
   * 每个要件带两份文本，缺一不可：
   * - `label`：中文标签，给回答模型、界面分组和"未覆盖要件"提示用
   * - `terms_en`：英文检索词。**关键词打分会把非英文字符全部剥掉**，
   *   只写中文标签的要件在关键词那一路贡献 0 个词，所有要件会退化成同一个排序，
   *   "按要件分别检索"就名存实亡了。这是实测踩过的坑，不要省。
   */
  legal_layers?: Array<{ layer: string; elements: Array<{ label: string; terms_en: string }> }>;
  /**
   * 因为问题原文没有该域专属信号词而被过滤掉的法律层名（目前只针对 GST）。
   * 参见 layer-relevance.ts 的说明。上层用来在风险提示里告诉用户"为什么这部法律没出现"，
   * 而不是悄悄丢掉、让用户以为系统漏检了。
   */
  filtered_layers?: string[];
  /**
   * 用户的原始中文问题。
   * 候选池的法域闸门要用它判断"这个问题属于哪几个法域"——
   * 放进查询包里，二次检索、交叉引用跟进这些下游路径就自动共用同一个判断，
   * 不会再出现某条路绕过闸门的情况。
   */
  question?: string;
  /** 用户问题涉及的法律适用日期，缺失时按当前日期。 */
  time_context?: string;
  /** 州级问题的辖区。 */
  jurisdiction?: JurisdictionCode;
}

export interface RetrievedKnowledgeChunk extends PublishedKnowledgeChunk {
  evidenceId: string;
  score: number;
  /** 命中的法律要件，供引用覆盖校验使用。 */
  element?: string;
}

/** 日期过滤的结果，供上层区分“无证据”和“证据不覆盖该期间”。 */
export interface RetrievalOutcome {
  evidence: RetrievedKnowledgeChunk[];
  /** 因适用期间不匹配而被排除的 chunk 数量。 */
  excludedByPeriod: number;
  /** 缺证据的法律要件。任一要件为空，关键结论不得输出。 */
  uncoveredElements: string[];
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how",
  "in", "is", "it", "of", "on", "or", "that", "the", "to", "what", "when",
  "where", "which", "with", "should", "must", "requirement", "requirements",
  "compliance", "india", "indian", "law",
]);

interface ApprovedGlossaryTerm {
  term_zh: string;
  aliases_zh: string[];
  official_term_en: string;
  search_terms_en: string[];
  domain: string[];
  exclusions: string;
  expert_notes: string;
  source: string;
  status: string;
  /**
   * 多义词的候选义项（2026-09-28 加）。
   * 没有这个字段的条目是一对一词条，行为和以前完全一样——**不要给老词条补空数组**，
   * `term-ambiguity.ts` 是按 `readings.length >= 2` 判断"是不是多义词"的。
   */
  readings?: TermReading[];
}

/**
 * 词典不再是编译期打进包里的静态文件，而是运行时可刷新的内存缓存。
 * 《产品规则表》要求：管理员上传新版《中英文检索词典模板》并同步后，
 * 检索要立刻用上新词典，不需要重新构建或重启。
 * `ensureGlossaryLoaded` 保证冷启动时至少加载过一次；
 * `refreshApprovedGlossaryCache` 由 admin/terms 接口在同步完成后调用。
 */
let cachedGlossary: ApprovedGlossaryTerm[] = [];
let glossaryLoaded = false;

export async function ensureGlossaryLoaded(): Promise<void> {
  if (glossaryLoaded) return;
  await refreshApprovedGlossaryCache();
}

export async function refreshApprovedGlossaryCache(): Promise<void> {
  const terms = await readApprovedGlossary();
  cachedGlossary = (terms as ApprovedGlossaryTerm[]).filter((term) => term.status === "APPROVED");
  glossaryLoaded = true;
}

/**
 * 已审定词典的当前内容。给 `term-ambiguity.ts` 的多义词闸门用。
 *
 * 单独开一个导出而不是让调用方直接读 `cachedGlossary`：那是模块私有状态，
 * 而且冷启动时可能还没加载过。这里统一保证"拿到手就是加载好的"。
 */
export async function loadApprovedGlossaryTerms(): Promise<ApprovedGlossaryTerm[]> {
  await ensureGlossaryLoaded();
  return cachedGlossary;
}

function uniqueTerms(values: string[], limit: number) {
  return [...new Set(values
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 2))]
    .slice(0, limit);
}

function chineseTriggerParts(term: ApprovedGlossaryTerm) {
  const slashParts = term.term_zh
    .split(new RegExp("[/／]"))
    .map((value) => value.trim())
    .filter((value) => value.length >= 3 || /[a-z0-9]/i.test(value));
  return [...new Set([term.term_zh, ...slashParts, ...term.aliases_zh].filter(Boolean))];
}

function matchesTrigger(question: string, trigger: string) {
  const normalizedQuestion = question.toLowerCase();
  const normalizedTrigger = trigger.trim().toLowerCase();
  if (!normalizedTrigger) return false;
  const containsNonAscii = [...normalizedTrigger]
    .some((character) => (character.codePointAt(0) ?? 0) > 0x7f);
  if (containsNonAscii) return normalizedQuestion.includes(normalizedTrigger);
  const escaped = normalizedTrigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(normalizedQuestion);
}

export function expandApprovedGlossary(question: string) {
  const matchedTerms = cachedGlossary.filter((term) => {
    const triggers = [
      ...chineseTriggerParts(term),
      term.official_term_en,
      ...term.search_terms_en,
    ];
    return triggers.some((trigger) => matchesTrigger(question, trigger));
  });
  /*
   * 多义词：**只用消歧成功的那个义项**的检索词和法域，不要把四个义项的词全塞进去。
   *
   * 全塞进去等于同时检索 pre-deposit、security deposit、bank guarantee、customs bond，
   * 候选池被四个不相干主题灌满，正是今天一整轮在修的那个问题。
   * 消歧不了的情况根本走不到这里——`legal-answer.ts` 在调模型之前就转追问了。
   */
  const ambiguity = resolveAmbiguousTerms(question, matchedTerms);
  const resolvedReadings = ambiguity.resolved.map((r) => r.reading);
  const ambiguousTermNames = new Set(
    matchedTerms.filter((t) => (t.readings?.length ?? 0) >= 2).map((t) => t.term_zh),
  );

  const searchTerms = uniqueTerms([
    // 一对一词条照旧贡献自己的检索词；多义词条的顶层 search_terms_en 是空的
    // （见 terms.approved.json 里的注释），所以这里天然不会混进未消歧的词。
    ...matchedTerms.filter((t) => !ambiguousTermNames.has(t.term_zh)).flatMap((t) => t.search_terms_en),
    ...resolvedReadings.flatMap((r) => r.search_terms_en),
  ], 20);

  const domainCounts = [
    ...matchedTerms.filter((t) => !ambiguousTermNames.has(t.term_zh)).flatMap((t) => t.domain),
    ...resolvedReadings.flatMap((r) => r.domain),
  ].reduce<Record<string, number>>((counts, domain) => {
    counts[domain] = (counts[domain] ?? 0) + 1;
    return counts;
  }, {});
  const domain = Object.entries(domainCounts)
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? "unknown";
  return { matchedTerms, searchTerms, domain, ambiguity };
}

/**
 * 从词典里挑出「本次证据里真的出现过」的术语，作为回答阶段的**译名对照表**。
 *
 * 词典一直只用在"中文问题 → 英文检索词"这个方向上，但同一份 zh_term ↔ en_canonical
 * 数据反过来同样有用：约束模型把英文法律术语译成中文时的用词。
 * 线上出现过 "Authorised Dealer"（经RBI授权办理外汇业务的银行）被译成"授权经销商银行"
 * 这种错误——dealer 在外汇语境里是交易商，不是卖货的经销商，两者含义完全不同。
 */
export function glossaryForEvidence(evidenceText: string, limit = 20) {
  const haystack = evidenceText.toLowerCase();
  return cachedGlossary
    // ⚠多义词一律不进译名对照表。
    //
    // 这张表是喂给模型的"专有名词必须按这里的译名翻译"，一个英文词配一个中文译名。
    // 而多义词**根本没有单一译名**——「保证金」对 pre-deposit / security deposit /
    // performance guarantee / customs bond 四个。硬塞一条进去，等于告诉模型
    // 「证据里所有的 deposit 都译成保证金」，这正是多义词闸门要防的那种混淆，
    // 从另一头又放了进来。
    //
    // 它们的消歧走 `term-ambiguity.ts`，结果只影响检索词和前提假设那句说明，
    // 不参与译名。
    .filter((term) => (term.readings?.length ?? 0) < 2)
    .filter((term) => {
      const candidates = [term.official_term_en, ...term.search_terms_en]
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length >= 4);
      return candidates.some((value) => haystack.includes(value));
    })
    .map((term) => ({ en: term.official_term_en, zh: term.term_zh }))
    .filter((pair) => pair.en && pair.zh)
    .slice(0, limit);
}

function cleanTerms(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 2))]
    .slice(0, 16);
}

function cleanElements(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length >= 2))]
    .slice(0, EVIDENCE_QUOTA.maxElements);
}

/**
 * 清洗模型给的分层要件。
 * 要件既接受 {label, terms_en} 对象，也接受裸字符串（此时英文检索词退回用标签本身，
 * 中文标签的情况下等于没有关键词信号，只能靠向量那一路——所以提示词里要求必须给 terms_en）。
 */
function cleanLayerElements(values: unknown): Array<{ label: string; terms_en: string }> {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: Array<{ label: string; terms_en: string }> = [];
  for (const value of values) {
    let label = "";
    let termsEn = "";
    if (typeof value === "string") {
      label = value.trim();
      termsEn = label;
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      label = typeof record.label === "string" ? record.label.trim() : "";
      termsEn = typeof record.terms_en === "string" ? record.terms_en.trim() : "";
    }
    if (!label && termsEn) label = termsEn;
    if (!termsEn) termsEn = label;
    if (label.length < 2 || seen.has(label)) continue;
    seen.add(label);
    result.push({ label, terms_en: termsEn });
    // 上限用 maxElementsHardCap 而不是 maxElements：义务本来就多的问题
    // （例如向外资发行新股，公司法上至少七条），固定 4 个名额数学上就注定漏。
    if (result.length >= EVIDENCE_QUOTA.maxElementsHardCap) break;
  }
  return result;
}

/** 清洗模型给的分层要件；层名为空或要件为空的层直接丢掉。 */
function cleanLayers(values: unknown): Array<{ layer: string; elements: Array<{ label: string; terms_en: string }> }> {
  if (!Array.isArray(values)) return [];
  return values
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const layer = typeof record.layer === "string" ? record.layer.trim() : "";
      const elements = cleanLayerElements(record.elements);
      if (!elements.length) return [];
      return [{ layer: layer || "未标注法律层", elements }];
    })
    .slice(0, EVIDENCE_QUOTA.maxLayers);
}

export function normalizeQueryPackage(
  question: string,
  raw?: Partial<LegalQueryPackage>,
  context?: { time_context?: string; jurisdiction?: JurisdictionCode },
): LegalQueryPackage {
  const glossary = expandApprovedGlossary(question);
  const englishQuery = typeof raw?.english_query === "string"
    ? raw.english_query.trim()
    : "";
  const cleanedLayers = cleanLayers(raw?.legal_layers);
  // 少数容易被通用词（PAN、登记）带偏的法域，问题原文没提到专属信号词时整层丢弃。
  // 参见 layer-relevance.ts。
  const { layers, dropped } = filterLayersByRelevance(question, cleanedLayers);
  // 分层存在时，legal_elements 取各层要件的合并结果，保证下游（向量检索、
  // 提示词里的"法律要件"一行）看到的是完整清单，而不只是第一层。
  const elements = layers.length
    ? [...new Set(layers.flatMap((entry) => entry.elements.map((item) => item.label)))]
    : cleanElements(raw?.legal_elements);
  return {
    domain: typeof raw?.domain === "string" && raw.domain.trim()
      ? raw.domain.trim()
      : glossary.domain,
    english_query: englishQuery || glossary.searchTerms.join(" ") || question,
    must_terms: cleanTerms(raw?.must_terms),
    optional_terms: uniqueTerms([
      ...cleanTerms(raw?.optional_terms),
      ...glossary.searchTerms,
    ], 20),
    question,
    // 未能拆出要件时退回单要件，避免配额逻辑失效。
    legal_elements: elements.length ? elements : ["主结论"],
    ...(layers.length ? { legal_layers: layers } : {}),
    ...(dropped.length ? { filtered_layers: dropped } : {}),
    time_context: context?.time_context ?? raw?.time_context,
    jurisdiction: context?.jurisdiction ?? raw?.jurisdiction,
  };
}

/**
 * 判断 chunk 的适用期间是否覆盖目标日期。chunk 上的生效日/失效日留空视为不设限（＝现行有效）。
 *
 * 用户没指定日期时按**当天**判断，而不是全部放行（2026-09-16 改）。
 * 原来写的是 `if (!targetDate) return true`，本意是"没说日期就不设限"，
 * 但真实效果是：一问"现在要交多少税"这类不带日期的问题——也就是绝大多数问题——
 * 这道期间校验就整个关掉了，已经废止的法（1961年所得税法）照样能被引用。
 * 按当天判断之后，没标失效日的资料（绝大多数）行为完全不变，只有确实已经废止的
 * 那部分会在"问现在"的时候被挡掉，这正是这道校验存在的意义。
 *
 * 代价（已知并接受）：问历史年度但没写明税期的问题，会因为查不到覆盖当天的条文而
 * 走到 PERIOD_NOT_COVERED，提示用户补充准确税期，而不是直接拿旧法作答。
 * 对合规工具来说，追问一句比拿错年代的法条作答安全。
 */
export function coversDate(chunk: PublishedKnowledgeChunk, targetDate?: string) {
  const effectiveTarget = targetDate ?? new Date().toISOString().slice(0, 10);
  const from = chunk.provisionEffectiveFrom;
  const to = chunk.provisionEffectiveTo;
  if (from && effectiveTarget < from) return false;
  if (to && effectiveTarget > to) return false;
  // 州级 chunk：适用起点取中央生效日与该辖区采纳日的较晚者。
  const centre = chunk.centreEffectiveFrom;
  if (centre && effectiveTarget < centre) return false;
  return true;
}

/** 判断 chunk 的辖区是否可用于该问题。 */
export function matchesJurisdiction(
  chunk: PublishedKnowledgeChunk,
  jurisdiction?: JurisdictionCode,
) {
  const chunkJurisdiction = chunk.jurisdiction ?? "CENTRE";
  if (chunkJurisdiction === "CENTRE") return true;
  if (!jurisdiction) return false;
  return chunkJurisdiction === jurisdiction;
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\-\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function occurrences(haystack: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) >= 0) {
    count += 1;
    position += needle.length;
    if (count >= 8) break;
  }
  return count;
}

function scoreChunks(
  chunks: PublishedKnowledgeChunk[],
  phraseSource: string[],
  mustTerms: string[],
) {
  const phrases = [...new Set(phraseSource.filter((value) => value.length >= 2))];
  const tokens = [...new Set(phrases.flatMap(tokenize))];

  return chunks
    .map((chunk) => {
      const title = `${chunk.source} ${chunk.majorTitle} ${chunk.minorTitle}`.toLowerCase();
      const body = chunk.body.toLowerCase();
      let score = 0;

      for (const phrase of phrases) {
        if (phrase.includes(" ")) {
          score += occurrences(title, phrase) * 12;
          score += occurrences(body, phrase) * 6;
        }
      }
      for (const token of tokens) {
        score += occurrences(title, token) * 5;
        score += Math.min(occurrences(body, token), 5);
      }
      for (const mustTerm of mustTerms) {
        if (title.includes(mustTerm) || body.includes(mustTerm)) score += 8;
      }

      return { chunk, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score || left.chunk.number - right.chunk.number);
}

/**
 * 同一 Section 拆成多个 Part 时按顺序合并，只占 1 个配额。
 * 《AI检索与回答规范 V1.4》§3.2。
 */
function sectionKey(chunk: PublishedKnowledgeChunk) {
  const minor = chunk.minorTitle.replace(/\(?\s*Part\s*\d+\s*\/\s*\d+\s*\)?/i, "").trim();
  return `${chunk.source}::${chunk.majorTitle}::${minor}`.toLowerCase();
}

/** 稀疏（关键词）和稠密（向量）两路各自的排名，用 RRF 融合。 */
export const RRF_K = 60;

export function chunkVectorKey(chunk: PublishedKnowledgeChunk) {
  return `${chunk.documentId}::${chunk.number}`;
}

/**
 * 倒数排名融合（Reciprocal Rank Fusion）。
 *
 * 为什么不直接把两边分数相加：关键词分是 12/6/5 这种没有上界的整数，
 * 余弦相似度是 0~1 的小数，量纲完全不同，相加等于让关键词分独裁。
 * RRF 只用"排第几"，不用分数本身，因此不需要调权重，也不怕量纲差异。
 * 公式：score = Σ 1 / (k + rank)，k 取业界惯例 60。
 */
export function fuseByRRF<T>(
  rankings: Array<Array<{ item: T; }>>,
  keyOf: (item: T) => string,
  k = RRF_K,
): Array<{ item: T; rrf: number }> {
  const scores = new Map<string, { item: T; rrf: number }>();
  for (const ranking of rankings) {
    ranking.forEach((entry, index) => {
      const key = keyOf(entry.item);
      const existing = scores.get(key);
      const contribution = 1 / (k + index + 1);
      if (existing) {
        existing.rrf += contribution;
      } else {
        scores.set(key, { item: entry.item, rrf: contribution });
      }
    });
  }
  return [...scores.values()].sort((left, right) => right.rrf - left.rrf);
}

/**
 * 按法律要件配额选取证据。
 * 先按要件分配（每要件 1–3 条），再受总上限 12 约束；不足不补位。
 *
 * `denseScoresByElement` 存在时走混合检索：关键词排一路、向量排一路，RRF 融合后再进配额。
 * 缺省（没配置向量服务、向量还没算、或调用失败）时自动退回纯关键词，行为与改动前完全一致。
 */
/**
 * 适用期间 + 辖区两道闸的候选池。
 * 交叉引用跟进、二次检索都要用同一套过滤口径——补进来的条文一样不能越过这两道闸，
 * 否则会从"补全"变成"引入不适用的条文"。
 */
export function scopeCandidates(
  chunks: PublishedKnowledgeChunk[],
  query: Pick<LegalQueryPackage, "jurisdiction" | "time_context" | "question">,
) {
  // 法域闸门放在最前面：问 ROC 年度合规时，GST 的条文根本不该进入候选池。
  // "annual return" 在公司法和 CGST 里是同一个英文词，靠打分区分不开，只能在这里拦。
  //
  // 把术语词典展开出来的英文词一起交给闸门（2026-09-17加）：管理员在词典里
  // 维护的同义说法，这道闸门此前完全不知道——问"转移定价"时因为词表里只写了
  // "转让定价"，整个所得税法域被误剔。现在词典加一个说法，闸门立刻就认得。
  const question = query.question ?? "";
  const { chunks: domainScoped, excluded: excludedDomains } =
    scopeByQuestionDomain(question, chunks, expandApprovedGlossary(question).searchTerms);
  // 新法取代旧法（2026-09-17加）：同一法域里两部新旧法并存时，按目标日期只留该用的那部。
  // 这道闸装在期间校验**之前**，因为它不依赖 chunk 上的生效日字段——已上传的
  // 两部所得税法都没填那两个字段，只靠 coversDate 一道闸，废止的 1961 法照样会被引用。
  const { chunks: supersessionScoped, excluded: excludedBySupersession } =
    scopeBySupersession(domainScoped, query.time_context);
  const jurisdictionScoped = supersessionScoped.filter((chunk) =>
    matchesJurisdiction(chunk, query.jurisdiction));
  const dateScoped = jurisdictionScoped.filter((chunk) =>
    coversDate(chunk, query.time_context));
  return {
    dateScoped,
    excludedByPeriod: jurisdictionScoped.length - dateScoped.length,
    excludedDomains,
    excludedBySupersession,
  };
}

export function retrieveKnowledge(
  chunks: PublishedKnowledgeChunk[],
  query: LegalQueryPackage,
  denseScoresByElement?: Map<string, Map<string, number>>,
): RetrievalOutcome {
  const { dateScoped, excludedByPeriod } = scopeCandidates(chunks, query);

  // 按法律层分配配额：每层各有自己的要件名额和证据额度，互不挤占。
  // 没给分层时按单层处理，跟改动前完全等价。
  const layers = (query.legal_layers?.length
    ? query.legal_layers
    : [{
        layer: "",
        // 没分层时，要件是裸字符串：标签和检索词是同一个（中文标签就没有关键词信号，
        // 只能靠向量那一路补，这正是提示词里强制要求 terms_en 的原因）。
        elements: query.legal_elements.map((label) => ({ label, terms_en: label })),
      }]
  ).slice(0, EVIDENCE_QUOTA.maxLayers);

  const picked: Array<{ chunk: PublishedKnowledgeChunk; element: string; score: number }> = [];

  /** 落选但可能用于位阶补位的候选。见 ensureHierarchyCoverage。 */

  const spare: typeof picked = [];
  // 跨层去重：同一 Section 不会因为出现在两层里就被引用两次。
  const usedSections = new Set<string>();
  const uncoveredElements: string[] = [];

  for (const { elements: layerElements } of layers) {
    const elements = layerElements.slice(0, EVIDENCE_QUOTA.maxElementsHardCap);
    const layerStartCount = picked.length;

    for (const { label: element, terms_en: termsEn } of elements) {
      // 关键词打分必须用英文检索词：中文标签经过 tokenize 后是空的，
      // 那样每个要件都会算出同一个排序，按要件分别检索就失效了。
      const sparseRanked = scoreChunks(
        dateScoped,
        [termsEn.toLowerCase(), query.english_query.toLowerCase(), ...query.must_terms],
        query.must_terms,
      );

      const denseScores = denseScoresByElement?.get(element);
      let ranked: Array<{ chunk: PublishedKnowledgeChunk; score: number }>;
      if (denseScores && denseScores.size > 0) {
        const denseRanked = dateScoped
          .map((chunk) => ({ chunk, score: denseScores.get(chunkVectorKey(chunk)) ?? 0 }))
          .filter((entry) => entry.score > 0)
          .sort((left, right) => right.score - left.score);
        const fused = fuseByRRF<{ chunk: PublishedKnowledgeChunk; score: number }>(
          [
            sparseRanked.map((entry) => ({ item: entry })),
            denseRanked.map((entry) => ({ item: entry })),
          ],
          (entry) => chunkVectorKey(entry.chunk),
        );
        // 融合后的名次决定取谁；score 仍沿用关键词分，只为保持下游排序和日志口径不变。
        ranked = fused.map((entry) => entry.item);
      } else {
        ranked = sparseRanked;
      }

      let takenForElement = 0;
      for (const entry of ranked) {
        if (takenForElement >= EVIDENCE_QUOTA.maxPerElement) break;
        // 本层额度（12 条）和全局硬上限（24 条）各自独立生效。
        if (picked.length - layerStartCount >= EVIDENCE_QUOTA.maxTotal) break;
        if (picked.length >= EVIDENCE_QUOTA.maxTotalAllLayers) break;
        const key = sectionKey(entry.chunk);
        if (usedSections.has(key)) continue;
        usedSections.add(key);
        picked.push({ chunk: entry.chunk, element, score: entry.score });
        takenForElement += 1;
      }
      // 落选的留一份，供后面的位阶补位用（只留前几条，避免堆积无关证据）。
      for (const entry of ranked.slice(0, EVIDENCE_QUOTA.maxPerElement * 3)) {
        if (usedSections.has(sectionKey(entry.chunk))) continue;
        spare.push({ chunk: entry.chunk, element, score: entry.score });
      }

      if (takenForElement < EVIDENCE_QUOTA.minPerElement) {
        uncoveredElements.push(element);
      }
    }
    }

  /**
   * 位阶覆盖：**保证每个位阶至少检索到一条**（只要候选里确实有）。
   *
   * 用户要的是"先搜 Act、再 Rules/Notification、最后 Circular"，但严格按位阶排序
   * 会答非所问——具体数值几乎都在下位法里（税率在 notification、表格和期限在 rules），
   * 先给 Act 的框架条款没用。所以做的是**覆盖保证**，不是排序。
   *
   * 挤占真正发生在上面那个"每个要件各取前 3 条"的循环里：某个要件的 3 个名额
   * 可能全被 circular 占掉，而一条 Act 条文排在第 4。知识库里 notification 越堆越多
   * （正在手工维护这一类），这种情况只会更常见，而且**不会有任何报错**。
   *
   * 只在某一层一条都没有时才动，且不会挤掉"某位阶的最后一条"或"某要件的最后一条"——
   * 详见 `ensureHierarchyCoverage`。
   */
  const coverage = ensureHierarchyCoverage(
    picked.map((entry) => ({
      item: entry,
      score: entry.score,
      level: resolveHierarchy(entry.chunk),
      element: entry.element,
    })),
    spare.map((entry) => ({
      item: entry,
      score: entry.score,
      level: resolveHierarchy(entry.chunk),
      element: entry.element,
    })),
  );

  const evidence = coverage.picked
    .map((entry) => entry.item)
    .sort((left, right) => right.score - left.score)
    .map((entry, index) => ({
      ...entry.chunk,
      evidenceId: `E${index + 1}`,
      score: entry.score,
      element: entry.element,
    }));

  return { evidence, excludedByPeriod, uncoveredElements };
}
