import type { AnswerResponse } from "../contracts";

/**
 * 法规要求 ↔ 证据 ↔ 实务建议 的一致性校验。
 *
 * 起因是线上观察到的两个现象，本质是同一个问题——**实务建议超出了法规要求的范围**：
 * 1. 实务建议里写了"向RBI提交FC-GPR"，但法规要求里根本没有 RBI 那一组，
 *    尽管 RBI Master Direction 的条文确实被检索到并作为证据下发了；
 * 2. 实务建议里写了"召开董事会/股东会通过特别决议"（业内公认正确），
 *    但法规要求里没有对应条目，尽管公司法 s62 就是这么规定的。
 *
 * 也就是说模型知道要做这些事，却没把对应的法定要求记下来。
 * 这在合规产品里是有害的：用户看"法规要求"以为那就是全部义务，
 * 而真正的依据散落在"建议"里，看起来像可做可不做。
 *
 * 这里只做**检测和暴露**，不尝试自动补写——凭空生成一条法定要求正是最该避免的事。
 */

type Step = AnswerResponse["action_steps"][number];

export interface CoverageGaps {
  /** 提供了证据、但没有任何一条法规要求引用它的法律。 */
  uncitedSources: string[];
  /** 引用了证据、却被写成"建议"而不是"法规要求"的条目数量。 */
  practicalWithLegalBasis: number;
}

export function findCoverageGaps(options: {
  steps: Step[];
  /** 与 citation_refs 对应的证据来源名，索引从 0 开始。 */
  evidenceSources: string[];
}): CoverageGaps {
  const { steps, evidenceSources } = options;

  const citedByMandatory = new Set<string>();
  let practicalWithLegalBasis = 0;

  for (const step of steps) {
    const sources = step.citation_refs
      .map((ref) => evidenceSources[ref - 1])
      .filter((source): source is string => Boolean(source));
    if (step.kind === "MANDATORY") {
      sources.forEach((source) => citedByMandatory.add(source));
    } else if (sources.length > 0) {
      // 有法条依据却被归到"实务建议"——这类条目应该同时（或改为）出现在法规要求里。
      practicalWithLegalBasis += 1;
    }
  }

  const uncitedSources = [...new Set(evidenceSources)]
    .filter((source) => source && !citedByMandatory.has(source));

  return { uncitedSources, practicalWithLegalBasis };
}

/**
 * 把「某部法律有证据、但法规要求里没有它」的缺口补上——办法是把引用了这部法律的
 * 实务建议**归位**到法规要求里。
 *
 * 为什么这样做是安全的：这条内容是模型自己写的、而且自己给它挂了法条引用。
 * 按我们自己的定义，有法条依据的事项就是法定要求，不是可做可不做的建议。
 * 归位只是把它放回正确的栏目，**没有凭空生成任何新内容**——凭空写一条法定要求
 * 才是最该避免的事。
 *
 * 只处理"这部法律在法规要求里一条都没有"的情况，不做全量搬迁，
 * 避免把实务建议整个搬空（那样又会变成另一个极端）。
 */
export function promoteUncoveredPractical(options: {
  steps: Step[];
  evidenceSources: string[];
}): { steps: Step[]; promoted: string[] } {
  const { steps, evidenceSources } = options;
  const gaps = findCoverageGaps({ steps, evidenceSources });
  if (gaps.uncitedSources.length === 0) return { steps, promoted: [] };

  const uncovered = new Set(gaps.uncitedSources);
  const promoted: string[] = [];
  const next = steps.map((step) => {
    if (step.kind !== "PRACTICAL" || step.citation_refs.length === 0) return step;
    const sources = step.citation_refs
      .map((ref) => evidenceSources[ref - 1])
      .filter((source): source is string => Boolean(source));
    const hit = sources.find((source) => uncovered.has(source));
    if (!hit) return step;
    // 这部法律已经补上了，后面同样引用它的建议不再重复归位。
    uncovered.delete(hit);
    promoted.push(hit);
    return { ...step, kind: "MANDATORY" as const };
  });

  // 归位后法规要求排前、实务建议排后，保持展示顺序。
  const mandatory = next.filter((step) => step.kind === "MANDATORY");
  const practical = next.filter((step) => step.kind === "PRACTICAL");
  return { steps: [...mandatory, ...practical], promoted };
}

/** 把检测结果转成写给用户看的提示。没有问题时返回空数组。 */
export function coverageNotes(gaps: CoverageGaps): string[] {
  const notes: string[] = [];
  if (gaps.uncitedSources.length > 0) {
    notes.push(
      `本次检索到以下法律的条文，但「法规要求」里没有列出对应义务，可能有遗漏，`
      + `建议结合原文复核：${gaps.uncitedSources.join("；")}。`,
    );
  }
  if (gaps.practicalWithLegalBasis > 0) {
    notes.push(
      `有 ${gaps.practicalWithLegalBasis} 条实务建议标注了法条依据——`
      + `这类事项属于法定要求而非可选建议，请按强制义务对待。`,
    );
  }
  return notes;
}
