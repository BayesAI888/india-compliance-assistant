#!/usr/bin/env node
/**
 * CBIC 通知 / 通函抓取器  v2  —— 基于 2026-09-20 对 taxinformation.cbic.gov.in 的实测逆向。
 *
 * ⚠️ v1（先探针再抓）的假设是错的。本版只用**实测返回 200 的接口**。
 *
 * ══ 为什么 Node 里 fetch() 会失败（根因，别再猜"网络被封"了）═════════════
 *   该站 TLS **证书链不完整**：服务器只下发叶证书
 *     CN=taxinformation.cbic.gov.in, 签发者 Sectigo Public Server Authentication CA OV R36
 *   而**中间证书没随包发送**。Chrome / curl 会走 AIA 自动补全，Node 的 fetch(undici)
 *   严格校验直接抛 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`（表现就是 "fetch failed"）。
 *   另外该站连接很飘，会偶发 ECONNRESET / 空响应。
 *   ⇒ 本脚本改用 node:https + rejectUnauthorized:false + 重试。实测 8 次成功 7 次，
 *     失败靠重试补上。（要严格校验可自行补 Sectigo 中间证书，但收益不大。）
 *
 * ══ 实测【可用】的接口（均在本机 curl 复现）══════════════════════════════
 *   POST /api/authenticate-token                        body {} → {"id_token":"<JWT>"}（匿名，无需账号）
 *   GET  /api/cbic-tax-msts                             → 税目清单
 *   GET  /api/cbic-notification-msts/fetchUpdatesByTaxId/{taxId}
 *                                                       → 该税目**最新更新**（实测固定 4 条，含 docFilePath）
 *   GET  /api/cbic-notification-msts/{id}               → 单条通知实体
 *   GET  /content/pdf/<docFilePath 正斜杠化>             → {"data":"<base64 PDF>"}（无需 token）
 *   GET  /content/html/<docFilePath 正斜杠化>            → HTML 正文（无需 token）
 *
 * ══ 实测【不可用】的接口（别再试）════════════════════════════════════════
 *   GET  /api/cbic-notification-msts                    → 500
 *   GET  .../fetchNotificationByYearAndCategory          → 500 CoreException（**门户"按年/类别"页就是坏的**）
 *   GET  .../fetchCategory/{taxId}                       → 500
 *   POST /api/_search/cbic-notification-msts             → F5 WAF「Request Rejected」
 *   ⇒ **没有"全量历史列表"接口**。能拿到的只有「最新更新」流 + 已知 id 的单条。
 *
 * ══ 用法 ═══════════════════════════════════════════════════════════════════
 *   node scripts/cbic-fetch.mjs                       # 抓全部税目最新更新（增量：跳过已抓 id）
 *   node scripts/cbic-fetch.mjs --tax 1000001,1000002
 *   node scripts/cbic-fetch.mjs --dry-run             # 只看会抓什么，不落盘
 *   node scripts/cbic-fetch.mjs --all                 # 忽略去重状态，全部重下
 *   node scripts/cbic-fetch.mjs --ids 1010753,1003335 # 指定 id 单条抓
 *   node scripts/cbic-fetch.mjs --lang en|hi|both     # 默认 both
 *   node scripts/cbic-fetch.mjs --out /some/dir
 *
 * 输出：<out>/<税目>/<类型>/<年>/<编号>__<标题>.pdf  +  <out>/CBIC-index.md
 * 去重状态：scripts/cbic-state.json
 */

import https from "node:https";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.CBIC_HOST || "https://taxinformation.cbic.gov.in";
const OUT_DIR = process.env.CBIC_OUT_DIR
  || "/Users/cora/Desktop/工作/印度税法/源文件/CBIC";
const STATE_PATH = process.env.CBIC_STATE || path.join(__dirname, "cbic-state.json");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

// 站点证书链不完整 + 连接飘 → 关校验 + 连接复用。见文件头说明。
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 4 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 并发池：最多 limit 个任务同时进行（站点飘，别开太猛）
async function mapPool(items, limit, fn) {
  const res = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) { const idx = i++; res[idx] = await fn(items[idx], idx); }
  };
  const n = Math.min(limit, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return res;
}

// 由 (税目/类型/年/编号/标题/语言) 推出确定性的落盘文件名
function variantFile(dir, no, title, lang, ext) {
  const base = `${sanitize(no, 40)}${lang === "hi" ? "_hi" : ""}__${sanitize(title, 60)}`;
  return path.join(dir, `${base}.${ext}`);
}

// ── CLI ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { tax: null, ids: null, dryRun: false, all: false, lang: "both", out: OUT_DIR };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--all") o.all = true;
    else if (a === "--tax") o.tax = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--ids") o.ids = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--lang") o.lang = argv[++i];
    else if (a === "--out") o.out = argv[++i];
  }
  return o;
}

