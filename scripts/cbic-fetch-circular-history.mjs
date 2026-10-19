#!/usr/bin/env node
/**
 * CBIC Circular 按年历史抓取器（2026-09-22 实测扩展）
 *
 * 背景：cbic-fetch-history.mjs 只抓 Notification。Circular 的按年接口长期以为"不存在"，
 *      其实【存在】——此前是方法名拼错（fetchCircularByYearAndCategory ✗）。
 *      正确接口（从 main.js 挖出的 cbicCircularMstService.fetchCircularByYearCategory）：
 *
 *   GET /api/cbic-circular-msts/fetchCircularByYearCategory?taxId={id}&year={y}&page={p}&size={n}
 *     → 该 (税目, 年份) 的全部 Circular。实测 GST 2025=11、Customs 2025=31（size=300 单页拿全）。
 *   字段：circularNo / circularName / circularCategory / docFilePath(英) / docFilePathHi(印)
 *        / issueDt / circularDt / isHistory / isAmended / parentId ...
 *   下载：GET /content/pdf/<docFilePath 正斜杠化> → {"data":"<base64 PDF>"}
 *
 * 需求：仅英文版；索引记录源站 PDF 直链。
 * 网络层同其它脚本：node:https + rejectUnauthorized:false + 重试 + 12s 超时。
 *
 * 用法：
 *   node scripts/cbic-fetch-circular-history.mjs                 # Customs+GST 的 2023/2024/2025 Circular（仅英文）
 *   node scripts/cbic-fetch-circular-history.mjs --tax 1000002
 *   node scripts/cbic-fetch-circular-history.mjs --years 2025
 *   node scripts/cbic-fetch-circular-history.mjs --dry-run
 *   node scripts/cbic-fetch-circular-history.mjs --all           # 忽略磁盘去重，全重下
 *
 * 输出：<out>/<税目>/Circular/<年>/<编号>__<标题>.pdf + <out>/CBIC-circular-history-index.md
 */

import https from "node:https";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.CBIC_HOST || "https://taxinformation.cbic.gov.in";
const OUT_DIR = process.env.CBIC_OUT_DIR || "/Users/cora/Desktop/工作/印度税法/源文件/CBIC";
const STATE_PATH = process.env.CBIC_CIRC_STATE || path.join(__dirname, "cbic-circular-history-state.json");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 4 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mapPool(items, limit, fn) {
  const res = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; res[idx] = await fn(items[idx], idx); } };
  const n = Math.min(limit, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return res;
}

const sanitize = (s, max = 90) => (s || "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, max);
const TAX_NAME = { "1000001": "GST", "1000002": "Customs", "1000003": "Central Excise", "1000004": "Service Tax" };

function parseArgs(argv) {
  const o = { tax: "1000002,1000001", years: "2023,2024,2025", dryRun: false, all: false, out: OUT_DIR };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--all") o.all = true;
    else if (a === "--tax") o.tax = argv[++i];
    else if (a === "--years") o.years = argv[++i];
    else if (a === "--out") o.out = argv[++i];
  }
  return o;
}

function request(url, { token = null, method = "GET", body = null, retry = 4 } = {}) {
  return new Promise((resolve) => {
    let attempt = 0;
    const once = () => {
      const u = new URL(url);
      const headers = { "Accept": "application/json, text/plain, */*", "Referer": `${HOST}/content-page/explore-circular`, "User-Agent": UA, "language": "en" };
      if (token) headers.Authorization = `Bearer ${token}`;
      let payload = null;
      if (body) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(payload); }
      const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers, agent }, (res) => {
        const chunks = []; res.on("data", (d) => chunks.push(d)); res.on("end", () => {
          const buf = Buffer.concat(chunks); const text = buf.toString("utf8");
          if (res.statusCode >= 500 && attempt < retry - 1) { attempt++; return void setTimeout(once, 700 * attempt); }
          let json; try { json = JSON.parse(text); } catch { /* 非 JSON 响应按原文返回 */ }
          resolve({ ok: res.statusCode < 400, status: res.statusCode, json, text });
        });
      });
      req.on("error", (e) => { if (attempt < retry - 1) { attempt++; return void setTimeout(once, 700 * attempt); } resolve({ ok: false, status: 0, text: `网络错误：${e.message}` }); });
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
  TOKEN = r.json?.id_token || null;
  return TOKEN;
}
async function apiGet(url) {
  await ensureToken().catch(() => {});
  let r = await request(url, { token: TOKEN });
  if (r.status === 401) { await ensureToken(true); r = await request(url, { token: TOKEN }); }
  return r;
}

