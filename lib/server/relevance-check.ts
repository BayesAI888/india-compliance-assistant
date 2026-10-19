import type { AnswerResponse } from "../contracts";
import { requestStructuredJson } from "./deepseek";
import { cosineSimilarity, embedTexts, isEmbeddingConfigured } from "./embeddings";
import type { RetrievedKnowledgeChunk } from "./retrieval";
import { decodeVector, readVectorIndex, vectorKey } from "./vector-store";

/**
 * 通用的"证据主题相关性"校验——补 quote-check.ts 留下的那个缺口。
 *
 * 起因是一次真实事故：一条"须申请PAN和TAN"的法规要求，挂的引用是《生产者公司组建》
 * 条款。quote-check.ts 判定 VERIFIED，因为模型附的英文原句确实一字不差地出现在
 * 那条证据里——但那段原文讲的是生产者公司的组建程序，跟PAN、TAN毫无关系。
 * quote-check 只回答"这句话是否逐字出现"，不回答"这段证据是否真的支持这条结论"，
 * 这道检查补的就是这个缺口，而且不再局限于某一类具体主张（PAN/TAN那次是临时用
 * claim-check.ts 的关键词法子窄范围堵的），对所有 MANDATORY 步骤通用。
 *
 * 两层判断，为了不让每条步骤都多付一次模型调用的延迟和费用：
 * 1. 向量初筛：结论文本 vs 它引用的证据文本，算余弦相似度。
 *    证据这一侧直接复用检索阶段已经算好、存在 vector-store.ts 里的向量，
 *    不重新嵌入；结论这一侧一次回答批量嵌入一次。相似度够高或够低的直接有结论，
 *    不升级。
 * 2. 模型判断：只有"看着不太对但不够确定"的中间地带才升级，问模型这段证据是否
 *    真的蕴含这条结论（不是话题相关）。复用 second-pass.ts 那套 requestStructuredJson
 *    调用方式，同样用便宜快的 query 角色。
 *
 * 判定为主题不符的步骤直接从 action_steps 里删掉——这是产品决策：这类失败比
 * "没有引用"更危险（带着看起来有依据的角标），不适合只是弱警示，索性不呈现。
 * 不留提示、不留痕迹（对应地，如果因此一条 MANDATORY 步骤都不剩，上层会整体退回
 * UNABLE_TO_CONFIRM，不会出现"一条法规要求都没有却显示成功"的怪异结果）。
 *
 * 没配置向量密钥、或 RELEVANCE_CHECK=off 时整体跳过，行为等同这道检查不存在——
 * 和 dense-retrieval.ts 的降级哲学一致：宁可少一层校验，也不能让回答整体失败。
 * 这一层内部任何未预期的错误也按"跳过"处理，不牵连主流程。
 */

type Step = AnswerResponse["action_steps"][number];

export function isRelevanceCheckEnabled() {
  const flag = process.env.RELEVANCE_CHECK?.trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return false;
  return isEmbeddingConfigured();
}

/**
 * 两条阈值目前是估的初始值，没有实测的中英跨语言相似度分布支撑——
 * 上线后要用真实案例（包括这次PAN/生产者公司的事故文本）跑几轮再调。
 * 做成环境变量方便不改代码直接调。
 */
const LOW_SIMILARITY = Number(process.env.RELEVANCE_LOW_THRESHOLD?.trim()) || 0.3;
const HIGH_SIMILARITY = Number(process.env.RELEVANCE_HIGH_THRESHOLD?.trim()) || 0.55;

/** 证据文本喂给模型判断时的截断长度，避免一条超长 Chunk 把 token 预算吃满。 */
const MAX_EVIDENCE_CHARS_FOR_JUDGE = 3000;

export type RelevanceVerdict = "RELEVANT" | "IRRELEVANT" | "ESCALATE";

/**
 * 纯函数：按两条阈值给一个相似度分数分档。单独拆出来是为了能在不接向量API的
 * 自测环境里，用固定分数直接测三档的边界行为（这个项目里所有能拆成纯函数的
 * 校验逻辑都这么处理——deepseek.ts/embeddings.ts 的网络调用没法在本地自测里跑，
 * 但"给定分数该归哪一档"这件事本身是确定性的，不该因为拆不开网络调用就测不到）。
 */
export function classifySimilarity(
  score: number,
  low = LOW_SIMILARITY,
  high = HIGH_SIMILARITY,
): RelevanceVerdict {
  if (score >= high) return "RELEVANT";
  if (score < low) return "IRRELEVANT";
  return "ESCALATE";
}

/**
 * 逐条算 MANDATORY 步骤的"结论 vs 已引用证据"最大相似度。
 * 没挂引用的步骤不参与——没有可比对的对象，也不是这道检查要管的失败类型
 * （那属于"完全没依据"，claim-check/coverage-check 已经在管）。
 */
