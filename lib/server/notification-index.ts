/**
 * Notification 时效核对：答案引用的法律，有没有更晚的修订通知。
 *
 * ## 为什么是"索引"不是"入库"
 *
 * GST / 所得税 / FEMA 的 notification 和 circular 数量极大（CBIC 的 GST notification
 * 2017 年至今超过 1500 份），而且**绝大多数是修订件**——单独读一份没有意义，
 * 必须叠加到母法上才有意义。全量入知识库不现实，也不该做。
 *
 * 所以只维护**元数据索引**：编号、日期、标题、链接、改了哪部母法。
 * 问答时拿答案引用的法律去比对，发现有更晚的修订就提示用户核对。
 * 正文不下载、不入库——真要看内容，用户点链接去官网看原件，那比我们转述可靠。
 *
 * ## 一条不能越的线
 *
 * **只能说"检测到有修订，请核对"，不能说"税率已改为 X%"。**
 *
 * 索引里只有标题，我们没读过正文，不知道它具体改了什么。这种情况下写出任何
 * 具体结论都是编造。措辞必须停在"有修订"这一层。
 *
 * 这和 `quote-check.ts`、`coverage-gap.ts` 是同一条原则：
 * **检索结果的边界不等于事实的边界**，能说到哪一步就只说到哪一步。
 *
 * ## 为什么不按"知识库快照日期"过滤
 *
 * 本来应该是"通知日期 > 我们这份法条的核验日期 → 提示"。但实测发现
 * `legal_as_of`（来自 chunk 的 `legalCurrencyCheckedAt`）**线上 100% 为空**——
 * 上传资料时没人填这个字段。拿一个恒空的字段做过滤条件，等于这道检查从不触发。
 *
 * 所以退一步：**只报每部法最近的那一次修订**，并把话说成
 * "这部法最近一次修订是 X，请确认你依据的版本已包含它"。
 * 不需要知道我们的快照日期也成立，而且不会因为一部法改过 4 次就刷屏。
 *
 * 哪天 `legal_as_of` 补上了，`filterByAsOf` 会自动收紧——它已经写在这里了，
 * 只是现在拿不到值。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Citation } from "../contracts";
import { t, type AnswerLanguage } from "./answer-language";

export interface NotificationEntry {
  source: string;
  domain: string;
  id: string;
  number?: string;
  date?: string;
  title: string;
  url: string;
  pdfUrl?: string;
  /** 母法系列，例如 `FEMA 395`。 */
  amends?: string;
  amendsTitle?: string;
  /** 知识库里对应的资料名。**只有这个字段有值的条目才会用来提示用户**。 */
  kbDocument?: string;
  isAmendment?: boolean;
}

interface IndexFile {
  schemaVersion: string;
  updatedAt?: string;
  entries: NotificationEntry[];
}

const INDEX_PATH = path.join(
  process.env.NOTIFICATION_INDEX_DIR?.trim()
    || process.env.LOCAL_KNOWLEDGE_DIR?.trim()
    || path.join(process.cwd(), ".local-data"),
  "notification-index.json",
);

/**
 * 进程内缓存。索引是离线生成的静态文件，一次问答里不会变；
 * 每次问答都读盘没有意义，而这条链路在关键路径上。
 * 文件不存在时缓存空数组——**不要每次都去试**，那等于每次问答多一次失败的 IO。
 */
let cached: NotificationEntry[] | undefined;

export async function loadNotificationIndex(): Promise<NotificationEntry[]> {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(await readFile(INDEX_PATH, "utf8")) as IndexFile;
    cached = Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    // 索引还没建、或读不动——静默当成"没有索引"。
    // 这条链路是补充信息，不能因为一个可选文件缺失就影响回答。
    cached = [];
  }
  return cached;
}

/** 测试用：清缓存。 */
export function resetNotificationIndexCache(): void {
  cached = undefined;
}

