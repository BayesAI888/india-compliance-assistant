#!/usr/bin/env node
/**
 * CBIC Notification 按年历史抓取器 —— 2026-09-21 基于实测接口扩展。
 *
 * 背景：v2 的 `fetchUpdatesByTaxId` 只回每税目【最新 4 条】，无法回溯历史。
 * 实测可用接口：
 *   GET /api/cbic-notification-msts/fetchNotificationByYearAndCategory?taxId={id}&year={y}&page={p}&size={n}
 *     → 该 (税目, 年份) 的【全部 Notification】，支持 page/size 翻页
 *       （实测 Customs 2025 = 192 条，GST 2025 = 90 条，size=300 单页拿全）
 *   每条带 docFilePath(英文) / docFilePathHi(印地语)，用 /content/pdf/<path> 下载。
 *   Circular 无按年接口（后端未实现），本脚本只抓 Notification。
 *
 * 需求（2026-09-21 用户）：只要英文版；除下载外，索引要记录源站 PDF 直链。
 *
 * 网络层同 v2：node:https + rejectUnauthorized:false + 重试 + 12s 超时（证书链不完整+连接飘）。
 *
 * 用法：
 *   node scripts/cbic-fetch-history.mjs                       # Customs+GST 的 2023/2024/2025 Notification（仅英文）
 *   node scripts/cbic-fetch-history.mjs --tax 1000002        # 仅 Customs
 *   node scripts/cbic-fetch-history.mjs --years 2025        # 仅 2025
 *   node scripts/cbic-fetch-history.mjs --dry-run           # 只看会抓多少，不落盘
 *   node scripts/cbic-fetch-history.mjs --all               # 忽略去重，全重下
 *   node scripts/cbic-fetch-history.mjs --lang hi           # 仅印地语（默认 en）
 *
 * 输出：<out>/<税目>/Notification/<年>/<编号>__<标题>.pdf  +  <out>/CBIC-history-index.md（含源链接列）
 * 去重：scripts/cbic-history-state.json（失败不写入，重跑自动补齐；磁盘已有则断点续传）
 */

import https from "node:https";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.CBIC_HOST || "https://taxinformation.cbic.gov.in";
const OUT_DIR = process.env.CBIC_OUT_DIR || "/Users/cora/Desktop/工作/印度税法/源文件/CBIC";
const STATE_PATH = process.env.CBIC_STATE || path.join(__dirname, "cbic-history-state.json");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

// 证书链不完整 + 连接飘 → 关校验 + 连接复用
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 4 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 并发池
async function mapPool(items, limit, fn) {
  const res = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; res[idx] = await fn(items[idx], idx); } };
  const n = Math.min(limit, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return res;
}

function variantFile(dir, no, title, lang, ext) {
  const base = `${sanitize(no, 40)}${lang === "hi" ? "_hi" : ""}__${sanitize(title, 60)}`;
  return path.join(dir, `${base}.${ext}`);
}

function parseArgs(argv) {
  const o = { tax: "1000002,1000001", years: "2023,2024,2025", dryRun: false, all: false, lang: "en", out: OUT_DIR };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--all") o.all = true;
    else if (a === "--tax") o.tax = argv[++i];
    else if (a === "--years") o.years = argv[++i];
    else if (a === "--lang") o.lang = argv[++i];
    else if (a === "--out") o.out = argv[++i];
  }
  return o;
}

function baseHeaders(token) {
  const h = { "Accept": "application/json, text/plain, */*", "Referer": `${HOST}/content-page/explore-notification`, "User-Agent": UA, "language": "en" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function request(url, { token = null, method = "GET", body = null, retry = 4 } = {}) {
  return new Promise((resolve) => {
    let attempt = 0;
    const once = () => {
      const u = new URL(url);
      const headers = baseHeaders(token);
      let payload = null;
      if (body) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(payload); }
      const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers, agent }, (res) => {
        const chunks = []; res.on("data", (d) => chunks.push(d)); res.on("end", () => {
          const buf = Buffer.concat(chunks); const text = buf.toString("utf8");
          if (res.statusCode >= 500 && attempt < retry - 1) { attempt++; return void setTimeout(once, 700 * attempt); }
          let json; try { json = JSON.parse(text); } catch { /* 非 JSON 响应按原文返回 */ }
          resolve({ ok: res.statusCode < 400, status: res.statusCode, json, text, contentType: res.headers["content-type"] || "", buffer: buf });
        });
      });
      req.on("error", (e) => { if (attempt < retry - 1) { attempt++; return void setTimeout(once, 700 * attempt); } resolve({ ok: false, status: 0, text: `网络错误：${e.message}${e.code ? ` (${e.code})` : ""}` }); });
      req.setTimeout(12000, () => req.destroy(new Error("timeout")));
      if (payload) req.write(payload);
      req.end();
    };
    once();
  });
}

