/**
 * 多义词消歧：一个中文词对应好几个互不相干的英文法律概念时，别让模型自己挑。
 *
 * ## 起因（2026-09-28 实测）
 *
 * 用户问「印度 income tax（ITD）案件中，**保证金**计算的基数包括哪些？」
 * 系统答的是**利息（interest）的计算基数**，还在前提假设第一条写着
 * 「用户问题中的"保证金"指所得税法下的利息（interest）」。
 *
 * 链路是这样断的：
 *
 *   1. 47 条已审定术语里**没有「保证金」** → 词典零命中、零英文检索词、法域 unknown。
 *   2. 翻译整件事只能交给模型。模型看到「income tax」+「**计算的基数**」，
 *      检索回来的是 s.234 那一族利息条款——而那些条款**真的在定义"计算基数"**
 *      （assessed tax、tax due on returned income）。
 *   3. 模型手上只有这些证据，为了让「保证金」和证据对上，**把问题里的词重新定义了**。
 *
 * **这不是编造事实，是悄悄改了问题。** 比编造更难发现：每一条引用都是真的、
 * 每一个数字都有出处，只是回答的不是用户问的那件事。
 * `evidence_sufficiency` 也报 FULL——按模型改过的那个问题，证据确实充分。
 * 自我申报挡不住"答了另一个问题"。
 *
 * ## 为什么不能简单加一条「保证金 → pre-deposit」
 *
 * 因为保证金在中文里本来就是好几个不同的法律概念，案例库里四种都有：
 *
 *   上诉预缴   pre-deposit          Apple India vs Delhi VAT（pre-deposit Rs.2 crores）
 *   客户押金   security deposit     三件「customer security deposit write-back 是否课税」
 *   履约保证金 performance guarantee
 *   刑事保释金 bail
 *
 * 映射成任何一个，另外三类问法就反过来答错。而原来的词典结构是**一对一**的
 * （`term_zh` → 一个 `official_term_en`），根本装不下多义词。
 *
 * ## 这里的做法
 *
 * 词条可以挂多个 `readings`，每个义项带自己的**上下文触发词**和英文检索词。
 *
 *   问题里有触发词 → 按它选，并在答案里写明"按××理解"（用户看得见，能纠正）。
 *   一个触发词都没有 → **不选**，转 NEED_INFORMATION，把候选列给用户挑。
 *
 * "这个词有歧义"是查表，确定性的；真正的选择交回给用户。
 * 这正是 `missing_information` 设计出来要干的事——它的规则写着
 * "用户本人能直接回答的问题"，而"你说的保证金是哪一种"就是。
 *
 * ## 刻意不做的事
 *
 * **不按"哪个义项的检索结果多"来自动选。** 那等于让知识库的藏书量决定用户在问什么——
 * 库里 pre-deposit 的资料多，就把所有保证金都当 pre-deposit。这恰恰是上面那个
 * 事故的同一个错误：让证据反过来定义问题。
 */

/** 一个义项。 */
export interface TermReading {
  /** 稳定标识，用于测试和日志，不展示给用户。 */
  id: string;
  /** 给用户看的中文说法，会出现在追问选项里。 */
  label_zh: string;
  official_term_en: string;
  /**
   * 上下文触发词：问题里出现其中任意一个，就认为用户说的是这个义项。
   *
   * 写的时候要挑**只属于这个义项**的词。「税」「金额」这种哪个义项都沾边的词
   * 放进来，等于让这个义项永远第一个命中，多义词表就白做了。
   */
  context_zh: string[];
  search_terms_en: string[];
  domain: string[];
}

/** 词典条目里和多义词有关的部分。没有 `readings` 的老条目行为完全不变。 */
export interface TermWithReadings {
  term_zh: string;
  aliases_zh?: string[];
  readings?: TermReading[];
}

export interface ResolvedTerm {
  term_zh: string;
  reading: TermReading;
  /** 命中的是哪个上下文词。写进答案的说明里，让用户知道系统凭什么这么理解。 */
  matchedContext: string;
}

export interface UnresolvedTerm {
  term_zh: string;
  candidates: TermReading[];
}

export interface AmbiguityResult {
  resolved: ResolvedTerm[];
  unresolved: UnresolvedTerm[];
}

function mentionsTerm(question: string, term: TermWithReadings): boolean {
  const q = question.toLowerCase();
  return [term.term_zh, ...(term.aliases_zh ?? [])]
    .filter(Boolean)
    .some((trigger) => q.includes(trigger.trim().toLowerCase()));
}

/**
 * 问题里提到的多义词，分成"消歧成功"和"消歧不了"两堆。
 *
 * 只看有 `readings` 的条目——一对一的老条目不经过这里，行为和以前一模一样。
 */
export function resolveAmbiguousTerms(
  question: string,
  terms: TermWithReadings[],
): AmbiguityResult {
  const resolved: ResolvedTerm[] = [];
  const unresolved: UnresolvedTerm[] = [];
  if (!question.trim()) return { resolved, unresolved };
  const q = question.toLowerCase();

  for (const term of terms) {
    const readings = term.readings ?? [];
    if (readings.length < 2) continue;          // 不是多义词
    if (!mentionsTerm(question, term)) continue;

    // 命中了上下文触发词的义项。可能不止一个——那说明问题里同时提到了
    // 两个义项的语境（"上诉时客户押金要不要一起缴"），一样算消歧不了。
    const hits: Array<{ reading: TermReading; matchedContext: string }> = [];
    for (const reading of readings) {
      const matched = reading.context_zh.find((word) => word && q.includes(word.toLowerCase()));
      if (matched) hits.push({ reading, matchedContext: matched });
    }

    if (hits.length === 1) {
      resolved.push({ term_zh: term.term_zh, reading: hits[0].reading, matchedContext: hits[0].matchedContext });
    } else {
      // 0 个命中 = 完全没线索；2 个以上 = 线索互相打架。两种都不许猜。
      unresolved.push({ term_zh: term.term_zh, candidates: readings });
    }
  }
  return { resolved, unresolved };
}

/**
 * 消歧不了时，拿去问用户的那一句。
 *
 * 一个词一句，直接把候选念出来。**不要写成"请补充更多信息"**这种空话——
 * 用户看不出该补什么，只会重问一遍原来的问题。
 */
export function ambiguityQuestion(term: UnresolvedTerm): string {
  const options = term.candidates.map((r) => `${r.label_zh}（${r.official_term_en}）`).join("、");
  return `你说的「${term.term_zh}」指的是哪一种：${options}？`;
}

/**
 * 消歧成功时，附在答案里的说明。
 *
 * 必须显式告诉用户"我是按哪个意思理解的"——系统是靠一个上下文词猜的，
 * 猜错时用户得能一眼看出来并纠正。不写这句，错误的理解就藏住了，
 * 那就退回成了这个模块要修的那个问题。
 */
export function readingNote(resolved: ResolvedTerm): string {
  return `本次把问题里的「${resolved.term_zh}」按「${resolved.reading.label_zh}`
    + `（${resolved.reading.official_term_en}）」理解`
    + `（依据是问题里出现了「${resolved.matchedContext}」）。`
    + `如果你指的是别的意思，请在问题里说明。`;
}

/** 消歧成功的义项贡献的英文检索词。 */
export function readingSearchTerms(result: AmbiguityResult): string[] {
  return [...new Set(result.resolved.flatMap((r) => r.reading.search_terms_en))];
}
