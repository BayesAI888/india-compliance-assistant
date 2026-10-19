import type { TermReading } from "./term-ambiguity";
import ExcelJS from "exceljs";

/**
 * 解析管理员上传的《印度合规助手_中英文检索词典模板》工作簿，
 * 只从"词典主表"取数据，筛出 workflow_status=PUBLISHED 的词条，
 * 转换成运行时检索用的词典结构（供 lib/server/terms-store.ts 落盘、
 * lib/server/retrieval.ts 加载使用）。
 *
 * 《知识库数据规范》约定：DRAFT/REVIEW_PENDING 不可检索，
 * PUBLISHED 已发布且通过质检才可导入，DEPRECATED 已废弃。
 */

const SHEET_NAME = "词典主表";

const REQUIRED_HEADERS = [
  "term_id",
  "zh_term",
  "en_canonical",
  "domain",
  "workflow_status",
] as const;

const KNOWN_HEADERS = [
  "term_id", "zh_term", "zh_aliases", "en_canonical", "en_aliases",
  "must_terms", "exclude_terms", "domain", "subdomain", "term_type",
  "scope_note", "source_id", "source_reference", "source_locator",
  "source_url", "workflow_status", "version_no", "effective_from",
  "effective_to", "reviewed_by", "reviewed_at", "change_note",
] as const;

const WORKFLOW_STATUSES = ["DRAFT", "REVIEW_PENDING", "PUBLISHED", "DEPRECATED"] as const;
type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/**
 * 词典的 domain 列是中文一级领域标签（见"选项字典"工作表），
 * 运行时词典用的是代码里的 Domain 枚举（lib/contracts.ts）。
 * "公司设立/MCA/ROC"在文档里是一个标签，但代码里拆成了两个领域，
 * 两边都标注，检索时不吃亏。
 */
const DOMAIN_LABEL_MAP: Record<string, string[]> = {
  "公司设立/MCA/ROC": ["company_incorporation", "mca_roc"],
  "FEMA/FDI/RBI": ["fema_fdi_rbi"],
  "GST": ["gst"],
  "所得税/TDS/TP": ["income_tax_tds_tp"],
  "进出口/海关": ["import_export_customs"],
  "行业监管": ["industry_regulation"],
  "诉讼案例": ["litigation_cases"],
};

export interface StoredApprovedTerm {
  term_zh: string;
  aliases_zh: string[];
  official_term_en: string;
  search_terms_en: string[];
  domain: string[];
  exclusions: string;
  expert_notes: string;
  source: string;
  status: "APPROVED";
  /**
   * 多义词的候选义项。**不来自 xlsx**——`buildApprovedGlossary()` 从不产出这个字段，
   * 它由 `terms-store.ts` 在读取时从 `config/term-readings.json` 合并上来。
   * 放在这里只是为了类型上说得通；想加多义词请改那个 JSON，不要加 xlsx 列。
   */
  readings?: TermReading[];
}

interface ParsedTermRow {
  rowNumber: number;
  termId: string;
  zhTerm: string;
  zhAliases: string[];
  enCanonical: string;
  enAliases: string[];
  mustTerms: string[];
  excludeTerms: string[];
  domainLabel: string;
  scopeNote: string;
  sourceReference: string;
  sourceLocator: string;
  workflowStatus: WorkflowStatus;
}

export interface TermsWorkbookResult {
  rows: ParsedTermRow[];
  errors: string[];
  warnings: string[];
  totalRows: number;
  publishedCount: number;
}

function splitList(value: string): string[] {
  return value.split(";").map((item) => item.trim()).filter(Boolean);
}

/** 读取单元格，容忍空值和非字符串（比如日期被读成Date对象）。 */
function cellText(value: ExcelJS.CellValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((item) => item.text).join("").trim();
    }
    if ("result" in value) return cellText(value.result);
    if ("text" in value && typeof value.text === "string") return value.text.trim();
  }
  return String(value).trim();
}

