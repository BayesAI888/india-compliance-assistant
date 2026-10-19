#!/usr/bin/env node
/**
 * export-acts.mjs — 导出 Indian Kanoon 的「Central Act and Rules」清单 + 全文
 *
 * 语料：doctypes:union-act（数据源 "Union of India - Act"，含 Central Acts / Rules / Regulations / Schemes）
 * 限制：单次查询最多 1000 条结果；按发布时间区间二分分段枚举。
 * 优化：用 maxpages 一次取多页（文档说明按"实际返回页数"计费，₹0.50/页），把上百次请求压成几次。
 * 容错：每完成一个叶子区间即写入 ranges.json（断点续跑不重复付费）；遇 403 优雅停止并保存进度。
 *
 * 子命令：
 *   probe      # 仅探测 API 是否可用（1 次调用）
 *   enumerate  # 分段枚举 -> <out>/catalog.json + ranges.json
 *   download   # 按 catalog 下载全文 HTML + meta
 *   manifest   # 生成 manifest.md
 *   all        # enumerate -> download -> manifest
 *
 * 环境变量：INDIANKANOON_API_TOKEN（必须）、ACTS_OUT（输出目录）
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import path from "node:path";

const API = process.env.INDIANKANOON_API_BASE || "https://api.indiankanoon.org";
const TOKEN = process.env.INDIANKANOON_API_TOKEN;
const OUT = process.env.ACTS_OUT || "/Users/cora/WorkBuddy/2026-09-11-10-47-25/outputs/central_acts";
const FILTER = "act doctypes:union-act";
const PRICE_PAGE = 0.5;
const PRICE_DOC = 0.2;
const MAXPAGES = 100;
const PACE_MS = 800;
// 下载阶段的节奏控制（3,800 次请求，必须放慢，否则重蹈 403）
const DOC_PACE_MS = Number(process.env.ACTS_DOC_PACE_MS || 2500); // 每次请求间隔
const DOC_MAX = Number(process.env.ACTS_DOC_MAX || 0);            // 本轮最多新增下载数，0=不限

// 仅联网子命令才需要 token；manifest 为纯本地操作，不应被拦
function requireToken() { if (!TOKEN) { console.error("缺少 INDIANKANOON_API_TOKEN"); process.exit(1); } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
let costSearch = 0, costDoc = 0;

const CKPT = () => path.join(OUT, "catalog.json");
const RANGES = () => path.join(OUT, "ranges.json");

async function exists(p) { try { await access(p); return true; } catch { return false; } }
async function loadJson(p, dflt) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return dflt; } }

class Blocked extends Error {}

async function ik(pathname, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${API}${pathname}`, {
        method: "POST",
        headers: { Authorization: `Token ${TOKEN}`, Accept: "application/json" },
      });
      if (r.status === 403) {
        const b = await r.text();
        if (i === tries - 1) throw new Blocked(`HTTP 403 ${b.slice(0, 120)}`);
        log(`  ⏳ 403，退避 ${30 * (i + 1)}s 后重试…`);
        await sleep(30000 * (i + 1));
        continue;
      }
      if (r.status === 429 || r.status >= 500) { lastErr = new Error(`HTTP ${r.status}`); await sleep(2000 * (i + 1)); continue; }
      if (r.status >= 400) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
      return JSON.parse(await r.text());
    } catch (e) {
      if (e instanceof Blocked) throw e;
      lastErr = e;
      if (i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

function parseFound(s) {
  if (!s) return 0;
  const m = /of\s+([\d,]+)/.exec(s);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
}
const cleanTitle = (t) => String(t || "").replace(/<\/?b>/g, "").replace(/\s+/g, " ").trim();

function toMeta(x) {
  return {
    docid: x.tid, title: cleanTitle(x.title), docsource: x.docsource || "",
    publishdate: x.publishdate || "", docsize: x.docsize || 0,
    link: `https://indiankanoon.org/doc/${x.tid}/`,
  };
}

async function searchRange(from, to, { pagenum = 0, maxpages } = {}) {
  const formInput = `${FILTER} fromdate:${fmt(from)} todate:${fmt(to)}`;
  const qs = new URLSearchParams({ formInput, pagenum: String(pagenum) });
  if (maxpages) qs.set("maxpages", String(maxpages));
  const d = await ik(`/search/?${qs}`);
  const pages = Math.ceil(((d.docs || []).length || 0) / 10) || 1;
  costSearch += PRICE_PAGE * pages;
  return d;
}

async function probe() {
  const d = await ik(`/search/?${new URLSearchParams({ formInput: "transfer pricing", pagenum: "0" })}`);
  log(`API 可用 ✓ | found=${JSON.stringify(d.found)}`);
}

async function enumerate() {
  await mkdir(OUT, { recursive: true });
  const ranges = await loadJson(RANGES(), {});          // { "from~to": [docid,...] }
  const catalog = new Map((await loadJson(CKPT(), [])).map((x) => [x.docid, x]));

  const save = async () => {
    const list = [...catalog.values()].sort(
      (a, b) => (a.publishdate || "").localeCompare(b.publishdate || "") || a.docid - b.docid);
    await writeFile(CKPT(), JSON.stringify(list, null, 1), "utf8");
    await writeFile(RANGES(), JSON.stringify(ranges, null, 1), "utf8");
  };

  let stop = false;
  async function collect(from, to, depth = 0) {
    if (stop) return;
    const key = `${fmt(from)}~${fmt(to)}`;
    if (ranges[key]) { for (const id of ranges[key]) if (!catalog.has(id)) catalog.set(id, { docid: id }); return; }

    let first;
    try {
      first = await searchRange(from, to, { maxpages: MAXPAGES });
    } catch (e) {
      if (e instanceof Blocked) { log(`⛔ 遭遇 403（${key}），保存进度后停止`); stop = true; return; }
      throw e;
    }
    const total = parseFound(first.found);
    if (total === 0) { ranges[key] = []; return; }

    if (total > 1000 && from < to && depth < 24) {
      const mid = new Date(Math.floor((from.getTime() + to.getTime()) / 2));
      const right = new Date(mid.getTime() + 86400000);
      if (right <= to) {
        log(`  split ${key} (${total}) -> 二分`);
        await collect(from, mid, depth + 1);
        await collect(right, to, depth + 1);
        return;
      }
    }

    let docs = (first.docs || []).map(toMeta);
    const needPages = Math.min(Math.ceil(total / 10), 100);
    if (docs.length < Math.min(total, needPages * 10) && needPages > 1) {
      // maxpages 未被采纳（或只返回首页）：按真实页码逐页补齐
      log(`    ↩ maxpages 仅返回 ${docs.length}/${total}，逐页补齐`);
      for (let p = 1; p < needPages && !stop; p++) {
        try {
          const d = await searchRange(from, to, { pagenum: p });
          docs.push(...(d.docs || []).map(toMeta));
          await sleep(PACE_MS);
        } catch (e) { if (e instanceof Blocked) { stop = true; break; } throw e; }
      }
    }
    ranges[key] = docs.map((x) => x.docid);
    for (const m of docs) if (!catalog.has(m.docid)) catalog.set(m.docid, m);
    log(`  区间 ${key}: ${total} 条 / ${needPages} 页 -> 累计 ${catalog.size}`);
    await save();
    if (total > 1000) log(`  ⚠️ ${key} 达 ${total} 条仍超 1000`);
  }

  log(`开始枚举（${FILTER}）`);
  await collect(new Date(Date.UTC(1700, 0, 1)), new Date(Date.UTC(2035, 11, 31)));
  await save();
  log(`枚举${stop ? "被中断" : "完成"}：${catalog.size} 条 | 搜索花费 ≈ ₹${costSearch.toFixed(2)}`);
  if (stop) { log("稍后重跑 enumerate 会自动跳过已完成区间，不会重复计费。"); process.exit(2); }
  return [...catalog.values()];
}

async function download() {
  const cat = await loadJson(CKPT(), []);
  const rawDir = path.join(OUT, "raw");
  await mkdir(rawDir, { recursive: true });
  log(`开始下载：共 ${cat.length} 条 | 间隔 ${DOC_PACE_MS}ms | 本轮上限 ${DOC_MAX || "不限"}`);
  let done = 0, skipped = 0, failed = 0;
  for (let i = 0; i < cat.length; i++) {
    const { docid } = cat[i];
    if (await exists(path.join(rawDir, `${docid}.html`))) { skipped++; continue; }
    try {
      const d = await ik(`/doc/${docid}/`);
      costDoc += PRICE_DOC;
      const body = d.doc ?? d.content ?? "";
      if (!body) { failed++; continue; }
      await writeFile(path.join(rawDir, `${docid}.html`), body, "utf8");
      await writeFile(path.join(rawDir, `${docid}.meta.json`), JSON.stringify({
        docid, title: d.title ?? cat[i].title, docsource: d.docsource ?? cat[i].docsource,
        publishdate: d.publishdate ?? cat[i].publishdate, link: cat[i].link,
      }, null, 1), "utf8");
      done++;
      if (done % 25 === 0) log(`  下载 ${done}（第 ${i + 1}/${cat.length}，跳过 ${skipped}，失败 ${failed}）`);
      if (DOC_MAX && done >= DOC_MAX) { log(`本轮已达上限 ${DOC_MAX}，停止（重跑可续）。`); break; }
      await sleep(DOC_PACE_MS);
    } catch (e) {
      if (e instanceof Blocked) { log(`⛔ 下载遇 403，已下载 ${done}，稍后重跑可续。`); process.exit(2); }
      failed++; log(`  ✗ ${docid}: ${e.message}`);
    }
  }
  log(`下载完成：新增 ${done}，跳过 ${skipped}，失败 ${failed} | 文书花费 ≈ ₹${costDoc.toFixed(2)}`);
}

async function manifest() {
  const cat = await loadJson(CKPT(), []);
  const rawDir = path.join(OUT, "raw");
  const has = [];
  for (const c of cat) has.push({ ...c, downloaded: await exists(path.join(rawDir, `${c.docid}.html`)) });
  const okCount = has.filter((x) => x.downloaded).length;
  const L = [];
  L.push("# Indian Kanoon — Central Act and Rules 清单");
  L.push("");
  L.push(`- 语料：\`doctypes:union-act\`（数据源 "Union of India - Act"，含 Central Acts / Rules / Regulations / Schemes）`);
  L.push(`- 条目总数：**${cat.length}**；已下载全文：**${okCount}**`);
  L.push(`- 数据来源：Indian Kanoon 官方付费 API（搜索 ₹0.50/页，取文书 ₹0.20/份）`);
  L.push(`- 生成时间：${new Date().toISOString()}`);
  L.push("");
  L.push("| # | docid | 标题 | 发布年份 | 数据源 | 本地文件 | IK 链接 |");
  L.push("|---:|---|---|---|---|---|---|");
  has.forEach((c, i) => {
    const y = (c.publishdate || "").slice(0, 4) || "-";
    L.push(`| ${i + 1} | ${c.docid} | ${String(c.title || "").replace(/\|/g, "／")} | ${y} | ${c.docsource || ""} | ${c.downloaded ? `raw/${c.docid}.html` : "—"} | ${c.link || ""} |`);
  });
  L.push("");
  await writeFile(path.join(OUT, "manifest.md"), L.join("\n"), "utf8");
  log(`清单已生成：${path.join(OUT, "manifest.md")}（${cat.length} 条，已下载 ${okCount}）`);
}

async function main() {
  const cmd = process.argv[2] || "all";
  if (cmd === "probe") { requireToken(); return probe(); }
  if (cmd === "enumerate") { requireToken(); return enumerate(); }
  if (cmd === "download") { requireToken(); return download(); }
  if (cmd === "manifest") return manifest();          // 纯本地，不需要 token
  requireToken();
  await enumerate(); await download(); await manifest();
}

main().catch((e) => {
  if (e instanceof Blocked) { console.error("BLOCKED:", e.message); process.exit(2); }
  console.error("ERROR", e); process.exit(1);
});
