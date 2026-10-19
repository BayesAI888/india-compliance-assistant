import { NextResponse } from "next/server";
import { buildApprovedGlossary, parseTermsWorkbook } from "../../../../lib/server/terms-workbook";
import { hasSyncedTerms, readApprovedGlossary, readTermsSyncMeta, writeApprovedGlossary } from "../../../../lib/server/terms-store";
import { refreshApprovedGlossaryCache } from "../../../../lib/server/retrieval";

const MAX_XLSX_BYTES = 15 * 1024 * 1024;

/**
 * 《产品规则表》约定：运行时检索词典只来源于管理员上传的
 * 《中英文检索词典模板》。有更新就同步——上传一次、校验通过就直接替换，
 * 不再额外要求逐词条人工审核（workflow_status=PUBLISHED 本身就是文档里的审核结果）。
 */
export async function GET() {
  const [glossary, meta, synced] = await Promise.all([
    readApprovedGlossary(),
    readTermsSyncMeta(),
    hasSyncedTerms(),
  ]);
  return NextResponse.json({
    synced,
    meta,
    termCount: glossary.length,
    sample: glossary.slice(0, 5).map((term) => ({
      term_zh: term.term_zh,
      official_term_en: term.official_term_en,
      domain: term.domain,
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "INVALID_FORM", message: "请求格式无效，请重新上传。" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "FILE_REQUIRED", message: "请选择要上传的.xlsx词典文件。" }, { status: 400 });
  }
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return NextResponse.json({ error: "XLSX_REQUIRED", message: "只接收.xlsx文件。" }, { status: 400 });
  }
  if (file.size > MAX_XLSX_BYTES) {
    return NextResponse.json({ error: "FILE_TOO_LARGE", message: "文件不能超过15MB。" }, { status: 413 });
  }

  const buffer = await file.arrayBuffer();
  const parsed = await parseTermsWorkbook(buffer);
  if (parsed.errors.length > 0) {
    return NextResponse.json({
      error: "VALIDATION_FAILED",
      message: "词典校验未通过，本次没有同步，检索词典保持原样。",
      totalRows: parsed.totalRows,
      publishedCount: parsed.publishedCount,
      errors: parsed.errors,
      warnings: parsed.warnings,
    }, { status: 422 });
  }

  const glossary = buildApprovedGlossary(parsed.rows);
  const meta = {
    sourceFileName: file.name,
    syncedAt: new Date().toISOString(),
    totalRows: parsed.totalRows,
    publishedCount: parsed.publishedCount,
    warnings: parsed.warnings,
  };

  try {
    await writeApprovedGlossary(glossary, meta);
    // 立刻让正在运行的问答服务用上新词典，不需要重新构建或重启。
    await refreshApprovedGlossaryCache();
  } catch {
    return NextResponse.json({ error: "STORE_FAILED", message: "词典保存失败，请重试。" }, { status: 500 });
  }

  return NextResponse.json({
    synced: true,
    meta,
    termCount: glossary.length,
    warnings: parsed.warnings,
  }, { status: 200 });
}
