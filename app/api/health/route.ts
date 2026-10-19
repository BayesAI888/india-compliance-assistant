import { NextResponse } from "next/server";
import { isDeepSeekConfigured } from "../../../lib/server/deepseek";
import { getKnowledgeStoreStatus } from "../../../lib/server/knowledge-store";
import { BUILD_INFO } from "../../../lib/build-info";

export async function GET() {
  const knowledge = await getKnowledgeStoreStatus();
  return NextResponse.json({
    status: "ok",
    product: "india-compliance-assistant",
    /**
     * 版本信息。**不需要登录就能看**，这是刻意的——
     * 「到底部没部上去」这个问题要能用一条 curl 回答，
     * 而不是靠登录后台、翻界面、再靠推理。
     *
     *   curl -s https://indiacompliance.cn/api/health | grep -o '"build":{[^}]*}'
     *
     * buildTime 变了但 sourceHash 没变 → 重新构建了，但代码还是旧的（包没解压对）。
     */
    build: BUILD_INFO,
    policyVersion: "1.0",
    knowledgeBase: knowledge.publishedDocumentCount > 0 ? "published" : "awaiting_admin_upload",
    publishedDocuments: knowledge.publishedDocumentCount,
    publishedChunks: knowledge.publishedChunkCount,
    deepSeek: isDeepSeekConfigured() ? "configured" : "not_configured",
  });
}