async function fetchYearCirculars(taxId, year) {
  let page = 0, size = 300, all = [];
  while (true) {
    const r = await apiGet(`${HOST}/api/cbic-circular-msts/fetchCircularByYearCategory?taxId=${taxId}&year=${year}&page=${page}&size=${size}`);
    if (!r.ok || !Array.isArray(r.json) || r.json.length === 0) break;
    all.push(...r.json);
    if (r.json.length < size) break;
    page++; await sleep(200);
  }
  return all;
}

async function fetchDoc(filePath) {
  const clean = String(filePath).replace(/\\/g, "/");
  const r = await request(`${HOST}/content/pdf/${clean}`);
  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
  const b64 = r.json?.data;
  if (!b64) return { ok: false, reason: "无 data 字段" };
  return { ok: true, buffer: Buffer.from(b64, "base64") };
}

async function loadState() { if (!existsSync(STATE_PATH)) return { seen: {} }; try { return JSON.parse(await readFile(STATE_PATH, "utf8")); } catch { return { seen: {} }; } }
const saveState = (s) => writeFile(STATE_PATH, JSON.stringify(s, null, 2), "utf8");

async function main() {
  const o = parseArgs(process.argv);
  console.log(`CBIC Circular 历史抓取器 → ${o.out}`);
  console.log(`税目: ${o.tax}  年份: ${o.years}  语言: 仅英文\n`);
  await ensureToken();
  console.log(`✓ token: ${TOKEN ? "已取得" : "未取得（该接口可能免 token）"}\n`);

  const taxIds = o.tax.split(",").map((s) => s.trim()).filter(Boolean);
  const years = o.years.split(",").map((s) => s.trim()).filter(Boolean);
  const state = await loadState();

  const items = [];
  for (const tid of taxIds) {
    const taxName = TAX_NAME[tid] || `tax${tid}`;
    for (const y of years) {
      const list = await fetchYearCirculars(tid, y);
      // 过滤历史版本（isHistory=Y），仅保留有效条目
      const live = list.filter((it) => String(it.isHistory || "").toUpperCase() !== "Y");
      console.log(`  ${taxName} ${y}: ${list.length} 条 Circular（有效 ${live.length}）`);
      for (const it of live) {
        items.push({
          id: String(it.contentId ?? it.id ?? ""),
          no: it.circularNo || `id${it.id}`,
          title: it.circularName || "",
          cat: it.circularCategory || "",
          date: it.issueDt || it.circularDt || "",
          en: it.docFilePath || null,
          taxName, year: y,
        });
      }
      await sleep(200);
    }
  }
  console.log(`\n共 ${items.length} 条 Circular\n`);

  // 去重（同 contentId）
  const seenIds = new Set();
  const uniq = [];
  for (const it of items) { if (seenIds.has(it.id)) continue; seenIds.add(it.id); uniq.push(it); }

  const tasks = [];
  for (const it of uniq) {
    const label = `${it.taxName} / Circular / ${it.year} / ${it.no}`;
    if (!it.en) { console.log(`  · ${label} — 无英文路径，跳过`); continue; }
    const dir = path.join(o.out, sanitize(it.taxName, 40), "Circular", String(it.year));
    const base = `${sanitize(it.no, 40)}__${sanitize(it.title, 60)}`;
    const file = path.join(dir, `${base}.pdf`);
    const clean = String(it.en).replace(/\\/g, "/");
    const url = `${HOST}/content/pdf/${clean}`;
    const has = existsSync(file) && statSync(file).size > 200;
    tasks.push(has && !o.all
      ? { skip: true, label, file, ...it, url }
      : { skip: false, label, file, ...it, p: clean, url });
  }

  const CONC = Math.max(1, Number(process.env.CBIC_CONCURRENCY || 3));

  if (o.dryRun) {
    const todo = tasks.filter((t) => !t.skip);
    console.log(`[dry-run] 将下载 ${todo.length} 个英文 PDF，跳过 ${tasks.filter((t) => t.skip).length} 个已存在。`);
    todo.slice(0, 6).forEach((t) => console.log(`  (dry) ${t.label}\n        ← ${t.url}`));
    if (todo.length > 6) console.log(`  ... 共 ${todo.length} 个`);
    return;
  }

  let downloaded = 0, skipped = 0, failed = 0;
  const results = await mapPool(tasks, CONC, async (t) => {
    if (t.skip) { skipped++; return { status: "skip", t }; }
    const d = await fetchDoc(t.p);
    if (!d.ok) { console.log(`  ✗ ${t.label} ${d.reason}`); failed++; return { status: "fail" }; }
    if (d.buffer.length < 200) { console.log(`  ✗ ${t.label} 文件过小`); failed++; return { status: "fail" }; }
    await mkdir(path.dirname(t.file), { recursive: true });
    await writeFile(t.file, d.buffer);
    console.log(`  ✓ ${t.label} PDF ${(d.buffer.length / 1024).toFixed(0)}KB → ${path.relative(o.out, t.file)}`);
    downloaded++;
    return { status: "ok", t };
  });

  const perItem = {};
  for (const r of results) {
    if (!r || (r.status !== "ok" && r.status !== "skip")) continue;
    const t = r.t;
    perItem[t.id] = { no: t.no, title: t.title, cat: t.cat, date: t.date, taxName: t.taxName, year: t.year, file: path.basename(t.file), url: t.url };
  }
  for (const id of Object.keys(perItem)) state.seen[id] = { ...perItem[id], at: new Date().toISOString() };
  await saveState(state);

  const flat = (x) => String(x || "").replace(/\s+/g, " ").trim();
  const rows = ["| 税目 | 年 | 编号 | 分类 | 标题 | 日期 | 本地文件 | 源站PDF直链 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...Object.values(state.seen).sort((a, b) => (a.year + a.no).localeCompare(b.year + b.no)).map((s) =>
      `| ${flat(s.taxName)} | ${flat(s.year)} | ${flat(s.no)} | ${flat(s.cat)} | ${flat(s.title)} | ${flat(s.date)} | ${flat((s.year ? s.year + "/" : "") + s.file)} | [PDF](${s.url}) |`)];
  const head = `# CBIC Circular 历史索引（${years[0]}–${years[years.length - 1]}）\n\n来源：${HOST}/content-page/explore-circular\n生成：${new Date().toISOString()}\n\n> 仅英文版。链接为源站 PDF 直链。接口：/api/cbic-circular-msts/fetchCircularByYearCategory\n\n`;
  await writeFile(path.join(o.out, "CBIC-circular-history-index.md"), head + rows.join("\n") + "\n", "utf8");
  console.log(`\n清单：${path.join(o.out, "CBIC-circular-history-index.md")}`);
  console.log(`\n完成。下载 ${downloaded} 个，跳过 ${skipped} 个，失败 ${failed}。`);
  if (failed) console.log(`⚠️ ${failed} 个失败——重跑本命令即可补齐。`);
}

main().catch((e) => { console.error("\n失败：", e.message); process.exitCode = 1; });
