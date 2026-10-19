import { NextResponse } from "next/server";
import { getPublishedKnowledgeChunks } from "../../../lib/server/knowledge-store";
import { getPublishedCases } from "../../../lib/server/case-store";

/**
 * GET /api/stats
 * 首页展示"这个助手到底收录了什么"用的公开统计。
 *
 * 只返回**聚合数量和一个日期**，不返回任何法规名称、条文标题或正文——
 * 产品规则表要求法规正文只在管理员后台可见，这里不能成为绕过它的旁路。
 * 法规名称本身虽然不算敏感，但"收录了哪些法"属于产品边界信息，
 * 现阶段一并不下发，需要时再单独评估。
 *
 * 缓存 5 分钟：文件存储那条路径每次都要把整个知识库 JSON 读进来解析，
 * 而首页是每次打开都会请求的，不加缓存等于每个访客都触发一次全量读盘。
 */

const CACHE_TTL_MS = 5 * 60 * 1000;

interface PublicStats {
  /** 收录的法律法规部数，按 chunk 的【来源】去重，不是文件份数——一部法可能拆成多个文件上传。 */
  lawCount: number;
  /** 已发布的条款数（chunk 数）。 */
  clauseCount: number;
  /** 已发布的判例数。 */
  caseCount: number;
  /** 最近一次法律现行性核验日（YYYY-MM-DD）。没有任何资料标注过就不下发这个字段。 */
  legalAsOf?: string;
}

let cache: { value: PublicStats; expiresAt: number } | undefined;

async function computeStats(): Promise<PublicStats> {
  const [chunks, cases] = await Promise.all([
    getPublishedKnowledgeChunks(),
    getPublishedCases(),
  ]);

  const sources = new Set<string>();
  let legalAsOf: string | undefined;
  for (const chunk of chunks) {
    if (chunk.source) sources.add(chunk.source.trim());
    const checkedAt = chunk.legalCurrencyCheckedAt;
    if (checkedAt && (!legalAsOf || checkedAt > legalAsOf)) legalAsOf = checkedAt;
  }

  return {
    lawCount: sources.size,
    clauseCount: chunks.length,
    caseCount: cases.length,
    ...(legalAsOf ? { legalAsOf: legalAsOf.slice(0, 10) } : {}),
  };
}

export async function GET() {
  const now = Date.now();
  if (!cache || cache.expiresAt <= now) {
    cache = { value: await computeStats(), expiresAt: now + CACHE_TTL_MS };
  }
  return NextResponse.json(cache.value, {
    // 浏览器侧也缓存一会儿，避免来回切标签页时反复打这个接口。
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
