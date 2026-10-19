#!/usr/bin/env node
// 探针3：确认 fetchNotificationByYearAndCategory 返回项字段 + 翻页/全量能力
import https from "node:https";

const HOST = "https://taxinformation.cbic.gov.in";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 3 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function request(url, { token = null, method = "GET", body = null, retry = 3 } = {}) {
  return new Promise((resolve) => {
    let attempt = 0;
    const once = () => {
      const u = new URL(url);
      const headers = { "Accept": "application/json, text/plain, */*", "Referer": `${HOST}/content-page/explore-notification`, "User-Agent": UA, "language": "en" };
      if (token) headers.Authorization = `Bearer ${token}`;
      let payload = null;
      if (body) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(payload); }
      const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers, agent }, (res) => {
        const chunks = []; res.on("data", (d) => chunks.push(d)); res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
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
async function ensureToken() { if (TOKEN) return TOKEN; const r = await request(`${HOST}/api/authenticate-token`, { method: "POST", body: {} }); TOKEN = r.json?.id_token; return TOKEN; }
async function api(url, method = "GET", body = null) { if (url.startsWith("/")) url = HOST + url; const t = await ensureToken(); let r = await request(url, { token: t, method, body }); if (r.status === 401) { const t2 = await ensureToken(true); r = await request(url, { token: t2, method, body }); } return r; }

(async () => {
  await ensureToken();
  // 1) 一条完整字段
  const one = await api(`/api/cbic-notification-msts/fetchNotificationByYearAndCategory?taxId=1000002&year=2025`);
  if (Array.isArray(one.json) && one.json[0]) {
    console.log("=== 一条完整字段（Customs 2025）===");
    const it = one.json[0];
    for (const k of Object.keys(it)) {
      let v = it[k]; if (typeof v === "string" && v.length > 90) v = v.slice(0, 90) + "…";
      console.log(`  ${k}: ${JSON.stringify(v)}`);
    }
    console.log(`\n  → 含 docFilePath? ${"docFilePath" in it}  含 docFilePathHi? ${"docFilePathHi" in it}  含 updateType? ${"updateType" in it}`);
  }
  console.log("");

  // 2) 不同 size 看全年总数
  for (const size of [20, 100, 300]) {
    const r = await api(`/api/cbic-notification-msts/fetchNotificationByYearAndCategory?taxId=1000002&year=2025&size=${size}`);
    const len = Array.isArray(r.json) ? r.json.length : r.status;
    console.log(`Customs 2025 size=${size} => ${len}`);
    await sleep(200);
  }
  // 3) page 翻页看是否还有更多（默认 size）
  for (const p of [0, 1, 2, 3]) {
    const r = await api(`/api/cbic-notification-msts/fetchNotificationByYearAndCategory?taxId=1000002&year=2025&page=${p}&size=100`);
    const len = Array.isArray(r.json) ? r.json.length : r.status;
    console.log(`Customs 2025 page=${p} size=100 => ${len}`);
    await sleep(200);
  }
  console.log("\ndone");
})().catch((e) => { console.error("探针失败:", e.message); process.exitCode = 1; });