export async function parseTermsWorkbook(buffer: ArrayBuffer): Promise<TermsWorkbookResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    return { rows: [], errors: ["文件无法解析，请确认这是有效的.xlsx文件。"], warnings, totalRows: 0, publishedCount: 0 };
  }

  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) {
    return {
      rows: [], warnings, totalRows: 0, publishedCount: 0,
      errors: [`没有找到"${SHEET_NAME}"工作表，请确认上传的是《中英文检索词典模板》。`],
    };
  }

  const grid: Array<Array<ExcelJS.CellValue | undefined>> = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    // ExcelJS 的 values 是从列号 1 开始的稀疏数组，切掉第 0 位后与原来的
    // sheet_to_json(header: 1) 保持同一列序号与空值语义。
    grid[rowNumber - 1] = (row.values as Array<ExcelJS.CellValue | undefined>).slice(1);
  });
  if (grid.length < 2) {
    return { rows: [], errors: ["词典主表里没有数据行。"], warnings, totalRows: 0, publishedCount: 0 };
  }

  const header = grid[0].map((value) => cellText(value));
  const missingHeaders = REQUIRED_HEADERS.filter((name) => !header.includes(name));
  if (missingHeaders.length) {
    return {
      rows: [], warnings, totalRows: 0, publishedCount: 0,
      errors: [`词典主表缺少必需的列：${missingHeaders.join("、")}。请不要改动表头行。`],
    };
  }

  const columnIndex = Object.fromEntries(
    KNOWN_HEADERS.map((name) => [name, header.indexOf(name)]),
  ) as Record<(typeof KNOWN_HEADERS)[number], number>;
  const get = (row: Array<ExcelJS.CellValue | undefined>, name: (typeof KNOWN_HEADERS)[number]) => {
    const index = columnIndex[name];
    return index >= 0 ? cellText(row[index]) : "";
  };

  const rows: ParsedTermRow[] = [];
  const seenTermIds = new Map<string, number>();

  for (let rowIndex = 1; rowIndex < grid.length; rowIndex += 1) {
    const raw = grid[rowIndex];
    const rowNumber = rowIndex + 1; // Excel 里的实际行号，从1数起
    const termId = get(raw, "term_id");
    const zhTerm = get(raw, "zh_term");
    if (!termId && !zhTerm) continue; // 空行，跳过不报错

    if (!termId) { errors.push(`第${rowNumber}行缺少【term_id】。`); continue; }
    if (!zhTerm) { errors.push(`第${rowNumber}行（${termId}）缺少【zh_term】。`); continue; }

    const enCanonical = get(raw, "en_canonical");
    if (!enCanonical) { errors.push(`第${rowNumber}行（${termId}）缺少【en_canonical】。`); continue; }

    const domainLabel = get(raw, "domain");
    if (!domainLabel) { errors.push(`第${rowNumber}行（${termId}）缺少【domain】。`); continue; }

    const workflowStatusRaw = get(raw, "workflow_status");
    if (!WORKFLOW_STATUSES.includes(workflowStatusRaw as WorkflowStatus)) {
      errors.push(`第${rowNumber}行（${termId}）的【workflow_status】="${workflowStatusRaw || "空"}"不是合法值（应为${WORKFLOW_STATUSES.join("/")}）。`);
      continue;
    }

    if (seenTermIds.has(termId)) {
      errors.push(`第${rowNumber}行的 term_id "${termId}" 与第${seenTermIds.get(termId)}行重复。`);
      continue;
    }
    seenTermIds.set(termId, rowNumber);

    if (!DOMAIN_LABEL_MAP[domainLabel]) {
      warnings.push(`第${rowNumber}行（${termId}）的领域标签"${domainLabel}"不在已知列表里，这条词会被同步但领域统计可能不准，建议核对"选项字典"里的领域列。`);
    }

    rows.push({
      rowNumber,
      termId,
      zhTerm,
      zhAliases: splitList(get(raw, "zh_aliases")),
      enCanonical,
      enAliases: splitList(get(raw, "en_aliases")),
      mustTerms: splitList(get(raw, "must_terms")),
      excludeTerms: splitList(get(raw, "exclude_terms")),
      domainLabel,
      scopeNote: get(raw, "scope_note"),
      sourceReference: get(raw, "source_reference"),
      sourceLocator: get(raw, "source_locator"),
      workflowStatus: workflowStatusRaw as WorkflowStatus,
    });
  }

  const publishedCount = rows.filter((row) => row.workflowStatus === "PUBLISHED").length;
  if (rows.length > 0 && publishedCount === 0) {
    warnings.push(
      `这份工作簿里有${rows.length}条词条，但没有一条 workflow_status=PUBLISHED。`
      + "同步后运行时检索词典会变成空的——如果不是故意的，请先把审核通过的词条改成PUBLISHED再重新上传。",
    );
  }
  return { rows, errors, warnings, totalRows: rows.length, publishedCount };
}

/** 只把 workflow_status=PUBLISHED 的词条转换成运行时词典用的结构。 */
export function buildApprovedGlossary(rows: ParsedTermRow[]): StoredApprovedTerm[] {
  return rows
    .filter((row) => row.workflowStatus === "PUBLISHED")
    .map((row): StoredApprovedTerm => {
      const domain = DOMAIN_LABEL_MAP[row.domainLabel] ?? [row.domainLabel];
      const searchTermsEn = [...new Set([
        row.enCanonical,
        ...row.enAliases,
        ...row.mustTerms,
      ].map((value) => value.trim()).filter(Boolean))];
      const source = [row.sourceReference, row.sourceLocator].filter(Boolean).join(" ");
      return {
        term_zh: row.zhTerm,
        aliases_zh: row.zhAliases,
        official_term_en: row.enCanonical,
        search_terms_en: searchTermsEn,
        domain,
        exclusions: row.excludeTerms.length ? `不应与以下概念混淆：${row.excludeTerms.join("、")}` : "",
        expert_notes: row.scopeNote,
        source: source || "未标注来源",
        status: "APPROVED",
      };
    });
}
