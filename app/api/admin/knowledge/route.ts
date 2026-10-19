import { NextResponse } from "next/server";
import {
  getKnowledgeDocumentForReview,
  getKnowledgeOverview,
  getKnowledgeStoreStatus,
  KnowledgeValidationError,
  publishKnowledgeDocument,
  setKnowledgeHierarchy,
  stageKnowledgeDocument,
  withdrawKnowledgeDocument,
} from "../../../../lib/server/knowledge-store";
import { HIERARCHY_RANK, type HierarchyLevel } from "../../../../lib/server/legal-hierarchy";
import { BUILD_INFO } from "../../../../lib/build-info";
import { isEmbeddingConfigured } from "../../../../lib/server/embeddings";
import { indexAfterPublish, indexPublishedChunks } from "../../../../lib/server/vector-indexer";
import { deleteDocumentVectors, getVectorCoverage } from "../../../../lib/server/vector-store";
import { listAbbreviations } from "../../../../lib/server/abbreviations";

const MAX_TXT_BYTES = 12 * 1024 * 1024;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  /*
   * ?view=document&id=... ：把一份已暂存的资料还原成「审核与发布」那一屏能直接渲染的形状，
   * 用于"回到未完成的审核"（2026-09-16加，见 getKnowledgeDocumentForReview 的说明）。
   * 原始 txt 没有存下来，所以不能重跑 validateKnowledgeTxt，这里从存下来的 chunk
   * 反推出提醒与待确认项——口径和校验器保持一致，都是看 chunk 上的那两个字段。
   */
  if (params.get("view") === "document") {
    const documentId = params.get("id")?.trim() ?? "";
    if (!documentId) {
      return NextResponse.json({ error: "DOCUMENT_ID_REQUIRED", message: "缺少资料标识。" }, { status: 400 });
    }
    const document = await getKnowledgeDocumentForReview(documentId);
    if (!document) {
      return NextResponse.json({ error: "DOCUMENT_NOT_FOUND", message: "找不到这份资料。" }, { status: 404 });
    }

    const chunks = document.chunks;
    const unanimous = (pick: (chunk: typeof chunks[number]) => string | undefined) => {
      if (chunks.length === 0) return undefined;
      const first = pick(chunks[0]);
      if (!first) return undefined;
      return chunks.every((chunk) => pick(chunk) === first) ? first : undefined;
    };

    return NextResponse.json({
      documentId: document.id,
      status: "READY_TO_REVIEW",
      fileName: document.fileName,
      chunkCount: chunks.length,
      separatorCount: chunks.length,
      errors: [],
      warnings: chunks.map((chunk) => chunk.warning).filter(Boolean),
      confirmations: chunks
        .filter((chunk) => chunk.needsEffectiveDateConfirmation)
        .map((chunk) => `Chunk ${chunk.number} 出现生效措辞`
          + `${chunk.effectiveDateHints?.length ? `（${chunk.effectiveDateHints[0]}）` : ""}，`
          + "请确认条文级生效日期。可确认“与整部法一致”，但不得跳过。"),
      preview: chunks.slice(0, 5),
      chunks,
      documentEffectiveFrom: unanimous((chunk) => chunk.provisionEffectiveFrom),
      documentEffectiveTo: unanimous((chunk) => chunk.provisionEffectiveTo),
      documentApplicabilityNote: unanimous((chunk) => chunk.applicabilityNote),
      alreadyPublished: document.status === "PUBLISHED",
    }, { headers: { "Cache-Control": "no-store" } });
  }

  const wantsOverview = params.get("view") === "overview";
  const status = await getKnowledgeStoreStatus();
  if (!wantsOverview) {
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({
    ...status,
    documents: await getKnowledgeOverview(),
    build: BUILD_INFO,
    vectors: { ...await getVectorCoverage(), configured: isEmbeddingConfigured() },
    abbreviations: listAbbreviations(),
  }, { headers: { "Cache-Control": "no-store" } });
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
    if (!fileName.toLowerCase().endsWith(".txt") || !text) {
      return NextResponse.json({ error: "TXT_REQUIRED", message: "请上传有内容的TXT文件。" }, { status: 400 });
    }
    if (new TextEncoder().encode(text).byteLength > MAX_TXT_BYTES) {
      return NextResponse.json({ error: "FILE_TOO_LARGE", message: "TXT文件不能超过12MB。" }, { status: 413 });
    }

    try {
      const staged = await stageKnowledgeDocument(fileName, text);
      return NextResponse.json({
        documentId: staged.document.id,
        status: staged.document.status,
        fileName: staged.document.fileName,
        chunkCount: staged.document.chunks.length,
        warningCount: staged.document.warningCount,
        duplicate: staged.duplicate,
      }, { status: staged.duplicate ? 200 : 201 });
    } catch (error) {
      if (error instanceof KnowledgeValidationError) {
        return NextResponse.json({
          error: "VALIDATION_FAILED",
          message: error.message,
          validation: error.result,
        }, { status: 422 });
      }
      return NextResponse.json({ error: "STORE_FAILED", message: "资料保存失败，请重试。" }, { status: 500 });
    }
  }

  if (payload.action === "publish") {
    const documentId = typeof payload.documentId === "string" ? payload.documentId.trim() : "";
    if (!documentId) {
      return NextResponse.json({ error: "DOCUMENT_ID_REQUIRED", message: "缺少待发布资料标识。" }, { status: 400 });
    }
    const document = await publishKnowledgeDocument(documentId);
    if (!document) {
      return NextResponse.json({ error: "DOCUMENT_NOT_FOUND", message: "没有找到这份待发布资料。" }, { status: 404 });
    }
    // 发布成功后顺带生成向量。这一步失败不影响发布结果（函数内部已吞掉异常），
    // 该文档会先只走关键词检索，之后可以在总览里点"补算向量"。
    await indexAfterPublish(document.id);
    return NextResponse.json({
      documentId: document.id,
      status: document.status,
      publishedAt: document.publishedAt,
      chunkCount: document.chunks.length,
    });
  }

  /**
   * 设定一份资料的法律位阶（Act / Rules / Notification / Circular）。
   *
   * 位阶参与三件事：检索配额保底、结论锚定校验、冲突提示（见 `legal-hierarchy.ts`）。
   * 判错的后果是**一份 circular 被当成 Act 去锚定结论**——所以值必须在白名单里，
   * 不接受任意字符串。前端传错、或者将来加了新位阶忘了同步，这里会直接拒绝，
   * 而不是把一个不认识的值写进库里等下游去处理。
   */
  if (payload.action === "setHierarchy") {
    const documentId = typeof payload.documentId === "string" ? payload.documentId.trim() : "";
    const level = typeof payload.hierarchyLevel === "string" ? payload.hierarchyLevel.trim() : "";
    if (!documentId) {
      return NextResponse.json({ error: "DOCUMENT_ID_REQUIRED", message: "缺少资料标识。" }, { status: 400 });
    }
    if (!(level in HIERARCHY_RANK)) {
      return NextResponse.json({
        error: "INVALID_HIERARCHY",
        message: `位阶只能是 ${Object.keys(HIERARCHY_RANK).join(" / ")}。`,
      }, { status: 400 });
    }
    const document = await setKnowledgeHierarchy(documentId, level as HierarchyLevel);
    if (!document) {
      return NextResponse.json({ error: "DOCUMENT_NOT_FOUND", message: "没有找到这份资料。" }, { status: 404 });
    }
    return NextResponse.json({
      documentId: document.id,
      hierarchyLevel: document.hierarchyLevel,
      hierarchyConfirmed: document.hierarchyConfirmed,
    });
  }

  if (payload.action === "withdraw") {
    const documentId = typeof payload.documentId === "string" ? payload.documentId.trim() : "";
    if (!documentId) {
      return NextResponse.json({ error: "DOCUMENT_ID_REQUIRED", message: "缺少待下架资料标识。" }, { status: 400 });
    }
    const document = await withdrawKnowledgeDocument(documentId);
    if (!document) {
      return NextResponse.json({ error: "DOCUMENT_NOT_FOUND", message: "没有找到这份资料。" }, { status: 404 });
    }
    // 下架即退出问答检索范围（getPublishedKnowledgeChunks只认PUBLISHED）。
    // 向量是派生数据，一并清掉；将来恢复发布时会自动重新生成。
    await deleteDocumentVectors(documentId);
    return NextResponse.json({
      documentId: document.id,
      status: document.status,
      withdrawnAt: document.withdrawnAt,
    });
  }

  if (payload.action === "restore") {
    const documentId = typeof payload.documentId === "string" ? payload.documentId.trim() : "";
    if (!documentId) {
      return NextResponse.json({ error: "DOCUMENT_ID_REQUIRED", message: "缺少待恢复资料标识。" }, { status: 400 });
    }
    const document = await publishKnowledgeDocument(documentId);
    if (!document) {
      return NextResponse.json({ error: "DOCUMENT_NOT_FOUND", message: "没有找到这份资料。" }, { status: 404 });
    }
    await indexAfterPublish(document.id);
    return NextResponse.json({
      documentId: document.id,
      status: document.status,
      publishedAt: document.publishedAt,
    });
  }

  if (payload.action === "reindex") {
    if (!isEmbeddingConfigured()) {
      return NextResponse.json({
        error: "EMBEDDING_NOT_CONFIGURED",
        message: "还没有配置向量服务密钥（EMBEDDING_API_KEY），无法生成向量。",
      }, { status: 400 });
    }
    try {
      const documentId = typeof payload.documentId === "string" ? payload.documentId.trim() : undefined;
      const summary = await indexPublishedChunks({
        documentId: documentId || undefined,
        force: payload.force === true,
      });
      return NextResponse.json(summary);
    } catch (error) {
      return NextResponse.json({
        error: "INDEXING_FAILED",
        message: error instanceof Error ? error.message : "生成向量失败，请稍后重试。",
      }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "UNKNOWN_ACTION", message: "不支持的操作。" }, { status: 400 });
}