// ── 网络层（node:https + 重试）──────────────────────────────────
function baseHeaders(token) {
  const h = {
    "Accept": "application/json, text/plain, */*",
    "Referer": `${HOST}/content-page/explore-notification`,
    "User-Agent": UA,
    "language": "en",
  };
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
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString("utf8");
          const ct = res.headers["content-type"] || "";
          if (res.statusCode >= 500 && attempt < retry - 1) { attempt++; return void setTimeout(once, 700 * attempt); }
          let json; try { json = JSON.parse(text); } catch { /* 保留原文 */ }
          resolve({ ok: res.statusCode < 400, status: res.statusCode, json, text, contentType: ct, buffer: buf });
        });
      });
      req.on("error", (e) => {
        if (attempt < retry - 1) { attempt++; return void setTimeout(once, 700 * attempt); }
        resolve({ ok: false, status: 0, text: `网络错误：${e.message}${e.code ? ` (${e.code})` : ""}` });
      });
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

// ── 工具 ─────────────────────────────────────────────────────
const sanitize = (s, max = 90) => (s || "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, max);
const yearOf = (d) => { const m = /(\d{4})/.exec(d || ""); return m ? m[1] : "unknown"; };
const extOf = (p, ct = "") => {
  const s = (p || "").toLowerCase();
  if (s.endsWith(".pdf") || ct.includes("pdf")) return "pdf";
  if (s.endsWith(".html") || s.endsWith(".htm")) return "html";
  return "bin";
};

async function loadState() {
  if (!existsSync(STATE_PATH)) return { seen: {} };
  try { return JSON.parse(await readFile(STATE_PATH, "utf8")); } catch { return { seen: {} }; }
}
const saveState = (s) => writeFile(STATE_PATH, JSON.stringify(s, null, 2), "utf8");

// 下载一份原文：content/pdf 返回 {data: base64}，content/html 返回正文
async function fetchDoc(filePath) {
  const clean = String(filePath).replace(/\\/g, "/");
  const ext = extOf(clean);
  const r = await request(`${HOST}/content/${ext === "pdf" ? "pdf" : "html"}/${clean}`);
  if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
  if (ext === "pdf") {
    const b64 = r.json?.data;
    if (!b64) return { ok: false, reason: "无 data 字段（可能不是 PDF）" };
    return { ok: true, ext: "pdf", buffer: Buffer.from(b64, "base64") };
  }
  return { ok: true, ext: "html", buffer: Buffer.from(r.text || "", "utf8") };
}

// ── 主流程 ───────────────────────────────────────────────────
async function main() {
  const o = parseArgs(process.argv);
  const state = await loadState();

  console.log(`CBIC 抓取器 v2  →  ${o.out}`);
  await ensureToken();
  console.log("✓ 已取得匿名 token\n");

  // 1) 税目清单
  const taxRes = await apiGet(`${HOST}/api/cbic-tax-msts`);
  if (!taxRes.ok || !Array.isArray(taxRes.json)) throw new Error(`取税目清单失败：HTTP ${taxRes.status} ${(taxRes.text || "").slice(0, 120)}`);
  let taxes = taxRes.json.map((t) => ({ id: String(t.id), name: t.taxName }));
  if (o.tax) taxes = taxes.filter((t) => o.tax.includes(t.id));
  console.log(`税目 ${taxes.length} 个：${taxes.map((t) => `${t.name}(${t.id})`).join(", ")}\n`);

  // 2) 收集条目
  const items = [];
  if (o.ids) {
    for (const id of o.ids) {
      const r = await apiGet(`${HOST}/api/cbic-notification-msts/${id}`);
      if (r.ok && r.json) items.push({ ...r.json, _taxName: "(指定 id)" });
      else console.log(`  ✗ id=${id} HTTP ${r.status}`);
      await sleep(150);
    }
  } else {
    for (const t of taxes) {
      const r = await apiGet(`${HOST}/api/cbic-notification-msts/fetchUpdatesByTaxId/${t.id}`);
      if (!r.ok || !Array.isArray(r.json)) { console.log(`  ✗ ${t.name}：HTTP ${r.status} ${(r.text || "").slice(0, 80)}`); continue; }
      console.log(`  ${t.name}：最新 ${r.json.length} 条`);
      for (const it of r.json) items.push({ ...it, _taxName: t.name });
      await sleep(200);
    }
  }
  console.log();

  // 3) 组装下载任务（文件粒度：断点续传 + 并发）
  const tasks = [];
  for (const it of items) {
    const id = String(it.id ?? "");
    const taxName = it._taxName || "(unknown)";
    const type = it.updateType || "Notification";
    const year = yearOf(it.updatedDate);
    const no = it.notificationNo || `id${id}`;
    const title = it.notificationName || it.notificationNameToBeDisplay || "";
    const label = `${taxName} / ${type} / ${year} / ${no}`;

    const variants = [];
    if (o.lang !== "hi" && it.docFilePath) variants.push({ lang: "en", p: it.docFilePath });
    if (o.lang !== "en" && it.docFilePathHi) variants.push({ lang: "hi", p: it.docFilePathHi });
    if (!variants.length) { console.log(`  · ${label} — 无原文路径，跳过`); continue; }

    const dir = path.join(o.out, sanitize(taxName, 40), sanitize(type, 30), year);

    if (o.dryRun) { for (const v of variants) console.log(`  (dry) ${label} [${v.lang}] ← ${v.p}`); continue; }

    for (const v of variants) {
      const clean = String(v.p).replace(/\\/g, "/");
      const predExt = extOf(clean) === "pdf" ? "pdf" : "html";
      const file = variantFile(dir, no, title, v.lang, predExt);
      // 断点续传：磁盘已有且非空 → 跳过（即便 state 没记录也不重复下载）
      const has = existsSync(file) && statSync(file).size > 200;
      tasks.push(has && !o.all && !o.ids
        ? { skip: true, label, lang: v.lang, file, id, no, title, type, taxName, year, date: it.updatedDate }
        : { skip: false, label, lang: v.lang, file, id, no, title, type, taxName, year, date: it.updatedDate, p: v.p });
    }
  }

  // 4) 并发执行（默认 3 路；站点连接飘，别开太猛）
  const CONC = Math.max(1, Number(process.env.CBIC_CONCURRENCY || 3));
  let downloaded = 0, skipped = 0, failed = 0;
  const results = await mapPool(tasks, CONC, async (t) => {
    if (t.skip) { skipped++; return { status: "skip", id: t.id, file: t.file, taxName: t.taxName, type: t.type, year: t.year, no: t.no, title: t.title, date: t.date }; }
    const d = await fetchDoc(t.p);
    if (!d.ok) { console.log(`  ✗ ${t.label} [${t.lang}] ${d.reason}`); failed++; return { status: "fail", id: t.id }; }
    if (d.buffer.length < 200) { console.log(`  ✗ ${t.label} [${t.lang}] 文件过小 (${d.buffer.length}B)`); failed++; return { status: "fail", id: t.id }; }
    await mkdir(path.dirname(t.file), { recursive: true });
    await writeFile(t.file, d.buffer);
    console.log(`  ✓ ${t.label} [${t.lang}] ${d.ext.toUpperCase()} ${(d.buffer.length / 1024).toFixed(0)}KB → ${path.relative(o.out, t.file)}`);
    downloaded++;
    return { status: "ok", id: t.id, file: t.file, taxName: t.taxName, type: t.type, year: t.year, no: t.no, title: t.title, date: t.date };
  });

  // 5) 汇总 + 落盘（state 与 index 均按 id 去重，断点续传安全）
  if (!o.dryRun) {
    const perItem = {};
    for (const r of results) {
      if (!r || (r.status !== "ok" && r.status !== "skip")) continue;
      if (!perItem[r.id]) perItem[r.id] = { no: r.no, title: r.title, type: r.type, taxName: r.taxName, year: r.year, date: r.date, files: [] };
      perItem[r.id].files.push(path.basename(r.file));
    }
    for (const id of Object.keys(perItem)) {
      const p = perItem[id];
      const set = new Set(state.seen[id]?.files || []);
      p.files.forEach((f) => set.add(f));
      state.seen[id] = { number: p.no, name: p.title, type: p.type, tax: p.taxName, date: p.date, files: [...set], at: new Date().toISOString() };
    }
    await saveState(state);

    const flat = (x) => String(x || "").replace(/\s+/g, " ").trim();
    const rows = ["| 税目 | 类型 | 年 | 编号 | 日期 | 标题 | 文件 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...Object.values(state.seen).map((s) =>
        `| ${flat(s.tax)} | ${flat(s.type)} | ${yearOf(s.date || s.number)} | ${flat(s.number)} | ${flat(s.date)} | ${flat(s.name)} | ${(s.files || []).join(" / ")} |`)];
    const head = `# CBIC 最新通知索引\n\n生成：${new Date().toISOString()}\n\n`;
    await writeFile(path.join(o.out, "CBIC-index.md"), head + rows.join("\n") + "\n", "utf8");
    console.log(`\n清单：${path.join(o.out, "CBIC-index.md")}`);
  }

  console.log(`\n完成。下载 ${downloaded} 个文件，跳过 ${skipped} 条（磁盘已存在），失败 ${failed}。`);
  if (skipped && !o.all && !o.dryRun) console.log("（跳过的是磁盘上已存在的文件；要重下加 --all）");
  if (failed) console.log(`⚠️ ${failed} 个下载失败——重跑本命令即可补齐（断点续传，已下的不会重抓）。`);
}

main().catch((e) => { console.error("\n失败：", e.message); process.exitCode = 1; });
