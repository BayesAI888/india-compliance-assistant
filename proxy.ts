import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** 管理后台使用浏览器原生 HTTP Basic Auth 的认证域。 */
const REALM = "yindu-compliance-admin";

/**
 * 全站最小安全响应头。页面会加载 Next.js 自己的内联启动脚本，因此 CSP 暂时保留
 * unsafe-inline；其余资源只允许同源，嵌入和对象插件一律关闭。
 */
function withSecurityHeaders(response: NextResponse) {
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  );
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=()");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return response;
}

function unauthorized(message: string, status = 401) {
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
  if (status === 401) {
    headers["WWW-Authenticate"] = `Basic realm="${REALM}", charset="UTF-8"`;
  }
  return withSecurityHeaders(new NextResponse(message, { status, headers }));
}

export function proxy(request: NextRequest) {
  const isAdminRoute = request.nextUrl.pathname === "/admin"
    || request.nextUrl.pathname.startsWith("/admin/")
    || request.nextUrl.pathname.startsWith("/api/admin/");

  if (!isAdminRoute) return withSecurityHeaders(NextResponse.next());

  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPass = process.env.ADMIN_PASSWORD;

  if (!expectedUser || !expectedPass) {
    return unauthorized(
      "管理后台未配置账号密码（缺少环境变量 ADMIN_USERNAME / ADMIN_PASSWORD），已拒绝访问。请管理员在 .env.local 里配置后重启服务。",
      503,
    );
  }

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Basic ")) {
    return unauthorized("需要管理员账号密码才能访问这个页面。");
  }

  let decoded = "";
  try {
    // atob 只按字节解码，中文用户名/密码要再按UTF-8转一次才不会变成乱码
    // （WWW-Authenticate 里已经声明了 charset="UTF-8"，主流浏览器会照这个编码提交）。
    const binary = atob(header.slice("Basic ".length));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    decoded = new TextDecoder("utf-8").decode(bytes);
  } catch {
    return unauthorized("登录信息格式无效，请重新输入。");
  }

  const separatorIndex = decoded.indexOf(":");
  const user = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : decoded;
  const pass = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";

  if (user !== expectedUser || pass !== expectedPass) {
    return unauthorized("账号或密码不对，请重新输入。");
  }

  return withSecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: ["/:path*"],
};
