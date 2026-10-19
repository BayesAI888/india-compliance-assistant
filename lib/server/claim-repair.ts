import type { AnswerResponse } from "../contracts";
import { extractCheckableClaims, findUnverifiedClaims } from "./claim-check";
import { englishCardinalVariants } from "./english-number";
import type { PublishedKnowledgeChunk } from "./knowledge-store";
import { coversDate, matchesJurisdiction, type LegalQueryPackage } from "./retrieval";

/**
 * 数值校验没通过时的补救检索。
 *
 * 起因：第一版做完校验后，界面上会出现"⚠ 30天 未在引用条文中找到出处，请核对官方原文"。
 * 用户的评价是"这是废话"——说得对。系统明明还有一整个知识库没搜，
 * 却把核对工作直接甩给用户，这不是负责，是偷懒。
 *
 * 所以这里做第二次、更有针对性的检索：带着那个具体数值（30天 / FC-GPR / 74%）
 * 回库里找能证明它的条文。
 * - 找到了 → 把这条补进引用、清掉警示，用户看到的是有出处的答案
 * - 确实没有 → 才保留提示，此时提示是有意义的（知识库真的缺这部分）
 *
 * 全过程不额外调用模型：只是把已有的关键词检索用在一个更窄的目标上，
 * 没有额外延迟和费用，也不会引入新的编造风险。
 */

type Step = AnswerResponse["action_steps"][number];

interface EvidenceChunk extends PublishedKnowledgeChunk {
  evidenceId: string;
  score: number;
  element?: string;
}

/** 把中文步骤里的数值转成可用于检索英文法条的关键词。 */
function claimSearchTerms(claim: string): string[] {
  // 表格编号：FC-GPR / PAS-3 这类，直接当关键词，并补一个去掉连字符的写法
  if (/^[A-Za-z]/.test(claim)) {
    return [claim.toLowerCase(), claim.replace(/-/g, "").toLowerCase(), claim.replace(/-/g, " ").toLowerCase()];
  }
  // 期限："30天" → 30 / thirty days
  const days = claim.match(/^(\d+)天$/);
  if (days) {
    const number = Number(days[1]);
    const words = englishCardinalVariants(number);
    return [
      `${days[1]} days`,
      `${days[1]} day`,
      ...words.flatMap((word) => [`${word} days`, `${word} day`]),
    ];
  }
  // 百分比："74%" → 74 per cent
  const percent = claim.match(/^([\d.]+)%$/);
  if (percent) return [`${percent[1]} per cent`, `${percent[1]}%`];
  return [claim.toLowerCase()];
}

function countOccurrences(haystack: string, needle: string) {
  if (!needle) return 0;
  // 纯字母的短词（PAN、TAN……）容易是其他单词的一部分——"pan"是"company"的子串，
  // "tan"是"standard""important"的子串。这类词必须按整词边界数，否则一部满是
  // "company"的公司法文本会给PAN刷出虚高分数，репair把毫不相关的条文当成找到了依据，
  // 悄悄清掉本该保留的警示（这道检查本身就是为了拦"看起来有依据、实际没有"这类问题）。
  // 带连字符/数字的表格编号（FC-GPR、PAS-3……）不会有这个问题，仍按原样数子串。
  if (/^[a-z]+$/.test(needle)) {
    const matches = haystack.match(new RegExp(`\\b${needle}\\b`, "g"));
    return matches ? Math.min(matches.length, 5) : 0;
  }
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) >= 0) {
    count += 1;
    position += needle.length;
    if (count >= 5) break;
  }
  return count;
}

/**
 * 针对某个数值做窄检索：把它的检索词和这条步骤原本引用的来源结合起来打分，
 * 优先在同一部法律里找，找不到再放宽到全库。
 */
function searchForClaim(
  claim: string,
  step: Step,
  evidence: EvidenceChunk[],
  candidates: PublishedKnowledgeChunk[],
): PublishedKnowledgeChunk | undefined {
  const terms = claimSearchTerms(claim);
  // 这条步骤已经引用了哪些来源——同一部法律里的条文优先。
  const preferredSources = new Set(
    step.citation_refs
      .map((ref) => evidence[ref - 1]?.source)
      .filter((source): source is string => Boolean(source)),
  );

  let best: { chunk: PublishedKnowledgeChunk; score: number } | undefined;
  for (const chunk of candidates) {
    const haystack = `${chunk.majorTitle} ${chunk.minorTitle} ${chunk.body}`.toLowerCase();
    let score = 0;
    for (const term of terms) score += countOccurrences(haystack, term) * 10;
    if (score === 0) continue;
    if (preferredSources.has(chunk.source)) score += 25;
    if (!best || score > best.score) best = { chunk, score };
  }
  return best?.chunk;
}

export function repairUnverifiedClaims(options: {
  steps: Step[];
  evidence: EvidenceChunk[];
  publishedChunks: PublishedKnowledgeChunk[];
  targetDate?: string;
  jurisdiction?: LegalQueryPackage["jurisdiction"];
}): { steps: Step[]; evidence: EvidenceChunk[] } {
  const flagged = options.steps.some((step) => step.unverified_claims.length > 0);
  if (!flagged) return { steps: options.steps, evidence: options.evidence };

  // 补充检索同样要过适用期间和辖区这两道闸，不能为了补一个数字就引入不适用的条文。
  const candidates = options.publishedChunks.filter((chunk) =>
    matchesJurisdiction(chunk, options.jurisdiction) && coversDate(chunk, options.targetDate));

  const evidence = [...options.evidence];
  const indexOf = new Map(evidence.map((chunk, index) => [`${chunk.documentId}::${chunk.number}`, index + 1]));

  const steps = options.steps.map((step) => {
    if (step.unverified_claims.length === 0) return step;

    const addedRefs: number[] = [];
    for (const claim of step.unverified_claims) {
      const found = searchForClaim(claim, step, evidence, candidates);
      if (!found) continue;
      const key = `${found.documentId}::${found.number}`;
      let ref = indexOf.get(key);
      if (!ref) {
        // 新证据追加在末尾，保证已有角标编号不发生位移。
        evidence.push({
          ...found,
          evidenceId: `E${evidence.length + 1}`,
          score: 0,
          element: "补充核验",
        });
        ref = evidence.length;
        indexOf.set(key, ref);
      }
      addedRefs.push(ref);
    }

    if (addedRefs.length === 0) return step;
    const citationRefs = [...new Set([...step.citation_refs, ...addedRefs])].sort((a, b) => a - b);
    const nextStep: Step = { ...step, citation_refs: citationRefs };
    // 用扩充后的引用重新校验一次：这次还找不到的，才是知识库真的缺。
    return { ...nextStep, unverified_claims: findUnverifiedClaims(nextStep, evidence) };
  });

  return { steps, evidence };
}

export { extractCheckableClaims };
