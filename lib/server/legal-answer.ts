import {
  EVIDENCE_QUOTA,
  MAX_CLARIFICATION_ITEMS,
  type AnswerResponse,
  type Citation,
  type JurisdictionCode,
  type RelatedCase,
} from "../contracts";
import { requestStructuredJson } from "./deepseek";
import { routeCaseRequest } from "./case-route";
import { checkNotificationUpdates } from "./notification-index";
import { findUnanchoredSteps, HIERARCHY_LABEL } from "./legal-hierarchy";
import { resolveHierarchy } from "./knowledge-store";
import { resolveAnswerLanguage, t, type AnswerLanguage } from "./answer-language";
import { computeDenseScores } from "./dense-retrieval";
import { findUnverifiedClaims } from "./claim-check";
import { repairUnverifiedClaims } from "./claim-repair";
import { expandAnswerAbbreviations } from "./abbreviations";
import { coverageNotes, findCoverageGaps, promoteUncoveredPractical } from "./coverage-check";
import { groundPracticalSteps } from "./practical-grounding";
import { followCrossReferences } from "./cross-reference";
import { checkQuotes, quoteNotes } from "./quote-check";
import { repairQuoteCitations } from "./quote-repair";
import { filterIrrelevantSteps } from "./relevance-check";
import { isCaseSeekingQuestion, shouldSearchCases } from "./case-relevance";
import {
  CASE_SEEKING_LIVE_TARGET,
  MIN_SUFFICIENT_LOCAL_RESULTS,
  mergeCaseResults,
  retrieveRelatedCases,
} from "./case-search";
import { buildCaseDigest, isCaseDigestIrrelevant } from "./case-digest";
import { getPublishedCases } from "./case-store";
import { findEvidenceGaps, isSecondPassEnabled, retrieveForGaps } from "./second-pass";
import {
  adjustForSelfDoubt,
  liftSufficiencyWhenCasesFound,
  parseEvidenceSufficiency,
  EVIDENCE_SUFFICIENCY_PROMPT_RULE,
  SELF_DOUBT_RISK_NOTE,
} from "./answer-self-doubt";
import { coverageGapNotes, findKnowledgeCoverageGaps } from "./coverage-gap";
import { reconcileCaseClaims, rewriteCaseEvidenceCaveats, stripCitationPrefixes, stripStepNumberPrefixes } from "./step-text";
import { deadlineAnchorNotes, findUnanchoredDeadlines } from "./deadline-anchor";
import { actionTimingNotes, findMissingActionTiming } from "./action-timing";
import type { PublishedKnowledgeChunk } from "./knowledge-store";
import { verifyKeyFigures, KEY_FIGURES_PROMPT_RULE } from "./key-figures";
import { detectQuestionCategories } from "./domain-scope";
import { pruneCrossDomainRefs } from "./citation-domain";
import {
  detectSupersededUse, SUPERSESSION_PROMPT_RULE,
} from "./intra-document-supersession";
import { classifyDocumentCategory } from "./document-category";
import { resolveConversationQuestionType, type QuestionType } from "./question-type";
import { loadDisputeTrack } from "./dispute-track";
import { collectCitationKeys, resolveDisputeCitations } from "./dispute-citations";
import { getPublishedKnowledgeChunks } from "./knowledge-store";
import {
  resolveAmbiguousTerms, ambiguityQuestion, readingNote, type AmbiguityResult,
} from "./term-ambiguity";
import { loadApprovedGlossaryTerms } from "./retrieval";
import {
  coversDate,
  ensureGlossaryLoaded,
  glossaryForEvidence,
  normalizeQueryPackage,
  retrieveKnowledge,
  scopeCandidates,
  type LegalQueryPackage,
  type RetrievedKnowledgeChunk,
} from "./retrieval";

const POLICY_VERSION = "1.4" as const;

/**
 * 法规要求和实务建议各自的条数上限。
 *
 * 定位是**防失控的保险丝，不是编辑意义上的删减**——正常回答不该碰到这两个数。
 * 真正限制长度的是模型的输出预算（下面的 maxTokens）：超了会让返回的JSON从中间断掉、
 * 解析失败，结果是整个回答都没有，比少几条严重得多。
 * 另外证据配额最多 24 条，模型也不可能凭空生成几十条有依据的要求。
 *
 * 分开计是因为踩过坑：原来是合并 slice(0,8)，法规要求变多后把名额占满，
 * 实务建议被整个切掉，界面上那一栏直接消失。
 */
const MAX_MANDATORY_STEPS = 20;
const MAX_PRACTICAL_STEPS = 12;

interface RawAnswer {
  answer_status?: string;
  short_conclusion?: string;
  assumptions?: unknown;
  action_steps?: unknown;
  risks_and_exceptions?: unknown;
  citation_ids?: unknown;
  missing_information?: unknown;
  practical_is_sequential?: unknown;
  key_figures?: unknown;
  evidence_sufficiency?: unknown;
  evidence_gap?: unknown;
}

function stringList(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * 解析模型返回的步骤。
 * `refIndexByEvidenceId` 把模型写的证据编号（E1/E2…）换算成最终引用列表里的序号，
 * 这样展示层可以按「依据哪部法律」把法规要求分组。
 * 模型漏标、或标注的证据已被适用期间校验剔除时，refs 为空数组——
 * 该条内容照常保留，由展示层归到「未标注具体依据」，绝不能因此丢掉一条法定要求。
 */
export function actionSteps(
  value: unknown,
  refIndexByEvidenceId: Map<string, number>,
): AnswerResponse["action_steps"] {
  if (!Array.isArray(value)) return [];
  const parsed = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) return [];
    const rawRefs = Array.isArray(record.citation_ids) ? record.citation_ids : [];
    const citationRefs = [...new Set(
      rawRefs
        .filter((id): id is string => typeof id === "string")
        .map((id) => refIndexByEvidenceId.get(id.trim()))
        .filter((index): index is number => typeof index === "number"),
    )].sort((a, b) => a - b);
    const sourceQuote = typeof record.source_quote === "string"
      ? record.source_quote.trim()
      : undefined;
    return [{
      kind: record.kind === "MANDATORY" ? "MANDATORY" as const : "PRACTICAL" as const,
      text,
      citation_refs: citationRefs,
      unverified_claims: [] as string[],
      ...(sourceQuote ? { source_quote: sourceQuote } : {}),
    }];
  });

  // 按类型分别截断，不能用一个总数上限。
  // 踩过的坑：原来是整体 slice(0,8)，分层之后法规要求变多，MANDATORY 把名额占满，
  // PRACTICAL 被整个切掉——界面上"实务建议"那一栏直接消失了。
  const mandatory = parsed.filter((step) => step.kind === "MANDATORY").slice(0, MAX_MANDATORY_STEPS);
  const practical = parsed.filter((step) => step.kind === "PRACTICAL").slice(0, MAX_PRACTICAL_STEPS);
  return [...mandatory, ...practical];
}

/**
 * legal_as_of = 本次全部被引用版本中最早的 legal_currency_checked_at。
 * 含义是“截至该日已确认这些法律仍为现行有效”，不是失效日，也不是知识库更新时间。
 * 《AI检索与回答规范 V1.4》§7 法律现行性。
 */
function computeLegalAsOf(chunks: RetrievedKnowledgeChunk[]): string | undefined {
  const dates = chunks
    .map((chunk) => chunk.legalCurrencyCheckedAt)
    .filter((value): value is string => Boolean(value));
  if (!dates.length) return undefined;
  return dates.sort()[0];
}

function toCitation(chunk: RetrievedKnowledgeChunk): Citation {
  return {
    display_title: chunk.source,
    authority: chunk.source,
    locator: [chunk.majorTitle, chunk.minorTitle].filter(Boolean).join(" · "),
    official_url: chunk.officialUrl,
    // snippet_display=DENY 的来源只展示定位和链接，不下发原文。
    snippet: chunk.snippetDisplay === "DENY" ? undefined : chunk.body.slice(0, 1_200),
    effective_from: chunk.provisionEffectiveFrom,
    effective_to: chunk.provisionEffectiveTo,
    applicability_note: chunk.applicabilityNote,
    jurisdiction: chunk.jurisdiction,
  };
}

export async function buildLegalQuery(
  question: string,
  context?: { time_context?: string; jurisdiction?: JurisdictionCode },
) {
  // 词典是运行时缓存，冷启动后第一次调用要保证已经加载过，
  // 之后这个调用几乎是零开销（内部已加载就直接返回）。
  await ensureGlossaryLoaded();
  const fallback = normalizeQueryPackage(question, undefined, context);
  if (fallback.optional_terms.length >= 2 && fallback.legal_elements.length > 1) {
    return fallback;
  }

  try {
    const { data } = await requestStructuredJson<Partial<LegalQueryPackage>>({
      role: "query",
      maxTokens: 800,
      messages: [
        {
          role: "system",
          content: `你是印度法律资料检索助手。把用户的中文问题改写为用于搜索英文法律原文的查询。
只输出JSON，格式为：
{"domain":"gst","english_query":"tax invoice movement of goods conveyance e-way bill","must_terms":["invoice","goods"],"optional_terms":["movement","conveyance","e-way bill"],"legal_layers":[{"layer":"GST","elements":[{"label":"单据要求","terms_en":"tax invoice particulars issue of invoice"},{"label":"e-way bill触发条件","terms_en":"e-way bill consignment value movement of goods"}]}]}
要求：
1. domain只能是company_incorporation、mca_roc、fema_fdi_rbi、gst、income_tax_tds_tp、import_export_customs、industry_regulation、litigation_cases、tax_notice或unknown。
2. 保留Act、Rule、Section、Form、Notification编号。
3. legal_layers 按**法律层**分组列出结论依赖的法律要件。每层最多${EVIDENCE_QUOTA.maxElements}个要件，
   最多${EVIDENCE_QUOTA.maxLayers}层。每个要件会单独检索，每层有自己独立的证据额度。
4. **一个问题往往同时落在多个法律层，必须分别列出，不要只写最贴近的那一层。**
   常见的层：公司法/MCA-ROC程序、FEMA/FDI外汇管制、GST、所得税/TDS/转让定价、进出口/海关、行业准入。
   例如"中资股东向印度公司增资前要核对什么"至少要拆成两层：
   [{"layer":"公司法/MCA-ROC","elements":[
      {"label":"增发新股的股东决议要求","terms_en":"further issue of share capital special resolution rights issue"},
      {"label":"股本变更向ROC的申报义务","terms_en":"notice to registrar alteration of share capital return of allotment"}]},
    {"layer":"FEMA/FDI","elements":[
      {"label":"FDI准入路径与行业上限","terms_en":"automatic route government approval sectoral cap foreign investment"},
      {"label":"向非居民发行股份的定价规则","terms_en":"pricing guidelines issue of equity instruments person resident outside india valuation"}]}]
   只写了FDI那一层、漏掉公司法程序，会让用户漏掉ROC申报，属于严重遗漏。
   ⚠️反过来同样重要：**不要仅因为某个法域可能顺带提到PAN、登记这类几乎任何公司事项
   都会用到的通用要求，就把这个法域拉入分层。** 判断标准是问题实际询问的义务类型，
   不是"沾边就算"。例如"中资股东向印度公司增资需要准备什么文件"不涉及日常经营纳税、
   开票或进项税抵扣，不应该拉入GST层——即使GST法条里恰好提到"注册须持有PAN"，
   那是任何公司都要满足的通用前提，不是这个问题特有的义务。
5. **每个要件必须同时给 label（中文标签）和 terms_en（英文检索词），terms_en 不能为空、不能写中文。**
   法律原文是英文，关键词检索会把中文字符全部剥掉——只给中文标签的要件，
   在关键词检索里贡献为零，等于这个要件白拆了。
   terms_en 要写成法条里真实会出现的英文措辞（例如写 "further issue of share capital"
   而不是 "capital increase"），并保留 Section / Rule / Form 编号。
6. 加入印度法律中常用的同义词，不生成法律结论。`,
        },
        { role: "user", content: question },
      ],
    });
    return normalizeQueryPackage(question, data, context);
  } catch {
    return fallback;
  }
}

