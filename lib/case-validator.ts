/**
 * 解析 `scripts/case-extract.mjs` 产出的判例结构化草稿（或管理员手改过的同格式文件）。
 *
 * 和 `knowledge-validator.ts` 是同一个思路：先把纯文本按固定模板解析成结构化字段，
 * 服务端和客户端（上传前预览）共用同一份解析逻辑，不会出现"客户端预览显示没问题，
 * 服务端一存就报错"这种两套逻辑不一致的坑。
 *
 * 模板字段和顺序是产品定好的，改字段名/顺序要连这里一起改：
 * 案件名称 / 法院与年份 / IndianKanoon文档ID / 争议税种以及主管税局 /
 * 税局主张(Revenue's Position) / 企业抗辩方向(Assessee's Argument) /
 * 最终裁定结果 / 证据支撑要点 / 印度数据库链接 / （可选）对中资企业的参考价值
 */

export interface ParsedCase {
  caseName: string;
  courtAndYear: string;
  docid: string;
  taxTypeAndAuthority: string;
  revenuePosition: string[];
  assesseeArgument: string[];
  finalRuling: string[];
  evidenceSupport: string[];
  officialUrl: string;
  referenceValueNote: string;
}

export interface CaseValidationResult {
  status: "READY_TO_REVIEW" | "VALIDATION_FAILED";
  errors: string[];
  warnings: string[];
  parsed?: ParsedCase;
}

const PLACEHOLDER = "文档中未明确提及";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 抓 `**Label**：内容`，内容一直取到下一个 `**` 粗体标签、`---` 分隔线或文末为止。
 *
 * 冒号后面故意不写 `\s*` 直接跳过空白——踩过一个坑：字段真的留空时（比如空白模板
 * 给管理员手填，某个可选字段没填），`\s*` 会贪婪吃掉冒号后所有空行，把下一个标签
 * 整段错误地并入当前字段。现在让懒惰捕获组自己去够到下一个标签前的换行为止，
 * 交给 `.trim()` 去掉两端空白——留空的字段这样能正确解析成空字符串，而不是吞掉邻居字段。
 */
function extractField(text: string, label: string): string {
  const pattern = new RegExp(`\\*\\*${escapeRegExp(label)}\\*\\*[：:]([\\s\\S]*?)(?=\\n\\*\\*|\\n---|$)`);
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

/** 章节标题写法是 `## 对中资企业的参考价值`，不是粗体标签，单独抓。 */
function extractSection(text: string, heading: string): string {
  const pattern = new RegExp(`##\\s*${escapeRegExp(heading)}\\s*\\n+([\\s\\S]*?)$`);
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

/** 把 "1. xxx\n2. yyy" 这种编号列表拆成数组；没有编号格式时把整段当成一条。 */
function parseList(value: string): string[] {
  if (!value) return [];
  const items = [...value.matchAll(/^\d+\.\s+(.+)$/gm)].map((match) => match[1].trim());
  if (items.length > 0) return items;
  return [value.trim()];
}

export function validateCaseText(fileName: string, rawText: string): CaseValidationResult {
  const normalized = rawText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!normalized.trim()) {
    errors.push("文件为空。");
    return { status: "VALIDATION_FAILED", errors, warnings };
  }

  const caseName = extractField(normalized, "案件名称");
  const courtAndYear = extractField(normalized, "法院与年份");
  const docid = extractField(normalized, "IndianKanoon文档ID");
  const taxTypeAndAuthority = extractField(normalized, "争议税种以及主管税局");
  const revenuePositionRaw = extractField(normalized, "税局主张（Revenue's Position）")
    || extractField(normalized, "税局主张(Revenue's Position)");
  const assesseeArgumentRaw = extractField(normalized, "企业抗辩方向（Assessee's Argument）")
    || extractField(normalized, "企业抗辩方向(Assessee's Argument)");
  const finalRulingRaw = extractField(normalized, "最终裁定结果");
  const evidenceSupportRaw = extractField(normalized, "证据支撑要点");
  const officialUrl = extractField(normalized, "印度数据库链接");
  const referenceValueNote = extractSection(normalized, "对中资企业的参考价值");

  // 必填：没有这几项，这条记录在问答里没法用（没法定位案件、没法核实出处）。
  if (!caseName) errors.push("缺少【案件名称】。");
  if (!docid) errors.push("缺少【IndianKanoon文档ID】。");
  if (!officialUrl) errors.push("缺少【印度数据库链接】。");
  if (officialUrl && !/^https?:\/\//i.test(officialUrl)) errors.push("【印度数据库链接】不是http/https地址。");
  if (!revenuePositionRaw) errors.push("缺少【税局主张】。");
  if (!assesseeArgumentRaw) errors.push("缺少【企业抗辩方向】。");
  if (!finalRulingRaw) errors.push("缺少【最终裁定结果】。");

  // 占位符提醒（不阻断——模型老实说"不知道"比瞎编好，但要提醒管理员这条数据不完整）。
  const fieldsToCheck: Array<[string, string]> = [
    ["法院与年份", courtAndYear],
    ["争议税种以及主管税局", taxTypeAndAuthority],
  ];
  for (const [label, value] of fieldsToCheck) {
    if (value === PLACEHOLDER) warnings.push(`【${label}】标注为"${PLACEHOLDER}"，发布前建议人工补充。`);
  }
  if (normalized.includes("⚠️ 原文超过")) {
    warnings.push("原文提炼时被截断过，模型可能没看到判决书后半部分的论证，建议对照原文核对一遍再发布。");
  }

  if (errors.length > 0) {
    return { status: "VALIDATION_FAILED", errors, warnings };
  }

  return {
    status: "READY_TO_REVIEW",
    errors,
    warnings,
    parsed: {
      caseName,
      courtAndYear: courtAndYear || PLACEHOLDER,
      docid,
      taxTypeAndAuthority: taxTypeAndAuthority || PLACEHOLDER,
      revenuePosition: parseList(revenuePositionRaw),
      assesseeArgument: parseList(assesseeArgumentRaw),
      finalRuling: parseList(finalRulingRaw),
      evidenceSupport: parseList(evidenceSupportRaw),
      officialUrl,
      referenceValueNote: referenceValueNote || PLACEHOLDER,
    },
  };
}
