/**
 * 把一整个对话导出成 PDF / Word。
 *
 * ## 为什么是这两条路
 *
 * 用户的要求是「导出的文件保留原文件的字体和格式」。做到这件事最可靠的办法，
 * 不是"再实现一遍排版"，而是**让导出的东西就用网页那一套 CSS**：
 *
 * - **PDF → 浏览器打印**。打印出来的 PDF 用的就是页面本身的样式，
 *   字体、字号、加粗、颜色、表格一模一样，**保真度天然是 100%**，因为它根本不是"转换"。
 *   零新依赖、零服务器风险。代价是用户要在打印弹窗里选一次"存为 PDF"。
 * - **Word → `.doc`（HTML 内核）**。Word 能直接打开带样式的 HTML 并保留
 *   字体/加粗/颜色/表格。同样零依赖。
 *
 * 考虑过但**没选**的两条：
 *
 * - **服务器无头 Chrome 直出 PDF**：体验最好（点一下就下载），但要在轻量服务器上
 *   装 Chromium（几百 MB + 常驻内存）还要单独装中文字体。为了一个导出按钮
 *   给生产站点引入拖垮网站的风险，不划算。
 * - **用 docx 库生成真 .docx**：格式是拿 docx 原语**重建**的，
 *   意味着网页样式一改、导出就开始走形——而"保留原格式"恰恰是这次的要求。
 *   等导出成为核心功能、愿意为它维护第二套样式时再说。
 *
 * ## `.doc` 的诚实说明
 *
 * 生成的是"HTML 内核的 .doc"，不是 OOXML 的 .docx。Word / WPS 都能正常打开、
 * 能编辑、能另存为 .docx，但**打开时可能提示一句格式与扩展名不一致**。
 * 这是这条路径的固有代价，不是 bug；在导出前的提示里如实告诉用户。
 */

/**
 * 导出件的排版版本号。**改了打印样式或 Word 样式就把它 +1。**
 *
 * 为什么需要这个：2026-09-18 排查"导出 PDF 还是一堆空白"时，来回三次都卡在
 * **分不清用户手上那份 PDF 是哪一版样式生成的**——每次都要我去读线上 CSS 才能确定。
 * 把版本号印在文件上之后，看一眼导出件就知道该不该重新构建，不用再猜。
 *
 * 版本变更记录：
 * - v1：初版（类名写错，侧栏没藏住）
 * - v2：修类名 + 解除 100vh + @page margin:0
 * - v3：`break-inside: avoid` 只留小单元（回答卡片不再被整块推到下一页）
 */
export const EXPORT_STYLE_VERSION = 4;

/** 导出用的对话数据。只要渲染需要的东西，不依赖 React。 */
export interface ExportableTurn {
  question: string;
  /** 这一轮回答的 HTML（从页面上那张回答卡片直接取的 outerHTML）。 */
  answerHtml: string;
}

export interface ExportableConversation {
  title: string;
  exportedAt: string;
  turns: ExportableTurn[];
}

/** 文件名里不能出现的字符，换成下划线；顺便截断，避免超长标题做出怪文件名。 */
export function safeFileName(title: string, extension: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\n\r\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40) || "印度合规问答";
  return `${cleaned}.${extension}`;
}

/**
 * Word 用的样式。
 *
 * **必须和 `globals.css` 的六级字号阶梯保持一致**——
 *   22px 关键数值 / 17px 结论 / 15px 法规要求 / 13px 前提假设与注记 /
 *   12px 法条名称 / 11px 区块标题。
 * Word 不认 CSS 变量，所以这里是把那六个值**展开写死**的副本。
 * 改了 globals.css 的阶梯，这里要跟着改；`v14-rules.check` 里有一条测试
 * 逐档钉住这件事，改漏了会红。
 *
 * ## 为什么 Word 里不做双栏标尺
 *
 * 网页版把区块标题移进了左侧 116px 的标尺栏。Word 要做同样的效果得靠表格布局，
 * 而 Word 表格在不同版本、不同页宽下列宽会被自动重算，一旦算错就是整份文档错位，
 * 比"标题占一行"糟糕得多。屏幕上双栏换来的是少滚几屏，而 Word 文档本来就要翻页读，
 * 收益也小。所以导出件走和窄屏、打印同一条降级路径：标签回到内容上方。
 *
 * 不在阶梯内的只有 `.doc-title`——那是导出文件自己的封面标题（"印度合规问答记录"），
 * 不是答案卡片里的内容，用衬线 20px 是文档惯例，不会和卡片里的层级混淆。
 *
 * 字体写成「宋体 + Songti SC」：Word 在 Windows 上认前者、macOS 上认后者，
 * 两个都写才能两边都不退化成默认字体。
 */
