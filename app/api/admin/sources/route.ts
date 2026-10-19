import { NextResponse } from "next/server";
import { getSourceConfigurationOverview } from "../../../../lib/server/source-config";

/** 只读展示当前来源治理配置；`/api/admin/*` 已由 proxy 要求管理员认证。 */
export async function GET() {
  try {
    return NextResponse.json(await getSourceConfigurationOverview(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[admin/sources] failed to read source configuration", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json(
      { error: "SOURCE_CONFIG_READ_FAILED", message: "暂时无法读取来源配置，请稍后重试。" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
