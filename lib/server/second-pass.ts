import { EVIDENCE_QUOTA } from "../contracts";
import { requestStructuredJson } from "./deepseek";
import type { PublishedKnowledgeChunk } from "./knowledge-store";
import {
  retrieveKnowledge,
  type LegalQueryPackage,
  type RetrievedKnowledgeChunk,
} from "./retrieval";

/**
 * 二次检索闭环。
 *
 * 这是"完整性"这一类错误的根因所在：法律要件是在**看到任何证据之前**、
 * 只凭中文问题猜出来的。猜到的才检索得到，没猜到的条文不是排序靠后——是压根没进候选池。
 * 实测漏掉的 Section 42（私募配售）、Section 39 / PAS-3（配发申报）在知识库里都有，
 * 只是第一轮没想到要找它们，于是整个管线再也没有第二次机会。
 *
 * 人做合规是反过来的：先读一遍手上的条文，发现"这里只讲了发行程序，没讲配发后的申报"，
 * 再去补查。这里就是把这一步补上——第一轮证据拿到后先不写答案，
 * 而是让模型对着已有证据回答一个问题：**就这个问题而言，还有哪些义务是这些条文没覆盖的？**
 * 把它说缺的那几项再检索一轮，合并后才生成答案。
 *
 * 代价是多一次模型调用（约 5-10 秒）。`SECOND_PASS_RETRIEVAL=off` 可以一键关掉，
 * 关掉后行为与改动前完全一致。
 */

export function isSecondPassEnabled() {
  return (process.env.SECOND_PASS_RETRIEVAL ?? "on").toLowerCase() !== "off";
}

interface GapElement {
  label: string;
  terms_en: string;
}

function cleanGapElements(value: unknown): GapElement[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: GapElement[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const termsEn = typeof record.terms_en === "string" ? record.terms_en.trim() : "";
    // terms_en 必须是英文：关键词打分会把非英文字符全部剥掉，
    // 只给中文标签的要件在关键词那一路贡献为零（这个坑这个项目踩过）。
    if (!label || !termsEn || !/[a-z]/i.test(termsEn)) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    result.push({ label, terms_en: termsEn });
    if (result.length >= EVIDENCE_QUOTA.maxElementsHardCap) break;
  }
  return result;
}

/** 让模型对着第一轮证据指出缺口。失败时返回空数组，调用方按"没有缺口"处理。 */
export async function findEvidenceGaps(options: {
  question: string;
  evidence: RetrievedKnowledgeChunk[];
}): Promise<GapElement[]> {
  const summary = options.evidence
    .map((chunk) => `- ${chunk.source} / ${chunk.majorTitle} / ${chunk.minorTitle}`)
    .join("\n");

  try {
    const { data } = await requestStructuredJson<{ missing_elements?: unknown }>({
      role: "query",
      maxTokens: 600,
      messages: [
        {
          role: "system",
          content: `你是印度法律检索的复核助手。下面给出的是针对用户问题**第一轮**检索到的条文清单。
你的任务不是回答问题，而是指出**还缺什么**。
只输出JSON：{"missing_elements":[{"label":"中文标签","terms_en":"english search terms"}]}
要求：
1. 逐项检查：就用户这个问题而言，实务上必须履行的义务里，哪些在上面的清单中**没有对应条文**？
   典型的遗漏是"程序做完了但申报没覆盖"——例如清单里有发行股份的程序条款，
   却没有配发之后向登记机关申报的条款；或者有实体规则，却没有对应的申报表格与时限规定。
1b. ⚠**时限锚点必须检查**：如果清单里某条义务的时限是**相对某个事件**计算的
   （"AGM后60天内"、"配发后30天内"、"收到通知后X天内"），那么**规定该事件本身何时必须发生
   的条文，是否也在清单里**？不在就是缺口，必须列出来。
   实测踩过的坑：年度合规的回答里每条时限都写"AGM后N天"，却没有一条说明AGM本身
   必须在财政年度结束后6个月内召开（公司法 s96）——用户只知道相对天数、不知道起点日期，
   等于一个截止日都排不出来。这类锚点条文通常就在知识库里，只是第一轮没想到要找。
2. 每一项都要给 terms_en（法条原文里真实会出现的英文措辞，保留 Section / Rule / Form 编号），
   不能写中文、不能为空。
3. **只列真正缺失的**。清单里已经有的不要重复列出；拿不准的宁可不列。
4. 最多列 ${EVIDENCE_QUOTA.maxElementsHardCap} 项。一项都不缺就返回 {"missing_elements":[]}。`,
        },
        {
          role: "user",
          content: `用户问题：${options.question}

第一轮检索到的条文：
${summary || "（空）"}`,
        },
      ],
    });
    return cleanGapElements(data.missing_elements);
  } catch {
    return [];
  }
}

/**
 * 针对缺口要件再检索一轮，返回第一轮里没有的新证据。
 * 复用 `retrieveKnowledge`，所以适用期间、辖区、同 Section 合并、配额这些约束全都继续生效。
 */
export function retrieveForGaps(options: {
  publishedChunks: PublishedKnowledgeChunk[];
  baseQuery: LegalQueryPackage;
  gaps: GapElement[];
  alreadyPicked: RetrievedKnowledgeChunk[];
}): PublishedKnowledgeChunk[] {
  const { publishedChunks, baseQuery, gaps, alreadyPicked } = options;
  if (gaps.length === 0) return [];

  const gapQuery: LegalQueryPackage = {
    ...baseQuery,
    // 缺口检索单独成一层：它有自己的证据额度，不和第一轮抢名额。
    legal_layers: [{ layer: "二次检索缺口", elements: gaps }],
    legal_elements: gaps.map((gap) => gap.label),
  };

  const { evidence } = retrieveKnowledge(publishedChunks, gapQuery);
  const seen = new Set(alreadyPicked.map((chunk) => `${chunk.documentId}::${chunk.number}`));
  return evidence.filter((chunk) => !seen.has(`${chunk.documentId}::${chunk.number}`));
}