function evidenceText(chunks: RetrievedKnowledgeChunk[]) {
  return chunks.map((chunk) => `[证据${chunk.evidenceId}]
对应法律要件：${chunk.element ?? "未标注"}
来源：${chunk.source}
章节：${chunk.majorTitle}
定位：${chunk.minorTitle}
辖区：${chunk.jurisdiction ?? "CENTRE"}
适用期间：${chunk.provisionEffectiveFrom ?? "未标注"} 至 ${chunk.provisionEffectiveTo ?? "仍有效"}${
    chunk.applicabilityNote ? `（${chunk.applicabilityNote}）` : ""
  }
官方链接：${chunk.officialUrl}
英文原文：
${chunk.body.slice(0, 8_000)}`).join("\n\n-----\n\n");
}

/**
 * 给每条要求挂上「用了已被取代的值」的标记。
 *
 * 比对的对象是**最终的**步骤正文和**最终的**证据原文：
 * 前面几道后处理会动正文，证据也可能在补充核验时追加，
 * 早一步比对都可能比到一份不是用户最终看到的东西。
 */
function withSupersededValues(
  steps: AnswerResponse["action_steps"],
  evidence: RetrievedKnowledgeChunk[],
): AnswerResponse["action_steps"] {
  return steps.map((step) => {
    const citedTexts = step.citation_refs
      .map((ref) => evidence[ref - 1]?.body)
      .filter((body): body is string => Boolean(body));
    if (citedTexts.length === 0) return step;
    const superseded = detectSupersededUse({ text: step.text, citedTexts });
    return superseded.length > 0 ? { ...step, superseded_values: superseded } : step;
  });
}

function unableToConfirm(options: {
  requestId: string;
  conversationId: string;
  conclusion: string;
  failureCode: AnswerResponse["failure_code"];
  legalAsOf?: string;
}): AnswerResponse {
  return {
    request_id: options.requestId,
    conversation_id: options.conversationId,
    answer_status: "UNABLE_TO_CONFIRM",
    failure_code: options.failureCode,
    short_conclusion: options.conclusion,
    key_figures: [],
    assumptions: [],
    action_steps: [],
    risks_and_exceptions: [],
    citations: [],
    missing_information: [],
    charge_eligible: false,
    legal_as_of: options.legalAsOf,
    policy_version: POLICY_VERSION,
  };
}

/**
 * 追问时携带的上一轮上下文。只在 route.ts 判定这一轮是"延续上一问题"（而不是新话题）
 * 时才会传入——legal-answer.ts本身不判断话题相关性，那是question-context.ts的职责，
 * 这里只管"有就用、没有就当首问处理"。
 */
export interface PriorTurnContext {
  selfContainedQuestion: string;
  shortConclusion: string;
  mandatoryFirstSentences: string[];
  citedLaws: string[];
  /**
   * 上一轮展示过的案例（案例名+docid）。加这个字段是为了让主回答生成模型
   * 也知道"上一轮展示过这个案例"——大多数追问细节的请求会被 route.ts 的
   * 现查现答专门流程接住、不会走到这里；这里只是让主流程在没有被专门流程
   * 接住时（比如追问触发词没覆盖到、或现查现答本身失败降级）也不会完全
   * 不知道上文提过案例，能照实说"上一轮提到的判例，具体细节建议点开原文链接"，
   * 而不是当成从没出现过。
   */
  relatedCases?: Array<{ caseName: string; docid: string }>;
  /** 这一轮对话已经确定的回答语言。追问时不能中途换语言，见 answer-language.ts。 */
  answerLanguage?: AnswerLanguage;
}

interface AnswerOptions {
  requestId: string;
  conversationId: string;
  question: string;
  publishedChunks: PublishedKnowledgeChunk[];
  targetDate?: string;
  jurisdiction?: JurisdictionCode;
  priorTurnContext?: PriorTurnContext;
  /**
   * 用户上传的Notice原文节选（OCR/解析出来的，每份文件一段，已截断）。
   *
   * 真实事故（2026-09-15）：原来只把提取出的七个字段拼进问题文本，原文本身
   * 从来没送进来过。用户问"这份notice里税局主要质疑什么"，模型手上只有
   * "某机关+文号+日期"，只能写出一套泛泛的通用流程，跟文件内容对不上。
   *
   * ⚠这是**用户提供的材料，不是已核验的法律依据**：只能用来理解案情、回答
   * 跟这份文件内容有关的问题，绝不能当成 citation 的来源（citation_ids 仍然
   * 只能来自下面的"已发布证据"）。提示词里对这一点有明确约束。
   */
  noticeExcerpts?: string[];
  /**
   * 本次对话**已经画过**的争议流程图（track id）。
   *
   * 由 route.ts 扫描整段对话的历史轮次得出，不是只看上一轮——
   * 只看上一轮会出现"第 2 轮被略过 → 第 3 轮以为没画过 → 又画一遍"的跳变。
   *
   * 为什么放在调用方算：这个模块拿不到对话，也不该拿。
   * 它的职责是"这一问该怎么答"，"这段对话已经说过什么"是 route.ts 的事，
   * 和 priorTurnContext 同一个分工。
   */
  shownDisputeTrackIds?: string[];
}

/**
 * 阶段三：判例检索接在主答案生成链路外面，而不是塞进 `answerFromPublishedKnowledgeInner`
 * 内部——那个函数里有4处 `unableToConfirm(...)` 提前返回，案例检索理应对所有分支都生效
 * （哪怕法规证据不足要提前返回，判例本身可能仍然是有用的补充信息），把合并动作放在最外层
 * 一次性做，不用在每个提前返回的分支里都补一遍，也不会漏改。
 *
 * `query`（含 `english_query`）只在这一层调用 `buildLegalQuery` 算一次，往下传给
 * inner 函数复用，不会为了拿判例检索用的英文查询词而多打一次模型调用。
 * 案例检索和主答案生成链路是并发跑的（先创建 Promise、不立即 await），
 * 不会因为案例检索变慢而拖慢主答案。
 */
/**
 * 这**一整段对话**在谈哪个法域，不是这一句里有哪些词。
 *
 * ## 起因（2026-09-28 实测）
 *
 * 用户问「印度 income tax（ITD）案件中，保证金计算的基数包括哪些？」→ 多义词闸门追问
 * → 用户答「**pre-deposit**」。这一轮的 `options.question` 就只有这两个词，
 * `detectQuestionCategories("pre-deposit")` 返回 `[]`，于是**判例的法域闸门整个失效**，
 * 一件 Service Tax 的 Infosys 判例（讲 extended period 和 suppression of facts 的）
 * 大摇大摆进了所得税问题的答案，排在第一条。
 *
 * 分类本身没错（那件判例确实被判成 gst），闸门逻辑也没错，**是闸门的输入没了**。
 *
 * ## 三层，按可靠性排
 *
 *   ① 当前问题自己判得出来 → 用它。
 *      **用户换话题时必须跟着换**，所以当前问题永远优先，不能被上文盖住。
 *   ② 判不出来 → 用上一轮的**自足问题**（`selfContainedQuestion` 是把
 *      "那这个呢"补全成完整问题之后的版本，通常带着法域词）。
 *   ③ 还判不出来 → 从上一轮**引用过的法律名**反推。
 *      这一层最硬：上一轮引的是 Income-tax Act，这个对话就是所得税的，
 *      不依赖任何措辞。
 *
 * 全都判不出来才返回 `[]`，含义是"不知道"，下游一律理解为**不要据此过滤**。
 *
 * ## 为什么不做"一旦定了就锁住整段对话"
 *
 * 和 `answer-language.ts` 的粘性语言不同：语言中途换是纯粹的缺陷，
 * 而话题中途换是**正常的**（"那 GST 那边呢"）。锁住会把用户困在第一个话题里。
 */
function resolveConversationCategories(options: AnswerOptions): string[] {
  const current = detectQuestionCategories(options.question);
  if (current.length > 0) return current;

  const prior = options.priorTurnContext;
  if (!prior) return [];

  const fromPriorQuestion = detectQuestionCategories(prior.selfContainedQuestion ?? "");
  if (fromPriorQuestion.length > 0) return fromPriorQuestion;

  // 从上一轮引用过的法律名反推。同一部法可能跨域，`classifyDocumentCategory`
  // 判不出来时会给 "other"，那种不算数。
  const fromCitedLaws = [...new Set(
    (prior.citedLaws ?? [])
      .map((law) => classifyDocumentCategory(law, [law]))
      .filter((id) => id && id !== "other"),
  )];
  return fromCitedLaws;
}

