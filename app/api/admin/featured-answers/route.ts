import { NextResponse } from "next/server";
import { getPublishedKnowledgeChunks } from "../../../../lib/server/knowledge-store";
import {
  featuredKnowledgeVersion,
  listFeaturedAnswers,
  updateFeaturedAnswer,
  type FeaturedAnswerTextUpdate,
} from "../../../../lib/server/featured-answer-store";

function knowledgeVersionOf(chunks: Awaited<ReturnType<typeof getPublishedKnowledgeChunks>>) {
  return featuredKnowledgeVersion(chunks.map((chunk) => chunk.documentId));
}

export async function GET() {
  try {
    const chunks = await getPublishedKnowledgeChunks();
    const knowledgeVersion = knowledgeVersionOf(chunks);
    const records = await listFeaturedAnswers(knowledgeVersion);
    return NextResponse.json({ records, knowledgeVersion }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[admin/featured-answers] failed to read", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "FEATURED_ANSWER_READ_FAILED", message: "暂时无法读取标准答案缓存。" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "请求格式无效。" }, { status: 400 });
  }

  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const enabled = typeof payload.enabled === "boolean" ? payload.enabled : undefined;
  const reviewed = payload.reviewed === true;
  const text = payload.text as FeaturedAnswerTextUpdate | undefined;
  if (!id || enabled === undefined || !text) {
    return NextResponse.json({ error: "INVALID_INPUT", message: "缺少标准答案、启用状态或编辑内容。" }, { status: 400 });
  }

  try {
    const chunks = await getPublishedKnowledgeChunks();
    const record = await updateFeaturedAnswer({
      id,
      enabled,
      reviewed,
      text,
      knowledgeVersion: knowledgeVersionOf(chunks),
    });
    return NextResponse.json({ record }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存标准答案失败。";
    return NextResponse.json({ error: "FEATURED_ANSWER_UPDATE_FAILED", message }, { status: 422 });
  }
}
