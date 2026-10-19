"use client";

import Link from "next/link";
import {
  Fragment,
  type CSSProperties,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  AnswerResponse,
  AttachmentUploadResponse,
  Citation,
  NoticeFacts,
  ReminderStatus,
  ReminderView,
} from "../lib/contracts";
import { encodeQr, qrSvgPath } from "../lib/qr-code";
import { lawCategoryLabel, lawCategoryOfTitle } from "../lib/law-categories";
// 从 lib/server/ 引入到客户端组件是刻意的，不是疏忽：`legal-hierarchy.ts` 零依赖、
// 纯函数、不碰文件系统也不含任何密钥，位阶判定规则只应该有**一份**。
// 在这里复制一套正则，迟早会和服务端检索用的那套走偏。
import { classifyHierarchy, HIERARCHY_SHORT_LABEL, HIERARCHY_RANK } from "../lib/server/legal-hierarchy";
import { buildWordHtml, safeFileName, type ExportableTurn } from "../lib/conversation-export";

type WorkspaceView = "chat" | "files" | "reminders" | "profile" | "history";
type Plan = "anonymous" | "free" | "professional";

/** 服务端下发的额度视图。界面显示的数字必须来自这里，不能前端自己算。 */
interface QuotaView {
  plan: Plan;
  limit: number;
  used: number;
  remaining: number;
}

/** 当前登录的用户。没登录时为 null——注意是 null 不是 undefined，表示"问过了，确实没登录"。 */
interface SessionUser {
  email: string;
  plan: "free" | "professional";
  plan_label: string;
  quota: QuotaView;
  /** 会员有效期。从来没买过时 active 为 false、paidThrough 为 null。 */
  membership?: {
    active: boolean;
    paidThrough: string | null;
    daysLeft: number;
  };
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  answer?: AnswerResponse;
}

/**
 * 「最近对话」里的一条——**一个对话（话题）一条，不是一个问题一条**。
 *
 * 2026-09-17 产品决定：对话的边界完全由用户的动作决定。
 *   进入网页、点「新建对话」→ 各开一个新对话；
 *   点「最近对话」里的某条 → 回到那条继续问；
 *   在同一个对话里连问多轮 → 列表里始终只有这一条，不会每问一次多一条。
 *
 * 存在 localStorage（不是 sessionStorage）：关掉网页再进来，默认是新话题，
 * 但这个列表还在，随时能点回去。**没有登录体系，所以它只属于这台电脑的这个浏览器**——
 * 换浏览器、换设备、清理浏览数据都会丢，服务端的对话内容还在但找不回对应ID了。
 * 这是现阶段的固有限制，要彻底解决得先做账号。
 */
interface ConversationEntry {
  /** 服务端的 conversation_id。 */
  id: string;
  /** 20字以内的话题概括，首问时由服务端下发（见 conversation-title.ts）。 */
  title: string;
  /** 最后一次提问的时间，用于排序。 */
  updatedAt: string;
  /** 这个对话里问过几轮，列表上给个量感。 */
  turnCount: number;
  /**
   * 问题发出去了、答案还没回来。
   *
   * 这条占位是**发请求之前**就写进去的（2026-09-18）：手机上切到别的 App 时页面可能
   * 被系统回收，响应就再也收不到了。服务端不认客户端断开，照样跑完、落盘、扣次——
   * 没有这条占位的话，那次问答就成了孤儿：**次数扣了，用户永远找不到**。
   * 答案回来后会被覆盖成 false。
   */
  pending?: boolean;
}

/**
 * 上传Notice/合同/申报文件的一条本地状态。UPLOADING是前端自己加的过渡状态——
 * 真正的状态（EXTRACTED/UNSUPPORTED/FAILED）来自/api/attachments的返回，
 * id为空字符串代表还没拿到服务端分配的attachment_id（正在上传中）。
 */
interface AttachmentItem {
  localId: string;
  id: string;
  name: string;
  status: "UPLOADING" | "EXTRACTED" | "UNSUPPORTED" | "FAILED";
  errorMessage?: string;
  noticeFacts?: NoticeFacts;
}

