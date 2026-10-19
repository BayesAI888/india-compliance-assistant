import type { PublishedKnowledgeChunk } from "./knowledge-store";

/**
 * 条文交叉引用自动跟进。
 *
 * 根因：法律要件是在**看到任何证据之前**、只凭中文问题猜出来的。猜到的才检索得到，
 * 没猜到的条文不是排序靠后——是压根没进候选池。实测到的漏项（Section 42 私募配售、
 * Section 39 / PAS-3 配发申报）在知识库里都有，只是这一轮没被想到。
 *
 * 人做合规是反过来的：先读 s62，看到条文里牵出 private placement，再去翻 s42。
 * 这里就是把这个动作自动化——从已经检索到的条文正文里，正则抽出它引用的
 * Section / Rule / Schedule 编号，把同一部法里那些条文也拉进证据集。
 *
 * 刻意做成**确定性的、零模型调用**：不需要判断"这条相关不相关"，
 * 是不是相关由立法者自己决定了——法条明文引用了它，它就是这条规则的一部分。
 * 这也让它天然通用：公司法、GST、所得税都适用，不针对任何具体领域打补丁。
 */

/**
 * 抓 "section 42"、"sub-section (2) of section 62"、"rule 21"、"schedule I" 这类引用。
 * 只认阿拉伯数字编号和罗马数字附表，不去解析 "the said section" 这类指代——
 * 猜错了会把不相关的条文塞进证据，宁可少抓。
 */
const SECTION_REFERENCE = /\bsection\s+(\d+[A-Z]{0,2})\b/gi;
const RULE_REFERENCE = /\brule\s+(\d+[A-Z]{0,2})\b/gi;
const SCHEDULE_REFERENCE = /\bschedule\s+([IVX]{1,5})\b/gi;

function collect(pattern: RegExp, text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match[1]) found.push(match[1].toUpperCase());
  }
  return found;
}

/** 把 chunk 的定位标题解析成"这是第几条"，用于和正文里抽到的编号对上。 */
function chunkNumbers(chunk: PublishedKnowledgeChunk) {
  const minor = chunk.minorTitle;
  return {
    sections: collect(new RegExp(SECTION_REFERENCE.source, "gi"), minor),
    rules: collect(new RegExp(RULE_REFERENCE.source, "gi"), minor),
    schedules: collect(new RegExp(SCHEDULE_REFERENCE.source, "gi"), minor),
  };
}

export interface CrossReferenceOptions {
  /** 第一轮检索到的证据。 */
  evidence: PublishedKnowledgeChunk[];
  /** 候选池（已经过适用期间与辖区过滤）。 */
  candidates: PublishedKnowledgeChunk[];
  /** 最多补充几条，防止一条法引出几十条把提示词撑爆。 */
  limit?: number;
}

/**
 * 返回"被已有证据明文引用、但还没进证据集"的条文。
 * 只在**同一部资料内部**跟进：跨文件的编号重名太多（各法都有 Section 2），
 * 跨文件跟进会引入大量噪声。
 */
export function followCrossReferences(options: CrossReferenceOptions): PublishedKnowledgeChunk[] {
  const { evidence, candidates, limit = 6 } = options;
  if (evidence.length === 0) return [];

  const already = new Set(evidence.map((chunk) => `${chunk.documentId}::${chunk.number}`));
  const picked: PublishedKnowledgeChunk[] = [];
  const pickedKeys = new Set<string>();

  for (const chunk of evidence) {
    const body = chunk.body;
    const wantedSections = new Set(collect(new RegExp(SECTION_REFERENCE.source, "gi"), body));
    const wantedRules = new Set(collect(new RegExp(RULE_REFERENCE.source, "gi"), body));
    const wantedSchedules = new Set(collect(new RegExp(SCHEDULE_REFERENCE.source, "gi"), body));
    // 自己引用自己不算（条文里经常写 "this section"、"sub-section (2) of section 62"）。
    const own = chunkNumbers(chunk);
    own.sections.forEach((value) => wantedSections.delete(value));
    own.rules.forEach((value) => wantedRules.delete(value));
    own.schedules.forEach((value) => wantedSchedules.delete(value));

    if (wantedSections.size + wantedRules.size + wantedSchedules.size === 0) continue;

    for (const candidate of candidates) {
      if (picked.length >= limit) break;
      // 只在同一部资料内部跟进。
      if (candidate.source !== chunk.source) continue;
      const key = `${candidate.documentId}::${candidate.number}`;
      if (already.has(key) || pickedKeys.has(key)) continue;

      const numbers = chunkNumbers(candidate);
      const matched = numbers.sections.some((value) => wantedSections.has(value))
        || numbers.rules.some((value) => wantedRules.has(value))
        || numbers.schedules.some((value) => wantedSchedules.has(value));
      if (!matched) continue;

      pickedKeys.add(key);
      picked.push(candidate);
    }
    if (picked.length >= limit) break;
  }

  return picked;
}
