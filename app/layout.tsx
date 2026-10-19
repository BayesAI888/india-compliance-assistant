import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

const description = "帮助中资企业在印度合规经营。中文提问，只用已审核官方资料回答，并提供可核验的条款级引用。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const rawHost = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const host = /^[a-z0-9.:[\]-]+$/i.test(rawHost) ? rawHost : "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProtocol === "https" || forwardedProtocol === "http"
    ? forwardedProtocol
    : host.startsWith("localhost") ? "http" : "https";
  const origin = `${protocol}://${host}`;
  const socialImage = new URL("/og.png", origin).toString();

  return {
    metadataBase: new URL(origin),
    // 站点名称与ICP备案登记的名称保持一致（贝耶斯印度合规），备案信息核查时口径才对得上。
    title: {
      default: "贝耶斯印度合规｜中文印度合规问答",
      template: "%s｜贝耶斯印度合规",
    },
    description,
    applicationName: "贝耶斯印度合规",
    keywords: ["印度合规", "中资企业", "FEMA", "FDI", "GST", "MCA", "ROC"],
    robots: { index: false, follow: false },
    openGraph: {
      type: "website",
      locale: "zh_CN",
      siteName: "贝耶斯印度合规",
      title: "贝耶斯印度合规｜中文印度合规问答",
      description,
      images: [{ url: socialImage, width: 1200, height: 630, alt: "印度合规助手：中文提问、官方资料、条款级引用" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "贝耶斯印度合规｜中文印度合规问答",
      description,
      images: [socialImage],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#082b4d",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        {/*
          正规页脚（2026-09-16 改）。原来是右下角一个 position:fixed 的小胶囊，
          在手机上会压住正文最后一行免责声明；而且对要面向企业客户的站点来说，
          一个飘着的备案号标签不像正经主体信息。改成文档流末尾的真页脚：
          不遮挡任何内容，也符合国内商业网站的惯例。
          页脚里只写确实存在的内容——没有"服务条款/隐私政策"页面就不放这两个链接，
          点开是404比没有更伤可信度。
        */}
        <footer className="site-footer">
          <p className="site-footer-disclaimer">
            本站提供的内容基于已发布的官方法规资料整理，仅供参考，不构成法律或税务意见。
            具体事项请结合自身情况咨询持牌专业人士。
          </p>
          <p className="site-footer-meta">
            <span>贝耶斯印度合规</span>
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
              粤ICP备2026138838号
            </a>
          </p>
        </footer>
      </body>
    </html>
  );
}
