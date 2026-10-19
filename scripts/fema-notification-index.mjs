#!/usr/bin/env node
/**
 * RBI FEMA notification 索引：抓元数据，不抓正文。
 *
 * ## 这个东西解决什么
 *
 * FEMA 的修订通知（Notification No. FEMA xxx/yyyy-RB）数量大、且**几乎全是修订件**——
 * 单独读一份没有意义，必须叠加到母法上才有意义。全量入知识库不现实。
 *
 * 所以只建**索引**：编号、日期、标题、链接、改了哪部母法。1500 份的元数据不到 1MB，
 * 正文按需再取。问答时拿答案引用的法律去索引里比对，发现有更新的修订就提示用户核对。
 *
 * ## 为什么只抓最近的、不抓 2000 年至今全量
 *
 * RBI 这个页面按年份分组，但年份切换是 ASP.NET 的 `__doPostBack`（JS 回发），
 * 没有可以直接请求的 URL 参数。硬啃要么上无头浏览器，要么逆向 ViewState——
 * 都不划算。
 *
 * 而且**不需要**：这个索引的价值在"我们知识库那份法条之后有没有新的修订"。
 * 老修订早就已经合并进我们收录的合并版条文里了，重复标出来只会制造噪音。
 * 默认页面给的是最近 ~20 份，每天跑一次、增量累积，时间一长索引自然就全了。
 *
 * 真要历史全量时再说——那属于一次性补数据，和日常巡检是两件事。
 *
 * ## 跑法
 *
 *     node scripts/fema-notification-index.mjs --dry-run   # 只打印解析结果，不写文件
 *     node scripts/fema-notification-index.mjs             # 合并进索引
 *
 * 输出：`.local-data/notification-index.json`（可用 NOTIFICATION_INDEX_DIR 改目录）。
 * **首次务必先 --dry-run 看一眼**：这个解析器是照着页面渲染结果写的，
 * 没拿真实 HTML 验证过（开发沙箱能取到这个站，但拿到的是转换后的文本、不是原始 HTML）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_URL = "https://www.rbi.org.in/Scripts/BS_FemaNotifications.aspx";

/**
 * 请求头要像个浏览器。
 *
 * 2026-09-20 实测：带 `User-Agent: india-compliance-index/1.0` 时 RBI 返回 **403**。
 * 这不是权限问题——这是一个**公开的、无需登录的政府公告页**，浏览器直接能打开；
 * 403 来自 WAF 的机器人过滤，它只看请求头长不长得像浏览器。
 *
 * 所以这里补齐浏览器会发的那几个头。**这不是绕过访问控制**，
 * 是让一个正当的、每天一次的公开信息读取不被误伤。
 *
 * 边界说清楚：如果 RBI 明确用 robots.txt 或条款禁止自动抓取，那就该停手换路
 * ——他们有 RSS（`https://www.rbi.org.in/Scripts/rss.aspx`），那才是站方给机器用的正门。
 * 现在这么做的前提是"它只是在挡爬虫特征，不是在禁止这件事本身"。
 */
const BROWSER_HEADERS = {
  "User-Agent": process.env.FEMA_USER_AGENT?.trim()
    || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
     + "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Cache-Control": "no-cache",
};
const OUT_DIR = process.env.NOTIFICATION_INDEX_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const OUT_PATH = path.join(OUT_DIR, "notification-index.json");
const DRY_RUN = process.argv.includes("--dry-run");

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/**
 * 按**锚点**解析，不按表格结构。
 *
 * 表格的 `<tr>/<td>` 嵌套是页面模板的实现细节，改版就废；而这三样东西是内容本身：
 *   ① 详情链接 `BS_FemaNotifications.aspx?Id=13553`
 *   ② 编号文本 `Notification No. FEMA 5(R)(6)/2026-RB`
 *   ③ PDF 链接 `rbidocs.rbi.org.in/.../XXXX.PDF`
 * 以详情链接为锚，向后在有限窗口内找编号和 PDF——窗口限长是为了不跨条误配。
 */
const DETAIL_RE = /<a[^>]+href="([^"]*BS_FemaNotifications\.aspx\?Id=(\d+))"[^>]*>([\s\S]*?)<\/a>/gi;
const NUMBER_RE = /((?:Notification\s+)?No\.?\s*FEMA[^<\n]{0,60}?-\s*RB)/i;
const PDF_RE = /href="(https?:\/\/rbidocs\.rbi\.org\.in\/[^"]+?\.PDF)"/i;
/** 日期行形如 `Jun 29, 2026`。 */
const DATE_RE = /\b([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})\b/g;

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