export async function answerFromPublishedKnowledge(options: AnswerOptions): Promise<AnswerResponse> {
  // 语言在**最外层、进入生成之前**定一次，往下传。
  // 不在内层各自判：服务端注入的文案（风险提示、核验警告、判例检索口径）
  // 绕过模型直接拼进答案，它们和模型输出必须用同一个语言参数，
  // 否则会出现英文正文里混一句中文警告——比全中文还糟。
  const answerLanguage = resolveAnswerLanguage({
    question: options.question,
    sticky: options.priorTurnContext?.answerLanguage,
  });

  /*
   * 多义词闸门：放在**调模型之前**。
   *
   * 中文「保证金」对应 pre-deposit / security deposit / performance guarantee /
   * customs bond 四个互不相干的概念（见 `term-ambiguity.ts` 里的事故记录）。
   * 消歧不了还往下走，模型就会**按检索回来的证据反推这个词是什么意思**——
   * 2026-09-28 实测它把「保证金」定义成了「利息(interest)」，然后一本正经地
   * 答了 s.234 的利息计算基数，每条引用都真、每个数字都有出处，只是答的不是那个问题。
   *
   * 所以在这里就截断：既不浪费一次 buildLegalQuery、也不给模型"自圆其说"的机会。
   * 用户回答之后带着明确语境重问一遍，后面整条链路才有意义。
   */
  // 这一整段对话在谈哪个法域。算一次，往下传给案例闸门和关键数值闸门共用——
  // 两处各算一次迟早会走偏，而它们判出不同的法域时，答案会自相矛盾。
  const conversationCategories = resolveConversationCategories(options);

  /*
   * 问题类型：争议应对型还是合规义务型。
   *
   * 争议型会额外挂一张审级流程图（骨架来自 config/dispute-tracks.json），
   * 因为「成本模型不是法定要求的列表」——硬套进「法规要求」那个框，
   * 必然变成一串法条编号（见 question-type.ts 顶部那次实测事故）。
   *
   * 和法域一样是**会话级**的：多义词闸门追问之后用户只答两个词，
   * 单看那一句什么都判不出来。
   */
  const questionType = resolveConversationQuestionType(
    options.question,
    options.priorTurnContext?.selfContainedQuestion,
  );

  const ambiguity = resolveAmbiguousTerms(options.question, await loadApprovedGlossaryTerms());
  if (ambiguity.unresolved.length > 0) {
    return {
      ...unableToConfirm({
        requestId: options.requestId,
        conversationId: options.conversationId,
        conclusion: ambiguity.unresolved.length === 1
          ? `「${ambiguity.unresolved[0].term_zh}」在中文里对应几个完全不同的法律概念，`
            + "按哪一个理解，答案会完全不同。先确认一下你问的是哪种。"
          : "问题里有几个词在中文里对应多个不同的法律概念，先确认一下具体所指。",
        failureCode: "NEED_INFO",
      }),
      // 状态改成 NEED_INFORMATION：这不是"知识库里查不到"，是"问题本身还没定下来"。
      // 两者对用户的含义完全不同——前者该去补资料，后者只要补一句话。
      answer_status: "NEED_INFORMATION",
      missing_information: ambiguity.unresolved.map(ambiguityQuestion),
      charge_eligible: false,
    };
  }

  const query = await buildLegalQuery(options.question, {
    time_context: options.targetDate,
    jurisdiction: options.jurisdiction,
  });

  /**
   * 判例的总规则（2026-10-16）：只要问题需要检索判例，**本地所有相关、已发布案例
   * 都是结果的一部分**。不能再让“用户是否用‘找几个’这类特定句式”决定本地列表
   * 是完整的还是只显示前三条。
   *
   * 本地库先行有两个原因：已发布案例经过人工复核，且它正是产品要沉淀的法律资料。
   * 本地不足三条，才走公司/主题专用检索或普通 Indian Kanoon 兜底；外部结果永远
   * 追加在本地结果之后，并按 docid 去重。
   */
  const needsCaseSearch = shouldSearchCases(options.question);
  const casesPromise = (async (): Promise<{ cases: RelatedCase[]; note?: string; searched: boolean }> => {
    // `searched` 区分"查过没有"和"压根没查"。这两件事在界面上必须长得不一样，
    // 理由见 contracts.ts 的 `case_search_empty`。
    if (!needsCaseSearch) return { cases: [], searched: false };
    const published = await getPublishedCases().catch(() => [] as Awaited<ReturnType<typeof getPublishedCases>>);

    // 第一步只读本地，并完整取回所有通过相关性和法域筛选的已发布案例。
    // 这一步不触发外部 API；即使最终需要补查，列表里的本地案例也不会被覆盖或截断。
    const localCases = await retrieveRelatedCases(
      query.english_query,
      published,
      conversationCategories,
      options.requestId,
      { includeAllLocal: true, localOnly: true },
    ).catch((error: unknown) => {
      if (isAnswerTraceEnabled()) {
        console.warn(
          `[trace ${options.requestId}] 本地判例检索失败:`,
          error instanceof Error ? error.message : error,
        );
      }
      return [] as RelatedCase[];
    });

    // 本地已有足够的相关案例时，到此为止。这样案例库越完整，外部 API 的调用越少。
    if (localCases.length >= MIN_SUFFICIENT_LOCAL_RESULTS) {
      return { cases: localCases, searched: true };
    }

    let routeCases: RelatedCase[] = [];
    let routeNote: string | undefined;
    try {
      const routed = await routeCaseRequest({
        question: options.question,
        modelEnglishQuery: query.english_query,
        publishedCases: published,
      });
      /*
       * 诊断落日志（2026-10-13）：公司/主题链路每一步的判定——意图识别、别名来源、
       * title 检索可用性、哪几路召回失败、过滤后剩几条——此前只塞在返回值里，
       * **没有任何人读它**；链路里任何一环静默失败，表现都只是"没查到判例"，
       * 无从排查（三星判例漏检就是这么查了两天才定位）。
       * 只打派生的检索词与判定结果，不打问题原文——与 ANSWER_TRACE 同一口径。
       */
      if (isAnswerTraceEnabled() && routed.diagnostics.length > 0) {
        console.info(`[trace ${options.requestId}] case-route: ${routed.diagnostics.join(" | ")}`);
      }
      if (routed.kind !== "none" && routed.cases.length > 0) {
        routeCases = routed.cases;
        routeNote = routed.note;
      } else if (routed.kind !== "none" && routed.note) {
        // 公司精确检索落空时，这句话仍有价值：它能说明下面可能出现的是同主题
        // 的其他企业案例，而不是假装“这些就是该公司的案件”。
        routeNote = routed.note;
      }
    } catch (error) {
      // 之前这里是完全静默的——公司链路炸了（网络/token/接口变更）只会表现为
      // "没查到判例"，和"库里没有"无法区分。至少把异常记下来。
      console.warn(
        `[trace ${options.requestId}] case-route threw:`,
        error instanceof Error ? error.message : error,
      );
    }
    // 路由链路可能已经带回一批更精确的公司/主题结果；本地案例必须保留在最前面。
    // 只要尚未达到外部补充目标，再跑普通兜底。若特定公司确实只有两件案件，最终
    // 也只展示真实命中的两件，绝不能塞无关案件凑成五件。
    const routedAndLocal = mergeCaseResults(localCases, routeCases, Number.POSITIVE_INFINITY);
    if (routedAndLocal.length >= CASE_SEEKING_LIVE_TARGET) {
      return { cases: routedAndLocal, note: routeNote, searched: true };
    }

    const fallbackCases = await retrieveRelatedCases(
      query.english_query,
      published,
      conversationCategories,
      options.requestId,
      { includeAllLocal: true, liveResultTarget: CASE_SEEKING_LIVE_TARGET },
    ).catch((error: unknown) => {
      if (isAnswerTraceEnabled()) {
        console.warn(
          `[trace ${options.requestId}] Indian Kanoon 判例检索失败:`,
          error instanceof Error ? error.message : error,
        );
      }
      return [] as RelatedCase[];
    });

    return {
      cases: mergeCaseResults(routedAndLocal, fallbackCases, Number.POSITIVE_INFINITY),
      note: routeNote,
      searched: true,
    };
  })();

  /*
   * 判例检索的结果**提前到主答案之前 await**（2026-10-13 改，原先是主答案之后）。
   *
   * 原因：模型申报 evidence_sufficiency 和写 short_conclusion 时必须知道判例区
   * 有没有货——"用户找三星广告费案件、判例区有三星 AMP 案"时申报 NONE，
   * 会把整份答案降级成"暂时无法确认"（那次事故的完整根因）。
   * 判例名清单进提示词 + 服务端 liftSufficiencyWhenCasesFound 兜底，两头对齐。
   *
   * 代价：shouldSearchCases 为真的问题，主答案要等本地检索；本地不足三条时才可能
   * 继续走公司/主题或 Indian Kanoon 的重操作。可接受——这类问题判例是主角，而且
   * 原先这里本来也要 await 它；普通业务问题 shouldSearchCases=false，casesPromise
   * 立即返回空，不多等一毫秒。
   */
  const caseBundle = await casesPromise;

  const answer = await answerFromPublishedKnowledgeInner(
    options, query, answerLanguage, ambiguity, conversationCategories, questionType,
    caseBundle.cases.map((item) => item.caseName),
  );
  answer.question_type = questionType;
  // 法域下发给展示层，给「法规要求」的分组把关（先法域、后位阶）。见 contracts.ts 的说明。
  answer.question_categories = conversationCategories;
  if (questionType === "DISPUTE_RESPONSE") {
    // 法域认不出来时 loadDisputeTrack 返回 undefined，不挂图——
    // 三个税种的预缴比例和审级完全不同，给错一张比不给更糟。
    const track = await loadDisputeTrack(conversationCategories).catch(() => undefined);
    /*
     * 一条对话里同一条流程图只画一次。
     *
     * 实测事故（2026-09-29）：第一问「收到 DGGI 的 SCN 怎么办」画了完整的 GST 三级图；
     * 第二问只问「有什么相关案例吗」，**整张图原样又出现一遍**，
     * 用户要滚过两页读过的东西才看到他真正问的那个答案。
     *
     * 骨架是配置里的定值，同一条对话里不会变，重画零信息增量。
     *
     * 判据是 **track id**，不是"是不是追问"：
     *   · 换了法域（所得税 → GST）→ id 不同 → 照画。那是另一条图，用户没见过。
     *   · 同一条图 → 只留一行指路，不留空白（不说一声，用户会以为系统忘了）。
     */
    const alreadyShown = track && (options.shownDisputeTrackIds ?? []).includes(track.id);
    if (alreadyShown && track) {
      answer.dispute_track_omitted = track.label;
    } else if (track) {
      /*
       * 给骨架里的条号挂角标。
       *
       * 这是**确定性查找**，不是检索：我们明确知道要 s.362 这一条，
       * 不是"最相关的那条"。所以直接去已发布 chunk 里按法规名 + 条号定位，
       * 不打分、不走向量（见 dispute-citations.ts）。
       *
       * 找不到的**如实标成"库里没有这一条"**，不降级成无角标——
       * 没角标看起来像"这个数不需要依据"，而"查不到"明说了依据应该有、库里缺，
       * 后者还能指导补库。
       */
      const citationMap = await (async () => {
        try {
          const chunks = await getPublishedKnowledgeChunks();
          return resolveDisputeCitations(collectCitationKeys(track), chunks, answer.citations);
        } catch {
          // 读知识库失败：图照挂，只是没有角标。流程图本身仍然有用。
          return new Map();
        }
      })();
      answer.dispute_track = {
        ...track,
        // 展示层拿 map 不方便（要序列化过网络），拍平成普通对象。
        _citations: Object.fromEntries(citationMap),
      };
    }
  }
  answer.answer_language = answerLanguage;
  // 判例包已在外层 await 完（主答案生成前）——见那里的注释。
  const { cases: relatedCases, note: caseSearchNote, searched: casesSearched } = caseBundle;
  if (relatedCases.length > 0) {
    answer.related_cases = relatedCases;
    // 检索口径说明：走专用路由时**必须**告诉用户我们是按什么查的——
    // 用户问"代持"、我们搜的是 benami；用户问"三星的代持案例"、给的可能是别家的。
    // 不说这一句，列表本身会被误读。
    if (caseSearchNote) answer.case_search_note = caseSearchNote;
    // 判例综述：把几份判例横向归纳成风险主题，而不是把案例记录原样倒给用户
    // （2026-09-16 用户反馈"信息是无用的、零散的"）。生成失败就只留列表，
    // 不影响主答案。
    // 结果列表可以完整展示；但一百多份案例的长字段不能一起喂给模型做综述，
    // 否则延迟和成本会随案例库膨胀。综述只读排序最靠前的 5 件，完整索引仍在下方。
    const digest = await buildCaseDigest({
      question: options.question,
      cases: relatedCases.slice(0, 5),
    }).catch(() => undefined);

    if (isCaseDigestIrrelevant(digest)) {
      // 模型逐份读过这些判例，判定它们与问题**没有实质关联**（提示词第 7 条）。
      // 那就整块不展示——列一堆不相干的判例，比不列更伤信任。
      //
      // 2026-09-22 实测事故：用户问所得税上诉保证金的计算基数，判例区列了
      // 讲常设机构的、讲 80-IA 扣除的、还有一件刑事冻结资产的。
      // 那次模型其实已经判过"不相关"了，只是它的答复和"调用失败"用了同一个
      // 返回值，上游分不清，照样把原始列表端了上去。
      //
      // 清空 related_cases 而不只是不给 digest：下面 `reconcileCaseClaims` 按
      // `related_cases` 的条数去改结论里"有没有判例"的措辞，不清空的话
      // 结论会被改成"已找到判例"，而页面上一条都没有——矛盾换了个方向而已。
      answer.related_cases = [];
      answer.case_search_note = undefined;
      // 清空之后要明说"没有"，不能让判例区整块消失。
      // 用户是冲着判例来问的，界面上对他问的那件事一个字都不回应，
      // 他分不清是"系统没找"还是"库里没有"，只能再问一遍。
      answer.case_search_empty = "JUDGED_IRRELEVANT";
    } else {
      answer.case_digest = digest;
    }
  } else if (casesSearched) {
    // 检索跑了、库里没有沾边的。同上：查过没有，和没查过，不能长得一样。
    answer.case_search_empty = "NO_MATCH";
  }

  /*
   * 判例合并进来之后，把整份回答里"没有判例"的说法和事实对齐（2026-09-18）。
   *
   * 真实事故：结论写着"本次检索到的证据中未包含具体判例"，而「相关判例」区块里
   * 明明白白列着三份 CESTAT 判例。根因不是措辞，是**判例检索和主答案并发跑**——
   * 模型写回答时根本没拿到判例，它那句话对自己的输入而言是实话。
   * 矛盾是合并这一步造出来的，所以也只能在合并之后修。
   */
  Object.assign(answer, reconcileCaseClaims(answer));

  // 问题本身要的就是判例时（"目前有哪些海关方面的官司"），判例是主角不是附录。
  // 2026-09-18 实测：这类问题拿到的是海关法上诉程序条文摆在最前面、判例埋在最底下。
  if (isCaseSeekingQuestion(options.question)) {
    answer.case_led = true;
    if (relatedCases.length === 0) {
      // 用户要的是判例，一条都没找到就明说，**不拿法条充数**，也不扣这一次。
      // 和 `coverage-gap.ts` 同一条原则：没给到用户要的东西，就不该按完整回答收费。
      answer.risks_and_exceptions = [
        t("caseSeekingEmpty", answerLanguage),
        ...answer.risks_and_exceptions,
      ];
      answer.charge_eligible = false;
    } else {
      /*
       * 这里的 `related_cases` 已经经过检索、法域过滤，并且没有被
       * `isCaseDigestIrrelevant` 判为不相关。用户要的正是判例，这些结果就是
       * 本轮的主证据；不能因为法规库没有一条专门写着“AMP 判例规则”的条文，
       * 还把整份“找判例”回答标成 PARTIAL。
       *
       * 旧逻辑只把 NONE 提到 PARTIAL，模型又会把“判例见下方”写进
       * evidence_gap，于是出现“部分覆盖 + 已找到判例”的自相矛盾横幅。
       * 这里在**判例相关性已确认之后**按问题目标定案：判例检索交付完整，
       * 法规原文只作背景，不再构成这个问题的覆盖缺口。
       */
      answer.evidence_sufficiency = "FULL";
      answer.evidence_gap = undefined;
      answer.risks_and_exceptions = answer.risks_and_exceptions
        .filter((item) => item !== SELF_DOUBT_RISK_NOTE);
    }
  }
  return answer;
}

