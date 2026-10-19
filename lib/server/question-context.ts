/**
 * 追问改写：把"股权结构方面法律有规定吗"这种依赖上文才看得懂的追问，
 * 补全成一个不看上文也能懂的独立问题，再送去检索和回答生成。
 *
 * 不做这一步的话，检索词生成（buildLegalQuery）拿到的就是这句孤零零的话，
 * 生成不出"foreign investment / non-resident shareholder"这类真正该查的检索词——
 * 检索这一步错了，后面所有环节都救不回来（这是这个功能要解决的原始bug）。
 *
 * 遵循项目一贯的"提示词不可靠"原则：模型改写的结果必须过一道确定性校验，
 * 校验不过（为空、太短、原样照抄了上一问）或者调用本身失败，一律退回
 * buildFallbackQuestion() 的确定性拼接兜底——绝不能让追问在这一步悄悄丢失
 * 新问的内容，也不能让上一轮的背景事实（例如"阿联酋公司""新设公司"）悄悄消失。
 * 这个教训来自对 AstrBot 的调研：它的LLM摘要压缩失败时会静默插入空摘要，
 * 没有任何日志，历史就此无声丢失（GitHub Issue #8133）——我们不能重蹈。
 */
import { requestStructuredJson } from "./deepseek";

export type TopicRelation = "CONTINUATION" | "NEW_TOPIC";

export interface RewriteInput {
  /** 用户这一轮实际打的字。 */
  question: string;
  /** 上一轮的自包含问题（首问时就是首问原文）。 */
  previousSelfContainedQuestion: string;
  previousShortConclusion: string;
  /**
   * 上一轮「法规要求」各条的首句。**判"是不是追问"要用到它**——
   * 用户追问时接的是上一个答案里的内容，不是上一个问题的字面。
   * 见 `previousTurnComparableText` 的说明。缺省时退化成只比问题，行为和改动前一致。
   */
  previousMandatoryFirstSentences?: string[];
  /** 上一轮引用到的法律名。同上。 */
  previousCitedLaws?: string[];
}

export interface RewriteLog {
  input: string;
  output: string;
  usedFallback: boolean;
  durationMs: number;
}

export interface RewriteOutcome {
  selfContainedQuestion: string;
  topicRelation: TopicRelation;
  usedFallback: boolean;
  log: RewriteLog;
}

const MIN_REWRITE_LENGTH = 6;

/**
 * 确定性拼接兜底：改写失败时用这个，而不是裸用用户这一轮的原始追问。
 * 保证背景事实（来自上一轮自包含问题）和这一轮的新问题都在，哪怕措辞不够自然。
 */
export function buildFallbackQuestion(previousSelfContainedQuestion: string, question: string): string {
  return `${previousSelfContainedQuestion}。用户接着问：${question}`;
}

/**
 * 改写结果是否可用。两个失败模式都见过对应的真实教训：
 *   - 太短/空：模型没有真正产出内容
 *   - 和上一轮自包含问题完全相同：模型把旧问题原样搬了回来，等于丢掉了这一轮真正问的内容
 */
export function isRewriteAcceptable(rewritten: string, previousSelfContainedQuestion: string): boolean {
  const trimmed = rewritten.trim();
  if (trimmed.length < MIN_REWRITE_LENGTH) return false;
  if (trimmed === previousSelfContainedQuestion.trim()) return false;
  return true;
}

/**
 * 真正的追问在语言上有个稳定特征：**它是省略句**——靠指代词或省略主语来依赖上文。
 * "那这个的期限是多久""上面提到的那部法呢""还需要准备什么"，都带着回指的痕迹。
 * 反过来，一个自带主语、自成一句的问题（"货票同行在印度具体需要做到哪些要求？"）
 * 不需要上文也能独立检索，它是新话题。
 */
const REFERRING_EXPRESSION = /这|那|它|其|该|此|上述|上面|前面|刚才|刚刚|之前|同样|另外|还有|继续|接着|以上|你说的|提到的/;

/** 问题里有没有指代词。额度闸门也要用（见 followup-charging.ts），所以导出。 */
export function hasReferringExpression(question: string): boolean {
  return REFERRING_EXPRESSION.test(question.trim());
}

/** 抽出可比对的词：中文按二元组（单字噪声太大），英文/数字按词。 */
function contentTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) terms.add(word);
  for (const run of text.match(/[一-龥]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) terms.add(run.slice(i, i + 2));
  }
  return terms;
}

/** 这一问的词有多少比例也出现在上一问里。上一问为空时返回 0。 */
export function questionOverlapRatio(question: string, previousQuestion: string): number {
  const current = contentTerms(question);
  if (current.size === 0) return 0;
  const previous = contentTerms(previousQuestion);
  let hit = 0;
  for (const term of current) if (previous.has(term)) hit += 1;
  return hit / current.size;
}

