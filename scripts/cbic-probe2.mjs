#!/usr/bin/env node
// 探针2：dump 一条样本看 category 字段真实取值，并实测 fetchNotificationByYearAndCategory 多组合
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

const TAX = { GST: "1000001", Customs: "1000002", "Central Excise": "1000003" };

(async () => {
  await ensureToken();

  // 1) dump 一条 2026 Customs 样本，看 category 相关字段
  const sample = await api(`/api/cbic-notification-msts/fetchUpdatesByTaxId/${TAX.Customs}`);
  if (Array.isArray(sample.json) && sample.json[0]) {
    const it = sample.json[0];
    console.log("=== 2026 Customs 样本字段 ===");
    for (const k of Object.keys(it)) {
      let v = it[k];
      if (typeof v === "string" && v.length > 70) v = v.slice(0, 70) + "…";
      console.log(`  ${k}: ${JSON.stringify(v)}`);
    }
    console.log("");
  }

  // 2) 实测 fetchNotificationByYearAndCategory 在多 category 取值下的返回
  const cats = ["Notification", "Circular", "notification", "circular", "NOTIFICATION", "CIRCULAR", "All", ""];
  const years = [2025, 2024, 2023];
  for (const taxName of ["Customs", "GST"]) {
    const tid = TAX[taxName];
    for (const y of years) {
      for (const c of cats) {
        const qs = `taxId=${tid}&year=${y}` + (c ? `&category=${encodeURIComponent(c)}` : "");
        const r = await api(`/api/cbic-notification-msts/fetchNotificationByYearAndCategory?${qs}`);
        if (Array.isArray(r.json) && r.json.length) {
          console.log(`★ ${taxName} ${y} category="${c}" => 数组 len=${r.json.length}`);
          r.json.slice(0, 2).forEach((x, i) => console.log(`     [${i}] ${x.notificationNo} | ${x.notificationName?.slice(0, 50)} | updatedDate=${x.updatedDate}`));
        } else if (r.status !== 200) {
          console.log(`  ${taxName} ${y} category="${c}" => HTTP ${r.status}`);
        }
        await sleep(200);
      }
    }
  }
  console.log("\ndone");
})().catch((e) => { console.error("探针失败:", e.message); process.exitCode = 1; });