/** 提取到的Notice事实拼成一行摘要，让用户在真正提问前先扫一眼提取得对不对。 */
function summarizeNoticeFacts(facts: NoticeFacts): string {
  const parts = [
    // 事由放第一位：机关/编号/日期看起来"有内容"，但只有事由能说明这份文件讲什么。
    // 之前预览不显示事由，用户看到一排字段以为识别得很好，实际送进模型的信息很单薄。
    facts.subject_matter && `事由：${facts.subject_matter}`,
    facts.authority && `机关：${facts.authority}`,
    facts.notice_or_form_number && `编号：${facts.notice_or_form_number}`,
    facts.reply_deadline && `回复截止日：${facts.reply_deadline}`,
    facts.amount && `金额：${facts.amount}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "已识别文件，但没有提取到具体字段，建议在问题里补充关键信息。";
}

/* 「最近对话」改成按对话列之后（2026-09-17），列表上不再显示单条回答的状态
   （一个对话里十轮问答会有十个不同的状态，显示哪一个都不对），
   原来的 STATUS_META_LABEL 随之删除。回答状态仍然显示在每张回答卡片自己身上。 */

/** 侧栏「最近对话」的日期展示：今天显示“今天”，否则显示“M月D日”。 */
function formatHistoryDate(date: Date) {
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay ? "今天" : `${date.getMonth() + 1}月${date.getDate()}日`;
}

interface PublicStats {
  lawCount: number;
  clauseCount: number;
  caseCount: number;
  legalAsOf?: string;
}

/**
 * 首页的五个入口。卡片上直接显示完整问句，点击即填进输入框——
 * 一度压成过四五个字的短提示（"须有印度股东吗"这种），但那样读起来像半句话，
 * 而且卡片实际宽度放得下完整问题，没必要缩。
 *
 * 顺序即优先级：税务 Notice 排第一——它意图最强（收到Notice的人是带着真实问题来的），
 * 也是唯一能上传文件解析的入口。改顺序时记得 globals.css 里那条加重样式跟着改，
 * 它是按 :nth-child 选的，认位置不认名字。
 */
const domainPrompts = [
  { label: "税务 Notice", question: "收到印度税局Notice应该怎么办？" },
  { label: "公司设立", question: "在印度设立企业必须有印度人参股吗？" },
  { label: "判例", question: "帮我找一下2026年以前关于跨国公司广告费案例" },
  { label: "FEMA / FDI / RBI", question: "中资股东向印度公司增资前要做什么准备工作？" },
  { label: "GST", question: "货票同行在印度具体需要做到哪些要求？" },
];

const navItems: Array<{ id: WorkspaceView; label: string; meta: string }> = [
  { id: "chat", label: "合规问答", meta: "中文提问" },
  { id: "files", label: "我的文件", meta: "Notice与合同" },
  { id: "reminders", label: "合规提醒", meta: "提前1天邮件" },
  { id: "profile", label: "企业档案", meta: "按需引用" },
];

const progressLabels = ["正在理解问题", "正在检索资料", "正在核对引用", "正在生成回答"];

/**
 * 「最近对话」列表的存放位置。用 localStorage：关掉网页再进来默认开新话题，
 * 但列表要留着，否则用户再也回不到之前的对话（服务端保留30天）。
 */
const CONVERSATION_LIST_KEY = "india-compliance-conversations";

/** 列表最多保留多少条，超出的按时间丢掉最旧的。改为全量保留（2026-09-30）：用户要求「最近对话」展示自己的全部历史对话。 */
const MAX_CONVERSATION_ENTRIES = Number.POSITIVE_INFINITY;

/**
 * 占位标题截多长。和服务端 `conversation-title.ts` 的 MAX_TITLE_LENGTH 保持一致——
 * 答案回来后会用模型概括的标题覆盖它，两边长度一样才不会在列表上跳一下。
 */
const MAX_CONVERSATION_TITLE_LENGTH = 20;

/**
 * 生成一个对话 id。
 *
 * 必须是 `conv_<UUID v4>` 形状——服务端只认这一种（见 conversation-store.ts 的
 * `isValidConversationId`），因为 conversation_id 就是读取对话的通行证，
 * 不能让任意字符串进来跟别人撞车。
 *
 * `crypto.randomUUID()` 只在安全上下文（HTTPS/localhost）可用。现在站点是 HTTPS，
 * 正常都走得到；万一走不到就返回 undefined，让服务端自己生成——
 * 那样只是退回"首问中断会丢答案"的老行为，不会让页面崩掉。
 */
function newConversationId(): string | undefined {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `conv_${crypto.randomUUID()}`;
  }
  return undefined;
}

function readConversationList(): ConversationEntry[] {
  try {
    const raw = window.localStorage.getItem(CONVERSATION_LIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // 逐条校验形状：localStorage 里的东西可能是旧版本写的、也可能被人手改过，
    // 不能假设它一定是当前的结构。
    return parsed.filter((item): item is ConversationEntry =>
      Boolean(item) && typeof item === "object"
      && typeof (item as ConversationEntry).id === "string"
      && typeof (item as ConversationEntry).title === "string");
  } catch {
    return [];
  }
}

function writeConversationList(entries: ConversationEntry[]) {
  try {
    window.localStorage.setItem(CONVERSATION_LIST_KEY, JSON.stringify(entries.slice(0, MAX_CONVERSATION_ENTRIES)));
  } catch {
    // 隐私模式或存储写满时会抛异常。列表丢了只是找不回历史对话，
    // 不能因此让页面崩掉——问答本身完全不依赖它。
  }
}

/** 用真实系统时间格式化「年月日」，避免页面上出现写死的日期。 */
function formatChineseDate(date: Date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 长判例检索偶尔会超过反向代理的首个等待窗口，代理会回 502/504，但应用进程仍会
 * 把同一轮跑完并写进通用缓存。对这两种网关错误自动重连，用户不必手动重复提问。
 *
 * 所有重连带同一个 X-Chat-Request-Id；服务端会并入首个仍在执行的请求，不会再次
 * 调模型、重复写历史或重复扣次数。模型服务自己返回的 503 含有明确原因，不在这里
 * 盲目重试，避免把真正的上游故障悄悄拖成长等待。
 */
async function fetchChatWithGatewayRetry(
  body: Record<string, unknown>,
  clientRequestId?: string,
): Promise<Response> {
  const retryableStatuses = new Set([502, 504, 524]);
  let lastNetworkError: unknown;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(clientRequestId ? { "X-Chat-Request-Id": clientRequestId } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!retryableStatuses.has(response.status) || attempt === 3) return response;
    } catch (error) {
      lastNetworkError = error;
      if (attempt === 3) throw error;
    }

    // 每次只等很短时间：第一条应用请求通常已经接近完成，第二次便会命中它的结果。
    await wait((attempt + 1) * 1_000);
  }

  throw lastNetworkError instanceof Error ? lastNetworkError : new Error("请求未完成，请稍后再试。");
}

/**
 * 生成消息用的本地随机ID。
 * `crypto.randomUUID()` 只在"安全上下文"（HTTPS 或 localhost）里可用——
 * 备案通过、配好HTTPS之前，网站暂时只能用 http://公网IP:端口 访问，不算安全上下文，
 * 直接调用会抛 TypeError 导致整个页面崩溃，所以这里做一个不依赖它的兜底方案。
 */
function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 超长文本截断到指定字数，避免案例库里几千字的字段原样铺满整页。 */
function clampText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <span className="brand-mark" aria-hidden="true">印</span>
      <span className="brand-copy">
        {/* 「贝耶斯」是ICP备案时登记的网站名称（贝耶斯印度合规），
            放在产品名上方做主体标识，字号小一档，不抢主标题。 */}
        <em className="brand-owner">贝耶斯</em>
        <strong>印度合规助手</strong>
        {!compact && <small>INDIA COMPLIANCE</small>}
      </span>
    </div>
  );
}

/**
 * 对话导出按钮（PDF / Word）。
 *
 * 两条路都**直接复用页面这套 CSS**，而不是重新实现一遍排版——
 * 用户要的是"保留原文件的字体和格式"，那么最可靠的做法就是别做转换：
 *
 * - **PDF** 走浏览器打印。打印出来的就是这张页面本身（见 globals.css 的 @media print），
 *   字体字号加粗颜色表格全都一样。用户要在弹窗里选一次"目标：另存为 PDF"。
 * - **Word** 生成 HTML 内核的 `.doc`。Word / WPS 都能打开并保留样式，
 *   但打开时**可能提示一句格式与扩展名不一致**——这是这条路径的固有代价，
 *   所以菜单里就把这句话写出来，别让用户打开时吓一跳。
 *
 * 为什么不在服务器上装无头浏览器直出 PDF：那要几百 MB 的 Chromium 常驻内存，
 * 还得单独装中文字体。为一个导出按钮给生产站点引入拖垮网站的风险，不划算。
 */
function ConversationExport({ title, messages }: { title: string; messages: ChatMessage[] }) {
  const [open, setOpen] = useState(false);
  const hasAnswers = messages.some((message) => message.answer);
  if (!hasAnswers) return null;

  /** 把屏幕上真实渲染的那几张回答卡片取下来，连同上一条用户提问配成一轮。 */
  function collectTurns(): ExportableTurn[] {
    const turns: ExportableTurn[] = [];
    let pendingQuestion = "";
    for (const message of messages) {
      if (message.role === "user") { pendingQuestion = message.text; continue; }
      // 取 DOM 里真实渲染出来的 HTML——这样导出的就是用户当时看到的那份，
      // 不用在这里把 AnswerResponse 再拼一遍（拼一遍就会和页面慢慢走形）。
      const node = document.getElementById(`answer-${message.id}`);
      turns.push({ question: pendingQuestion, answerHtml: node?.innerHTML ?? message.text });
      pendingQuestion = "";
    }
    return turns;
  }

  function exportWord() {
    const html = buildWordHtml({
      title,
      exportedAt: new Date().toLocaleString("zh-CN"),
      turns: collectTurns(),
    });
    // \ufeff（BOM）必须有：没有它 Word 会把 UTF-8 当成本地编码，中文全是乱码。
    const blob = new Blob(["\ufeff", html], { type: "application/msword;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeFileName(title, "doc");
    link.click();
    URL.revokeObjectURL(url);
    setOpen(false);
  }

  return (
    <div className="conversation-export">
      <button className="quiet-button" type="button" onClick={() => setOpen((v) => !v)}
        aria-expanded={open} title="把这个对话导出成文件">
        导出
      </button>
      {open && (
        <div className="conversation-export-menu">
          <button type="button" onClick={() => { setOpen(false); window.print(); }}>
            导出为 PDF
          </button>
          <small>会打开打印窗口，目标选「另存为 PDF」</small>
          <button type="button" onClick={exportWord}>导出为 Word</button>
          <small>Word 打开时可能提示格式与扩展名不一致，选「是」即可</small>
        </div>
      )}
    </div>
  );
}

/**
 * 状态徽标。
 *
 * ## 为什么要看 `evidence_sufficiency`，不能只看 `answer_status`
 *
 * `answer_status` 只有三个值，而证据覆盖程度有四档（FULL / PARTIAL / NONE / 没报）。
 * PARTIAL 刻意**不降级**（验收 #58 的教训：主干答对了的答案不该作废），
 * 于是它映射到 SUFFICIENT——界面就给一份自陈"证据未直接规定"的答案
 * 盖了绿色的「依据充分」章。2026-09-28 实测两次都是这样：
 * 结论第一句写着"未出现预缴保证金一词及其计算规则"，头上顶着绿章。
 *
 * **"不降级"不等于"装作完全覆盖"。** 状态语义仍然留三个值（它参与计费、
 * 参与后续追问的判断），但徽标文案按覆盖程度走。
 *
 * 模型没报字段时也走这一档——说不清自己够不够，就不该显得很确定。
 */
function StatusPill({
  status,
  sufficiency,
}: {
  status: AnswerResponse["answer_status"];
  sufficiency?: AnswerResponse["evidence_sufficiency"];
}) {
  if (status === "SUFFICIENT" && sufficiency !== "FULL") {
    return (
      <span className="status-pill status-partial">
        {sufficiency === "NONE" ? "证据未覆盖" : "部分覆盖"}
      </span>
    );
  }
  const copy = {
    SUFFICIENT: "依据充分",
    NEED_INFORMATION: "需要补充信息",
    UNABLE_TO_CONFIRM: "暂时无法确认",
  }[status];

  return <span className={`status-pill status-${status.toLowerCase()}`}>{copy}</span>;
}

/**
 * 正文里的引用角标——小号编号，悬停/键盘聚焦时弹出详情浮层。
 * 浮层里补上了 historical_label / applicability_note / non_binding_jurisdiction / snippet
 * 这几个 Citation 里本来就有、但过去界面完全没显示过的字段。
 */
function CitationMark({ citation, index }: { citation: Citation; index: number }) {
  // 手机/平板没有"悬停"，所以点击也要能展开——底部引用列表删掉之后，
  // 角标是唯一的出处入口，不能只支持鼠标。
  const [pinned, setPinned] = useState(false);
  return (
    <sup className={`citation-mark ${pinned ? "citation-mark-pinned" : ""}`}>
      <button
        type="button"
        className="citation-mark-trigger"
        aria-expanded={pinned}
        aria-label={`引用 ${index}：${citation.display_title}`}
        onClick={() => setPinned((current) => !current)}
      >
        {index}
      </button>
      <span className="citation-mark-popover" role="tooltip">
        <strong>{citation.display_title}</strong>
        <span className="cm-meta">
          {citation.authority}
          {citation.date ? ` · ${citation.date}` : ""} · {citation.locator}
        </span>
        {citation.historical_label && <span className="cm-flag">{citation.historical_label}</span>}
        {citation.non_binding_jurisdiction && <span className="cm-flag cm-flag-danger">非管辖法院判例，仅供参考</span>}
        {citation.applicability_note && <span className="cm-meta">{citation.applicability_note}</span>}
        {citation.snippet && <span className="cm-snippet">“{citation.snippet}”</span>}
        <a href={citation.official_url} target="_blank" rel="noreferrer">查看官方原文 →</a>
      </span>
    </sup>
  );
}

type ActionStep = AnswerResponse["action_steps"][number];

const UNGROUPED_LABEL = "未标注具体依据";

/**
 * 「法规要求」里各部法律出现的固定次序：公司法 → 所得税 → GST → FEMA → RBI。
 * 用户核对合规时习惯按这个顺序过一遍，不希望每次回答里的先后随模型输出摇摆。
 * 没匹配到这几类的法律排在它们之后（按原有出现顺序），「未标注具体依据」始终垫底。
 */
const LAW_ORDER_PATTERNS: RegExp[] = [
  /companies act|company act|公司法/i,
  /income[\s-]?tax|所得税/i,
  /\bgst\b|goods and services tax|货物与服务税|增值税/i,
  /\bfema\b|foreign exchange management/i,
  /\brbi\b|reserve bank of india/i,
];

function lawRank(law: string): number {
  if (law === UNGROUPED_LABEL) return LAW_ORDER_PATTERNS.length + 1;
  const index = LAW_ORDER_PATTERNS.findIndex((pattern) => pattern.test(law));
  return index >= 0 ? index : LAW_ORDER_PATTERNS.length;
}

/**
 * 按「依据哪部法律」给法规要求分组，再按上面的固定次序排序。
 * 分组依据是模型为每条要求标注的引用序号（citation_refs）→ 对应引用的 display_title。
 * 一条要求依据多部法律时，归到第一条引用所属的法律，其余引用仍以角标形式跟在文字后面。
 * 没标注依据的，单独归到「未标注具体依据」，不丢内容也不假装它有出处。
 */
/**
 * 一条要求归到哪部法律下面。
 *
 * ## 为什么不能只看第一个角标（2026-09-28 修）
 *
 * 实测事故：一条要求同时引了角标 14（Income-tax Act, 2025）和 31
 * （CBDT 的 Office Memorandum F.No.404/72/93-ITCC，讲 stay of demand 的预缴比例）。
 * 原来按 `citation_refs[0]` 归组，于是这一条挂在「Income-tax Act, 2025 法律」下面，
 * **那份备忘录的名字在页面上一个字都没出现**。
 *
 * 危害不只是"少显示了一个来源"：`legal-hierarchy.ts` 里写得很清楚，
 * circular／备忘录是税务机关的行政解释，**只约束税务官、不约束法院**。
 * 把它的内容摆在「法律」这个位阶徽标底下，等于给一份最弱的依据盖了最高的章。
 *
 * 改成两件事：
 *   ① 归组看**位阶最高**的那条引用，不看顺序——这条要求真正的法源是那部法。
 *   ② 引用跨了多部法律时，把其余几部**显式列在条目里**，各自带自己的位阶。
 *
 * ## 为什么位阶之前还要先过一道法域（2026-09-29 修）
 *
 * 上面那条规则修完之后，反向的事故立刻出现了：用户问 GST，
 * 一条要求同时引了角标 5（ICAI IDTC – GST Law）和角标 11（Income-tax Act, 2025）。
 * 按位阶排，法律 > 行业指南，于是选中 Income-tax Act——
 * 这条讲进项税抵扣、讲「罚款为应纳税额的 10% 或 1 万卢比」的纯 GST 内容，
 * 被挂到了「**所得税 / DTAA**」这个标题下面，
 * 而它真正的出处 ICAI IDTC 降级成了一行小字「另据」。
 *
 * 位阶规则本身没写错，错在**它是在跨法域的候选里排序的**。
 * 位阶只在同一法域内部可比：所得税法的位阶再高，它也不是一个 GST 问题的法源。
 * 「法律 > 通告」是对的，「所得税法 > GST 指南」这个比较**本身就不成立**。
 *
 * 所以顺序改成 **先法域、后位阶**：
 *   ① 先把候选缩到"属于用户所问法域"的那些；
 *   ② 在这个子集里再按位阶取最高。
 *
 * 两个刻意的退让，方向都是"宁可不收窄，也不丢内容"：
 *   · 法域认不出来（空数组）→ 不收窄，退回纯位阶。
 *   · 这一条一个引用都落不进所问法域 → 也不收窄。这种情况下收窄会得到空集，
 *     而把这条要求整条判成"无依据"比归错组更糟。
 */
function primaryCitation(
  step: ActionStep,
  citations: Citation[],
  questionCategories: string[] = [],
) {
  const cited = step.citation_refs
    .map((ref) => citations[ref - 1])
    .filter((c): c is Citation => Boolean(c?.display_title));
  if (cited.length === 0) return undefined;
  // ① 法域闸门。只在"缩窄之后还有候选"时才生效，见上面的说明。
  const inDomain = questionCategories.length === 0
    ? cited
    : cited.filter((c) => questionCategories.includes(lawCategoryOf(c.display_title).id));
  const pool = inDomain.length > 0 ? inDomain : cited;
  // ② HIERARCHY_RANK 数字越小位阶越高。稳定取最小值，平手时保持原顺序。
  return pool.reduce((best, current) =>
    HIERARCHY_RANK[classifyHierarchy(current.display_title)]
      < HIERARCHY_RANK[classifyHierarchy(best.display_title)] ? current : best);
}

/** 除主法源之外，这一条还引到的其他法律（去重，保持出现顺序）。 */
export function secondaryLaws(
  step: ActionStep,
  citations: Citation[],
  questionCategories: string[] = [],
): string[] {
  const primary = primaryCitation(step, citations, questionCategories)?.display_title;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of step.citation_refs) {
    const title = citations[ref - 1]?.display_title;
    if (!title || title === primary || seen.has(title)) continue;
    seen.add(title);
    out.push(title);
  }
  return out;
}

function groupStepsByLaw(
  steps: ActionStep[],
  citations: Citation[],
  questionCategories: string[] = [],
) {
  const groups = new Map<string, ActionStep[]>();
  for (const step of steps) {
    const label = primaryCitation(step, citations, questionCategories)?.display_title
      ?? UNGROUPED_LABEL;
    groups.set(label, [...(groups.get(label) ?? []), step]);
  }
  // Array.prototype.sort 是稳定排序（ES2019+）：同一优先级内部保持原有顺序。
  return [...groups.entries()].sort(([left], [right]) => lawRank(left) - lawRank(right));
}

/**
 * 法律**类别**——比"单部法律"粗一层的归类。
 *
 * 起因（2026-09-20 用户要求）：跨法域的问题会引到五六部法律，
 * 按单部法律平铺，界面上就是五六个并列的小标题，用户看不出哪些是一类的。
 * 先归到"所得税""公司法""GST"这种大类，组内再按单部法律分，层次就出来了。
 *
 * 和后台总览那套 `document-category.ts` 是同一组类别、但**刻意不复用它**：
 * 那个模块是服务端的，前端 import 会把服务端代码打进客户端包；
 * 而且那边的输入是 fileName，这边的输入是引用的 `display_title`，
 * 判据本来就不同。两处各自维护，各自的注释里互相指一下。
 */
/**
 * 答案侧的类别归类：只把 id 配上中文名，**判据本身在 `lib/law-categories.ts`**。
 *
 * 判据 2026-09-29 从这里搬走了。原因：服务端的引用法域闸门
 * （`lib/server/citation-domain.ts`）判的是同一个东西——引用里的法律正式名。
 * 留两份正则各自演化，迟早出现"前端认为这条是 GST、服务端认为不是"的分裂。
 *
 * 唯一留在这里的是 `UNGROUPED_LABEL` 这个前端专有的哨兵值：
 * "未标注具体依据"不是一个法律类别，它是"压根没有依据"，服务端侧没有这个概念。
 */
export function lawCategoryOf(law: string): { id: string; label: string } {
  if (law === UNGROUPED_LABEL) return { id: "ungrouped", label: UNGROUPED_LABEL };
  const id = lawCategoryOfTitle(law);
  return { id, label: lawCategoryLabel(id) };
}

/**
 * 把「按单部法律分好的组」再收进「法律类别」。
 *
 * 只有**类别数 ≥ 2** 时才真的分层展示——只涉及一个类别时多套一层标题是纯噪音
 * （"公司法与 MCA/ROC" 下面只有一个"The Companies Act, 2013"，等于说了两遍）。
 * 这个判断放在这里而不是渲染里，是为了让"要不要分层"这件事只有一处定义。
 */
export function groupLawsByCategory(
  lawGroups: Array<[string, ActionStep[]]>,
): Array<{ id: string; label: string; laws: Array<[string, ActionStep[]]> }> {
  const buckets = new Map<string, { id: string; label: string; laws: Array<[string, ActionStep[]]> }>();
  for (const entry of lawGroups) {
    const category = lawCategoryOf(entry[0]);
    const bucket = buckets.get(category.id);
    if (bucket) bucket.laws.push(entry);
    else buckets.set(category.id, { ...category, laws: [entry] });
  }
  // 类别之间的次序，沿用组内单部法律的最高优先级——这样整体顺序和原来一致，
  // 不会因为多套一层分组就把用户熟悉的排列打乱。
  return [...buckets.values()].sort((a, b) =>
    Math.min(...a.laws.map(([law]) => lawRank(law)))
    - Math.min(...b.laws.map(([law]) => lawRank(law))));
}

/** 竖向流程图：有明确先后顺序的实务建议用这个渲染，纯CSS，不引图表库。 */
function PracticalFlow({ steps, renderRefs, renderUnverified, renderSuperseded }: {
  steps: ActionStep[];
  renderRefs: (step: ActionStep) => ReactNode;
  renderUnverified: (step: ActionStep) => ReactNode;
  renderSuperseded: (step: ActionStep) => ReactNode;
}) {
  return (
    <ol className="practical-flow">
      {steps.map((step, index) => (
        <li key={step.text} className="practical-flow-node">
          <span className="practical-flow-index">{index + 1}</span>
          <span className="practical-flow-text">
            {step.text}
            {renderRefs(step)}
            {/* 实务建议这一路同样要挂：线上那条 15% 恰恰就出现在实务建议第 7 条里，
                只在法规要求那一路挂等于漏掉了它真正出事的地方。 */}
            {renderSuperseded(step)}
            {renderUnverified(step)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * 双栏标尺的一个区块：左栏只装标签，右栏只装内容。
 *
 * 2026-09-21 改版的核心。改之前区块标题（结论／前提假设／法规要求／实务建议／相关判例）
 * 横在内容上方，五个从不被阅读的词各吃一段垂直空间，用户为它们滚了五次屏。
 * 移进左栏之后标题和内容**并排**，首屏从"结论 + 前提假设"扩到
 * "结论 + 关键数值 + 前提假设 + 法规要求第一个类别"。
 *
 * `sub` 是标签下面那行小字概览（"3 个法律类别 · 6 部法源"）。它替用户回答了
 * "这一块有多少东西"，省掉一次滚到底的试探。数字一律现算，不写死。
 *
 * 窄屏（<820px）由 CSS 折回单栏，标签退回内容上方——和改版前一样，不会更差。
 */
function AnswerRow({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="answer-row answer-section">
      <div className="answer-rail">
        <h2 className="answer-block-title">{title}</h2>
        {sub ? <span className="answer-rail-sub">{sub}</span> : null}
      </div>
      <div className="answer-col">{children}</div>
    </section>
  );
}

/** 骨架里的一格。结构和 `dispute-track.ts` 的 TrackCell 对齐。 */
interface TrackCell {
  key: string; value: string; basis: "STATUTE" | "PRACTICE_ESTIMATE";
  note?: string; citation_override?: string; hierarchy?: string;
}
interface TrackStage {
  id: string; label: string;
  citation?: string | { act_2025: string; act_1961: string };
  note?: string; cells: TrackCell[];
  /** `"__branch__"` 表示分叉块插在这一级之后。见渲染处的说明。 */
  next?: string | null;
}
interface DisputeTrackView {
  label: string;
  branch_question?: string;
  branches?: Array<{ id: string; when: string; label: string; stages: TrackStage[] }>;
  stages: TrackStage[];
  running_cost?: Record<string, {
    label?: string; value?: string; note?: string; carve_out?: string;
    /** 分级罚款。条文按情节把罚款分成几档，平铺成一句话会让用户看不出差 4 倍。 */
    scale?: Array<{ level: string; rate: string; cite?: string; note?: string }>;
    misreporting_cases?: { label?: string; items?: string[] };
    waiver?: { label?: string; text?: string; cite?: string };
  }>;
  /** 条号 → 角标序号。服务端确定性查出来的，见 dispute-citations.ts。 */
  _citations?: Record<string, { ref?: number; label: string; missing: boolean }>;
}

/**
 * 配置里的注释用 `**粗体**` 写强调，而 JSX 会把星号原样渲染出来
 * （2026-09-29 截图里就是 `**不是法条**` 带着星号显示）。
 *
 * 不引 markdown 库——只为一种标记引个依赖不划算，而且渲染 HTML
 * 会把配置文件变成一个能注入标签的地方。这里只认 `**…**`，其余原样。
 */
function boldMarks(text: string): ReactNode[] {
  // split 带捕获组时，**奇数位**就是被 ** 包起来的那一段。
  return text.split(/\*\*(.+?)\*\*/g).map((part, index) =>
    index % 2 === 1
      ? <strong key={index}>{part}</strong>
      : <Fragment key={index}>{part}</Fragment>);
}

/**
 * 骨架里一个条号的角标。
 *
 * 三种状态，**必须长得不一样**：
 *   查到了      正常角标，点开看原文
 *   库里没有    明说「库里没有这一条」——不是"这个数不需要依据"，
 *              而是依据应该有、库里缺。这句话还能直接喂给补库清单。
 *   骨架没写    什么都不显示
 *
 * 把"查不到"降级成"没角标"是错的：两者在用户眼里是完全不同的两件事。
 */
function TrackCitation({
  keyText, citations, answer,
}: {
  keyText?: string;
  citations?: DisputeTrackView["_citations"];
  answer: AnswerResponse;
}) {
  if (!keyText) return null;
  const resolved = citations?.[keyText];
  if (resolved?.ref) {
    const citation = answer.citations[resolved.ref - 1];
    if (citation) return <CitationMark citation={citation} index={resolved.ref} />;
  }
  if (resolved?.missing) {
    return <span className="dispute-cite-missing" role="note">库里没有这一条</span>;
  }
  return null;
}

/** 双条号（所得税 2025 法重排过）收敛成主 + 旧。 */
function stageCitation(citation: TrackStage["citation"]) {
  if (!citation) return {};
  if (typeof citation === "string") return { primary: citation };
  return { primary: citation.act_2025, legacy: citation.act_1961 };
}

/**
 * 一个审级。
 *
 * ⚠**法定格子和实务估计格子必须长得不一样**——这是整个流程图的要害。
 * 平均耗时没有任何条文依据，但又必须显示（只给单价不给乘数，
 * 等于给了一张没法用的价目表）。显示了就得说清它没出处。
 */
function DisputeStage({
  stage, citations, answer,
}: {
  stage: TrackStage;
  citations?: DisputeTrackView["_citations"];
  answer: AnswerResponse;
}) {
  const { primary, legacy } = stageCitation(stage.citation);
  const mark = (keyText?: string) => (
    <TrackCitation keyText={keyText} citations={citations} answer={answer} />
  );
  return (
    <div className="dispute-node">
      <div className="dispute-node-head">
        <span className="dispute-node-title">{stage.label}</span>
        {primary ? (
          <span className="dispute-node-ref">
            {primary}
            {mark(primary)}
            {legacy ? (
              <span className="dispute-node-legacy">
                （旧法 {legacy}{mark(legacy)}）
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="dispute-cells">
        {stage.cells.map((cell) => (
          <div
            key={cell.key}
            className={`dispute-cell ${cell.basis === "STATUTE" ? "dispute-cell-law" : "dispute-cell-est"}`}
          >
            <span className="dispute-cell-key">
              {cell.key}
              {cell.basis === "PRACTICE_ESTIMATE"
                ? <span className="dispute-est-tag">无条文</span>
                : null}
              {cell.hierarchy === "CIRCULAR"
                ? <span className="dispute-cell-hier">通函</span>
                : null}
            </span>
            <span className="dispute-cell-val">{cell.value}</span>
            {cell.note ? <span className="dispute-cell-note">{boldMarks(cell.note)}</span> : null}
            {cell.citation_override ? (
              <span className="dispute-cell-note">
                依据：{cell.citation_override}{mark(cell.citation_override)}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** YYYY-MM-DD → 「2026年10月20日」。解析失败原样返回——展示函数不许抛错。 */
function cnDateOf(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate;
  const [, y, m, d] = match;
  return `${Number(y)}年${Number(m)}月${Number(d)}日`;
}

/**
 * 输入框里的纯日期本身不说明它是哪一种日期；而所得税的版本判断不能把 Notice 日期、
 * 登录日期等误当作交易日期。用户从专用追问框提交完整日期时，明确把它标成交易 /
 * 付款 / 收入发生日期，服务端才能按既定的严格规则识别。FY、AY 则保留用户原样。
 */
function incomeTaxTimeSupplement(period: string): string {
  const value = period.trim();
  // 人们常输入 2026/10/14 或 2026年10月14日；对话框不该要求用户记住某一种分隔符。
  // 统一成 ISO 再交给服务端，日期的合法性（如 2 月 30 日）仍由服务端最终校验。
  const date = value.match(/^(20\d{2})\s*(?:年|[/.／-])\s*(\d{1,2})\s*(?:月|[/.／-])\s*(\d{1,2})(?:日)?$/);
  if (date) {
    const [, year, month, day] = date;
    const isoDate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return `补充的所得税适用期间：具体交易、付款或收入发生日期为 ${isoDate}`;
  }
  // DD/MM/YYYY 仅在“日”大于12时有唯一含义；其余写法交给服务端继续追问，
  // 不把 10/11/2026 擅自解释成 10 月或 11 月。
  const unambiguousDayFirst = value.match(/^(\d{1,2})\s*[/.／-]\s*(\d{1,2})\s*[/.／-]\s*(20\d{2})$/);
  if (unambiguousDayFirst && Number(unambiguousDayFirst[1]) > 12) {
    const [, day, month, year] = unambiguousDayFirst;
    const isoDate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return `补充的所得税适用期间：具体交易、付款或收入发生日期为 ${isoDate}`;
  }
  return `补充的所得税适用期间：${value}`;
}

function AnswerCard({ answer, onDeadlineReminder, onIncomeTaxTimeSubmit, incomeTaxTimeBusy = false }: {
  answer: AnswerResponse;
  /**
   * 点击「回复截止日」提示行时回调（2026-10-13）：父组件拿预填信息跳到合规提醒页。
   * 提醒**不在这里直接创建**——AI 建议的日期必须经用户确认，这是产品规则表的硬约束；
   * 这里只做"带日期跳过去"，最终按下「创建」的是用户本人。
   */
  onDeadlineReminder?: (prefill: { title: string; date: string; detail?: string }) => void;
  /**
   * 所得税期间的专用追问。父组件保留上一条完整问题，只把这一行补充显示成新的用户消息，
   * 这样服务端收到的是可独立判断的一整段事实，不依赖未落库的追问卡片。
   */
  onIncomeTaxTimeSubmit?: (period: string) => void;
  incomeTaxTimeBusy?: boolean;
}) {
  const [incomeTaxTime, setIncomeTaxTime] = useState("");
  const isIncomeTaxTimeClarification = answer.clarification_kind === "INCOME_TAX_TIME";
  const mandatory = answer.action_steps.filter((step) => step.kind === "MANDATORY");
  const practical = answer.action_steps.filter((step) => step.kind === "PRACTICAL");
  // 第三个参数是法域闸门：先法域、后位阶。见 primaryCitation 的说明。
  const mandatoryGroups = groupStepsByLaw(
    mandatory, answer.citations, answer.question_categories ?? [],
  );
  /**
   * 「法律类别 → 法条 → 条目」三层。
   *
   * 2026-09-21 之前这里是摊平成一维再在每个类别首部法律上挂个标题，理由是
   * "渲染那段有七八十行，套一层容易改错"。现在改回嵌套，因为**类别变成了真正的容器**：
   * 改版前的嵌套关系是画反的——低一层的「法条」套着浅底圆角块，高一层的「类别」
   * 只有一条上边框，于是三部法律看起来像三张并列卡片，而它们其实同属一个法域。
   * 容器归还给类别之后，DOM 上就必须真的嵌套，摊平做不出盒子。
   *
   * 当初怕改错的那段渲染已经抽成了 `renderRequirementTable`，嵌套层只剩两行 map。
   *
   * 只有一个类别时不渲染类别头：那种情况下标题是废话
   * （"公司法与 MCA/ROC" 下面只有一部《公司法》，等于同一件事说两遍），
   * 但**盒子要留着**——它现在承担"这一组是一个整体"的分组语义。
   */
  const mandatoryCategories = groupLawsByCategory(mandatoryGroups);
  const showCategoryTitles = mandatoryCategories.length >= 2;
  const mandatoryLawCount = mandatoryCategories.reduce((sum, c) => sum + c.laws.length, 0);

  /* 争议应对型才有。`dispute_track` 在契约里是 unknown——它是配置文件里的原样数据，
     服务端不做形状转换（转换越多、和配置走偏的机会越多），所以在这里断言一次。 */
  const disputeTrack = answer.question_type === "DISPUTE_RESPONSE"
    ? (answer.dispute_track as DisputeTrackView | undefined)
    : undefined;
  const trackStageCount = disputeTrack
    ? disputeTrack.stages.length
      + (disputeTrack.branches ?? []).reduce((sum, b) => sum + b.stages.length, 0)
    : 0;

  const renderRefs = (step: ActionStep) => step.citation_refs.map((ref) => {
    const citation = answer.citations[ref - 1];
    return citation ? <CitationMark key={ref} citation={citation} index={ref} /> : null;
  });

  /*
   * 角标适合在读某一条要求时即时核对；但原句核验补进的 Act 如果只留在角标里，
   * 用户很容易看不到它已经被补入。把本次回答真正用到的引用汇成卡片底部的
   * 「法律原文」：这里不列检索到但最终没有被回答采用的资料，避免把候选资料误读成依据。
   */
  const legalOriginals = [...new Set(answer.action_steps.flatMap((step) => step.citation_refs))]
    .sort((left, right) => left - right)
    .map((ref) => {
      const citation = answer.citations[ref - 1];
      if (!citation) return null;
      // 优先展示已经逐字核验过的 supporting sentence；没有时才退回该引用资料的原文摘录。
      const verifiedQuotes = [...new Set(answer.action_steps
        .filter((step) => step.citation_refs.includes(ref)
          && step.quote_status === "VERIFIED"
          && Boolean(step.source_quote?.trim()))
        .map((step) => step.source_quote!.trim()))];
      return { ref, citation, originalText: verifiedQuotes.join("\n\n") || citation.snippet };
    })
    .filter((item): item is {
      ref: number;
      citation: Citation;
      originalText?: string;
    } => Boolean(item));

  const legalOriginalsSection = legalOriginals.length > 0 ? (
    <AnswerRow title="法律原文" sub={`${legalOriginals.length} 条引用`}>
      <div className="citation-section">
        {legalOriginals.map(({ ref, citation, originalText }) => (
          <a
            key={ref}
            href={citation.official_url}
            target="_blank"
            rel="noreferrer"
          >
            <span className="cite-index">{ref}</span>
            <span className="cite-body">
              <strong>{citation.display_title}</strong>
              <span className="cite-meta">
                {citation.authority}
                {citation.date ? ` · ${citation.date}` : ""} · {citation.locator}
              </span>
              {originalText ? <span className="cite-original">“{originalText}”</span> : null}
              <span className="cite-link">查看官方原文 →</span>
            </span>
          </a>
        ))}
      </div>
    </AnswerRow>
  ) : null;

  // 有明确的 PARTIAL / NONE 覆盖结果时，理由跟着答案放在最末尾；
  // 读者先看到结论和依据，再决定这个缺口是否影响自己的决策。
  const showCoverageReminder = answer.answer_status === "SUFFICIENT"
    && Boolean(answer.evidence_sufficiency)
    && answer.evidence_sufficiency !== "FULL";
  const coverageGap = answer.evidence_gap
    ?? "本次证据未完整覆盖这个问题，主干结论有依据，但其中某一子问题在已发布的资料里找不到直接条文。";

  // 服务端逐条核对过：这些数值在被引用的条文原文里找不到对应表述。
  // 必须显著提示——模型出现过"凭记忆写错表格编号和期限、却挂着角标"的情况。
  const renderUnverified = (step: ActionStep) => (
    step.unverified_claims.length > 0
      ? (
        <span className="unverified-flag" role="note">
          ⚠ {step.unverified_claims.join("、")} 未在引用条文中找到出处，请核对官方原文
        </span>
      )
      : null
  );

  // 服务端把模型附的英文原句拿去和被引用的条文原文做过精确匹配。
  // 对不上意味着"结论也许对，但引用可能指错了条款"——这种错误光看角标发现不了，
  // 必须显式说出来。VERIFIED / SKIPPED 不打扰用户。
  /**
   * 这一条除了所在分组那部法，还引了别的法律时，把它们列出来。
   *
   * 不列的后果见 `groupStepsByLaw` 的说明：一条同时引了所得税法和 CBDT 备忘录的
   * 要求，会整条挂在「Income-tax Act, 2025 法律」下面，而那份备忘录
   * **在页面上一个字都不出现**——一份只约束税务官、不约束法院的行政解释，
   * 被盖上了「法律」的章。
   *
   * 位阶跟着一起显示，因为这正是要让用户看见的那个差别。
   */
  const renderSecondaryLaws = (step: ActionStep) => {
    const laws = secondaryLaws(step, answer.citations, answer.question_categories ?? []);
    if (laws.length === 0) return null;
    return (
      <span className="step-secondary-laws">
        另据：
        {laws.map((law, index) => {
          const level = HIERARCHY_SHORT_LABEL[classifyHierarchy(law)];
          return (
            <span key={law}>
              {index > 0 ? "；" : ""}
              {law}
              {level ? <span className="law-group-level">{level}</span> : null}
            </span>
          );
        })}
      </span>
    );
  };

  /**
   * 用了「引用条文自己标注为已被取代」的数值。
   *
   * 这一条必须用**最重的**那套警示样式（和 unverified-flag 同级），因为它比
   * "找不到出处"更容易蒙混过关：数字确实逐字出现在原文里，角标也挂得对，
   * 用户从任何外观特征上都看不出问题。差别只在条文后面那句 NOTE 里。
   *
   * 文案里把新值直接写出来——只说"可能已过时"等于把活丢回给用户，
   * 而我们手上明明有那个新值。但**不替他改**，理由见
   * `intra-document-supersession.ts`：那一条也可能讲的就是历史年度。
   */
  const renderSuperseded = (step: ActionStep) => {
    const items = step.superseded_values ?? [];
    if (items.length === 0) return null;
    return (
      <>
        {items.map((item) => (
          <span key={item.used} className="unverified-flag" role="note">
            {/* ⚠不能写 markdown 的 ** **：JSX 会把星号原样渲染出来，用真的 <strong>。 */}
            {item.kind === "REVERSED" ? (
              <>
                ⚠ 本条把 {item.used} 说成了现行值，但所引用的条文
                <strong>自己标注的现行值是 {item.replacement}</strong>，方向可能写反了。请核对原文。
              </>
            ) : item.kind === "UNCLEAR" ? (
              <>
                ⚠ 本条同时出现 {item.used} 和 {item.replacement}，但没有写明哪个是现行值。
                所引用的条文标注 <strong>{item.used} 已调整为 {item.replacement}</strong>。请核对原文。
              </>
            ) : (
              <>
                ⚠ 本条用的 {item.used}，被所引用的条文
                <strong>自己标注为已调整为 {item.replacement}</strong>。请点开角标核对原文后再使用。
              </>
            )}
          </span>
        ))}
      </>
    );
  };

  const renderQuoteStatus = (step: ActionStep) => {
    if (step.quote_status === "NOT_FOUND") {
      return (
        <span className="unverified-flag" role="note">
          ⚠ 本条标注的条文原句未能在所引用的条文中找到，引用可能指错条款，请点开角标核对
        </span>
      );
    }
    // 表格型条文：用柔和样式，且**不说"指错条款"**——系统确实分不清，
    // 乱扣帽子的代价是用户以后连真警示也不信。理由见 quote-check.ts 的 TABLE_MARKER。
    if (step.quote_status === "TABLE_UNVERIFIABLE") {
      return (
        <span className="unverified-flag unverified-flag-soft" role="note">
          本条出自表格型条文，原文列序错乱，无法自动核验原句（不代表引用有误，可点开角标看原文）
        </span>
      );
    }
    if (step.quote_status === "MISSING") {
      return (
        <span className="unverified-flag unverified-flag-soft" role="note">
          本条未附条文原句，无法自动核验出处
        </span>
      );
    }
    return null;
  };

  /**
   * 「法规要求」和「相关判例」两块的先后，由服务端下发的 `case_led` 决定。
   *
   * 默认（绝大多数问题）：法规要求 → 实务建议 → 相关判例。用户问的是"该怎么做"，
   * 法定义务当然是主角，判例是补充参考。
   *
   * `case_led === true`（"目前有哪些海关方面的官司""找几个转让定价的案子"）：
   * 判例提到最前面，法规要求的标题改成「相关法律依据」排在后面。
   * 起因是 2026-09-18 实测——用户问"有哪些海关方面的官司"，拿到的是海关法
   * 上诉程序条文摆在最上面、判例埋在最底下，**方向反了**。
   *
   * 刻意不做成"只给判例"：用户找判例时通常也需要知道上诉期限、管辖法院这些条文基础。
   * 换的是主次，不是删信息。判定逻辑在服务端 `case-relevance.ts`，
   * 前端只认这一个布尔值，不自己猜。
   */
  /**
   * 一部法律下的全部要求，一律走表格。
   *
   * 改版前是"超过 3 条才转表格，3 条及以下用列表"。结果是同一屏里一半列表一半表格，
   * 「依据」那一列对不齐——想逐条核对、或者要把这页导出给税务顾问的人，得来回找。
   * 统一表格换来整个「法规要求」区的纵向对齐，代价只是单条要求也带一行表头，
   * 而表头只在**类别内的第一部法律**上渲染（`withHead`），不会每部法律重复一遍。
   */
  const renderRequirementTable = (steps: ActionStep[], withHead: boolean) => (
    <table className="requirement-table">
      {withHead && (
        <thead>
          <tr><th scope="col">序号</th><th scope="col">法规要求</th><th scope="col">依据</th></tr>
        </thead>
      )}
      <tbody>
        {steps.map((step, index) => (
          <tr key={step.text}>
            <td>{index + 1}</td>
            <td>
              {step.text}
              {renderSecondaryLaws(step)}
              {renderSuperseded(step)}
              {renderUnverified(step)}
              {renderQuoteStatus(step)}
            </td>
            <td className="requirement-table-refs">
              {step.citation_refs.length > 0 ? renderRefs(step) : <span className="no-ref">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const mandatorySection = mandatory.length > 0 ? (
    <AnswerRow
      /* 判例当主角时，这一块的标题改成「相关法律依据」——它此刻的角色是
         给判例提供条文背景（上诉期限、管辖法院），不再是答案的主干。 */
      title={answer.case_led ? "相关法律依据" : "法规要求"}
      sub={<>
        {showCategoryTitles ? `${mandatoryCategories.length} 个法律类别` : null}
        {showCategoryTitles ? <br /> : null}
        {`${mandatoryLawCount} 部法源 · ${mandatory.length} 条`}
      </>}
    >
      {mandatoryCategories.map((category) => (
        <section key={category.label} className="law-category">
          {showCategoryTitles ? <div className="law-category-head">{category.label}</div> : null}
          {category.laws.map(([law, steps], lawIndex) => (
            <div key={law} className="law-group">
              {/* 法条名 + 位阶。位阶从资料名推断（Act / Rules / Notification / Circular），
                  推断不出来时不显示——挂一个"未知"角标没有信息量。 */}
              <h3 className="law-group-title">
                <span>{law}</span>
                {HIERARCHY_SHORT_LABEL[classifyHierarchy(law)]
                  ? <span className="law-group-level">{HIERARCHY_SHORT_LABEL[classifyHierarchy(law)]}</span>
                  : null}
              </h3>
              {renderRequirementTable(steps, lawIndex === 0)}
            </div>
          ))}
        </section>
      ))}
    </AnswerRow>
  ) : null;

  /* 阶段三：判例检索命中时才会有这个字段（大多数问题不涉及判例，通常是空/缺省）。
          本地案例库和实时兜底查到的案例字段丰富程度不一样（实时兜底只有标题/来源/摘录），
          按产品决定不加"本地/实时"标签区分，各字段缺省时对应那一行不渲染即可，
          不用为了对齐而补空内容。 */
  /**
   * 查过没有 → 明说没有。**不能和"没查过"长得一样。**
   *
   * 2026-09-29 实测：用户直接问「有什么相关案例吗」，判例区整块不渲染，
   * 页面上对他问的那件事一个字都没有。他没法判断是系统没找还是库里没有。
   *
   * 两个值分开写，因为它们是两件不同的事，用户的下一步动作也不同：
   * NO_MATCH 意味着库里该补料；JUDGED_IRRELEVANT 意味着找到了但不沾边，
   * 补料也不会变。
   */
  const caseEmptySection = answer.case_search_empty ? (
    <AnswerRow title="相关判例" sub="未找到">
      <p className="case-empty">
        {answer.case_search_empty === "JUDGED_IRRELEVANT"
          ? "案例库里检索到了一些判例，但逐份比对后与本问题没有实质关联，因此不列出。"
          : "已检索本平台案例库，未找到与本问题相关的判例。"}
        <span className="case-empty-note">
          这不代表印度没有相关判例，只代表本平台案例库中暂无。涉诉决策请以外部顾问的检索结果为准。
        </span>
      </p>
    </AnswerRow>
  ) : null;

  const caseSection = (
    answer.related_cases && answer.related_cases.length > 0 ? (
    <AnswerRow
      title="相关判例"
      sub={answer.case_digest
        ? `${answer.related_cases?.length ?? 0} 件 · ${answer.case_digest.clusters.length} 个风险主题`
        : `${answer.related_cases?.length ?? 0} 件`}
    >
      {/* 检索口径说明。走专用路由（按公司查 / 按主题查）时才有。
          放在列表**之前**是刻意的：它解释的是"下面这些是怎么来的、是不是你要的那些"，
          放在后面用户已经读完列表、先入为主了再看到就晚了。
          典型内容：「未检索到三星在 benami 这一主题上的判例。以下是其他企业的同类判例，
          它们不是三星的案例。」 */}
      {answer.case_search_note ? (
        <p className="case-search-note">{answer.case_search_note}</p>
      ) : null}
      {/* 有综述就渲染综述（按风险主题横向归纳），没有才退回简短列表。
          原来是把案例库里存的九字段原样 join 出来——单个大案例的字段本身就有几千字，
          三个案例上万字，用户反馈"信息是无用的、零散的"（2026-09-16）。 */}
      {answer.case_digest ? (
        <div className="case-digest">
          {/* 这里原本有一句"判例不是法律依据、法规要求只来自已审核法条"的说明，
              应用户要求删掉（2026-09-17）——这条纪律在服务端是硬性执行的
              （判例不参与 citation_ids），不靠这句话提醒，界面上不必每次重复。 */}
          {answer.case_digest.clusters.map((cluster, index) => (
            <section key={cluster.title} className="case-cluster">
              <h3 className="case-cluster-title">
                <span className="case-cluster-index">{`0${index + 1}`.slice(-2)}</span>
                {cluster.title}
              </h3>
              <p className="case-cluster-challenge">{cluster.challenge}</p>
              <ul className="case-cluster-evidence">
                {cluster.evidence.map((entry) => (
                  <li key={`${entry.docid}-${entry.text.slice(0, 12)}`}>
                    {entry.text}
                    <a
                      className="case-evidence-link"
                      href={`https://indiankanoon.org/doc/${entry.docid}/`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      原文↗
                    </a>
                  </li>
                ))}
              </ul>
              {cluster.takeaway && (
                <p className="case-cluster-takeaway">{cluster.takeaway}</p>
              )}
            </section>
          ))}

          {answer.case_digest.action_points.length > 0 && (
            <section className="case-cluster">
              <h3 className="case-cluster-title">应对要点</h3>
              <ol className="case-action-points">
                {answer.case_digest.action_points.map((point) => <li key={point}>{point}</li>)}
              </ol>
            </section>
          )}

          {answer.case_digest.index.length > 0 && (
            <section className="case-cluster">
              <h3 className="case-cluster-title">重点案例索引</h3>
              <ul className="case-index">
                {answer.case_digest.index.map((entry) => (
                  <li key={entry.docid}>
                    <a href={entry.official_url} target="_blank" rel="noreferrer">{entry.case_name}</a>
                    {entry.angle && <span>{entry.angle}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 综述只读最相关的少量案例，避免一次把上百份长记录送进模型；
              但用户明确来找判例时，所有本地命中的案例都必须可见、可点开核对。 */}
          {answer.related_cases.length > answer.case_digest.index.length && (
            <section className="case-cluster">
              <h3 className="case-cluster-title">本次全部检索结果</h3>
              <ul className="case-index">
                {answer.related_cases.map((item) => (
                  <li key={item.docid}>
                    <a href={item.official_url} target="_blank" rel="noreferrer">{item.caseName}</a>
                    {(item.court_and_year || item.tax_type_and_authority) && (
                      <span>{clampText([item.court_and_year, item.tax_type_and_authority].filter(Boolean).join(" · "), 200)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : (
        <div className="related-cases">
          {answer.related_cases.map((item) => (
            <article key={item.docid} className="related-case-card">
              <h3 className="related-case-name">{item.caseName}</h3>
              {/* ⚠这一行也必须截断。2026-09-22 实测：一件 Vodafone 判例的
                  「争议税种以及主管税局」字段被整理成了两千多字的大杂烩，
                  原样铺出来占了整整一屏。下面 final_ruling / snippet 都 clamp 过，
                  唯独这里漏了——修上一轮"大案例铺满屏"时漏掉的就是这个字段。 */}
              {(item.court_and_year || item.tax_type_and_authority) && (
                <p className="related-case-meta">
                  {clampText([item.court_and_year, item.tax_type_and_authority].filter(Boolean).join(" · "), 200)}
                </p>
              )}
              {/* 退回列表时也要截断：这些字段在大案例里动辄几千字，原样铺开就是之前那个问题。 */}
              {item.final_ruling && item.final_ruling.length > 0 && (
                <p className="related-case-line">
                  <strong>裁定结果：</strong>{clampText(item.final_ruling.join("；"), 220)}
                </p>
              )}
              {item.snippet && <p className="related-case-snippet">{clampText(item.snippet, 220)}</p>}
              <a className="related-case-link" href={item.official_url} target="_blank" rel="noreferrer">
                查看判例原文
              </a>
            </article>
          ))}
        </div>
      )}
    </AnswerRow>
    ) : null
  );

  return (
    <article className="answer-card">
      <div className="answer-card-head">
        {!showCoverageReminder && (
          <StatusPill status={answer.answer_status} sufficiency={answer.evidence_sufficiency} />
        )}
        <span className="no-charge">
          {answer.legal_as_of ? (
            <span className="legal-as-of">本回答依据的法律，截至 {answer.legal_as_of} 经核验为现行有效</span>
          ) : null}
          {answer.charge_eligible ? "本次问答扣1次问答额度" : "本次不扣次数"}
        </span>
      </div>

      <div className="answer-card-body">

      {/* 回复截止日红色提示行（2026-10-13）：Notice/Order 里写明了具体回复期限时，
          这是整张卡片里最不容错过的一行——错过它，后面写得再好都是被告席上的证据。
          日期来自服务端对上传文件的提取（数字核验过原文），但 OCR 认错数字挡不住，
          所以把**原文写法**一并展示，让用户能对回原件核对。
          点击＝带着这个日期跳到合规提醒页**预填**，不自动创建（用户确认是硬约束）。 */}
      {answer.reply_deadline && (
        <button
          type="button"
          className="deadline-alert"
          onClick={() => onDeadlineReminder?.({
            title: `${answer.reply_deadline!.authority ?? "印度税务"}Notice/Order 回复截止`,
            date: answer.reply_deadline!.date,
            detail: `截止日期取自上传文件原文「${answer.reply_deadline!.text}」，创建前请对照原件核对。`,
          })}
        >
          <strong>本 Notice/Order 需要在 {cnDateOf(answer.reply_deadline.date)} 之前回复</strong>
          <small>文件原文写法：{answer.reply_deadline.text} · 点击设置截止日提醒</small>
        </button>
      )}

      {/* 结论 + 关键数值 + 前提假设合成一块「结论板」。
          三者合并是因为它们回答的是同一个问题的三个面：
            结论     ——「能不能做 / 要做什么」
            关键数值 ——「具体是多少」
            前提假设 ——「这答案对我成不成立」
          拆成三个区块时用户要滚两次才凑齐，而且前提假设离结论越远、越容易被跳过——
          一个合规工具把适用前提藏起来，比答错更危险。 */}
      {answer.short_conclusion && (
        <AnswerRow title="结论" sub={answer.assumptions.length > 0 ? "含适用前提" : undefined}>
          <div className="verdict-board">
            <div className="verdict-main">
              {/* 这句话是整张卡片的语义锚点。它下面那行关键数值是视觉锚点，
                  两者挨在一起。上面那个「结论」标题反而是最小的一档——它只是定位标签。
                  完整的字号阶梯说明见 globals.css 里 :root 上方那段注释。 */}
              <p className="answer-lead">{answer.short_conclusion}</p>

              {/* 关键数值：全页最大的字。服务端 `key-figures.ts` 已逐个回查过
                  ——每个数值都必须逐字出现在某条已核验的法规要求条目里，对不上的整条丢弃。
                  所以这里拿到几条就渲染几条，**不补占位符凑满四格**：
                  只有两个有出处的数值就显示两个，比凑四个诚实。
                  --kf-count 把实际条数喂给 CSS 栅格，两条时就是两格等宽。 */}
              {answer.key_figures.length > 0 && (
                <div
                  className="key-figures"
                  style={{ "--kf-count": answer.key_figures.length } as CSSProperties}
                >
                  {answer.key_figures.map((figure) => (
                    <div key={figure.value} className="key-figure">
                      <b>{figure.value}</b>
                      <small>
                        {figure.label}
                        {figure.note ? <><br />{figure.note}</> : null}
                      </small>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {answer.assumptions.length > 0 && (
              <div className="assumption-block">
                <span className="assumption-cap">本答案成立的前提</span>
                <ol className="assumption-list">
                  {answer.assumptions.map((item) => <li key={item}>{item}</li>)}
                </ol>
              </div>
            )}
          </div>
        </AnswerRow>
      )}

      {isIncomeTaxTimeClarification && onIncomeTaxTimeSubmit ? (
        <AnswerRow title="补充适用期间" sub="不扣次数">
          <div className="income-tax-time-dialog">
            <p>上一条问题已保留。填一项即可继续核对：</p>
            <form
              className="income-tax-time-form"
              onSubmit={(event) => {
                event.preventDefault();
                const period = incomeTaxTime.trim();
                if (period && !incomeTaxTimeBusy) onIncomeTaxTimeSubmit(period);
              }}
            >
              <input
                aria-label="所得税适用期间"
                value={incomeTaxTime}
                onChange={(event) => setIncomeTaxTime(event.target.value)}
                placeholder="例如 FY21-22、AY 2021/22、2026年5月或2026/10/14"
                disabled={incomeTaxTimeBusy}
                autoComplete="off"
              />
              <button type="submit" disabled={!incomeTaxTime.trim() || incomeTaxTimeBusy}>
                {incomeTaxTimeBusy ? "核对中…" : "继续"}
              </button>
            </form>
            <small>具体日期优先；FY21-22、AY 2021/22、财年21-22都可以。仅有“21-22”时，请补 FY 或 AY。</small>
          </div>
        </AnswerRow>
      ) : answer.missing_information.length > 0 && (
        <AnswerRow title="请补充" sub={`${answer.missing_information.length} 项`}>
          <ol>
            {answer.missing_information.map((item) => <li key={item}>{item}</li>)}
          </ol>
        </AnswerRow>
      )}

      {/* 争议应对型：审级流程图排在法规要求**之前**。
          用户处在一个有时限、有对手的处境里，他第一眼要看的是
          「我还有多少天、下一步在哪一级」，不是法条清单。
          骨架不经过模型，见 dispute-track.ts。 */}
      {disputeTrack && (
        <AnswerRow
          title="争议流程"
          sub={<>
            {disputeTrack.label}
            <br />
            {trackStageCount} 个审级
          </>}
        >
          <div className="dispute-flow">
            {/* 顺序由数据驱动：**分叉块插在 `next === "__branch__"` 的那一级之后**。
                不要写成"先分叉、再主干"——起点（评估令 + 缴款通知）是主干的第一级，
                分叉发生在它之后。第一版就是把分叉硬编码在最前面，
                结果起点整个不见了（2026-09-29 用户发现）。 */}
            {disputeTrack.stages.map((stage, index) => (
              <Fragment key={stage.id}>
                {index > 0 ? <div className="dispute-arrow" /> : null}
                <DisputeStage
                  stage={stage}
                  citations={disputeTrack._citations}
                  answer={answer}
                />
                {stage.next === "__branch__" && disputeTrack.branch_question ? (
                  <>
                    <span className="dispute-branch-q">{disputeTrack.branch_question}</span>
                    <div className="dispute-branches">
                      {(disputeTrack.branches ?? []).map((branch) => (
                        <div key={branch.id} className="dispute-branch">
                          <span className="dispute-branch-cap">{branch.when} → {branch.label}</span>
                          {branch.stages.map((bs) => (
                            <DisputeStage
                              key={bs.id}
                              stage={bs}
                              citations={disputeTrack._citations}
                              answer={answer}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </Fragment>
            ))}

            {/* 贯穿全程的成本：不属于任何一个审级，所以不能塞进节点里。
                利息的 carve_out 必须跟着一起出现——所得税那条
                「罚款部分在一审裁定前不计息」漏掉就会把利息算多。 */}
            {Object.entries(disputeTrack.running_cost ?? {}).map(([key, item]) => (
              <div key={key} className="dispute-running">
                <strong>{item.label ?? key}</strong>
                {item.value ? `：${item.value}` : ""}
                {item.note ? <span className="dispute-cell-note">{boldMarks(item.note)}</span> : null}
                {item.carve_out ? <span className="dispute-cell-note">{boldMarks(item.carve_out)}</span> : null}

                {/* 分级罚款：**必须分行摆**。50% 和 200% 差四倍，
                    挤在一句话里用户看不出这是同一件事的两个档位，
                    而「是少报还是错报」往往是整个争议里最值钱的争点。 */}
                {item.scale ? (
                  <table className="dispute-scale">
                    <tbody>
                      {item.scale.map((row) => (
                        <tr key={row.level}>
                          <td className="dispute-scale-level">{row.level}</td>
                          <td className="dispute-scale-rate">{row.rate}</td>
                          <td className="dispute-scale-note">
                            {row.note ? boldMarks(row.note) : null}
                            {row.cite ? <span className="dispute-scale-cite">{row.cite}</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}

                {item.misreporting_cases?.items?.length ? (
                  <span className="dispute-cell-note">
                    <strong>{item.misreporting_cases.label}</strong>
                    <span className="dispute-case-list">
                      {item.misreporting_cases.items.map((c) => <span key={c}>{c}</span>)}
                    </span>
                  </span>
                ) : null}

                {item.waiver?.text ? (
                  <span className="dispute-cell-note">
                    <strong>{item.waiver.label}</strong>
                    {boldMarks(item.waiver.text)}
                    {item.waiver.cite ? <span className="dispute-scale-cite">{item.waiver.cite}</span> : null}
                  </span>
                ) : null}
              </div>
            ))}

          </div>
        </AnswerRow>
      )}

      {/* 同一条对话里流程图只画一次。这一轮略过时**必须留一行指路**——
          直接消失会让用户以为系统忘了，而重画整张图是上一次事故本身
          （2026-09-29：追问「有什么相关案例吗」，三级流程图原样又来一遍，
          用户要滚过两页读过的内容才看到他真正问的那个答案）。 */}
      {!disputeTrack && answer.dispute_track_omitted ? (
        <AnswerRow title="争议流程">
          <p className="dispute-omitted">
            {answer.dispute_track_omitted}的审级、期限与预缴比例见本次对话上文，本轮不再重复。
          </p>
        </AnswerRow>
      ) : null}

      {/* 「法规要求」和「相关判例」的先后由 answer.case_led 决定，见下面的注释。 */}
      {answer.case_led && (caseSection ?? caseEmptySection)}
      {mandatorySection}

      {practical.length > 0 && (
        <AnswerRow
          title="实务建议"
          sub={practical.length > 1
            ? `${practical.length} 步${answer.practical_is_sequential ? " · 按先后" : ""}`
            : undefined}
        >
          {/* 只要有两条以上就走流程图：无论是「先做什么再做什么」的步骤，
              还是「要准备哪几份材料」的清单，编号+连线都比一段平铺的列表更好读。 */}
          {practical.length > 1 ? (
            <PracticalFlow
              steps={practical}
              renderRefs={renderRefs}
              renderUnverified={renderUnverified}
              renderSuperseded={renderSuperseded}
            />
          ) : (
            <ol>
              {practical.map((step) => (
                <li key={step.text}>
                  {step.text}
                  {renderRefs(step)}
                  {renderSuperseded(step)}
                  {renderUnverified(step)}
                </li>
              ))}
            </ol>
          )}
        </AnswerRow>
      )}

      {!answer.case_led && (caseSection ?? caseEmptySection)}

      {/* 追问案例细节现查现答：只有这一轮命中了case-detail-lookup.ts那条专门流程才会有
          （追问已展示案例的模板外细节，比如"涉案金额是多少"）。source_quote只有
          quote_status===VERIFIED时才会下发，NOT_FOUND/MISSING时detail本身已经换成
          了"未能核验"的提示语，不会有没核验过的具体数字流到这里被渲染出来。 */}
      {answer.case_detail_answer && (
        <AnswerRow title="案例细节" sub="现查判决书原文">
          <article className="related-case-card">
            <h3 className="related-case-name">{answer.case_detail_answer.caseName}</h3>
            <p className="related-case-line">{answer.case_detail_answer.detail}</p>
            {answer.case_detail_answer.quote_status === "VERIFIED" && answer.case_detail_answer.source_quote && (
              <p className="related-case-snippet">原文依据：{answer.case_detail_answer.source_quote}</p>
            )}
            <a className="related-case-link" href={answer.case_detail_answer.official_url} target="_blank" rel="noreferrer">
              查看判例原文
            </a>
          </article>
        </AnswerRow>
      )}

      {legalOriginalsSection}

      {/* 部分覆盖的警示放在答案最末尾。它仍保留原来的完整理由，
          只是不会在用户读结论前先占据整条头部。 */}
      {showCoverageReminder && (
        <AnswerRow title="证据覆盖" sub="部分覆盖">
          <div className="coverage-reminder" role="note">
            <StatusPill status={answer.answer_status} sufficiency={answer.evidence_sufficiency} />
            <span className="evidence-gap">{coverageGap}</span>
          </div>
        </AnswerRow>
      )}
      </div>
    </article>
  );
}

function ChatView({
  plan,
  onRequireLogin,
  onAnswered,
  resumeConversationId,
  onConversationLoaded,
  onDeadlineReminder,
}: {
  plan: Plan;
  onRequireLogin: () => void;
  /** 每答完一轮回调一次，父组件据此更新「最近对话」列表和额度显示。 */
  onAnswered: (info: { conversationId: string; title?: string; quota?: QuotaView; pending?: boolean }) => void;
  /** 从「最近对话」点进来时带上要继续的那条对话ID；新对话时为空。 */
  resumeConversationId?: string;
  /** 历史对话成功读回来后通知父组件，用来摘掉「最近对话」上的"未取回"标记。 */
  onConversationLoaded: (conversationId: string) => void;
  /** 回答卡片里「回复截止日」提示行的点击回调：带预填日期跳到合规提醒页。 */
  onDeadlineReminder?: (prefill: { title: string; date: string; detail?: string }) => void;
}) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  // 真实系统时间，挂载后再取，避免服务端渲染时间和用户本机时间不一致。
  const [todayLabel, setTodayLabel] = useState("");
  /*
   * 多轮对话的会话ID。**不再从存储里恢复**（2026-09-17改）：
   * 进入网页默认就是新话题，想接着之前的聊要从「最近对话」点进来。
   * 原来存在 sessionStorage 里、挂载时自动恢复，于是刷新一下就接着上一个对话，
   * 和"再次进入默认新话题"这条产品规则是冲突的。
   * 现在这个值只在三种情况下有内容：① 首问后服务端分配的；
   * ② 从「最近对话」点进来时带进来的（resumeConversationId）。
   */
  const [conversationId, setConversationId] = useState(resumeConversationId ?? "");
  const [newTopicNotice, setNewTopicNotice] = useState(false);
  // 知识库覆盖范围，只有聚合数量。取不到就整条不显示——首页宁可少一行，
  // 也不能显示"已收录 0 部法规"这种反效果的文案。
  const [stats, setStats] = useState<PublicStats | undefined>();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const now = new Date();
      setTodayLabel(formatChineseDate(now));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  /*
   * 从「最近对话」点进来时，把之前聊过的内容读回来**原样重现回答卡片**。
   *
   * `answer` 是完整回答，渲染出来和当时看到的一模一样（法规要求、实务建议、
   * 引用、判例综述都在）。老数据里没存完整回答（这个字段2026-09-17才加），
   * 那些轮次只有一句话结论，退回只显示结论——不报错、也不假装有。
   *
   * 读失败（对话已过期、网络问题）同样不拦着用户：照样能在这条对话里继续提问，
   * 只是看不到之前聊了什么；服务端那边的上下文是完整的，不受影响。
   */
  useEffect(() => {
    if (!resumeConversationId) return;
    let cancelled = false;
    fetch(`/api/chat?conversation_id=${encodeURIComponent(resumeConversationId)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((data: { turns?: Array<{
        turn_id: string;
        question: string;
        short_conclusion: string;
        answer?: AnswerResponse;
      }> } | undefined) => {
        if (cancelled) return;
        if (!data?.turns?.length) {
          // 修复前的「不扣次数追问」没有写入服务器；这类旧条目没有可恢复的内容。
          // 留一条明确说明，不能让用户误以为点击没生效或被静默带回新建对话。
          setMessages([{
            id: `history-empty-${resumeConversationId}`,
            role: "assistant",
            text: "这条历史对话尚未保存可恢复的内容。请重新提问一次；之后的补充期间也会完整保存在这里。",
          }]);
          return;
        }
        setMessages(data.turns.flatMap((turn) => [
          { id: `${turn.turn_id}-q`, role: "user" as const, text: turn.question },
          {
            id: `${turn.turn_id}-a`,
            role: "assistant" as const,
            text: turn.answer?.short_conclusion ?? turn.short_conclusion,
            answer: turn.answer,
          },
        ]));
        // 成功把这条对话读回来了 → 那条"点开查看结果"的占位标记该摘掉了。
        // turns 为空说明服务端那边也确实没答成（极少数情况），标记留着更诚实。
        if (data.turns.length > 0) onConversationLoaded(resumeConversationId);
      })
      .catch(() => {
        if (!cancelled) setError("历史对话未能读取，请稍后再试。");
      });
    return () => { cancelled = true; };
  }, [resumeConversationId, onConversationLoaded]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/stats")
      .then((response) => (response.ok ? response.json() : undefined))
      .then((data: PublicStats | undefined) => {
        if (!cancelled && data && data.clauseCount > 0) setStats(data);
      })
      .catch(() => {
        // 统计只是锦上添花，取不到就当没有，不打扰用户、也不打日志。
      });
    return () => { cancelled = true; };
  }, []);

  /** "开始新话题"：只清本地的会话ID，不清屏幕上已经显示的消息——
   *  下一条问题会在服务端开一个新会话，不再延续之前的背景。
   *  和侧边栏的「新建对话」的区别：那个会连屏幕一起清空、算一个全新的对话；
   *  这个是轻量的"就地换个话题"，留着上文给用户看。 */
  function startNewTopic() {
    setConversationId("");
    setNewTopicNotice(true);
    window.setTimeout(() => setNewTopicNotice(false), 2500);
  }

  async function submitQuestion(
    event?: FormEvent,
    submission?: { requestText: string; displayText?: string },
  ) {
    event?.preventDefault();
    const trimmed = (submission?.requestText ?? question).trim();
    const displayText = (submission?.displayText ?? trimmed).trim();
    if (!trimmed || busy) return;

    setError("");
    setQuestion("");
    setMessages((current) => [
      ...current,
      { id: randomId(), role: "user", text: displayText },
    ]);
    setBusy(true);
    setProgress(0);

    const progressTimer = window.setInterval(() => {
      setProgress((current) => Math.min(current + 1, progressLabels.length - 1));
    }, 260);

    // 带上全部有id的附件（含还没提取成功的），不只是EXTRACTED的——服务端会替没能
    // 提取成功的那几个生成具体原因（"notice.jpg：图片格式暂不支持自动识别"这种），
    // 只传成功的那几个会让用户看不懂"为什么还是让我补充"。还在上传中(id为空)的跳过。
    const attachmentIds = attachments.map((item) => item.id).filter(Boolean);

    /*
     * 登录用户的对话 id **在发请求之前就定下来**，而不是等服务端在响应里回传（2026-09-18 改）。
     *
     * 起因：手机上问完问题切到别的 App，iOS Safari / 微信内置浏览器会把页面冻结甚至
     * 回收。服务端不认 `request.signal`，照样跑完、照样落盘、照样扣次——
     * 但**前端从没知道过这次的 conversation_id**（它只在响应里），于是
     * 「最近对话」里没有这条，那份答案成了孤儿：**次数扣了，用户永远找不到**。
     *
     * 现在 id 是前端生成的，下面会立刻写进「最近对话」。页面被回收也没关系，
     * 回来点那条进去，`GET /api/chat` 会把服务端存好的完整答案取回来。
     *
     * 服务端只接受 `conv_<UUID v4>` 这一种形状（见 conversation-store.ts 的
     * isValidConversationId）——并且会按登录账号校验归属。
     *
     * 游客试用不创建「最近对话」入口，也不会把 id 用于下一轮请求。这样页面上的
     * 行为和服务端保持一致：试用答案只能当次查看，历史、追问和文件资料都要登录。
     */
    const activeConversationId = plan === "anonymous" ? "" : (conversationId ?? newConversationId());
    if (plan !== "anonymous" && !conversationId && activeConversationId) setConversationId(activeConversationId);
    /*
     * 先写一条占位进「最近对话」，标题用问题本身截断。
     * 这一步必须在 fetch **之前**——整个修复的意义就在于"答案没回来也留得下线索"。
     * 回答成功后 onAnswered 会用模型概括的标题覆盖它。
     */
    if (plan !== "anonymous" && activeConversationId) {
      onAnswered({
        conversationId: activeConversationId,
        title: trimmed.slice(0, MAX_CONVERSATION_TITLE_LENGTH),
        pending: true,
      });
    }

    try {
      // HTTPS 下这里一定会有 UUID；降级浏览器没有它也仍可正常提问，只是没有
      // “网关超时后与首个请求合并”的额外保护。
      const clientRequestId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : undefined;
      const [response] = await Promise.all([
        fetchChatWithGatewayRetry({
          question: trimmed,
          ...(displayText !== trimmed ? { display_question: displayText } : {}),
          ...(activeConversationId ? { conversation_id: activeConversationId } : {}),
          ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}),
        }, clientRequestId),
        wait(1000),
      ]);

      /*
       * 额度用完时服务端返回 402，带着一句该怎么办的话（游客去注册、
       * 登录用户等下个月）。这里要把它原样告诉用户，并且对游客直接把登录弹窗叫出来——
       * 只说"额度用完了"却不给下一步，等于把人堵在门口。
       */
      if (response.status === 402) {
        const payload = await response.json() as { message?: string; needs_login?: boolean; quota?: QuotaView };
        if (payload.quota) onAnswered({ conversationId: activeConversationId, quota: payload.quota });
        if (payload.needs_login) onRequireLogin();
        throw new Error(payload.message || "额度已用完。");
      }
      if (!response.ok) {
        // 服务端对可解释的失败（如模型服务故障 503）会带 message，原样透传；
        // 解析不出来（网关 502/504、纯文本等）才落到笼统提示。
        let detail = "";
        try {
          detail = ((await response.json()) as { message?: string })?.message ?? "";
        } catch { /* body 不是 JSON，忽略 */ }
        throw new Error(detail || "请求未完成，请稍后再试。");
      }
      const answer = (await response.json()) as AnswerResponse;
      if (plan !== "anonymous" && answer.conversation_id && answer.conversation_id !== activeConversationId) {
        // 正常不该发生（id 是前端定的），但服务端万一因为格式校验没通过而
        // 自己生成了一个，以服务端为准——答案存在哪边，用户就该能从哪边找回来。
        setConversationId(answer.conversation_id);
      }
      setMessages((current) => [
        ...current,
        {
          id: answer.request_id,
          role: "assistant",
          text: answer.short_conclusion,
          answer,
        },
      ]);
      // 更新「最近对话」：按对话记，不按问题记。标题只在首问时随回答下发，
      // 追问那几轮 title 是空的，父组件据此保留原标题、只更新时间和轮次。
      onAnswered({
        conversationId: plan === "anonymous" ? "" : answer.conversation_id,
        title: answer.conversation_title,
        quota: answer.quota,
      });
      setAttachments([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "请求未完成，请稍后再试。");
    } finally {
      window.clearInterval(progressTimer);
      setBusy(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // 对话输入框按 Return 直接发送；只有 Shift + Return 保留换行。
    // 中文输入法正在选词时不能发送，否则按 Return 确认候选词会把半句话提交出去。
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitQuestion();
  }

  /**
   * 选好文件立刻真上传（不等用户提问）：拿到attachment_id和提取出的notice_facts
   * 预览，让用户在真正提问前先看一眼"识别得对不对"。每个文件独立一个UPLOADING占位，
   * 互不阻塞——先选的没传完，后选的也能继续显示上传中。
   */
  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).slice(0, 5);
    event.target.value = "";
    if (plan === "anonymous") {
      onRequireLogin();
      return;
    }
    if (files.length === 0) return;

    const placeholders: AttachmentItem[] = files.map((file) => ({
      localId: randomId(),
      id: "",
      name: file.name,
      status: "UPLOADING",
    }));
    setAttachments((current) => [...current, ...placeholders]);

    const body = new FormData();
    if (conversationId) body.append("conversation_id", conversationId);
    for (const file of files) body.append("files", file);

    try {
      const response = await fetch("/api/attachments", { method: "POST", body });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: string; message?: string } | null;
        if (response.status === 401) onRequireLogin();
        throw new Error(failure?.message ?? "上传未完成，请稍后再试。");
      }
      const payload = (await response.json()) as AttachmentUploadResponse;
      if (payload.conversation_id && payload.conversation_id !== conversationId) {
        setConversationId(payload.conversation_id);
      }
      setAttachments((current) => current.map((item) => {
        const placeholderIndex = placeholders.findIndex((p) => p.localId === item.localId);
        if (placeholderIndex === -1) return item;
        const result = payload.results[placeholderIndex];
        if (!result) return { ...item, status: "FAILED", errorMessage: "上传未完成，请重新选择文件。" };
        return {
          ...item,
          id: result.attachment_id,
          status: result.status,
          errorMessage: result.error_message,
          noticeFacts: result.notice_facts,
        };
      }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "上传未完成，请稍后再试。";
      setAttachments((current) => current.map((item) => (
        placeholders.some((p) => p.localId === item.localId)
          ? { ...item, status: "FAILED", errorMessage: message }
          : item
      )));
    }
  }

  const empty = messages.length === 0;

  return (
    <section className={`chat-view ${empty ? "chat-view-empty" : ""}`}>
      <div className="chat-topline">
        {/* 知识库范围原来在标题下面单独占一行，挪到顶部和日期并排，省出一整行高度。
            取不到统计（或知识库还空着）时退回原来那句静态说明，不留空。 */}
        <span className="source-lock">
          <i aria-hidden="true" />
          {stats
            ? `已收录 ${stats.lawCount} 部法规 · ${stats.clauseCount.toLocaleString("zh-CN")} 个条款`
              + (stats.legalAsOf ? ` · 核验于 ${stats.legalAsOf}` : "")
            : "只使用管理员审核并发布的官方资料"}
        </span>
        <div className="topline-right">
          {!empty && conversationId && (
            <button
              className="quiet-button"
              type="button"
              onClick={startNewTopic}
              title="下一条问题不再延续之前的背景"
            >
              {newTopicNotice ? "已开始新话题" : "开始新话题"}
            </button>
          )}
          {!empty && (
            <ConversationExport
              title={messages.find((item) => item.role === "user")?.text.slice(0, 40) || "印度合规问答"}
              messages={messages}
            />
          )}
          <button className="quiet-button" type="button" title="按此日期检索适用的条文版本">
            当前日期：{todayLabel || "读取中…"}
          </button>
        </div>
      </div>

      {empty ? (
        <div className="welcome-block">
          {/* 2026-09-16 精简：删掉纯装饰的英文小标题、三张信任卡片、单独一行的知识库范围，
              标题改单行——13寸笔记本要在不滚动的情况下看到输入框和"问助手"按钮。
              信息一条没删，只是换了承载方式：信任标识压进下面这句话，知识库范围挪到了顶部。 */}
          <h1>今天有什么可以帮到你</h1>
          <p>
            中文提问，只引用管理员审核过的官方法规原文，每条结论都能点开出处；
            依据不足时不作答，也不扣次数。
          </p>

          <div className="domain-grid" aria-label="常见问题">
            {domainPrompts.map((prompt) => (
              <button
                type="button"
                key={prompt.label}
                onClick={() => setQuestion(prompt.question)}
                className="domain-card"
              >
                <strong>{prompt.label}</strong>
                <small>{prompt.question}</small>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="message-list" aria-live="polite">
          {messages.map((message, index) => {
            const previousUserQuestion = message.answer?.clarification_kind === "INCOME_TAX_TIME"
              ? messages.slice(0, index).reverse().find((item) => item.role === "user")?.text
              : undefined;
            return (
              <div key={message.id} className={`message-row message-${message.role}`}>
                <div className="message-author">{message.role === "user" ? "你" : "合规助手"}</div>
                {/* id 供「导出」取这一轮真实渲染出来的 HTML——导出的就是用户当时看到的那份。 */}
                <div id={`answer-${message.id}`}>
                  {message.answer ? (
                    <AnswerCard
                      answer={message.answer}
                      onDeadlineReminder={onDeadlineReminder}
                      incomeTaxTimeBusy={busy}
                      onIncomeTaxTimeSubmit={previousUserQuestion
                        ? (period) => {
                          const supplement = incomeTaxTimeSupplement(period);
                          void submitQuestion(undefined, {
                            requestText: `${previousUserQuestion}\n\n${supplement}`,
                            displayText: supplement,
                          });
                        }
                        : undefined}
                    />
                  ) : <p>{message.text}</p>}
                </div>
              </div>
            );
          })}
          {busy && (
            <div className="message-row message-assistant progress-message">
              <div className="message-author">合规助手</div>
              <div className="progress-card">
                <span className="progress-dot" aria-hidden="true" />
                <strong>{progressLabels[progress]}</strong>
                <small>没有可靠引用，不会生成正式结论。</small>
              </div>
            </div>
          )}
        </div>
      )}

      <form className="composer" onSubmit={submitQuestion}>
        {attachments.length > 0 && (
          <div className="attachment-row">
            {attachments.map((item) => (
              <div key={item.localId} className={`attachment-chip attachment-chip-${item.status.toLowerCase()}`}>
                <span className="attachment-chip-name">
                  <span>
                    {item.name}
                    {item.status === "UPLOADING" && "（上传中…）"}
                    {item.status === "EXTRACTED" && "（已识别）"}
                    {(item.status === "UNSUPPORTED" || item.status === "FAILED") && "（未能识别）"}
                  </span>
                  <button
                    type="button"
                    aria-label={`移除${item.name}`}
                    onClick={() => setAttachments((items) => items.filter((entry) => entry.localId !== item.localId))}
                  >
                    ×
                  </button>
                </span>
                {item.status === "EXTRACTED" && item.noticeFacts && (
                  <span className="attachment-chip-preview">{summarizeNoticeFacts(item.noticeFacts)}</span>
                )}
                {(item.status === "UNSUPPORTED" || item.status === "FAILED") && item.errorMessage && (
                  <span className="attachment-chip-error">{item.errorMessage}</span>
                )}
              </div>
            ))}
          </div>
        )}
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder="例如：收到印度税局的Notice，应该先做什么？"
          aria-label="输入印度合规问题"
          rows={3}
        />
        <div className="composer-footer">
          <div className="composer-actions">
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png"
              multiple
              onChange={handleFiles}
              hidden
            />
            <button className="attach-button" type="button" onClick={() => fileInput.current?.click()} aria-label="上传文件">
              <span aria-hidden="true">＋</span> 上传Notice、合同或申报文件
            </button>
            <span>Return发送 · Shift + Return换行 · 单次最多5个文件</span>
          </div>
          <button className="send-button" type="submit" disabled={!question.trim() || busy}>
            {busy ? "检索中" : "问助手"}<span aria-hidden="true">↗</span>
          </button>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
      {/* 原来这里还有一行"没有可靠来源时会追问或停止回答，且不扣次数"的说明，
          和标题下那句、以及页脚的免责声明三处重复，为腾出首屏高度删掉了。 */}
    </section>
  );
}

function FilesView({ plan, onLogin }: { plan: Plan; onLogin: () => void }) {
  return (
    <section className="workspace-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">PRIVATE DOCUMENTS</span><h1>我的文件</h1></div>
        <button className="primary-button" type="button" onClick={plan === "anonymous" ? onLogin : undefined}>＋ 上传文件</button>
      </div>
      <div className="privacy-callout"><span>私</span><p><strong>文件只属于你的账户和当前对话。</strong>系统不会把用户文件放进公共知识库，也不会让其他账户检索。</p></div>
      <div className="empty-panel">
        <span className="empty-symbol">文</span>
        <h2>{plan === "anonymous" ? "登录后管理文件" : "还没有上传文件"}</h2>
        <p>支持PDF、Word、TXT、JPG和PNG。单个文件20MB以内，最多100页。</p>
        {plan === "anonymous" && <button type="button" className="text-button" onClick={onLogin}>邮箱登录 →</button>}
      </div>
    </section>
  );
}

/** 提醒列表上的时间，按指定时区显示——截止按印度、提醒按中国，两个时区都要看得懂。 */
function formatInZone(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function reminderStatusLabel(status: ReminderStatus): string {
  if (status === "ACTIVE") return "待发送";
  if (status === "SENT") return "已发送";
  // 连续几次没发出去就停在这里等人工看，而不是继续重试一个必然失败的地址。
  if (status === "PAUSED") return "发送失败，已暂停";
  return "已取消";
}

/**
 * 「合规提醒」页（2026-09-30 从静态占位页改成真功能）。
 *
 * 之前这一页是写死的：日期是假卡片、按钮点了没反应。现在接 /api/reminders，
 * 能建、能看、能取消。列表每次由服务端回全量，前端不做本地拼接——
 * 拼接出来的列表和服务端的真值一旦对不上，最难查。
 */
function RemindersView({ plan, onUpgrade, onLogin, prefill, onPrefillApplied }: {
  plan: Plan;
  onUpgrade: () => void;
  onLogin: () => void;
  /**
   * 从回答卡片「回复截止日」提示行跳过来时带的预填（2026-10-13）。
   * 只做**预填**不做自动创建——AI 建议的日期必须由用户过目后亲手按下「创建」。
   * 应用完立刻通过 onPrefillApplied 通知父组件清掉，避免用户建完提醒再点回
   * 这个页面时字段被莫名其妙地重新填一遍。
   */
  prefill?: { title: string; date: string; detail?: string } | null;
  onPrefillApplied?: () => void;
}) {
  const signedIn = plan !== "anonymous";
  const unlocked = plan === "professional";
  const [reminders, setReminders] = useState<ReminderView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/reminders", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<{ reminders?: ReminderView[] }>) : undefined))
      .then((data) => {
        if (cancelled || !data?.reminders) return;
        setReminders(data.reminders);
      })
      .catch(() => {
        // 列表拉不到就留空：页面其余部分照常可用，不因为一个列表让整页报错。
      })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [plan]);

  // 预填：从回答卡片跳过来时把日期/标题带进表单。应用完立刻清掉（见 props 注释）。
  useEffect(() => {
    if (!prefill) return;
    const timer = window.setTimeout(() => {
      setTitle(prefill.title ?? "");
      setDate(prefill.date ?? "");
      setDetail(prefill.detail ?? "");
      setError("");
      onPrefillApplied?.();
    }, 0);
    return () => window.clearTimeout(timer);
    // 故意不把 onPrefillApplied 放进依赖：它每次渲染都是新函数，放进去会反复触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim() || !date) {
      setError("请填写提醒标题和截止日期。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", title: title.trim(), date, detail: detail.trim() }),
      });
      const data = (await response.json()) as { reminders?: ReminderView[]; message?: string };
      if (!response.ok) {
        setError(data.message ?? "没能创建这条提醒，请稍后再试。");
      } else {
        setReminders(data.reminders ?? []);
        setTitle("");
        setDate("");
        setDetail("");
      }
    } catch {
      setError("网络不通，没能创建这条提醒。");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", id }),
      });
      const data = (await response.json()) as { reminders?: ReminderView[]; message?: string };
      if (response.ok) setReminders(data.reminders ?? []);
      else setError(data.message ?? "没能取消这条提醒。");
    } catch {
      setError("网络不通，没能取消这条提醒。");
    } finally {
      setBusy(false);
    }
  }

  // 说明卡上的日历从"写死的 8 月 18 日"改成真的下一条提醒——
  // 假日期看着像能用，其实是在骗人。
  const next = reminders.find((item) => item.status === "ACTIVE");
  const nextDate = next ? new Date(next.deadlineAt) : null;

  return (
    <section className="workspace-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">DEADLINE REMINDERS</span><h1>合规提醒</h1></div>
        {loaded && reminders.length > 0 && (
          <span className="reminder-count">{reminders.filter((item) => item.status === "ACTIVE").length} 条待发</span>
        )}
      </div>

      {/* 把"什么时候发、发到哪、按哪个时区"讲清楚——用户不该靠猜判断自己会不会收到邮件。 */}
      <div className="reminder-preview">
        <div className="calendar-card">
          <small>{nextDate ? nextDate.toLocaleString("en-US", { timeZone: "Asia/Kolkata", month: "short" }).toUpperCase() : "—"}</small>
          <strong>{nextDate ? nextDate.toLocaleString("en-US", { timeZone: "Asia/Kolkata", day: "numeric" }) : ""}</strong>
        </div>
        <div>
          <span className="pro-chip">专业版</span>
          <h2>截止日前一天，北京时间上午 9 点发邮件</h2>
          <p>
            邮件发到你账号的邮箱（{plan === "anonymous" ? "登录后才有" : "即登录邮箱"}）。
            截止日按印度当地时间算，提醒按北京时间送——收信的人在中国。
            AI 可以从 Notice 里建议日期，但必须由你确认后才会创建提醒。
          </p>
        </div>
      </div>

      {!signedIn && (
        <div className="upgrade-banner">
          <p><strong>登录后才能用合规提醒</strong><span>提醒要发到你账号的邮箱，游客没有邮箱可发。</span></p>
          <button type="button" onClick={onLogin}>登录 / 注册</button>
        </div>
      )}

      {signedIn && !unlocked && (
        <div className="upgrade-banner"><p><strong>专业版每月9.9元</strong><span>每月30次问答、文件分析、Word/PDF导出和合规提醒。</span></p><button type="button" onClick={onUpgrade}>查看专业版</button></div>
      )}

      {signedIn && unlocked && (
        <form className="reminder-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>提醒标题</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：GSTR-3B 月度申报" maxLength={120} />
          </label>
          <label>
            <span>截止日期（印度时间）</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label>
            <span>说明（选填，会写进邮件正文）</span>
            <textarea value={detail} onChange={(event) => setDetail(event.target.value)} placeholder="例如：10月进项税额需在11月20日前完成申报与缴税" maxLength={500} rows={3} />
          </label>
          <div className="reminder-form-footer">
            <span>{error ? <em className="reminder-form-error">{error}</em> : "创建后到点自动发信，随时可以取消。"}</span>
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "提交中…" : "创建提醒"}</button>
          </div>
        </form>
      )}

      {signedIn && loaded && reminders.length === 0 && (
        <p className="reminder-empty">还没有提醒。{unlocked ? "在上面填一条，到点会发邮件给你。" : ""}</p>
      )}

      {signedIn && reminders.length > 0 && (
        <div className="reminder-list">
          {reminders.map((item) => (
            <div key={item.id} className={`reminder-card${item.status === "ACTIVE" ? "" : " is-done"}`}>
              <div className="reminder-card-main">
                <strong>{item.title}</strong>
                {item.detail && <p>{item.detail}</p>}
                <small>
                  截止 {formatInZone(item.deadlineAt, "Asia/Kolkata")}（印度时间）
                  {" · "}提醒 {formatInZone(item.notifyAt, "Asia/Shanghai")}（北京时间）
                </small>
              </div>
              <div className="reminder-card-side">
                <span className="reminder-status">{reminderStatusLabel(item.status)}</span>
                {(item.status === "ACTIVE" || item.status === "PAUSED") && (
                  <button type="button" onClick={() => void cancel(item.id)} disabled={busy}>取消</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ProfileView({ quotaLabel, quotaRemaining, quotaLimit, percent, showUpgrade, onUpgrade, membershipNote }: {
  quotaLabel: string;
  quotaRemaining: number;
  quotaLimit: number;
  percent: number;
  showUpgrade: boolean;
  onUpgrade: () => void;
  /** 会员有效时显示有效期。没有会员就不显示这一行。 */
  membershipNote?: string;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <section className="workspace-panel">
      <div className="panel-heading"><div><span className="eyebrow">COMPANY PROFILE</span><h1>企业档案</h1></div></div>
      <p className="panel-intro">只有你主动选择后，企业档案才会用于当前对话。问题里的明确事实优先。</p>
      {/* 额度与订阅状态（2026-09-30 从侧边栏底部挪进来）：账号相关信息归到账号页。
          侧边栏是深色底，这里是浅色主区域，配色用 .profile-quota 单独写，不能复用暗色的 .quota-card。 */}
      <div className="profile-quota">
        <div className="profile-quota-copy">
          <span>{quotaLabel}</span>
          <strong>{quotaRemaining}<small> / {quotaLimit}次</small></strong>
        </div>
        <div className="quota-ring" style={{ "--quota": `${percent * 3.6}deg` } as CSSProperties}><span>{percent}%</span></div>
        {showUpgrade && <button type="button" className="profile-quota-upgrade" onClick={onUpgrade}>升级专业版</button>}
      </div>
      {membershipNote && <p className="profile-membership-note">{membershipNote}</p>}
      <form className="profile-form" onSubmit={(event) => { event.preventDefault(); setSaved(true); }}>
        <label><span>企业名称</span><input placeholder="例如：ABC India Private Limited" /></label>
        <label><span>企业类型</span><select defaultValue=""><option value="" disabled>请选择</option><option>Private Limited Company</option><option>LLP</option><option>Branch Office</option><option>Liaison Office</option></select></label>
        <label><span>注册邦</span><input placeholder="例如：Maharashtra" /></label>
        <label><span>主要行业</span><input placeholder="例如：制造业" /></label>
        <label><span>外资情况</span><input placeholder="例如：中资股东持股100%" /></label>
        <label><span>GSTIN（选填）</span><input placeholder="仅在需要时填写" /></label>
        <div className="profile-form-footer"><span>{saved ? "已保存到当前演示会话" : "你可以随时修改或删除这些信息。"}</span><button type="submit" className="primary-button">保存档案</button></div>
      </form>
    </section>
  );
}

/**
 * 「全部对话」页（2026-09-30）。侧边栏的「最近对话」是快查列表，这页是全量视图：
 * 搜索 + 列出该账号的全部历史对话，点任意一条回到那条对话继续问。
 * 与主界面共用同一条左侧边栏（app-shell 布局不变，只是主区域换了内容）。
 */
function HistoryView({ conversations, activeId, onOpen }: {
  conversations: ConversationEntry[];
  activeId: string;
  onOpen: (id: string) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const query = keyword.trim().toLowerCase();
  const filtered = query
    ? conversations.filter((entry) => entry.title.toLowerCase().includes(query))
    : conversations;
  return (
    <section className="workspace-panel history-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">ALL CONVERSATIONS</span><h1>全部对话</h1></div>
        <label className="history-search">
          <span className="screen-reader-only">搜索全部对话</span>
          <input
            type="search"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索标题关键词"
          />
        </label>
      </div>
      <p className="panel-intro">共 {conversations.length} 条对话，按最近更新排序。点任意一条回到那条对话继续问。</p>
      {filtered.length === 0 ? (
        <p className="history-page-empty">{query ? "没有匹配标题的对话。" : "还没有历史对话，回到合规问答页问第一个问题吧。"}</p>
      ) : (
        <div className="history-page-list">
          {filtered.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`history-page-item${entry.id === activeId ? " active" : ""}`}
              onClick={() => onOpen(entry.id)}
            >
              <strong>{entry.title}</strong>
              <small>
                {formatHistoryDate(new Date(entry.updatedAt))}
                {entry.turnCount > 1 ? ` · ${entry.turnCount}轮` : ""}
                {entry.pending ? " · 点开查看结果" : ""}
              </small>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** 注册、登录和重置密码。涉及改密的操作均须先验证一次性邮箱验证码。 */
function LoginModal({ onClose, onSignedIn }: { onClose: () => void; onSignedIn: (user: SessionUser) => void }) {
  const [mode, setMode] = useState<"login" | "register" | "reset">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [codeNotice, setCodeNotice] = useState("");
  const [resendAfter, setResendAfter] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needsVerification = mode !== "login";
  const isResettingPassword = mode === "reset";

  function changeMode(nextMode: "login" | "register" | "reset") {
    setMode(nextMode);
    setError("");
    setCodeNotice("");
    setVerificationCode("");
    setPassword("");
    setPasswordConfirmation("");
    setResendAfter(0);
  }

  useEffect(() => {
    if (resendAfter <= 0) return;
    const timer = window.setInterval(() => {
      setResendAfter((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendAfter]);

  async function sendVerificationCode() {
    if (!email.includes("@")) {
      setError("请先填写正确的邮箱地址。");
      return;
    }
    setSendingCode(true);
    setError("");
    setCodeNotice("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: isResettingPassword ? "send_password_reset_code" : "send_registration_code", email }),
      });
      const data = await response.json() as { ok?: boolean; message?: string; resend_after_seconds?: number };
      if (!response.ok || !data.ok) throw new Error(data.message || "验证码发送失败，请稍后再试。");
      setResendAfter(data.resend_after_seconds ?? 60);
      setCodeNotice(
        isResettingPassword
          ? "如该邮箱已注册，验证码已发送；请到邮箱查收（10 分钟内有效）。"
          : "验证码已发送，请到邮箱查收（10 分钟内有效）。",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "验证码发送失败，请稍后再试。");
    } finally {
      setSendingCode(false);
    }
  }

  async function submit() {
    if (needsVerification && password !== passwordConfirmation) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: mode === "reset" ? "reset_password" : mode,
          email,
          password,
          ...(needsVerification ? { passwordConfirmation, verificationCode } : {}),
        }),
      });
      const data = await response.json() as { user?: SessionUser; message?: string };
      if (!response.ok || !data.user) throw new Error(data.message || "操作没成功，请重试。");
      onSignedIn(data.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作没成功，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="login-title">
        <button className="modal-close" type="button" onClick={onClose} aria-label="关闭">×</button>
        <Brand compact />
        <h2 id="login-title">{mode === "login" ? "登录" : mode === "register" ? "注册账号" : "重置密码"}</h2>
        <p>
          {mode === "login"
            ? "登录后，对话记录和额度都记在你的账户上。"
            : mode === "register"
              ? "先验证邮箱，再设置密码。注册后每个自然月有 3 次提问额度。"
              : "验证注册邮箱后，即可设置新密码。重置后，其他设备将需要重新登录。"}
        </p>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="modal-field">
            <span>邮箱</span>
            <div className="email-code-row">
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => { setEmail(event.target.value); setError(""); }}
                placeholder="name@company.com"
              />
              {needsVerification && (
                <button
                  type="button"
                  className="send-code-button"
                  onClick={() => { void sendVerificationCode(); }}
                  disabled={sendingCode || resendAfter > 0 || !email.includes("@")}
                >
                  {sendingCode ? "发送中…" : resendAfter > 0 ? `${resendAfter}s 后重发` : "发送验证码"}
                </button>
              )}
            </div>
          </label>
          {needsVerification && (
            <label className="modal-field">
              <span>邮箱验证码</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={verificationCode}
                onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="请输入 6 位验证码"
              />
            </label>
          )}
          <label className="modal-field">
            <span>密码</span>
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={needsVerification ? "至少8位，含字母和数字" : ""}
            />
          </label>
          {needsVerification && (
            <label className="modal-field">
              <span>确认密码</span>
              <input
                type="password"
                autoComplete="new-password"
                value={passwordConfirmation}
                onChange={(event) => setPasswordConfirmation(event.target.value)}
                placeholder="请再输入一次密码"
              />
              {passwordConfirmation && password !== passwordConfirmation && <small className="password-mismatch">两次输入的密码不一致</small>}
            </label>
          )}
          {codeNotice && <p className="code-notice" role="status">{codeNotice}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button
            className="primary-button full-button"
            type="submit"
            disabled={busy || sendingCode || !email.includes("@") || password.length < 8 || (needsVerification && (verificationCode.length !== 6 || password !== passwordConfirmation))}
          >
            {busy ? "处理中…" : mode === "login" ? "登录" : mode === "register" ? "注册并登录" : "确认并登录"}
          </button>
        </form>
        {mode === "login" ? (
          <div className="auth-links">
            <button type="button" className="text-switch" onClick={() => changeMode("register")}>还没有账号？注册一个</button>
            <button type="button" className="text-switch" onClick={() => changeMode("reset")}>忘记密码？</button>
          </div>
        ) : (
          <button
            type="button"
            className="text-switch"
            onClick={() => changeMode("login")}
          >
            已经有账号了？去登录
          </button>
        )}
        {needsVerification && <small className="demo-note">验证码仅用于账号安全验证，请勿转发给他人。</small>}
      </section>
    </div>
  );
}

/** 服务端下发的套餐档位。价格只有一个来源，前端不自己算钱。 */
interface PricePlan {
  months: number;
  priceFen: number;
  label: string;
  priceYuan: number;
  perMonthYuan: number;
}

function PricingModal({ onClose, onPaid, onLogin }: {
  onClose: () => void;
  onPaid: () => void;
  onLogin: () => void;
}) {
  const [plans, setPlans] = useState<PricePlan[]>([]);
  const [membership, setMembership] = useState<{ active: boolean; paidThrough: string | null; daysLeft: number } | null>(null);
  const [months, setMonths] = useState(1);
  /** 是否已进入"扫码付款"这一步（微信扫码是唯一支付渠道）。 */
  const [channel, setChannel] = useState<"WECHAT" | null>(null);
  const [outTradeNo, setOutTradeNo] = useState("");
  const [codeUrl, setCodeUrl] = useState("");
  const [needLogin, setNeedLogin] = useState(false);
  const [starting, setStarting] = useState(false);
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState("");

  // onPaid 每次渲染都是新函数，直接放进轮询的依赖里会让定时器被反复重建。用 ref 接住。
  const onPaidRef = useRef(onPaid);
  useEffect(() => { onPaidRef.current = onPaid; }, [onPaid]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/membership", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { plans?: PricePlan[]; membership?: { active: boolean; paidThrough: string | null; daysLeft: number } } | null) => {
        if (cancelled) return;
        if (!data) { setNeedLogin(true); return; }
        setPlans(data.plans ?? []);
        setMembership(data.membership ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  /*
   * 付款结果的轮询。**不能只靠支付平台的异步通知**：
   * 通知可能延迟或被挡，而用户正盯着这个页面——只等通知的话，
   * 他付完钱界面还停在"等待支付"，会以为钱付了没到账，然后重复付款。
   */
  useEffect(() => {
    if (!outTradeNo || !channel || paid) return;
    const endpoint = "/api/pay/wechat";
    let cancelled = false;
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      if (attempts > 120) {
        clearInterval(timer);
        setError("等待支付结果超时。如果已经付款成功，刷新页面即可看到会员已生效。");
        return;
      }
      try {
        const response = await fetch(`${endpoint}?order=${encodeURIComponent(outTradeNo)}`, { cache: "no-store" });
        const data = await response.json() as { paid?: boolean; expired?: boolean };
        if (cancelled) return;
        if (data.paid) {
          clearInterval(timer);
          setPaid(true);
          onPaidRef.current();
        } else if (data.expired) {
          clearInterval(timer);
          setError("这笔订单已经超时未支付，请重新下单。");
        }
      } catch {
        // 一次网络抖动不算数，下次轮询继续。
      }
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [outTradeNo, channel, paid]);

  async function startPay() {
    setError("");
    setStarting(true);
    try {
      const response = await fetch("/api/pay/wechat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ months }),
      });
      const data = await response.json() as { outTradeNo?: string; codeUrl?: string; message?: string };
      if (!response.ok || !data.outTradeNo) {
        setError(data.message ?? "下单失败，请稍后重试。");
        return;
      }
      setChannel("WECHAT");
      setOutTradeNo(data.outTradeNo);
      setCodeUrl(data.codeUrl ?? "");
    } catch {
      setError("网络异常，请稍后重试。");
    } finally {
      setStarting(false);
    }
  }

  const selected = plans.find((item) => item.months === months);
  const qr = codeUrl ? qrSvgPath(encodeQr(codeUrl), 2) : null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="modal pricing-modal" role="dialog" aria-modal="true" aria-labelledby="pricing-title">
        <button className="modal-close" type="button" onClick={onClose} aria-label="关闭">×</button>

        {paid ? (
          <>
            <span className="eyebrow">PAYMENT RECEIVED</span>
            <h2 id="pricing-title">会员已生效</h2>
            <p className="pay-success">付款已确认，专业版权益现在就能用。</p>
            <button className="primary-button full-button" type="button" onClick={onClose}>开始使用</button>
          </>
        ) : needLogin ? (
          <>
            <span className="eyebrow">SIMPLE PRICING</span>
            <h2 id="pricing-title">把合规问题问清楚，9.9元一个月</h2>
            <p>购买会员需要先登录——会员是挂在账号上的，换设备登录也能用。</p>
            <button className="primary-button full-button" type="button" onClick={onLogin}>登录 / 注册</button>
          </>
        ) : channel ? (
          <>
            <span className="eyebrow">WECHAT PAY</span>
            <h2 id="pricing-title">微信扫码付款</h2>
            {qr && (
              <div className="pay-qr">
                <svg className="pay-qr-svg" viewBox={qr.viewBox} role="img" aria-label="微信支付二维码">
                  <path d={qr.path} fill="currentColor" shapeRendering="crispEdges" />
                </svg>
                <small>用微信扫上面的二维码</small>
              </div>
            )}
            <p className="pay-waiting">{starting ? "正在生成订单…" : "等待支付结果…"}</p>
            {error && <p className="pay-error">{error}</p>}
            <button className="ghost-button full-button" type="button" onClick={() => {
              setChannel(null);
              setOutTradeNo("");
              setCodeUrl("");
              setError("");
            }}>重新选择套餐</button>
          </>
        ) : (
          <>
            <span className="eyebrow">SIMPLE PRICING</span>
            <h2 id="pricing-title">把合规问题问清楚，9.9元一个月</h2>
            {membership?.active && (
              <p className="pay-success">
                当前会员有效期至 {membership.paidThrough?.slice(0, 10)}，还剩 {membership.daysLeft} 天。现在续费会在到期时间上顺延。
              </p>
            )}
            <div className="plan-picker">
              {plans.map((plan) => (
                <button
                  key={plan.months}
                  type="button"
                  className={`plan-option${plan.months === months ? " is-selected" : ""}`}
                  onClick={() => setMonths(plan.months)}
                >
                  <small>{plan.label}</small>
                  <strong>¥{plan.priceYuan}</strong>
                  <span>折合 ¥{plan.perMonthYuan} / 月</span>
                </button>
              ))}
            </div>
            {plans.length === 0 && <p className="pay-waiting">正在读取套餐信息…</p>}
            <div className="pay-channels">
              <button className="primary-button full-button" type="button" disabled={starting || plans.length === 0} onClick={() => startPay()}>
                微信扫码支付{selected ? ` ¥${selected.priceYuan}` : ""}
              </button>
            </div>
            {error && <p className="pay-error">{error}</p>}
            <small className="demo-note">不会自动续费，到期会邮件提醒您续费。</small>
          </>
        )}
      </section>
    </div>
  );
}

export default function Home() {
  const [view, setView] = useState<WorkspaceView>("chat");
  /** 当前登录的用户。null＝确认没登录（不是"还没查"）。 */
  const [user, setUser] = useState<SessionUser | null>(null);
  /** 额度。登录用户来自账号，游客来自服务端按 cookie 算的试用次数。 */
  const [quota, setQuota] = useState<QuotaView | undefined>();
  const plan: Plan = user?.plan ?? "anonymous";
  const [showLogin, setShowLogin] = useState(false);
  const [showPricing, setShowPricing] = useState(false);
  const [history, setHistory] = useState<ConversationEntry[]>([]);
  /** 换这个值＝让 ChatView 重新挂载（消息、会话ID、输入框、附件一起归零）。 */
  const [chatSessionKey, setChatSessionKey] = useState(0);
  /** 不为空＝这次挂载是要"接着某条历史对话继续问"，而不是开新的。 */
  const [resumeConversationId, setResumeConversationId] = useState("");
  /**
   * 回答卡片「回复截止日」→ 合规提醒页的预填（2026-10-13）。
   * 有值时切到提醒页并填进表单；应用完由 RemindersView 回调清空。
   */
  const [reminderPrefill, setReminderPrefill] = useState<{ title: string; date: string; detail?: string } | null>(null);

  // 列表存在 localStorage，挂载后再读——服务端渲染时没有 window。
  useEffect(() => {
    const timer = window.setTimeout(() => setHistory(readConversationList()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  /*
   * 登录之后，**从服务端把这个账号的对话列表拉回来**（2026-09-18）。
   *
   * 起因：用户实测发现**同一个账号换一个浏览器登录，历史会话记录全没了**。
   * 服务端其实一直存着完整对话（保留 30 天），丢的只是"哪些对话是我的"这份索引——
   * 它一直被放在浏览器的 localStorage 里。和游客额度那个 P0 是同一个形状的错误：
   * **该由服务端持有的东西放在了客户端手上**，区别只是那次被人刷穿，这次用户自己丢数据。
   *
   * 合并而不是替换：这台浏览器上可能还有**登录之前以游客身份问过的对话**，
   * 那些在服务端没有归属、拉不回来，但本地索引还在，不该因为登录就把它们抹掉。
   * 同一个 id 两边都有时以服务端为准（标题和轮次是服务端的更准）。
   */
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetch("/api/conversations", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((data: { conversations?: ConversationEntry[] } | undefined) => {
        if (cancelled || !data?.conversations?.length) return;
        setHistory((current) => {
          const serverIds = new Set(data.conversations!.map((item) => item.id));
          const merged = [
            ...data.conversations!,
            ...current.filter((item) => !serverIds.has(item.id)),
          ]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, MAX_CONVERSATION_ENTRIES);
          writeConversationList(merged);
          return merged;
        });
      })
      .catch(() => {
        // 拉不到就用本地那份——列表是便利功能，不该因为一次网络抖动让页面出错。
      });
    return () => { cancelled = true; };
  }, [user]);

  // 打开页面先问一次"我是谁"：cookie 里的会话还有效就直接是登录状态，
  // 不需要用户每次重新登录。取不到就当游客，不打扰。
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((data: { user?: SessionUser | null } | undefined) => {
        if (cancelled) return;
        setUser(data?.user ?? null);
        if (data?.user) setQuota(data.user.quota);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  /** 付款成功后重新拉一次账号信息——套餐和额度都要跟着变，不能靠前端自己改显示。 */
  async function refreshUser() {
    try {
      const response = await fetch("/api/auth", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { user?: SessionUser | null };
      setUser(data.user ?? null);
      if (data.user) setQuota(data.user.quota);
    } catch {
      // 刷新失败也不影响：付款本身已经入账了，下次进页面自然是对的。
    }
  }

  async function signOut() {
    await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    }).catch(() => {});
    setUser(null);
    setQuota(undefined);
    // 登出后不再显示上一个人的对话列表——这台电脑可能是共用的。
    setHistory([]);
    writeConversationList([]);
    startFreshConversation();
  }

  /**
   * 每答完一轮调一次。**按对话更新，不是按问题追加**——
   * 同一个对话里连问十轮，列表里始终只有这一条。
   * 标题只在首问时随回答下发，追问那几轮 title 是空的，这时保留原标题。
   */
  function recordAnswered(info: { conversationId: string; title?: string; quota?: QuotaView; pending?: boolean }) {
    // 额度每次都跟着回答回来，界面显示的数字因此始终和服务端一致。
    if (info.quota) setQuota(info.quota);
    if (!info.conversationId) return;
    setHistory((current) => {
      const existing = current.find((item) => item.id === info.conversationId);
      const updated: ConversationEntry = {
        id: info.conversationId,
        // 占位写的是问题原文的前若干字；答案回来时 title 是模型概括的标题，覆盖它。
        // 答案回来但没带 title（追问轮次不下发标题）时保留原标题。
        title: info.title || existing?.title || "新对话",
        updatedAt: new Date().toISOString(),
        // **轮次只在答案真的回来时才 +1**：占位那一次不能算，
        // 否则问一次列表上会显示两轮。
        turnCount: (existing?.turnCount ?? 0) + (info.pending ? 0 : 1),
        pending: info.pending === true,
      };
      // 最近聊过的排在最前面。
      const next = [updated, ...current.filter((item) => item.id !== info.conversationId)]
        .slice(0, MAX_CONVERSATION_ENTRIES);
      writeConversationList(next);
      return next;
    });
  }

  /** 历史对话读回来了，摘掉列表上的"未取回"标记。 */
  function markConversationLoaded(conversationId: string) {
    setHistory((current) => {
      if (!current.some((item) => item.id === conversationId && item.pending)) return current;
      const next = current.map((item) =>
        (item.id === conversationId ? { ...item, pending: false } : item));
      writeConversationList(next);
      return next;
    });
  }

  /**
   * 「新建对话」：真的开一个新对话。
   *
   * 改之前它只做了 `setView("chat")`——切一下视图，会话ID和屏幕上的消息都原样留着，
   * 于是点完之后问的下一个问题，服务端仍然当成上一问的追问（2026-09-16 用户指出）。
   * 用户点这个按钮时表达的意思非常明确：**接下来要问的是一件新的事**。
   * 这是整个系统里最可靠的"换话题"信号，比任何文本判断都准，之前却被丢掉了。
   */
  function startFreshConversation() {
    setResumeConversationId("");
    setChatSessionKey((value) => value + 1);
    setView("chat");
  }

  /** 点「最近对话」里的一条：回到那条对话继续问，并把之前聊过什么显示出来。 */
  function resumeConversation(id: string) {
    setResumeConversationId(id);
    setChatSessionKey((value) => value + 1);
    setView("chat");
  }

  /* 额度全部来自服务端（2026-09-17）。改之前这一行是写死的假数据——
     "专业版 12/30""免费 0/3""游客 0/1"，跟后端毫无关系，后端也从不检查。
     服务端还没返回时先按 0 显示，不自己编一个数出来。 */
  const quotaLimit = quota?.limit ?? 0;
  const quotaRemaining = quota?.remaining ?? 0;
  const percent = quotaLimit > 0 ? Math.round((quotaRemaining / quotaLimit) * 100) : 0;

  return (
    <main className="app-shell">
      <header className="mobile-header"><Brand compact /><button type="button" onClick={() => setShowLogin(true)}>{plan === "anonymous" ? "登录" : "账户"}</button></header>
      <aside className="sidebar">
        <Brand />
        <button className="new-chat-button" type="button" onClick={startFreshConversation}><span>＋</span>新建对话</button>
        <nav className="workspace-nav" aria-label="工作区导航">
          {navItems.map((item) => (
            <button type="button" key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>
              <span className="nav-dot" aria-hidden="true" /><span><strong>{item.label}</strong><small>{item.meta}</small></span>
            </button>
          ))}
        </nav>
        <div className="sidebar-section">
          {/* 「全部」进全量历史对话页（HistoryView）：侧边栏的「最近对话」是快查，
              这里是完整列表的入口。之前是无 onClick 的死按钮。 */}
          <div className="section-label"><span>最近对话</span><button type="button" onClick={() => setView("history")}>全部</button></div>
          {history.length === 0 ? (
            <p className="history-empty">还没有历史提问，问一个问题试试。</p>
          ) : (
            history.map((entry) => (
              <button
                key={entry.id}
                className={`history-item${entry.id === resumeConversationId ? " active" : ""}`}
                type="button"
                onClick={() => resumeConversation(entry.id)}
                title="点开接着这条对话继续问"
              >
                <strong>{entry.title}</strong>
                <small>
                  {formatHistoryDate(new Date(entry.updatedAt))}
                  {entry.turnCount > 1 ? ` · ${entry.turnCount}轮` : ""}
                  {/* 占位条目：问题发出去了但这台设备没收到答案（多半是切到别的 App
                      被系统回收了）。服务端那边已经答完存好，点进去就能取回来。
                      不标出来的话，用户看到一条陌生标题会以为是误触。 */}
                  {entry.pending ? " · 点开查看结果" : ""}
                </small>
              </button>
            ))
          )}
        </div>
        {/* 额度卡挪进了「企业档案」页（2026-09-30）：它之前占着侧边栏底部一大块，
            「最近对话」全量展示后留给列表的面积太小（一次只能看到一两条）。
            侧边栏底部现在只保留账号行，列表区域最大化。 */}
        <div className="account-row">
          {/* 头像＝退出入口（2026-10-13 挪过来的）：账号行的文字改成了"升级/续费"引导，
              退出必须另有去处，否则用户找不到登出的地方。悬浮有提示。 */}
          <button
            type="button"
            className="avatar"
            onClick={() => (user ? void signOut() : setShowLogin(true))}
            title={user ? "点击退出登录" : "点击登录或注册"}
          >{user ? user.email.slice(0, 1).toUpperCase() : "访"}</button>
          <button
            type="button"
            className="account-copy"
            onClick={() => (user ? setShowPricing(true) : setShowLogin(true))}
            title={user ? (user.plan === "professional" ? "查看会员与续费" : "升级专业版") : "点击登录或注册"}
          >
            <strong>{user ? user.email : "访客用户"}</strong>
            <small>{user
              ? user.plan === "professional"
                ? user.membership?.active && user.membership.daysLeft != null
                  // 次数一并显示（2026-10-14 用户要求）：专业版是每月 30 次、
                  // 跨月重置（plan-quota.ts），只显示天数时用户不知道这个月还能问几次。
                  ? `专业版用户，剩余 ${user.membership.daysLeft} 天-${quotaRemaining} 次`
                  : "专业版用户"
                : "免费用户·点此升级专业版"
              : `还可试问${quotaRemaining}次`}</small>
          </button>
          {/* prefetch={false}：真实事故(2026-09-16)——Next.js的<Link>默认在进入视口时就会后台预取
              目标页面，这个链接常驻侧边栏、首页一打开就在视口里，于是刚打开首页就会悄悄去请求
              /admin；/admin受proxy.ts的HTTP Basic Auth保护，服务器对这个预取请求回了401，
              浏览器就弹出了原生的账号密码输入框——看起来像是"网站一打开就要登录"，其实登录门槛
              本身没错（只挡了/admin），错在不该让它在没人点击的时候就被悄悄请求到。 */}
          <Link href="/admin" prefetch={false} className="admin-link" aria-label="进入管理员后台">管</Link>
        </div>
      </aside>

      <div className="main-surface">
        {view === "chat" && (
          <ChatView
            key={chatSessionKey}
            plan={plan}
            onRequireLogin={() => setShowLogin(true)}
            onAnswered={recordAnswered}
            resumeConversationId={resumeConversationId || undefined}
            onConversationLoaded={markConversationLoaded}
            onDeadlineReminder={(prefill) => {
              setReminderPrefill(prefill);
              setView("reminders");
            }}
          />
        )}
        {view === "files" && <FilesView plan={plan} onLogin={() => setShowLogin(true)} />}
        {view === "reminders" && (
          <RemindersView
            plan={plan}
            onUpgrade={() => setShowPricing(true)}
            onLogin={() => setShowLogin(true)}
            prefill={reminderPrefill}
            onPrefillApplied={() => setReminderPrefill(null)}
          />
        )}
        {view === "profile" && (
          <ProfileView
            quotaLabel={user ? `${user.plan_label}本月额度` : "试用额度"}
            quotaRemaining={quotaRemaining}
            quotaLimit={quotaLimit}
            percent={percent}
            showUpgrade={plan !== "professional"}
            onUpgrade={() => setShowPricing(true)}
            membershipNote={user?.membership?.active
              ? `会员有效期至 ${user.membership.paidThrough?.slice(0, 10)}（还剩 ${user.membership.daysLeft} 天），到期不自动扣款。`
              : undefined}
          />
        )}
        {view === "history" && (
          <HistoryView conversations={history} activeId={resumeConversationId} onOpen={resumeConversation} />
        )}
      </div>

      {showLogin && (
        <LoginModal
          onClose={() => setShowLogin(false)}
          onSignedIn={(signedIn) => {
            setUser(signedIn);
            setQuota(signedIn.quota);
            setShowLogin(false);
            // 换人登录了，上一个人的对话列表不该留在这台电脑的界面上。
            setHistory([]);
            writeConversationList([]);
            startFreshConversation();
          }}
        />
      )}
      {showPricing && (
        <PricingModal
          onClose={() => setShowPricing(false)}
          onPaid={refreshUser}
          onLogin={() => { setShowPricing(false); setShowLogin(true); }}
        />
      )}
    </main>
  );
}