/**
 * 上一轮的**可比对文本**：上一问 + 上一个答案的要点。
 *
 * ## 为什么必须把答案算进来
 *
 * 真实事故（2026-09-21 用户实测）：上一问是"向中国母公司支付特许权使用费，
 * 需要代扣哪些税、走什么申报流程"，追问是"中印税收协定下的优惠税率是多少？
 * 具体需要怎样申请"——**明显是同一件事的下一步**，却被判成新话题、扣了一次费。
 *
 * 实测重合度只有 **0.048**：「特许权使用费」和「优惠税率」一个共同的字都没有。
 *
 * 根因不是阈值定高了，是**比较的对象选错了**。人在对话里追问，接的是
 * "你刚才答案里提到的那个东西"，不是"你上一个问题里的词"——
 * 上一个答案讲了 10% 优惠税率、税收居民证明、Form 145，用户顺着问下去，
 * 用的自然是答案里的词。只比问题↔问题，等于假设用户会重复自己的提问用词。
 *
 * 把答案要点纳入之后，同一对实测从 0.048 升到 **0.476**；
 * 而 2026-09-16 那次真正的跑题事故（广告费判例 → 货票同行）仍然是 0.063，
 * 没有被带坏——因为那两件事确实不相干。
 *
 * ## 只取要点，不取整篇答案
 *
 * 答案全文几千字，词汇面铺得太广，什么问题都能蹭上一点重合度，
 * 阈值就失去意义了。所以只取三样**代表这一轮谈了什么**的短文本：
 * 结论、各条法规要求的首句、引用到的法律名。这三样在 `ConversationTurn`
 * 里本来就存着（当初是为了给模型做上下文），不需要新增存储。
 */
export function previousTurnComparableText(previous: {
  selfContainedQuestion?: string;
  shortConclusion?: string;
  mandatoryFirstSentences?: string[];
  citedLaws?: string[];
}): string {
  return [
    previous.selfContainedQuestion ?? "",
    previous.shortConclusion ?? "",
    ...(previous.mandatoryFirstSentences ?? []),
    ...(previous.citedLaws ?? []),
  ].filter(Boolean).join(" ");
}

/** 词面重合低于这个比例，且没有任何指代词时，判定为新话题。估的初始值，需要用真实对话调。 */
const NEW_TOPIC_OVERLAP_THRESHOLD = 0.2;

/**
 * 短于这个长度的问题一律不否决。
 *
 * 复核时实测发现的误伤（2026-09-17）：中文追问经常**连指代词都不用**，直接省略主语——
 * "需要多少注册资本？""董事必须有印度居民吗？""注册大概要多久？"——它们既没有指代词，
 * 句子又短、词面重合天然就低，于是全被判成了新话题。这道判断实际上是在惩罚
 * "问得短"，不是在识别"换了话题"。
 *
 * 一个真正自足的问题必须自带足够多属于自己的内容才站得住；短句几乎必然依赖上文。
 * 所以先过长度这一关，再谈重合度。上面那三句分别是 9/11/8 个字，
 * 真实事故里那句"货票同行在印度具体需要做到哪些要求？"是 18 个字。
 */
const SELF_CONTAINED_MIN_LENGTH = 14;

/**
 * 确定性否决：模型说"延续"，但这一问既不带任何指代词、又和上一问几乎没有词面重合时，
 * 一律改判为新话题。
 *
 * 真实事故（2026-09-16）：上一问是"印度公司的广告费有什么判例、怎样才能合规"，
 * 这一问是"货票同行在印度具体需要做到哪些要求？"——一个完全自足的GST问题。
 * 模型判成了 CONTINUATION，于是这一问被改写成带广告费背景的问题，
 * 回答出来全是广告费台账、广告发票、账簿保存，和货票同行毫无关系。
 *
 * 为什么要确定性兜底而不是改提示词：**两类误判的代价完全不对称**。
 * 把新话题误判成延续 → 答案整个跑题，用户还看不出为什么（他并不知道系统在偷偷拼上文）；
 * 把延续误判成新话题 → 最多丢掉背景、多追问一句，用户补一句就好。
 * 所以这里宁可错杀延续，不可放过跑题。
 */
export function shouldForceNewTopic(question: string, previousComparableText: string): boolean {
  const trimmed = question.trim();
  // 太短的问题不否决：短≠换话题，见 SELF_CONTAINED_MIN_LENGTH 的说明。
  if (trimmed.length < SELF_CONTAINED_MIN_LENGTH) return false;
  if (REFERRING_EXPRESSION.test(trimmed)) return false;
  // 第二个参数是**上一轮的可比对文本**（上一问 + 答案要点），不只是上一问——
  // 见 previousTurnComparableText。只比问题时，"特许权使用费→优惠税率"这种
  // 正常的追问重合度只有 0.048，会被误判成新话题并扣费。
  return questionOverlapRatio(trimmed, previousComparableText) < NEW_TOPIC_OVERLAP_THRESHOLD;
}