/**
 * 明确在找判例、却一条都没检索到时给用户的话。
 *
 * 措辞必须是"**本次没有检索到**"，不能写成"印度没有这类判例"——
 * 案例库覆盖的是有限样本，实时检索也只取前几条。
 * 和 `coverage-gap.ts`、`step-text.ts` 的措辞口径一致：
 * **检索结果的边界不等于事实的边界。**
 */
export const CASE_SEEKING_EMPTY_NOTE =
  "本次没有检索到与这个问题相关的判例——案例库和实时检索都没有命中，"
  + "不代表印度没有这类判例。下面的内容来自法律条文，不是判例。本次不扣除提问次数。";

/**
 * 诊断日志：出现"答非所问"时，这两行能直接分辨问题出在哪一段——
 * 检索词本身就跑偏了（问题理解/改写阶段的锅），还是检索词对、命中的条文不对
 * （知识库覆盖或打分的锅），还是两者都对、只是生成阶段没用好证据。
 *
 * 起因：2026-09-15 用户实测"换了一份完全不同的Notice、回答却几乎一样"，
 * 我连着猜错两个根因（多轮上下文污染、提取结果为空撞缓存），都被用户的实际
 * 观察否掉了——没有仪表就只能猜，猜的代价比装仪表大得多。
 *
 * 只打**派生出来的**检索词（英文法律检索词、中文要件标签）和命中的条文标识
 * （法律名 + 条号），不打用户问题原文，更不打上传文件的任何内容——
 * 《产品规则表 V1.4》要求用户上传文件不进普通日志。
 * 填 ANSWER_TRACE=off 可以整体关掉。
 */
export function isAnswerTraceEnabled() {
  const flag = process.env.ANSWER_TRACE?.trim().toLowerCase();
  return !(flag === "off" || flag === "false" || flag === "0");
}

function logAnswerTrace(
  requestId: string,
  query: LegalQueryPackage,
  evidence: RetrievedKnowledgeChunk[],
) {
  if (!isAnswerTraceEnabled()) return;
  console.info(
    `[trace ${requestId}] query_en=${JSON.stringify(query.english_query)}`
    + ` elements=${JSON.stringify(query.legal_elements)}`,
  );
  console.info(
    `[trace ${requestId}] evidence=${JSON.stringify(
      evidence.map((chunk) => `${chunk.evidenceId}|${chunk.source}|${chunk.minorTitle}`),
    )}`,
  );
}