const WORD_STYLES = `
  body { font-family: "PingFang SC", "Microsoft YaHei", "微软雅黑", sans-serif;
         font-size: 15px; line-height: 1.9; color: #17324a; }
  .doc-head { border-bottom: 2px solid #0b2f53; padding-bottom: 10px; margin-bottom: 22px; }
  .doc-title { font-family: "Songti SC", "宋体", serif; font-size: 20px; font-weight: bold;
               color: #0b2f53; margin: 0 0 6px; }
  .doc-meta { font-size: 11px; color: #667b8e; margin: 0; }
  .turn { margin-bottom: 30px; }
  .turn-question { font-size: 15px; font-weight: bold; color: #0b2f53;
                   background: #eef5fa; padding: 10px 12px; margin: 0 0 14px; }
  .answer-block-title, .law-category-head { font-size: 11px; font-weight: bold;
                        letter-spacing: 1.4px; color: #667b8e; margin: 20px 0 8px; }
  .answer-rail-sub { font-size: 11px; font-weight: normal; color: #9dafbd; }
  .answer-lead { font-size: 17px; font-weight: 600; color: #0b2f53; margin: 0 0 12px;
                 line-height: 1.85; }
  .key-figure b { font-size: 22px; font-weight: bold; color: #0b2f53; }
  .key-figure small { font-size: 11px; color: #6f8799; }
  .assumption-list, .assumption-cap, .case-search-note, .case-digest-caveat,
  .related-case-snippet { font-size: 13px; color: #667b8e; }
  .law-group-title, .related-case-name { font-size: 12px; font-weight: 600; color: #667b8e; }
  .law-group-level { font-size: 11px; font-weight: normal; color: #8299ab; }
  .case-cluster-title { font-size: 15px; font-weight: normal; color: #0b2f53; }
  .case-cluster-takeaway { font-size: 15px; font-weight: bold; color: #2b5875;
                           background: #edf5fa; padding: 9px 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 15px; }
  th { background: #f2f7fb; color: #8296a6; font-size: 11px; font-weight: bold;
       text-align: left; padding: 7px 10px; border-bottom: 1px solid #e9f0f5; }
  td { padding: 9px 10px; border-bottom: 1px solid #f0f5f8; vertical-align: top; }
  .doc-foot { margin-top: 30px; padding-top: 12px; border-top: 1px solid #d8e5ee;
              font-size: 11px; color: #667b8e; }
`;
/**
 * 从页面上取来的回答 HTML 里，把**导出后没有意义的东西**去掉。
 *
 * - 引用角标是个 `<button>`，要靠鼠标悬停才出内容；导出成静态文件后它既点不动、
 *   也不该在正文里留下一串孤零零的数字。
 * - 浮层本身（`.citation-mark-popover`）在文件里会变成一大段突然冒出来的文字，
 *   把正文冲得七零八落。
 *
 * 用正则而不是 DOMParser：这个函数要能在 Node 里单测，不依赖浏览器环境。
 * 只删这两类确定的结构，不做通用 HTML 清洗——通用清洗写不对，也不需要。
 */
export function stripInteractiveBits(html: string): string {
  return html
    // 整个角标（含浮层）一起删掉：<sup class="citation-mark ...">…</sup>
    .replace(/<sup[^>]*class="[^"]*citation-mark[^"]*"[^>]*>[\s\S]*?<\/sup>/g, "")
    // 单独出现的浮层（理论上已被上一条带走，留着兜底）
    .replace(/<div[^>]*class="[^"]*citation-mark-popover[^"]*"[^>]*>[\s\S]*?<\/div>/g, "");
}

/** 生成 Word 能打开的 HTML 文档。 */
export function buildWordHtml(conversation: ExportableConversation): string {
  const turns = conversation.turns.map((turn) => `
    <div class="turn">
      <p class="turn-question">${escapeHtml(turn.question)}</p>
      ${stripInteractiveBits(turn.answerHtml)}
    </div>`).join("\n");

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapeHtml(conversation.title)}</title>
<style>${WORD_STYLES}</style>
</head>
<body>
  <div class="doc-head">
    <p class="doc-title">${escapeHtml(conversation.title)}</p>
    <p class="doc-meta">贝耶斯印度合规 · 导出于 ${escapeHtml(conversation.exportedAt)}</p>
  </div>
  ${turns}
  <p class="doc-foot">
    本文件由「贝耶斯印度合规」自动导出，内容仅供参考，不构成法律意见。
    落地前请以引用的官方原文为准。（排版 v${EXPORT_STYLE_VERSION}）
  </p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