async function computeStepSimilarities(
  steps: Step[],
  evidence: RetrievedKnowledgeChunk[],
): Promise<Map<number, number>> {
  const candidates = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.kind === "MANDATORY" && step.citation_refs.length > 0);
  if (candidates.length === 0) return new Map();

  const [index, vectors] = await Promise.all([
    readVectorIndex(),
    embedTexts(candidates.map(({ step }) => step.text)),
  ]);

  const scores = new Map<number, number>();
  candidates.forEach(({ step, index: stepIndex }, position) => {
    const claimVector = vectors[position];
    if (!claimVector) return; // 这条结论没嵌入成功，交由下面统一按"跳过评分"处理

    let best = 0;
    for (const ref of step.citation_refs) {
      const chunk = evidence[ref - 1];
      if (!chunk) continue;
      const entry = index.get(vectorKey(chunk.documentId, chunk.number));
      if (!entry) continue;
      for (const window of entry.windows) {
        const similarity = cosineSimilarity(claimVector, decodeVector(window));
        if (similarity > best) best = similarity;
      }
    }
    scores.set(stepIndex, best);
  });
  return scores;
}

/** 中间地带升级用的模型判断：这段证据是否真的蕴含这条结论。失败时返回 undefined。 */
async function judgeEntailment(claimText: string, evidenceText: string): Promise<boolean | undefined> {
  try {
    const { data } = await requestStructuredJson<{ supported?: unknown }>({
      role: "query",
      maxTokens: 200,
      messages: [
        {
          role: "system",
          content: `你是法律证据相关性判官。给定一条中文法律结论和一段被它引用的英文证据原文，
判断这段证据是否**真的支持（蕴含）**这条结论——不是话题相近、不是都在讲同一部法律，
而是这段原文的具体内容能不能推出这条结论。
例如"须申请PAN和TAN"这条结论，如果证据讲的是另一件事（比如某类公司的组建程序），
即使两者都属于印度公司合规，也不算支持。
只输出JSON：{"supported": true 或 false}`,
        },
        {
          role: "user",
          content: `结论：${claimText}\n\n证据原文：${evidenceText.slice(0, MAX_EVIDENCE_CHARS_FOR_JUDGE)}`,
        },
      ],
    });
    return typeof data.supported === "boolean" ? data.supported : undefined;
  } catch {
    return undefined;
  }
}

function evidenceTextFor(step: Step, evidence: RetrievedKnowledgeChunk[]): string {
  return step.citation_refs
    .map((ref) => evidence[ref - 1])
    .filter((chunk): chunk is RetrievedKnowledgeChunk => Boolean(chunk))
    .map((chunk) => `${chunk.majorTitle} ${chunk.minorTitle}\n${chunk.body}`)
    .join("\n---\n");
}

export interface RelevanceFilterResult {
  steps: Step[];
  /** 被判定主题不符、已从 action_steps 里删掉的步骤数——不下发给用户，只在服务端可见。 */
  removedCount: number;
}

/**
 * 过滤掉主题不符的 MANDATORY 步骤。PRACTICAL 步骤不在这道检查范围内
 * （和 quote-check.ts 的范围保持一致——它们本来就靠 practical-grounding.ts
 * 借用 MANDATORY 的引用，MANDATORY 被过滤后自然不会再借到）。
 */
export async function filterIrrelevantSteps(options: {
  steps: Step[];
  evidence: RetrievedKnowledgeChunk[];
}): Promise<RelevanceFilterResult> {
  if (!isRelevanceCheckEnabled()) return { steps: options.steps, removedCount: 0 };

  try {
    const scores = await computeStepSimilarities(options.steps, options.evidence);
    if (scores.size === 0) return { steps: options.steps, removedCount: 0 };

    const toRemove = new Set<number>();
    for (const [stepIndex, score] of scores) {
      const verdict = classifySimilarity(score);
      if (verdict === "RELEVANT") continue;
      if (verdict === "IRRELEVANT") {
        toRemove.add(stepIndex); // 明显不相关，不用再升级确认
        continue;
      }
      // ESCALATE：中间地带，升级到模型判断
      const step = options.steps[stepIndex];
      const evidenceText = evidenceTextFor(step, options.evidence);
      const supported = await judgeEntailment(step.text, evidenceText);
      // 模型判断失败时按"可疑"处理，不悄悄放过——原则和 quote-check.ts 一致：
      // 这类"看起来有依据"的失败比"没有依据"更危险，宁可误删也不能漏判。
      if (supported === false || supported === undefined) toRemove.add(stepIndex);
    }

    if (toRemove.size === 0) return { steps: options.steps, removedCount: 0 };
    const steps = options.steps.filter((_, index) => !toRemove.has(index));
    return { steps, removedCount: toRemove.size };
  } catch {
    // 这层校验本身出错不能连累整条回答——按"跳过"处理，等同没做这道检查。
    return { steps: options.steps, removedCount: 0 };
  }
}