let TOKEN = null;
async function ensureToken(force = false) {
  if (TOKEN && !force) return TOKEN;
  const r = await request(`${HOST}/api/authenticate-token`, { method: "POST", body: {} });
  const t = r.json?.id_token;
  if (!t) throw new Error(`取 token 失败：HTTP ${r.status} ${(r.text || "").slice(0, 150)}`);
  TOKEN = t; return t;
}
async function apiGet(url) {
  let t = await ensureToken();
  let r = await request(url, { token: t });
  if (r.status === 401) { t = await ensureToken(true); r = await request(url, { token: t }); }
  return r;
}

const sanitize = (s, max = 90) => (s || "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, max);
async function loadState() { if (!existsSync(STATE_PATH)) return { seen: {} }; try { return JSON.parse(await readFile(STATE_PATH, "utf8")); } catch { return { seen: {} }; } }
const saveState = (s) => writeFile(STATE_PATH, JSON.stringify(s, null, 2), "utf8");

// 下载一份原文：content/pdf 返回 {data: base64}
async function fetchDoc(filePath) {
  const clean = String(filePath).replace(/\\/g, "/");
  const r = await request(`${HOST}/content/pdf/${clean}`);
  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
  const b64 = r.json?.data;
  if (!b64) return { ok: false, reason: "无 data 字段（可能不是 PDF）" };
  return { ok: true, ext: "pdf", buffer: Buffer.from(b64, "base64") };
}

// 按 (税目, 年份) 翻页拉全量 Notification
async function fetchYearNotifications(taxId, year) {
  let page = 0, size = 300, all = [];
  while (true) {
    const r = await apiGet(`${HOST}/api/cbic-notification-msts/fetchNotificationByYearAndCategory?taxId=${taxId}&year=${year}&page=${page}&size=${size}`);
    if (!r.ok || !Array.isArray(r.json) || r.json.length === 0) break;
    all.push(...r.json);
    if (r.json.length < size) break;
    page++; await sleep(200);
  }
  return all;
}

const TAX_NAME = { "1000001": "GST", "1000002": "Customs", "1000003": "Central Excise", "1000004": "Service Tax" };

async function main() {
  const o = parseArgs(process.argv);
  const state = await loadState();
  console.log(`CBIC Notification 历史抓取器 → ${o.out}`);
  console.log(`税目: ${o.tax}  年份: ${o.years}  语言: ${o.lang}\n`);
  await ensureToken();
  console.log("✓ 已取得匿名 token\n");

  const taxIds = o.tax.split(",").map((s) => s.trim()).filter(Boolean);
  const years = o.years.split(",").map((s) => s.trim()).filter(Boolean);

  const items = [];
  for (const tid of taxIds) {
    const taxName = TAX_NAME[tid] || `tax${tid}`;
    for (const y of years) {
      const list = await fetchYearNotifications(tid, y);
      console.log(`  ${taxName} ${y}: ${list.length} 条 Notification`);
      for (const it of list) {
        items.push({
          id: String(it.id ?? ""),
          no: it.notificationNo || `id${it.id}`,
          title: it.notificationName || it.notificationNameToBeDisplay || "",
          en: it.docFilePath || null,
          hi: it.docFilePathHi || null,
          taxName, year: y,
        });
      }
      await sleep(200);
    }
  }
  console.log(`\n共 ${items.length} 条 Notification\n`);

  // 组装下载任务（仅 o.lang 指定语言；默认 en）
  const tasks = [];
  for (const it of items) {
    const label = `${it.taxName} / Notification / ${it.year} / ${it.no}`;
    const p = o.lang === "hi" ? it.hi : it.en;
    if (!p) { console.log(`  · ${label} — 无${o.lang === "hi" ? "印地语" : "英文"}路径，跳过`); continue; }
    const dir = path.join(o.out, sanitize(it.taxName, 40), "Notification", String(it.year));
    const clean = String(p).replace(/\\/g, "/");
    const file = variantFile(dir, it.no, it.title, o.lang === "hi" ? "hi" : "en", "pdf");
    const url = `${HOST}/content/pdf/${clean}`;
    const has = existsSync(file) && statSync(file).size > 200;
    tasks.push(has && !o.all
      ? { skip: true, label, file, id: it.id, no: it.no, title: it.title, type: "Notification", taxName: it.taxName, year: it.year, url }
      : { skip: false, label, file, id: it.id, no: it.no, title: it.title, type: "Notification", taxName: it.taxName, year: it.year, p: clean, url });
  }

  const CONC = Math.max(1, Number(process.env.CBIC_CONCURRENCY || 3));

  if (o.dryRun) {
    const todo = tasks.filter((t) => !t.skip);
    console.log(`[dry-run] 将下载 ${todo.length} 个 ${o.lang === "hi" ? "印地语" : "英文"} PDF，跳过 ${tasks.filter((t) => t.skip).length} 个已存在。`);
    todo.slice(0, 6).forEach((t) => console.log(`  (dry) ${t.label}\n        ← ${t.url}`));
    if (todo.length > 6) console.log(`  ... 共 ${todo.length} 个`);
    return;
  }

  let downloaded = 0, skipped = 0, failed = 0;
  const results = await mapPool(tasks, CONC, async (t) => {
    if (t.skip) { skipped++; return { status: "skip", id: t.id, file: t.file, taxName: t.taxName, type: t.type, year: t.year, no: t.no, title: t.title, url: t.url }; }
    const d = await fetchDoc(t.p);
    if (!d.ok) { console.log(`  ✗ ${t.label} ${d.reason}`); failed++; return { status: "fail", id: t.id }; }
    if (d.buffer.length < 200) { console.log(`  ✗ ${t.label} 文件过小 (${d.buffer.length}B)`); failed++; return { status: "fail", id: t.id }; }
    await mkdir(path.dirname(t.file), { recursive: true });
    await writeFile(t.file, d.buffer);
    console.log(`  ✓ ${t.label} PDF ${(d.buffer.length / 1024).toFixed(0)}KB → ${path.relative(o.out, t.file)}`);
    downloaded++;
    return { status: "ok", id: t.id, file: t.file, taxName: t.taxName, type: t.type, year: t.year, no: t.no, title: t.title, url: t.url };
  });

  // 汇总 + 落盘（state 与 index 均按 id 去重）
  const perItem = {};
  for (const r of results) {
    if (!r || (r.status !== "ok" && r.status !== "skip")) continue;
    if (!perItem[r.id]) perItem[r.id] = { no: r.no, title: r.title, type: r.type, taxName: r.taxName, year: r.year, files: [], urls: [] };
    perItem[r.id].files.push(path.basename(r.file));
    perItem[r.id].urls.push(r.url);
  }
  for (const id of Object.keys(perItem)) {
    const p = perItem[id];
    const s = state.seen[id] || { files: [], urls: [] };
    const fset = new Set(s.files || []); p.files.forEach((f) => fset.add(f));
    const uset = new Set(s.urls || []); p.urls.forEach((u) => uset.add(u));
    state.seen[id] = { number: p.no, name: p.title, type: p.type, tax: p.taxName, date: p.year, files: [...fset], urls: [...uset], at: new Date().toISOString() };
  }
  await saveState(state);

  const flat = (x) => String(x || "").replace(/\s+/g, " ").trim();
  const rows = ["| 税目 | 类型 | 年 | 编号 | 标题 | 文件 | 链接 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...Object.values(state.seen).map((s) =>
      `| ${flat(s.tax)} | ${flat(s.type)} | ${flat(s.date)} | ${flat(s.number)} | ${flat(s.name)} | ${(s.files || []).join(" / ")} | ${(s.urls || []).map((u) => `[PDF](${u})`).join(" ")} |`)];
  const head = `# CBIC Notification 历史索引（${years[0]}–${years[years.length - 1]}）\n\n生成：${new Date().toISOString()}\n\n> 仅英文版。链接为源站 PDF 直链，可点击重下。\n\n`;
  await writeFile(path.join(o.out, "CBIC-history-index.md"), head + rows.join("\n") + "\n", "utf8");
  console.log(`\n清单：${path.join(o.out, "CBIC-history-index.md")}`);
  console.log(`\n完成。下载 ${downloaded} 个文件，跳过 ${skipped} 个（磁盘已存在），失败 ${failed}。`);
  if (skipped && !o.all) console.log("（跳过的是磁盘上已存在的文件；要重下加 --all）");
  if (failed) console.log(`⚠️ ${failed} 个下载失败——重跑本命令即可补齐（断点续传，已下的不会重抓）。`);
}

main().catch((e) => { console.error("\n失败：", e.message); process.exitCode = 1; });
