import { NextResponse } from "next/server";
import {
  CaseValidationError,
  getCaseOverview,
  publishCase,
  stageCase,
  withdrawCase,
} from "../../../../lib/server/case-store";

const MAX_TXT_BYTES = 2 * 1024 * 1024;

export async function GET() {
  const cases = await getCaseOverview();
  return NextResponse.json({ cases }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "请求格式无效。" }, { status: 400 });
  }

  if (payload.action === "stage") {
    const fileName = typeof payload.fileName === "string" ? payload.fileName.trim() : "";
    const text = typeof payload.text === "string" ? payload.text : "";
    const lowerName = fileName.toLowerCase();
    if (!(lowerName.endsWith(".md") || lowerName.endsWith(".txt")) || !text) {
      return NextResponse.json({ error: "MD_REQUIRED", message: "请上传有内容的案例md或txt文件（按九字段模板格式）。" }, { status: 400 });
    }
    if (new TextEncoder().encode(text).byteLength > MAX_TXT_BYTES) {
      return NextResponse.json({ error: "FILE_TOO_LARGE", message: "文件不能超过2MB——这个模板不该有这么大。" }, { status: 413 });
    }
    try {
      const staged = await stageCase(fileName, text);
      return NextResponse.json({
        id: staged.record.id,
        status: staged.record.status,
        caseName: staged.record.caseName,
        docid: staged.record.docid,
        duplicate: staged.duplicate,
      }, { status: staged.duplicate ? 200 : 201 });
    } catch (error) {
      if (error instanceof CaseValidationError) {
        return NextResponse.json({
          error: "VALIDATION_FAILED",
          message: error.message,
          errors: error.errors,
          warnings: error.warnings,
        }, { status: 422 });
      }
      return NextResponse.json({ error: "STORE_FAILED", message: "案例保存失败，请重试。" }, { status: 500 });
    }
  }

  if (payload.action === "publish" || payload.action === "restore") {
    const id = typeof payload.id === "string" ? payload.id.trim() : "";
    if (!id) return NextResponse.json({ error: "ID_REQUIRED", message: "缺少案例标识。" }, { status: 400 });
    const record = await publishCase(id);
    if (!record) return NextResponse.json({ error: "CASE_NOT_FOUND", message: "没有找到这条案例。" }, { status: 404 });
    return NextResponse.json({ id: record.id, status: record.status, publishedAt: record.publishedAt });
  }

  if (payload.action === "withdraw") {
    const id = typeof payload.id === "string" ? payload.id.trim() : "";
    if (!id) return NextResponse.json({ error: "ID_REQUIRED", message: "缺少案例标识。" }, { status: 400 });
    const record = await withdrawCase(id);
    if (!record) return NextResponse.json({ error: "CASE_NOT_FOUND", message: "没有找到这条案例。" }, { status: 404 });
    return NextResponse.json({ id: record.id, status: record.status, withdrawnAt: record.withdrawnAt });
  }

  return NextResponse.json({ error: "UNKNOWN_ACTION", message: "不支持的操作。" }, { status: 400 });
}
