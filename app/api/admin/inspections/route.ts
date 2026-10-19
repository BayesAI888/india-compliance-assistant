import { NextResponse } from "next/server";
import {
  buildDomainWatchList,
  buildInspectionQueue,
  computeMaintenanceMetrics,
  runFileLine,
  TIER_LABEL,
  type InspectableDocument,
} from "../../../../lib/server/inspection";
import {
  listInspectableDocuments,
  listInspections,
  recordInspection,
  upsertInspectableDocument,
} from "../../../../lib/server/compliance-store";

/**
 * GET  /api/admin/inspections
 *   返回当期待巡检清单、领域线关注列表和四项运营指标。
 *
 * POST /api/admin/inspections
 *   记录一次巡检结果。文件线无变化时自动推进法律现行性核验时间；
 *   有变化必须由管理员判断，不自动推进。
 */

export async function GET() {
  const documents = await listInspectableDocuments();
  const now = new Date();

  return NextResponse.json({
    generated_at: now.toISOString(),
    tier_legend: TIER_LABEL,
    // 文件线与领域线分别出条目；两条线必须同时运行。
    queue: buildInspectionQueue(documents, now),
    domain_watch: buildDomainWatchList(documents),
    metrics: computeMaintenanceMetrics(documents, { total: 0, degradedForCurrency: 0 }, now),
    note: "文件线发现不了外部修改型变更（例如 Press Note 3 被 Press Note 2 从外部修订），必须同时跑领域线。",
  }, { headers: { "Cache-Control": "no-store" } });
}

interface InspectionPostBody {
  action: "REGISTER_DOCUMENT" | "FILE_LINE" | "DOMAIN_LINE";
  document?: InspectableDocument;
  document_id?: string;
  observed_fingerprint?: string;
  /** 领域线：本次查看的领域与结论。 */
  domain?: string;
  change_detected?: boolean;
  conclusion?: string;
  actor_user_id?: string;
}

export async function POST(request: Request) {
  let body: InspectionPostBody;
  try {
    body = (await request.json()) as InspectionPostBody;
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "请求格式无效。" }, { status: 400 });
  }

  if (body.action === "REGISTER_DOCUMENT") {
    if (!body.document?.id) {
      return NextResponse.json(
        { error: "DOCUMENT_REQUIRED", message: "缺少待登记的资料。" },
        { status: 400 },
      );
    }
    const saved = await upsertInspectableDocument(body.document);
    return NextResponse.json({ document: saved }, { headers: { "Cache-Control": "no-store" } });
  }

  if (body.action === "FILE_LINE") {
    const documents = await listInspectableDocuments();
    const document = documents.find((item) => item.id === body.document_id);
    if (!document) {
      return NextResponse.json(
        { error: "DOCUMENT_NOT_FOUND", message: "找不到该资料。" },
        { status: 404 },
      );
    }

    const outcome = runFileLine({
      document,
      observedFingerprint: body.observed_fingerprint,
    });
    await recordInspection({
      documentId: document.id,
      line: "FILE",
      domain: document.domain,
      fingerprintBefore: outcome.fingerprintBefore,
      fingerprintAfter: outcome.fingerprintAfter,
      changeDetected: outcome.changeDetected,
      conclusion: outcome.conclusion,
      actorUserId: body.actor_user_id,
      // 只有确认无变化才自动推进；抓取失败或有变化都不推进。
      advanceCurrencyCheckedAt: outcome.canAutoAdvance,
      advanceLinkCheckedAt: outcome.conclusion !== "FETCH_FAILED",
    });

    return NextResponse.json({ outcome }, { headers: { "Cache-Control": "no-store" } });
  }

  if (body.action === "DOMAIN_LINE") {
    if (!body.domain || !body.conclusion) {
      return NextResponse.json(
        { error: "DOMAIN_RESULT_REQUIRED", message: "领域线需要给出领域和结论。" },
        { status: 400 },
      );
    }
    const record = await recordInspection({
      documentId: body.document_id,
      line: "DOMAIN",
      domain: body.domain,
      changeDetected: Boolean(body.change_detected),
      conclusion: body.conclusion,
      actorUserId: body.actor_user_id,
      // 领域线确认本领域无新规时，才推进被查资料的核验时间。
      advanceCurrencyCheckedAt: Boolean(body.document_id) && !body.change_detected,
    });
    return NextResponse.json({ record }, { headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json(
    { error: "UNKNOWN_ACTION", message: "未知的巡检动作。" },
    { status: 400 },
  );
}

export async function PATCH() {
  const records = await listInspections(50);
  return NextResponse.json({ records }, { headers: { "Cache-Control": "no-store" } });
}