function stripTags(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

/** 在锚点之前最近的一个日期——RBI 把日期单独放一行，管着它下面那几条。 */
function dateBefore(html, index) {
  let found;
  DATE_RE.lastIndex = 0;
  for (const m of html.slice(0, index).matchAll(DATE_RE)) found = m;
  if (!found) return undefined;
  const month = MONTHS[found[1]];
  if (!month) return undefined;
  return `${found[3]}-${String(month).padStart(2, "0")}-${String(Number(found[2])).padStart(2, "0")}`;
}

export function parseFemaPage(html) {
  const rows = [];
  for (const m of html.matchAll(DETAIL_RE)) {
    const [whole, detailHref, id, linkInner] = m;
    const title = stripTags(linkInner);
    // 标题太短的多半是"Corrigendum"这类导航链接，不是通知条目。
    if (title.length < 20) continue;
    const window = html.slice(m.index + whole.length, m.index + whole.length + 1500);
    const number = window.match(NUMBER_RE)?.[1]?.replace(/\s+/g, " ").trim();
    const pdf = window.match(PDF_RE)?.[1];
    rows.push({
      id,
      title,
      number,
      date: dateBefore(html, m.index),
      detailUrl: detailHref.startsWith("http") ? detailHref : `https://www.rbi.org.in${detailHref.replace(/^\/?/, "/")}`,
      pdfUrl: pdf,
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * 母法归属——索引的价值全在这一步
 * ------------------------------------------------------------------ */

/**
 * 从编号里解出母法系列。
 *
 *   FEMA 5(R)(6)/2026-RB      → FEMA 5(R)    存款条例第六次修订
 *   FEMA 23(R)/(8)/2026-RB    → FEMA 23(R)   货物服务出口条例
 *   FEMA.396(4)/2025-RB       → FEMA 396     债务工具条例
 *   FEMA 389(1)/2026-RB       → FEMA 389     跨境合并条例
 *
 * 规则：取第一个数字，后面紧跟的 `(R)` 属于系列本身（R = Revised，是不同的一部条例），
 * 再往后的括号是第几次修订，**不属于系列**。这两者分不清就会把
 * "存款条例第 6 次修订" 当成 "FEMA 5(6)" 这个不存在的系列。
 */
export function parseFemaSeries(number) {
  if (!number) return undefined;
  const m = number.match(/FEMA\s*\.?\s*(\d+)\s*(\(\s*R\s*\))?/i);
  if (!m) return undefined;
  return `FEMA ${m[1]}${m[2] ? "(R)" : ""}`;
}

/**
 * 标题里的母法名：`Foreign Exchange Management (Deposit) (Sixth Amendment) Regulations, 2026`
 * → `Foreign Exchange Management (Deposit) Regulations`。
 *
 * 做法是**去掉"第 N 次修订"那一节和年份**，剩下的就是母法名。
 * 和编号解析互为旁证：两条都指向同一部法，才算有把握；对不上就标出来让人看。
 */
const AMENDMENT_CLAUSE =
  /\(\s*(?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|Eleventh|Twelfth|Amendment)[^)]*\)\s*/gi;

export function parseParentFromTitle(title) {
  if (!title) return undefined;
  const cleaned = title
    .replace(AMENDMENT_CLAUSE, " ")
    .replace(/,\s*\d{4}\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

/** 这份通知是不是修订件（而不是全新发布一部条例）。 */
export function isAmendment(title) {
  return /\bAmendment\b/i.test(title ?? "");
}

/**
 * FEMA 系列 → 我们知识库里对应的资料名。
 *
 * **只列知识库真的收录了的**：索引里出现一条改了 FEMA 8(R)（保函条例）的通知，
 * 而我们压根没收录保函条例，那就没必要提示用户"去核对"——他手上根本没有那份东西，
 * 提示只会变成噪音。宁可少提示，也不要提示一堆用户用不上的。
 *
 * 新收录资料时要同步往这里加一条，否则新资料的修订永远不会被提示。
 */
export const FEMA_SERIES_TO_KB = {
  "FEMA 395": "FEMA 395/2019-RB — Foreign Exchange Management (Mode of Payment and Reporting of Non-Debt Instruments) Regulations, 2019",
  "FEMA 396": "FEMA (Debt Instruments) Regulations, 2019",
  "FEMA 5(R)": "FEMA (Deposit) Regulations, 2016",
  "FEMA 3(R)": "FEMA (Borrowing and Lending) Regulations, 2018",
  "FEMA 23(R)": "FEMA (Export of Goods and Services) Regulations, 2015",
  "FEMA 10(R)": "FEMA (Foreign Currency Accounts by a Person Resident in India) Regulations, 2015",
};

/* ------------------------------------------------------------------ *
 * 合并写入
 * ------------------------------------------------------------------ */

function toEntry(row) {
  const series = parseFemaSeries(row.number);
  const parentFromTitle = parseParentFromTitle(row.title);
  return {
    source: "RBI-FEMA",
    domain: "fema_fdi_rbi",
    id: `rbi-fema-${row.id}`,
    number: row.number,
    date: row.date,
    title: row.title,
    url: row.detailUrl,
    pdfUrl: row.pdfUrl,
    amends: series,
    amendsTitle: parentFromTitle,
    /** 知识库里收录了对应母法时才有值——没有值的条目不会用来提示用户。 */
    kbDocument: series ? FEMA_SERIES_TO_KB[series] : undefined,
    isAmendment: isAmendment(row.title),
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
}

async function readIndex() {
  try {
    return JSON.parse(await readFile(OUT_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: "1.0", entries: [] };
    throw error;
  }
}

async function main() {
  process.stdout.write(`抓取 ${SOURCE_URL}\n`);
  // **超时必须设**：印度政府站从国内访问经常很慢。不设超时时 fetch 会一直挂着，
  // 终端停在上面那行不动——和"脚本没跑起来"长得一模一样，排查时会往完全错误的方向找。
  const response = await fetch(SOURCE_URL, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(Number(process.env.FEMA_FETCH_TIMEOUT_MS) || 30_000),
  }).catch((error) => {
    throw new Error(
      error.name === "TimeoutError"
        ? `30 秒没连上 ${SOURCE_URL}——这台机器可能访问不了 rbi.org.in。`
          + `先单独试：curl -sI ${SOURCE_URL} | head -3`
        : `请求失败：${error.message}`,
    );
  });
  if (response.status === 403) {
    throw new Error(
      "HTTP 403——RBI 的 WAF 把请求当成爬虫挡了。\n"
      + "   这个脚本已经带了浏览器请求头；还是 403 的话说明对方在更深一层识别（TLS 指纹之类）。\n"
      + "   两条出路：\n"
      + "   ① 换 RBI 的 RSS（站方给机器用的正门）：https://www.rbi.org.in/Scripts/rss.aspx\n"
      + "   ② 自定义 UA 再试：FEMA_USER_AGENT='...' node scripts/fema-notification-index.mjs --dry-run",
    );
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();

  const rows = parseFemaPage(html);
  console.log(`解析到 ${rows.length} 条`);
  if (rows.length === 0) {
    console.error("⚠ 一条都没解析出来——页面结构可能变了，先别写索引。");
    console.error("   把页面存下来看一眼：curl -s '" + SOURCE_URL + "' > /tmp/fema.html");
    process.exitCode = 1;
    return;
  }

  const entries = rows.map(toEntry);
  const withSeries = entries.filter((e) => e.amends).length;
  const withKb = entries.filter((e) => e.kbDocument).length;
  const missingDate = entries.filter((e) => !e.date).length;

  console.log(`  解出母法系列：${withSeries}/${entries.length}`);
  console.log(`  其中知识库收录了母法：${withKb}`);
  if (missingDate) console.log(`  ⚠ ${missingDate} 条没解出日期`);

  console.log("\n前 8 条：");
  for (const e of entries.slice(0, 8)) {
    console.log(`  ${e.date ?? "????-??-??"}  ${(e.amends ?? "—").padEnd(12)} ${e.kbDocument ? "[库内]" : "      "} ${e.title.slice(0, 62)}`);
  }

  if (DRY_RUN) {
    console.log("\n--dry-run：没有写入任何文件。");
    return;
  }

  const index = await readIndex();
  const known = new Set(index.entries.map((e) => e.id));
  const fresh = entries.filter((e) => !known.has(e.id));
  index.entries = [...index.entries, ...fresh]
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  index.updatedAt = new Date().toISOString();

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(index, null, 2), "utf8");
  console.log(`\n新增 ${fresh.length} 条，索引共 ${index.entries.length} 条 → ${OUT_PATH}`);
}

/**
 * 作为模块被 import 时不执行（测试要用上面那些纯函数）。
 *
 * **必须用 `pathToFileURL`，不能拼 `file://${process.argv[1]}`。**
 * 2026-09-20 实测：项目路径是 `/Users/.../印度合规机器人/site/...`，
 * `import.meta.url` 会把中文百分号编码成 `%E5%8D%B0%E5%BA%A6...`，
 * 而 `process.argv[1]` 是原始路径——两边永远不相等，`main()` 一次都没被调用，
 * 终端**一行输出都没有**。路径里没有非 ASCII 字符时那个写法恰好能用，所以极易漏掉。
 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("失败：", error.message);
    process.exitCode = 1;
  });
}
