import type { AnswerResponse } from "../contracts";
import { HIERARCHY_RANK } from "./legal-hierarchy";
import { resolveHierarchy, type PublishedKnowledgeChunk } from "./knowledge-store";
import { findUnverifiedClaims } from "./claim-check";
import { normalizeForQuoteMatch } from "./quote-check";
import { scopeCandidates, type LegalQueryPackage, type RetrievedKnowledgeChunk } from "./retrieval";

/**
 * 原句核验失败后的确定性引用修复。
 *
 * 这不是让模型重答，也不根据中文结论猜一条法律：只拿模型已经声明的英文原句，
 * 在本题可适用、同法域的已发布知识库里逐字找出处。找到了才补进角标；找不到仍然
 * 保留 NOT_FOUND 警示。这样既能修正"原句来自 s149、却挂到 Directors Rules"，也不会
 * 为了消除红字而制造一个看似合理的引用。
 */

type Step = AnswerResponse["action_steps"][number];

interface QuoteMatch {
  chunk: PublishedKnowledgeChunk;
}

const MIN_QUOTE_LENGTH = 25;

function findQuoteMatch(quote: string, candidates: PublishedKnowledgeChunk[]): QuoteMatch | undefined {
  if (quote.trim().length < MIN_QUOTE_LENGTH) return undefined;
  const needle = normalizeForQuoteMatch(quote);
  if (!needle) return undefined;

  // 这里**只接受整句逐字命中**。原句核验的常规路径可容忍跨 chunk 的长锚点，
  // 但修复路径面对的是全库 1 万多个 chunk；逐个计算最长公共片段既昂贵，也会把
  // "像一句法条"误认成出处。精确命中已经可跨越 PDF 的换行、连字符与脚注排版，
  // 因为 normalizeForQuoteMatch 已经统一处理了这些差异。
  const matches: QuoteMatch[] = [];
  for (const chunk of candidates) {
    const body = normalizeForQuoteMatch(chunk.body);
    if (!body) continue;
    if (body.includes(needle)) matches.push({ chunk });
  }

  // 同一段原句偶尔会在 Act 和 Rules 的资料中重复。两者都能逐字支撑结论时，
  // 选位阶更高的 Act；真正只有 Rules 的程序性要求，则仍会保留 Rules。
  return matches.sort((left, right) => {
    const hierarchy = HIERARCHY_RANK[resolveHierarchy(left.chunk)]
      - HIERARCHY_RANK[resolveHierarchy(right.chunk)];
    if (hierarchy !== 0) return hierarchy;
    return `${left.chunk.documentId}:${left.chunk.number}`
      .localeCompare(`${right.chunk.documentId}:${right.chunk.number}`);
  })[0];
}

/**
 * 对当前角标之外的可适用资料做一次原句反向检索。
 *
 * 添加而非替换旧角标：旧的 Rules / circular 仍可能支持这条要求的其他部分；新增的
 * Act 会因位阶规则成为前端的主法源，并让英文原句与实际角标严格对应。
 */
export function repairQuoteCitations(options: {
  steps: Step[];
  evidence: RetrievedKnowledgeChunk[];
  publishedChunks: PublishedKnowledgeChunk[];
  question: string;
  targetDate?: string;
  jurisdiction?: LegalQueryPackage["jurisdiction"];
}): { steps: Step[]; evidence: RetrievedKnowledgeChunk[] } {
  const needsRepair = options.steps.some((step) =>
    step.kind === "MANDATORY"
    && step.quote_status === "NOT_FOUND"
    && Boolean(step.source_quote?.trim()));
  if (!needsRepair) return { steps: options.steps, evidence: options.evidence };

  // 与主检索共用期间、辖区、法域及新旧法替代的闸门，不能因为修复一条角标就绕开它们。
  const candidates = scopeCandidates(options.publishedChunks, {
    question: options.question,
    time_context: options.targetDate,
    jurisdiction: options.jurisdiction,
  }).dateScoped;
  const evidence = [...options.evidence];
  const indexOf = new Map(
    evidence.map((chunk, index) => [`${chunk.documentId}::${chunk.number}`, index + 1]),
  );

  const steps = options.steps.map((step) => {
    if (step.kind !== "MANDATORY" || step.quote_status !== "NOT_FOUND" || !step.source_quote) {
      return step;
    }

    const matched = findQuoteMatch(step.source_quote, candidates);
    if (!matched) return step;

    const key = `${matched.chunk.documentId}::${matched.chunk.number}`;
    let ref = indexOf.get(key);
    if (!ref) {
      evidence.push({
        ...matched.chunk,
        evidenceId: `E${evidence.length + 1}`,
        score: 0,
        element: "原句核验修复",
      });
      ref = evidence.length;
      indexOf.set(key, ref);
    }

    const citationRefs = [...new Set([...step.citation_refs, ref])].sort((a, b) => a - b);
    const nextStep: Step = { ...step, citation_refs: citationRefs };
    // 引用变多后，顺便重新检查该条的硬数值；不能让已经补到正确 Act 的 182 天
    // 仍因为旧角标范围太窄而挂着无意义的警示。
    return { ...nextStep, unverified_claims: findUnverifiedClaims(nextStep, evidence) };
  });

  return { steps, evidence };
}