interface RawRewrite {
  topic_relation?: string;
  rewritten_question?: string;
}

export async function rewriteFollowUp(input: RewriteInput): Promise<RewriteOutcome> {
  const startedAt = Date.now();
  const fallbackQuestion = () => buildFallbackQuestion(input.previousSelfContainedQuestion, input.question);

  try {
    const { data } = await requestStructuredJson<RawRewrite>({
      role: "query",
      maxTokens: 400,
      messages: [
        {
          role: "system",
          content: `你是对话上下文助手，专门处理法律问答里的"追问"场景。
任务：判断用户这一次说的话，是延续上一个法律问题，还是转向了一个新话题；
如果是延续，把它改写成一个不看上文也能看懂、能直接拿去检索法律条文的完整问题。

只输出JSON：{"topic_relation":"CONTINUATION","rewritten_question":"完整问题"}

规则：
1. topic_relation 只能是 CONTINUATION（延续同一件事）或 NEW_TOPIC（明显换了不相关的另一件事）。
2. 判断标准：这一次的话单独拿出来看，如果缺了上文的背景事实（主体身份、公司类型、
   交易类型等）就没法准确判断该查哪部法律、哪些条款，就是 CONTINUATION；
   如果不需要上文背景也能独立、准确地检索和回答，就是 NEW_TOPIC。
3. 是 CONTINUATION 时，rewritten_question 必须：
   - 把回答这次问题必要的背景事实从上一问里带过来，不需要再看上一轮对话就能看懂问的是什么
   - 只问这一次实际问的内容，不要把上一问已经答过的内容当成新问题重复问一遍
   - 是一个自然的中文问句，不是关键词堆砌
4. 是 NEW_TOPIC 时，rewritten_question 输出空字符串即可，不会被使用。`,
        },
        {
          role: "user",
          content: `上一问（已补全为自包含问题）：${input.previousSelfContainedQuestion}
上一问的结论：${input.previousShortConclusion}
用户这一次接着问：${input.question}`,
        },
      ],
    });

    /*
     * 注意默认方向：只有模型**明确**说 CONTINUATION 才当延续，其余（NEW_TOPIC、
     * 拼错、空值、没这个字段）一律当新话题。原来写的是反过来的——不是 NEW_TOPIC 就当延续，
     * 于是模型只要含糊一下，这一问就会被拼上上一问的背景。按上面 shouldForceNewTopic
     * 里说的那个不对称：跑题的代价远大于丢背景的代价，含糊时应当落在安全的那一边。
     */
    const modelSaysContinuation = data.topic_relation === "CONTINUATION";
    const topicRelation: TopicRelation = modelSaysContinuation
      && !shouldForceNewTopic(input.question, previousTurnComparableText({
        selfContainedQuestion: input.previousSelfContainedQuestion,
        shortConclusion: input.previousShortConclusion,
        mandatoryFirstSentences: input.previousMandatoryFirstSentences,
        citedLaws: input.previousCitedLaws,
      }))
      ? "CONTINUATION"
      : "NEW_TOPIC";

    if (topicRelation === "NEW_TOPIC") {
      return {
        selfContainedQuestion: input.question,
        topicRelation: "NEW_TOPIC",
        usedFallback: false,
        log: { input: input.question, output: input.question, usedFallback: false, durationMs: Date.now() - startedAt },
      };
    }

    const rewritten = typeof data.rewritten_question === "string" ? data.rewritten_question.trim() : "";
    if (isRewriteAcceptable(rewritten, input.previousSelfContainedQuestion)) {
      return {
        selfContainedQuestion: rewritten,
        topicRelation: "CONTINUATION",
        usedFallback: false,
        log: { input: input.question, output: rewritten, usedFallback: false, durationMs: Date.now() - startedAt },
      };
    }

    const fallback = fallbackQuestion();
    return {
      selfContainedQuestion: fallback,
      topicRelation: "CONTINUATION",
      usedFallback: true,
      log: { input: input.question, output: fallback, usedFallback: true, durationMs: Date.now() - startedAt },
    };
  } catch {
    // 调用本身失败（网络/超时/解析）——同样退回确定性拼接，不是裸用原始追问。
    const fallback = fallbackQuestion();
    return {
      selfContainedQuestion: fallback,
      topicRelation: "CONTINUATION",
      usedFallback: true,
      log: { input: input.question, output: fallback, usedFallback: true, durationMs: Date.now() - startedAt },
    };
  }
}