async function answerFromPublishedKnowledgeInner(
  options: AnswerOptions,
  query: LegalQueryPackage,
  /**
   * 回答语言。由 `answer-language.ts` 在进入生成之前**确定性**判定，
   * 不让模型自己看着办——见那个文件开头的说明。
   */
  answerLanguage: AnswerLanguage = "zh",
  /**
   * 多义词消歧结果。在外层算好传进来，不在这里重算——
   * 外层已经据此做过"消歧不了就转追问"的提前返回，两处各算一次迟早会走偏。
   * 走到这里时 `unresolved` 必定是空的，只有 `resolved` 有用。
   */
  ambiguity: AmbiguityResult = { resolved: [], unresolved: [] },
  /**
   * 会话级法域。在外层算好传进来，理由同 `ambiguity`：
   * 两处各算一次，迟早会出现"案例按所得税过滤、关键数值按 GST 过滤"的分裂。
   */
  conversationCategories: string[] = [],
  /**
   * 这一问是不是争议应对型。
   *
   * 传进来只为一件事：**告诉模型审级流程由界面的流程图负责，它不要再写一遍。**
   * 流程图本身是配置渲染的，和模型无关；但模型不知道它存在，
   * 就会在「实务建议」里再把"3 个月内上诉、预缴 10%"讲一遍
   * （2026-09-29 实测，第 6 步一字不差地复述了流程图第一格）。
   *
   * 这条是**提示词层的约束，不是兜底**——写重了只是冗余，不会出错，
   * 所以不值得为它再加一道确定性校验。和数字类的规则不同。
   */
  questionType: QuestionType = "COMPLIANCE_DUTY",
  /**
   * 判例区将要展示的案例名清单（由外层在 await 完 casesPromise 之后传进来）。
   *
   * 为什么模型需要知道（2026-10-13 事故）：模型申报 evidence_sufficiency 和写
   * short_conclusion 时看不到判例，会申报 NONE/写"未包含判例"——而判例区其实有货，
   * 整份答案被降级成"暂时无法确认"。清单进提示词让它对着事实说话，
   * 服务端另有 `liftSufficiencyWhenCasesFound` 兜底（见那个函数的三条边界）。
   */
  relatedCaseNames: string[] = [],
): Promise<AnswerResponse> {
  // 向量检索这一路是"加分项"：算出来就参与 RRF 融合，算不出来就静默退回纯关键词。
  // 分层之后要件总数最多 maxLayers × maxElements，不能再按单层的 4 个截断，
  // 否则后面几层的要件拿不到向量分，等于只有关键词一路在跑。
  // 向量侧按「中文标签 + 英文检索词」一起编码：标签保留语义、英文词对齐法条原文用语。
  const denseInputs = new Map<string, string>();
  for (const layer of query.legal_layers ?? []) {
    for (const element of layer.elements) {
      denseInputs.set(element.label, `${element.label}. ${element.terms_en}`);
    }
  }
  const denseScores = await computeDenseScores(
    options.publishedChunks,
    query.legal_elements.slice(0, EVIDENCE_QUOTA.maxLayers * EVIDENCE_QUOTA.maxElements),
    query.english_query,
    denseInputs,
  );
  const initialRetrieval = retrieveKnowledge(options.publishedChunks, query, denseScores);
  const { excludedByPeriod, uncoveredElements } = initialRetrieval;

  // 补第一轮之外的证据，两条路子，都受同一套适用期间/辖区闸门约束：
  //   ① 条文交叉引用：已检索到的条文明文引用了哪些条，把那些条也拉进来（确定性，零模型调用）
  //   ② 二次检索：让模型对着第一轮结果指出"还缺哪些义务"，再检索一轮（治的是"要件靠猜"这个根因）
  const { dateScoped } = scopeCandidates(options.publishedChunks, query);
  const supplements: PublishedKnowledgeChunk[] = [];

  if (initialRetrieval.evidence.length > 0) {
    supplements.push(...followCrossReferences({
      evidence: initialRetrieval.evidence,
      candidates: dateScoped,
    }));

    if (isSecondPassEnabled()) {
      const gaps = await findEvidenceGaps({
        question: options.question,
        evidence: initialRetrieval.evidence,
      });
      supplements.push(...retrieveForGaps({
        publishedChunks: options.publishedChunks,
        baseQuery: query,
        gaps,
        alreadyPicked: initialRetrieval.evidence,
      }));
    }
  }

  // 补充证据接在第一轮后面，编号顺延——已有角标不会因为补进来的条文而位移。
  const seenSupplement = new Set(
    initialRetrieval.evidence.map((chunk) => `${chunk.documentId}::${chunk.number}`),
  );
  const evidence: RetrievedKnowledgeChunk[] = [...initialRetrieval.evidence];
  for (const chunk of supplements) {
    const key = `${chunk.documentId}::${chunk.number}`;
    if (seenSupplement.has(key)) continue;
    seenSupplement.add(key);
    evidence.push({
      ...chunk,
      evidenceId: `E${evidence.length + 1}`,
      score: 0,
      element: "补充检索",
    });
  }

  logAnswerTrace(options.requestId, query, evidence);

  if (evidence.length === 0) {
    // 区分“完全没有资料”和“有资料但都不覆盖所问期间”。
    if (excludedByPeriod > 0) {
      return unableToConfirm({
        requestId: options.requestId,
        conversationId: options.conversationId,
        failureCode: "PERIOD_NOT_COVERED",
        conclusion: options.targetDate
          ? `已发布资料中没有覆盖${options.targetDate}的条款，`
            + "不能用其他期间的规则倒推结论。本次不扣次数。"
          // 没指定日期时按当天判断（见 retrieval.ts 的 coversDate）。走到这里通常是：
          // 检索到的条文都出自已废止的旧法，而问题没写明税期，无法断定该用新法还是旧法。
          : "检索到的条款都已经失效（所属法律已废止或被替代），按当前日期不适用；"
            + "但你的问题没有写明税期或交易日期，无法确定应当适用哪个年度的规则。"
            + "请补充具体的评估年度（如 AY 2019-20）或交易日期后重问。本次不扣次数。",
      });
    }
    return unableToConfirm({
      requestId: options.requestId,
      conversationId: options.conversationId,
      failureCode: "INSUFFICIENT_EVIDENCE",
      conclusion: "已发布资料中没有找到能支持这个问题的可定位条款，本次不生成法律结论。",
    });
  }

  const { data } = await requestStructuredJson<RawAnswer>({
    role: "answer",
    // 跨法律层的问题会产出十几条要求加建议，1800 曾经不够用——
    // 输出被截断时整份JSON都解析不了，用户看到的是"服务暂时未完成"，
    // 比列表短几条糟糕得多。宁可多留预算。
    maxTokens: 4_000,
    messages: [
      {
        role: "system",
        content: `你是面向中资企业的印度合规回答助手。你只能使用本次提供的已发布证据。
只输出JSON，格式为：
{
  "answer_status":"SUFFICIENT",
  "short_conclusion":"${answerLanguage === "en" ? "a short conclusion in English" : "中文简短结论"}",
  "assumptions":["假设"],
  "action_steps":[{"kind":"MANDATORY","text":"操作步骤","citation_ids":["E1"],"source_quote":"逐字取自证据原文的英文原句"},{"kind":"PRACTICAL","text":"实务建议","citation_ids":[]}],
  "risks_and_exceptions":["风险或例外"],
  "key_figures":[{"value":"20%","label":"法定预提税率","note":"未取得TRC时适用"}],
  "evidence_sufficiency":"FULL",
  "citation_ids":["E1","E2"],
  "practical_is_sequential":false,
  "missing_information":[]
}
硬性规则：
1. ${answerLanguage === "en"
  ? `**Write the entire answer in English.** Give a conclusion and actionable steps.
   Because the source provisions are already in English, quote them directly — do not paraphrase
   through another language. This makes the answer strictly more faithful, not less.`
  : "回答用中文，给结论和可执行步骤。"}
2. 每个实质性法律结论都必须由citation_ids中的证据支持。只能引用给出的E编号。
3. 每个法律要件都要有自己的证据。某个要件没有证据时，不得输出依赖该要件的结论——
   但**只是不回答那一部分，不是整个问题都不回答**。其余有证据的要件照常作答，
   并把没覆盖的那部分写进risks_and_exceptions说明。
4. 涉及适用期间的结论，必须在结论或步骤中写明所依据条文的适用期间，例如“适用于FY 2024-25及以后税期”。
5. 引用州级来源时须写明辖区；用中央条文回答州级实体问题时，须说明这是该邦对应条文的镜像。
6. GST税率全国统一，不得表述为各邦自定。
7. missing_information只能用于“用户自己案情里的事实”，例如具体行业、公司类型、交易金额、
   注册地邦、纳税期间——这些必须是用户本人能直接回答的问题。
   缺这类事实时用NEED_INFORMATION，最多列出${MAX_CLARIFICATION_ITEMS}项。
8. UNABLE_TO_CONFIRM 只用于一种情况：**这个问题的核心要件全都没有证据**，
   以至于给不出任何有依据的结论。此时 missing_information 必须留空[]，
   把知识库缺少哪个领域的规定写在 short_conclusion 里说明，
   绝不能反过来在 missing_information 里让用户去提供法律条文、监管规定或官方文件——
   那是系统知识库的缺口，不是用户该补的信息。
   ⚠️ 反过来说：**只要有一部分要件拿到了证据，就不要用 UNABLE_TO_CONFIRM**，
   而应就这部分作答，把缺的部分写进 risks_and_exceptions。
   ⚠️ 更不得声称"知识库缺少某某规定"，除非它确实出现在下面告知你的"未检索到证据的要件"里。
   证据里已经给了的内容，不许说成缺失。
9. 法定要求用MANDATORY；操作经验用PRACTICAL。不得把实务建议写成法定义务。
10. 每条MANDATORY步骤都必须在自己的citation_ids里写明它依据哪几条证据（只能用给出的E编号），
    界面会按这个把要求按法律分组展示。
    ⚠**写PRACTICAL步骤前，先检查它是不是在把某条MANDATORY要求翻译成具体动作**
    （例如MANDATORY写"须经特别决议授权"，PRACTICAL写"召开股东大会通过特别决议批准发行"——
    这是同一件事，必须把对应的E编号也写进这条PRACTICAL的citation_ids，不能因为文字不同就当成
    没有依据。只有证据原文确实完全没提到、纯属操作经验的内容（例如"提前预约估值机构的时间"
    "留存文件备查"），citation_ids才允许写[]。
11. practical_is_sequential：PRACTICAL步骤之间有明确先后顺序、必须按顺序执行时写true，
    只是并列的若干条建议时写false。
12. ⚠️**申报表格编号（如FC-GPR、FC-TRS、PAS-3、MGT-14）、天数期限、百分比门槛、金额门槛
    这类具体数值，必须逐字来自证据原文，不许凭记忆写。**
    证据里没有出现的，就不要写——宁可说"本次检索到的条文未涵盖申报表格与时限"，
    也不要给一个看起来很确定、实际没有出处的数字。
    特别注意：新发股份用FC-GPR、存量股份转让用FC-TRS，两者不能混；
    写之前先在证据里确认到底出现的是哪一个、期限是多少天。
    系统会在你输出后逐条比对这些数值是否真的出现在你引用的证据里，对不上的会被标记出来。
12b. ⚠**每条MANDATORY步骤必须给 source_quote：逐字复制证据原文里支持这条结论的那一句英文。**
    要求：①必须一字不差地来自你在 citation_ids 里引用的那条证据的英文原文，
    不许改写、不许翻译、不许拼接不同段落；②必须是真正支持这条结论的那一句，
    不是这条证据里随便一句；③至少25个字符。
    ⚠**只引最关键的那一句（40个英文单词以内），不要整段照抄。**
    条文里的长列表（(a)(b)(c)…）跨段落、跨页，整段抄容易抄串行或跨到别的条文里去，
    反而会让核验失败。引最能说明这条义务的那一句就够了。
    系统会把这句话拿到被引用的证据原文里做精确匹配，对不上就会被标记出来。
    ⚠**如果你在证据里找不到能支持这条结论的原句，说明这条结论没有依据——
    不要写这条要求，也不要挂一个最接近的引用凑数。**
    实测踩过的坑：回答写"根据FDI政策第5.2条，中资股东须遵守Press Note 3、投资须经政府审批"，
    结论本身是对的，但5.2条原文只讲行业上限，一个字都没提接壤国家——
    引用指错了条款。这种"结论对、引用错"比不引用更危险：它看起来有出处，经不起核对。
13. ⚠**不要在正文开头写"根据《法律名》第X条，……"。** 界面已经把法规要求按法律分组
    （组标题就是法律名），每条后面还有角标可以点开看条文定位和官方原文——
    正文里再写一遍，同一个出处在一屏里出现三次，读起来很乱。
    直接写义务本身，例如"向非现有股东发行新股须经股东特别决议授权"。
    出处放在 citation_ids 和 source_quote 里，不要写进正文。
13b. ⚠**每条 MANDATORY 正文开头，先用一个4~10个字的短语概括这条要求是关于什么，
    再用"："接完整的法规要求内容。** 这是主题标签，让不懂合规的普通读者一眼扫到
    "这条在讲什么"，再决定要不要往下细看细则——和15c禁止的"第一步"步骤序号是
    两回事：主题标签是名词短语、不编号、不暗示先后顺序；步骤序号是"第X步"这种
    带编号的执行语气，规则15c明确禁止。
    ✓"确定发行价格：向非居民发行股份的价格不得低于注册估值师……出具的估值报告所确定的价格。"
    ✓"核对FDI准入路径和行业上限：确认公司所处行业是否允许外资、适用自动路径还是政府审批路径。"
    ✗"第一步：确定发行价格……"（这是步骤序号，不是主题标签，15c禁止）
    ✗"向非居民发行股份的价格不得低于……"（没有开头短语，读者要读完整句才知道在讲什么）
    短语要贴合这条要求本身的主题（"确定发行价格""核对准入路径""完成资金申报"这类
    动宾短语），不要写成对用户的行动指令（不要写"请确定发行价格"）——MANDATORY
    陈述的是法律规定了什么，不是在指挥用户做什么，行动指令留给 PRACTICAL 去写。
14. ⚠**实务建议不能为空**：action_steps 里必须同时包含 MANDATORY 和 PRACTICAL 两类，
    PRACTICAL 至少 2 条。只给法规要求、不给可执行建议的回答是不合格的。
    ⚠**实务建议必须把上面每一条法规要求都落到可执行动作上，不许漏。**
    写之前先自己过一遍：上面每条要求各自需要用户**准备什么材料、找谁出具、按什么顺序做**？
    每一样都要在实务建议里出现。
    典型的漏项：法规要求里提到"发行价须依据注册估值师的估值报告确定"，
    实务建议却没写"提前聘请特许会计师/注册估值师出具估值报告"——
    用户读完不知道这份报告要找谁做、什么时候做，等于这条要求没落地。
    同理还有：要交的表格、要开的会、要留存的决议和会议记录、要向哪个机关申报。
14b. ⚠**每一项申报/报送/召开会议类义务，都要写明它的截止时间。**
    而且**相对时限必须配上锚点**：如果你写了"AGM后60天内报送"，那么"AGM本身必须在
    财政年度结束后多久内召开"也必须在回答里出现（前提是证据里有这一条）。
    只给相对天数、不给起点，用户排不出任何一个具体日期，等于没有给截止日。
    证据里确实没有锚点条文时，在 risks_and_exceptions 里说明，不要自己推算日期。
15. 实务建议按**实际执行顺序**排列（先做的在前），界面会渲染成流程图。
    不要写"建议咨询专业律师"这种放之四海皆准的空话占位置——
    除非确实有需要专业判断的具体事项，并写明是哪一项。
15b. ⚠**实务建议的读者是不懂合规的普通企业人员，不是律师。** 每一条都要让他知道：
    **谁去做、准备什么材料、交给哪个机关、什么时候之前做完**。
    - 用大白话。必须用专业术语时，紧跟一句话解释它是什么。
      ✗"完成SBO申报" \u3000✓"确认公司是否有需要申报的实际控制人（持股超过一定比例的自然人），有就要向公司注册处申报"
    - 提到表格时，写清楚**这张表是干什么用的**，不要只甩编号。
      ✗"提交MGT-7" \u3000✓"提交年度申报表MGT-7（把公司一年的股东、董事、股本情况报给公司注册处）"
    - ⚠**凡是申报、报送、开会、缴款这类动作，必须写明截止时间**，
      而且时间要能落到日历上：写"AGM后60天内"时，前面必须已经交代过 AGM 本身的时限。
      时间只能来自证据原文，证据里没有就写"本次检索到的条文未涵盖该事项的时限"，
      **绝对不许凭印象补一个天数**——系统会逐条比对你写的每个天数是否真的出现在引用的条文里。
    - 一条只讲一件事。需要连续做三件事就拆成三条，不要塞进一句话里。
15c. ⚠**MANDATORY 和 PRACTICAL 的文字本身都不许写"第一步""第二步""Step 1"这类步骤序号前缀。**
    界面会自己编号，而且 MANDATORY 和 PRACTICAL 用的是两套互相独立的编号：MANDATORY 按法律
    分组、每组各自从1开始编号；PRACTICAL 按你给的数组顺序整体编号、渲染成流程图。
    如果你在文字里另外写一套"第一步……第六步"贯穿两个区块的编号，界面编号和你写的数字
    对不上，读者会分不清法规要求和实务建议、看不懂断在哪（真实事故：MANDATORY 里混进了
    "第一步""第四步"，PRACTICAL 里混进了"第二步""第三步""第五步""第六步"——两边拼起来
    才是完整序列，单独看每一节都缺号断层，完全看不懂）。
    ⚠**MANDATORY 只陈述义务本身**（"须经股东特别决议授权"），不要写成"第一步，请……"这种
    带执行语气的句子——法规要求不是操作步骤，只是在说明法律规定了什么。
    需要表达先后顺序或依赖关系时，PRACTICAL 靠数组顺序（配合 practical_is_sequential）
    和界面自身的编号/流程图表达就够了；文字里最多用"随后""完成上一步后""在此之前"这类
    衔接词，不要写数字编号。
16. ⚠**给了证据的每一部法律，MANDATORY 里都必须至少有一条对应的要求。**
    如果某部法律的证据与本问题确实无关，在 risks_and_exceptions 里写明"××法的条文本次未采用，
    原因是……"，不要默默忽略。
    实测踩过的坑：RBI Master Direction 的条文被检索到了、实务建议里也写了"向RBI提交FC-GPR"，
    但法规要求里根本没有 RBI 这一组——用户看法规要求以为那就是全部义务，
    真正的依据却散落在"建议"里，看起来像可做可不做。
17. ⚠**先写 MANDATORY，再写 PRACTICAL；实务建议里出现的每一个动作，
    只要它有法条依据，对应的要求必须已经在 MANDATORY 里出现过。**
    自查方法：写完实务建议后逐条回头看——"这一步是法律要求的，还是我的经验建议？"
    是法律要求的，就必须能在上面找到对应条目；找不到就说明 MANDATORY 漏了，补上。
    例如"召开董事会与股东大会通过特别决议"是公司法 s62 的明文要求，
    不能只作为建议出现；而"提前准备好章程和股东协议备查"属于经验，才放 PRACTICAL。
18. ${KEY_FIGURES_PROMPT_RULE}
18b. ${EVIDENCE_SUFFICIENCY_PROMPT_RULE}
18c. ${SUPERSESSION_PROMPT_RULE}
19. ${answerLanguage === "en"
  ? `Keep all statutory terms, authority names and form numbers exactly as they appear in the
    source text (Authorised Dealer Bank, FC-GPR, SPICe+). Do not translate or gloss them —
    in English mode there is nothing to translate, and inventing glosses only adds error.`
  : `⚠**专有名词按下面「术语对照」给出的译名翻译，不要自己另造译法。**
    没列进对照表的机构名、表格名、法律概念，**首次出现时写成「中文（English）」**，
    例如"外汇指定银行（Authorised Dealer Bank）"。
    特别注意：外汇语境里的 Authorised Dealer 指经RBI授权办理外汇业务的银行，
    是"交易商/指定银行"，**不是卖货的"经销商"**，译错会让读者理解成完全不同的机构。`}${
      options.priorTurnContext
        ? `
20. ⚠**这是一次追问，下面会给你"上文"信息。** 上文已经确认的背景事实（主体身份、
    公司类型、交易类型等）不要重复询问、也不要当成新证据缺口写进risks_and_exceptions。
    如果上文的结论和本次新检索到的证据冲突，以本次证据为准，并在risks_and_exceptions
    里说明和上文不一致的地方。上文列出的"已经讲过的法规要求"不需要重新论证一遍，
    除非本次证据补充了新的信息。`
        : ""
    }${
      questionType === "DISPUTE_RESPONSE"
        ? `
20b. ⚠**审级流程不用你写。** 这一问是争议应对型，界面上会单独渲染一张
    审级流程图（各级上诉期限、强制预缴比例、平均耗时、累计利息都在图里，
    数据来自配置文件，不经过你）。所以：
    （1）不要在 PRACTICAL 里复述"几个月内向某某机关上诉""预缴争议税额的百分之几"——
        图里已经有了，重复一遍只会让用户读两次。
    （2）你该写的是**这个案子特有的**动作：要收集哪些凭证、抗辩的论点怎么立、
        哪些事实需要向税局说明。这些图里没有，只有你能写。
    （3）确实需要提到某一级审级时，只说"若对裁定不服可继续上诉"，
        不要带具体期限和比例的数字——图和文字给出两个数时，用户不知道该信哪个。`
        : ""
    }${
      options.noticeExcerpts?.length
        ? `
21. ⚠**下面会给你用户上传的文件原文节选。** 用户问"这份文件说了什么""税局质疑的是
    什么""要求我做什么"这类问题时，**必须依据原文节选具体作答**，指名道姓地说出
    文件里写的事由、对象、时间窗口、引用的文号和依据，不许用"仔细阅读通知中的
    Brief facts 部分""核对通知列出的税额"这种放之四海而皆准的空话搪塞——
    用户已经把文件给你了，答"你自己去看文件"是没有价值的。
    ⚠同时注意三条边界：
    （1）原文节选**不是已核验的法律依据**，citation_ids 只能引用下面"已发布证据"
        里的条文，绝不能给原文节选编角标、也不能把文件里提到的法条编号当成
        已核实的引用——文件提到某条法律，只说明文件这么写，不等于知识库核实过。
    （2）文件里写的内容如果和已发布证据冲突，以已发布证据为准，并在
        risks_and_exceptions 里指出这处不一致。
    （3）不要把文件的性质搞错：通报性质的文件（告知某项专项行动、核查安排）
        不要当成针对用户的指控或处罚通知来答。`
        : ""
    }`,
      },
      {
        role: "user",
        content: `用户问题：${options.question}${
          options.priorTurnContext
            ? `

上文（追问延续，仅供理解背景，不是本次证据，不能作为citation_ids的依据）：
  上一问：${options.priorTurnContext.selfContainedQuestion}
  上一问结论：${options.priorTurnContext.shortConclusion}${
              options.priorTurnContext.mandatoryFirstSentences.length
                ? `\n  上一问已经讲过的法规要求：${options.priorTurnContext.mandatoryFirstSentences.map((s) => `“${s}”`).join("；")}`
                : ""
            }${
              options.priorTurnContext.citedLaws.length
                ? `\n  上一问引用过的法律：${options.priorTurnContext.citedLaws.join("、")}`
                : ""
            }${
              options.priorTurnContext.relatedCases?.length
                ? `\n  上一问展示过的案例：${options.priorTurnContext.relatedCases.map((c) => c.caseName).join("、")}`
                  + "（如果这次追问的是这些案例的细节而不是新的法律问题，如实说明本轮未重新核实该细节，建议用户点开案例原文链接核对，不要凭印象补充数字或结论）"
                : ""
            }`
            : ""
        }
${
          options.noticeExcerpts?.length
            ? `
用户上传的文件原文节选（用户提供的材料，不是已核验的法律依据，不能作为citation_ids的来源）：
${options.noticeExcerpts.map((excerpt, index) => `【文件${index + 1}】\n${excerpt}`).join("\n\n")}
`
            : ""
        }
适用日期：${options.targetDate ?? "未指定，按当前有效版本处理"}
辖区：${options.jurisdiction ?? "未指定"}
法律要件${query.legal_layers?.length ? "（按法律层分组，回答要覆盖每一层，不能只答其中一层）" : ""}：${
          query.legal_layers?.length
            ? query.legal_layers.map((entry) => `\n  【${entry.layer}】${entry.elements.join("、")}`).join("")
            : query.legal_elements.join("、")
        }${
          uncoveredElements.length
            ? `\n未检索到证据的要件（仅这几项不得下结论，其余要件照常作答）：${uncoveredElements.join("、")}`
              + "\n注意：这里没列出的内容都是有证据的，不许在回答里说成知识库缺失。"
            : ""
        }

英文检索包：${JSON.stringify(query)}
${(() => {
  const pairs = glossaryForEvidence(evidence.map((chunk) => chunk.body).join("\n"));
  return pairs.length
    ? `\n术语对照（专有名词必须按这里的译名翻译）：\n${
        pairs.map((pair) => `  ${pair.en} → ${pair.zh}`).join("\n")}\n`
    : "";
})()}
已发布证据：
${evidenceText(evidence)}${
          relatedCaseNames.length
            ? `

已确认相关的判例（这些判例将随本答案在「相关判例」区块展示。用户在找判例时，它们就是本答案要交付的实质内容——评估 evidence_sufficiency 时判例也算证据，列出的判例与问题直接相关时至少报 PARTIAL，不得报 NONE；short_conclusion 也不要说"未找到/未包含相关判例"，改成指明判例见下方区块）：
${relatedCaseNames.map((name) => `- ${name}`).join("\n")}`
            : ""
        }`,
      },
    ],
  });

  const rawStatus = data.answer_status === "NEED_INFORMATION"
    ? "NEED_INFORMATION"
    : data.answer_status === "SUFFICIENT"
      ? "SUFFICIENT"
      : "UNABLE_TO_CONFIRM";

  const citedIds = stringList(data.citation_ids, evidence.length);
  const citedEvidence = citedIds.flatMap((id) => {
    const chunk = evidence.find((item) => item.evidenceId === id);
    return chunk ? [chunk] : [];
  });

  // 引用校验：适用期间不匹配的直接删除该条引用，而不是整体降级。
  const verifiedEvidence = citedEvidence.filter((chunk) =>
    coversDate(chunk, options.targetDate));
  const droppedForPeriod = citedEvidence.length - verifiedEvidence.length;

  // 全部引用都不覆盖所问期间时，返回 UNABLE_TO_CONFIRM 并说明缺哪个期间。
  if (citedEvidence.length > 0 && verifiedEvidence.length === 0) {
    return unableToConfirm({
      requestId: options.requestId,
      conversationId: options.conversationId,
      failureCode: "PERIOD_NOT_COVERED",
      conclusion: options.targetDate
        ? `检索到的条款都不覆盖${options.targetDate}，`
          + "不能用其他期间的规则倒推结论。请补充准确的税期或交易日期。本次不扣次数。"
        : "检索到的条款按当前日期都已失效（所属法律已废止或被替代），"
          + "而问题里没有写明税期或交易日期，无法确定应当适用哪个年度的规则。"
          + "请补充具体的评估年度（如 AY 2019-20）或交易日期后重问。本次不扣次数。",
      legalAsOf: computeLegalAsOf(evidence),
    });
  }

  // 证据编号 → 最终引用列表里的序号（1 开始）。只登记通过适用期间校验的证据，
  // 被剔除的引用不会留下悬空的角标编号。
  const refIndexByEvidenceId = new Map(
    verifiedEvidence.map((chunk, index) => [chunk.evidenceId, index + 1]),
  );

  const hasVerifiedCitations = verifiedEvidence.length > 0;
  const finalStatus = rawStatus === "SUFFICIENT" && !hasVerifiedCitations
    ? "UNABLE_TO_CONFIRM"
    : rawStatus;

  // 逐条核对步骤里的表格编号、天数、百分比是否真的出现在它引用的证据里。
  // 这是确定性校验，用来兜住"提示词要求了但模型没照做"的情况。
  const parsedSteps = actionSteps(data.action_steps, refIndexByEvidenceId);
  const firstPass = parsedSteps.map((step) => ({
    ...step,
    unverified_claims: findUnverifiedClaims(step, verifiedEvidence),
  }));

  // 校验不通过时不要直接把"请自己核对官方原文"甩给用户——先带着这个具体数值
  // 回知识库再找一遍。找到了就把那条补进引用、清掉警示；确实找不到才保留提示。
  const repaired = repairUnverifiedClaims({
    steps: firstPass,
    evidence: verifiedEvidence,
    publishedChunks: options.publishedChunks,
    targetDate: options.targetDate,
    jurisdiction: options.jurisdiction,
  });
  const checkedSteps = repaired.steps;
  const repairedEvidence = repaired.evidence;

  // 法规要求 ↔ 证据 ↔ 实务建议 的一致性处理。
  // 第一步：没挂引用的实务建议，先看它是不是在复述某条已引用的法规要求（重合中文短语）,
  // 是的话把那条引用借过来——这类是模型"忘挂"，不是真的没依据。
  // 原句核验：模型附的英文原句必须真的出现在它引用的那条证据里。
  // 这一步治的是"结论对、引用错"——过去只校验数字，命题类主张完全没人管。
  const firstQuoteCheck = checkQuotes({ steps: checkedSteps, evidence: repairedEvidence });
  // 原句出自知识库、却挂到了同主题另一条法规时，先用英文原句反向找到正确出处。
  // 这一步只做确定性逐字检索，不让模型为了去掉警示而重写或猜测引用。
  const quoteRepaired = repairQuoteCitations({
    steps: firstQuoteCheck,
    evidence: repairedEvidence,
    publishedChunks: options.publishedChunks,
    question: options.question,
    targetDate: options.targetDate,
    jurisdiction: options.jurisdiction,
  });
  const finalEvidence = quoteRepaired.evidence;
  const quoted = checkQuotes({ steps: quoteRepaired.steps, evidence: finalEvidence });
  const unverifiedAll = [...new Set(quoted.flatMap((step) => step.unverified_claims))];

  // 证据主题相关性校验：quote-check 只管"原句是否逐字出现"，不管"这段证据是否
  // 真的支持这条结论"——生产者公司条款那次事故就是原句逐字对得上、但主题完全不相关。
  // 判定不符的 MANDATORY 步骤直接删掉，不留提示（产品决策：这类失败比没引用更危险，
  // 不适合只是弱警示）。如果因此一条 MANDATORY 步骤都不剩，整体退回 UNABLE_TO_CONFIRM，
  // 避免出现"看起来成功、实际上没有任何法规要求"的怪异结果。
  const mandatoryBeforeFilter = quoted.filter((step) => step.kind === "MANDATORY").length;
  const relevanceFiltered = await filterIrrelevantSteps({ steps: quoted, evidence: finalEvidence });
  if (mandatoryBeforeFilter > 0
    && relevanceFiltered.steps.filter((step) => step.kind === "MANDATORY").length === 0) {
    return unableToConfirm({
      requestId: options.requestId,
      conversationId: options.conversationId,
      failureCode: "INSUFFICIENT_EVIDENCE",
      conclusion: "本次检索到的证据未能通过主题相关性核验，不能确认与所问事项对应的法规要求。"
        + "请换个更具体的问法重试，或等待知识库补充相关资料。本次不扣次数。",
      legalAsOf: computeLegalAsOf(finalEvidence),
    });
  }

  const grounding = groundPracticalSteps(relevanceFiltered.steps);
  // 第二步：某部法律有证据却在法规要求里一条都没有时，把引用了它的实务建议移过去
  // ——那条内容本来就是模型自己写的、自己挂的引用，有法条依据就是法定要求。
  const evidenceSources = finalEvidence.map((chunk) => chunk.source);
  const promotion = promoteUncoveredPractical({ steps: grounding.steps, evidenceSources });
  const finalSteps = promotion.steps;
  // 归位之后再检测一次，剩下的才是真正补不上的缺口。
  const coverage = findCoverageGaps({ steps: finalSteps, evidenceSources });

  const risks = stringList(data.risks_and_exceptions, 8);
  if (promotion.promoted.length > 0) {
    risks.push(
      `以下法律的义务原本被写在「实务建议」里，因其有明确法条依据，已归入「法规要求」：`
      + `${[...new Set(promotion.promoted)].join("；")}。`,
    );
  }
  // 知识库覆盖缺口：这个领域的**地基法律**根本不在库里时，必须明说（见 coverage-gap.ts）。
  // 放在所有风险提示的最前面——它说的是"下面这些内容的法律底座缺了一块"，
  // 比任何单条提示都更该被先看到。
  const knowledgeGaps = findKnowledgeCoverageGaps(options.question, options.publishedChunks);
  risks.unshift(...coverageGapNotes(knowledgeGaps));
  risks.push(...coverageNotes(coverage));
  risks.push(...quoteNotes(finalSteps, answerLanguage));
  // Notification 时效核对：引用的法律有没有更晚的修订通知。
  // 索引缺失、读取失败一律静默返回空——这是补充信息，不能拖垮回答。
  /**
   * 结论锚定：有没有哪条法规要求**只靠 notification/circular 撑着**。
   *
   * 查的是每条步骤自己引的证据，不是整份回答的证据池——整体有 Act 不等于这一条有。
   * 真实风险是"某条具体要求全靠一份 circular"，而回答里恰好另有几条引了 Act，
   * 看总量完全发现不了。
   */
  const unanchored = findUnanchoredSteps({
    steps: finalSteps,
    citationLevels: finalEvidence.map((chunk) => resolveHierarchy(chunk)),
  });
  if (unanchored.length > 0) {
    risks.push(t("unanchoredSteps", answerLanguage, {
      n: unanchored.length,
      items: unanchored
        .map((entry) => `「${entry.text.slice(0, 24)}…」（${entry.levels.map((l) => HIERARCHY_LABEL[l]).join("/")}）`)
        .join(answerLanguage === "en" ? "; " : "；"),
    }));
  }

  risks.push(...(await checkNotificationUpdates({
    citations: finalEvidence.map(toCitation),
    asOf: computeLegalAsOf(finalEvidence),
    language: answerLanguage,
  })).notes);
  // 时限锚点：只写"AGM后60天"而不写"AGM本身何时必须召开"，用户排不出任何具体日期。
  risks.push(...deadlineAnchorNotes(findUnanchoredDeadlines(finalSteps)));
  // 申报/开会这类动作没写截止时间时点名——可操作性的最后一道闸。
  risks.push(...actionTimingNotes(findMissingActionTiming(finalSteps)));
  if (unverifiedAll.length > 0) {
    risks.push(
      `以下具体数值未能在本次引用的条文原文中找到对应表述，已在对应条目上标注，`
      + `请以官方原文为准：${unverifiedAll.join("、")}。`,
    );
  }
  if (droppedForPeriod > 0) {
    risks.push(`已剔除 ${droppedForPeriod} 条不覆盖所问期间的引用，结论仅基于剩余可适用条款。`);
  }
  if (uncoveredElements.length > 0 && finalStatus !== "UNABLE_TO_CONFIRM") {
    risks.push(`以下法律要件缺少已发布证据，未纳入结论：${uncoveredElements.join("、")}。`);
  }
  if (query.filtered_layers?.length) {
    risks.push(
      `以下法域因与本次问题的具体场景关联度不足，未纳入检索：${query.filtered_layers.join("、")}。`
      + `如果你认为这部法律确实相关，可以在问题里补充具体场景（例如涉及的经营行为）重新提问。`,
    );
  }

  const shortConclusion = typeof data.short_conclusion === "string" && data.short_conclusion.trim()
    ? data.short_conclusion.trim()
    : "暂时无法根据已发布资料确认。";
  // 模型申报的证据覆盖程度，决定状态和计费（见 answer-self-doubt.ts）。
  //
  // 2026-09-22 之前这里读的是 `shortConclusion`，拿正则去猜模型的中文措辞。
  // 那条路整道失效过：模型写"未直接**规定**"，而动词表里只有 包含|涵盖|找到|提供|列出，
  // 于是一份自陈证据不足的答案照样盖了"依据充分"、照样扣了次。
  // 措辞表是人手写的、模型的写法是无穷的，改成读申报字段。
  //
  // 2026-10-13 再加一层 `liftSufficiencyWhenCasesFound`：用户在找判例、判例区有货时，
  // 模型报的 NONE 只反映知识库法规缺口——判例是另一路已交付的主干，不能连坐降级。
  const evidenceSufficiency = liftSufficiencyWhenCasesFound(
    parseEvidenceSufficiency(data.evidence_sufficiency),
    isCaseSeekingQuestion(options.question),
    relatedCaseNames.length > 0,
  );
  const selfDoubt = adjustForSelfDoubt(
    evidenceSufficiency,
    // 地基法律缺失时一律不扣次：这份答案是用相邻法律凑出来的，不该按完整回答收费。
    finalStatus === "SUFFICIENT" && hasVerifiedCitations && knowledgeGaps.length === 0,
  );
  const adjustedStatus: AnswerResponse["answer_status"] =
    selfDoubt.downgrade && finalStatus === "SUFFICIENT" ? "UNABLE_TO_CONFIRM" : finalStatus;
  // 降级后必须一并清空步骤：UNABLE_TO_CONFIRM 分支会把 citations 清掉，
  // 步骤留着的话里面的角标会指向不存在的引用。
  /*
   * 引用的法域闸门：一条 GST 要求不许挂所得税法的角标。
   *
   * 装在这里而不是更靠后，是为了让**下游全部**看到剔过的角标——
   * 关键数值的法域校验、前端的分组、「另据」列表、判例对账都读 citation_refs，
   * 只在渲染前剔一次，那几处看到的还是旧的，又会各走各的。
   * 和 `retrieveRelatedCases` 那次"闸门只装在三个 return 里的一个上"是同一个教训。
   */
  const adjustedSteps = pruneCrossDomainRefs(
    adjustedStatus === "UNABLE_TO_CONFIRM" ? [] : finalSteps,
    finalEvidence,
    conversationCategories,
  );
  const adjustedRisks = selfDoubt.prependRiskNote && !risks.includes(SELF_DOUBT_RISK_NOTE)
    ? [SELF_DOUBT_RISK_NOTE, ...risks]
    : risks;

  // 缩写补全称放在最后统一做：跨结论、步骤、风险提示共享一个"已展开"集合，
  // 保证每个缩写只在最先出现的那一处展开一次。
  return expandAnswerAbbreviations<AnswerResponse>({
    request_id: options.requestId,
    conversation_id: options.conversationId,
    answer_status: adjustedStatus,
    failure_code: adjustedStatus === "NEED_INFORMATION"
      ? "NEED_INFO"
      : adjustedStatus === "UNABLE_TO_CONFIRM"
        ? "INSUFFICIENT_EVIDENCE"
        : undefined,
    short_conclusion: shortConclusion,
    evidence_sufficiency: evidenceSufficiency,
    /*
     * 缺口说明只在**真的降级了**的时候下发。
     *
     * 两个方向各挡一次：
     *   · 报了 FULL 却带着缺口文字 → 丢掉。既然说全覆盖，就不该另有一句"但是"。
     *   · 报了 PARTIAL 却没写缺口 → 这里不编，交给展示层给中性兜底文案。
     *     编一个缺口出来比不说更糟：用户会照着它去补一份根本不缺的资料。
     * 同义反复（"证据不足""部分内容缺失"）在这里直接当成没写——
     * 提示词已经明说不要，兜底文案至少不会误导。
     */
    evidence_gap: evidenceSufficiency === "FULL"
      ? undefined
      : (() => {
        const raw = typeof data.evidence_gap === "string" ? data.evidence_gap.trim() : "";
        if (!raw || raw.length > 60) return undefined;
        return /^(证据不足|依据不足|部分(内容)?缺失|信息不足|资料不全)[。.]?$/.test(raw)
          ? undefined
          : raw;
      })(),
    // 关键数值：标签信模型、数值逐个回查已核验步骤。对不上的整条丢弃，
    // 理由见 key-figures.ts 顶部——把一个没出处的数字放到全页最大字号，
    // 是"有依据的外观 + 无依据的内容"这种失败方式的极端形态。
    //
    // 传 adjustedSteps 而不是 parsedSteps：前者是经过适用期间过滤、补充核验、
    // claim-check 之后的**最终**步骤，`unverified_claims` 到这一步才是齐的。
    // 拿早期的 parsedSteps 去校验，等于在体检结果出来之前就发了健康证明。
    //
    // UNABLE_TO_CONFIRM 时强制清空：那种状态下连条文都没有，
    // 任何被放大到 22px 的数字都只会加深"系统很确定"的错觉。
    // 第二道闸（2026-09-22 加）：数值必须**属于用户问的那个法域**。
    // 实测事故：问所得税上诉保证金，全页最大的字是「10% · GST上诉预缴比例」——
    // 出处是真的（确实引了 CGST Rules），只是答的不是用户问的那个税。
    // 把步骤引到的法规名一起传下去，由 key-figures.ts 拿它判类别。
    // 第三道闸（2026-09-28 加）：**证据没完整覆盖这个问题时，一个数值都不显示。**
    //
    // 实测：用户问「申请 stay of demand 需要预缴的保证金，计算基数包括哪些」，
    // 答案第一句就是"未出现预缴保证金一词及其计算规则"，
    // 而全页最大的字是 **「500卢比 · 暂缓征税申请费」**——那是上诉费，不是保证金基数。
    //
    // 它通过了前两道闸：有出处（引的是已核验的条目）、法域也对（都是所得税）。
    // 但**答案自己承认没找到用户问的那个东西**，这种情况下 22px 那一行
    // 必然是"手头恰好有的另一个数"——数值越准确，误导越强。
    key_figures: adjustedStatus === "UNABLE_TO_CONFIRM" || evidenceSufficiency !== "FULL"
      ? []
      : verifyKeyFigures(
        data.key_figures,
        adjustedSteps.map((step) => ({
          ...step,
          sources: step.citation_refs
            .map((ref) => finalEvidence[ref - 1]?.source)
            .filter((source): source is string => Boolean(source)),
        })),
        { questionCategories: conversationCategories },
      ),
    // 消歧成功时，把"我是按哪个意思理解的"放进前提假设**第一条**。
    // 系统是靠一个上下文词猜的，猜错时用户得能一眼看出来并纠正；
    // 不写这句，错误的理解就藏住了——那就退回成了多义词闸门要修的那个问题本身。
    assumptions: [
      ...ambiguity.resolved.map(readingNote),
      ...stringList(data.assumptions, 5),
    ],
    // 去掉正文开头的「第X步：」和「根据《X》第Y条，」两种前缀——都是提示词已经要求
    // 不要写、但模型偶尔还是会写的格式噪音，做成确定性后处理兜底而不是只信提示词。
    // 步骤序号前缀要先删：如果先删「根据《X》第Y条，」，「第一步：根据《X》第Y条，……」
    // 剩下的「第一步：……」开头就不再匹配 stripCitationPrefix 的 ^根据 锚点了。
    // 放在缩写补全称之前：否则被删掉的那段前缀会白白占用某个缩写"只展开一次"的名额。
    // 条文内自标已废止：答案用了一个"引用条文自己说已经改掉了"的数值时标记出来。
    // 放在最后一层是因为它要拿**最终**的步骤正文去比对——前面几道后处理
    // （删前缀、改判例措辞）都可能动到正文，比对必须在动完之后。
    action_steps: withSupersededValues(
      rewriteCaseEvidenceCaveats(stripCitationPrefixes(stripStepNumberPrefixes(adjustedSteps))),
      finalEvidence,
    ),
    practical_is_sequential: data.practical_is_sequential === true,
    risks_and_exceptions: adjustedRisks,
    // 用 finalEvidence 而不是 verifiedEvidence：补充核验时新找到的条文追加在末尾，
    // 必须一起下发，否则那些新角标会指向不存在的引用。
    citations: adjustedStatus === "UNABLE_TO_CONFIRM" ? [] : finalEvidence.map(toCitation),
    // 产品规则：missing_information 只能用于追问用户自己的案情事实。
    // UNABLE_TO_CONFIRM（知识库缺相关规定）时不得列出，防止提示词失效时仍误导用户
    // 去"补充"本该由知识库覆盖的法律条文。
    missing_information: adjustedStatus === "NEED_INFORMATION"
      ? stringList(data.missing_information, MAX_CLARIFICATION_ITEMS)
      : [],
    charge_eligible: selfDoubt.chargeEligible,
    legal_as_of: computeLegalAsOf(verifiedEvidence.length ? verifiedEvidence : evidence),
    policy_version: POLICY_VERSION,
  });
}