/**
 * 按知识库核验日期过滤：只留下**比我们这份资料更晚**的修订。
 *
 * `asOf` 为空（当前线上的实际情况）时不过滤——见文件头的说明。
 * 不过滤不等于全报，后面还有"每部法只取最新一条"那一步兜着。
 */
export function filterByAsOf(entries: NotificationEntry[], asOf?: string): NotificationEntry[] {
  if (!asOf) return entries;
  return entries.filter((entry) => !entry.date || entry.date > asOf);
}

/**
 * 答案引用的法律，在索引里命中了哪些修订。
 *
 * 匹配用 `kbDocument` 和引用的 `display_title`/`authority` 做**双向包含**：
 * 知识库里的资料名和索引里写的名字不会一字不差（一个是管理员上传时填的，
 * 一个是我维护映射表时写的），但两者之间一定有一方包含另一方的主干。
 * 归一化掉大小写、标点和年份后比对。
 *
 * 每部法**只返回最近一条**——一部法改过 4 次时，把 4 条都摆出来对用户没有增量价值，
 * 他要做的动作是同一个：去官网看现行文本。
 */
export function findNotificationUpdates(options: {
  citations: Citation[];
  entries: NotificationEntry[];
  asOf?: string;
}): NotificationEntry[] {
  const { citations, entries } = options;
  if (citations.length === 0 || entries.length === 0) return [];

  const citedKeys = new Set(
    citations.flatMap((c) => [c.display_title, c.authority].filter(Boolean).map(normalizeLawName)),
  );

  const candidates = filterByAsOf(
    entries.filter((entry) => {
      if (!entry.kbDocument) return false;   // 知识库没收这部法，提示了用户也用不上
      const key = normalizeLawName(entry.kbDocument);
      return [...citedKeys].some((cited) => cited.includes(key) || key.includes(cited));
    }),
    options.asOf,
  );

  // 每个母法系列只留最新的一条。
  const latest = new Map<string, NotificationEntry>();
  for (const entry of candidates) {
    const key = entry.amends ?? entry.kbDocument ?? entry.id;
    const current = latest.get(key);
    if (!current || (entry.date ?? "") > (current.date ?? "")) latest.set(key, entry);
  }
  return [...latest.values()].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

/**
 * 法律名归一化：去掉年份、括号里的修订字样、标点、大小写。
 *
 * 年份必须去掉：知识库里写的是 "FEMA (Deposit) Regulations, **2016**"，
 * 索引里的母法名可能带别的年份或者不带。年份留着，两边永远对不上。
 */
export function normalizeLawName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(?:notification|no|regulations?|rules?|act)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * 生成挂进「风险与例外」的提示语。
 *
 * 措辞刻意保守：说"检测到有更晚的修订通知"，**不说它改了什么**——
 * 我们只有标题，没读过正文。见文件头那条不能越的线。
 */
export function notificationNotes(
  updates: NotificationEntry[],
  language: AnswerLanguage = "zh",
): string[] {
  if (updates.length === 0) return [];
  const items = updates
    .map((u) => language === "en"
      ? `${u.number ?? u.title} (${u.date ?? "date unknown"})`
      : `${u.number ?? u.title}（${u.date ?? "日期不详"}）`)
    .join(language === "en" ? "; " : "；");
  return [t("notificationUpdates", language, { n: updates.length, items })];
}

/** 一次调用拿到提示语。索引缺失时返回空数组，不影响回答。 */
export async function checkNotificationUpdates(options: {
  citations: Citation[];
  asOf?: string;
  language?: AnswerLanguage;
}): Promise<{ notes: string[]; updates: NotificationEntry[] }> {
  try {
    const entries = await loadNotificationIndex();
    const updates = findNotificationUpdates({
      citations: options.citations, entries, asOf: options.asOf,
    });
    return { notes: notificationNotes(updates, options.language ?? "zh"), updates };
  } catch {
    return { notes: [], updates: [] };
  }
}
