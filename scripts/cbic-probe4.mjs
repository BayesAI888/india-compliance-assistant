#!/usr/bin/env node
// 探针4：统计 2025 Customs 全量类别分布 + 编号格式 + 是否存在 Circular 专用接口
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

const TAX = { GST: "1000001", Customs: "1000002" };
(async () => {
  await ensureToken();
  for (const [name, tid] of Object.entries(TAX)) {
    const r = await api(`/api/cbic-notification-msts/fetchNotificationByYearAndCategory?taxId=${tid}&year=2025&size=300`);
    const arr = Array.isArray(r.json) ? r.json : [];
    const catCount = {};
    const fmtCount = { withSlashYear: 0, dashOnly: 0, other: 0 };
    const samples = { withSlashYear: null, dashOnly: null };
    for (const it of arr) {
      const cat = it.notificationCategory || "(空)";
      catCount[cat] = (catCount[cat] || 0) + 1;
      const no = it.notificationNo || "";
      if (/\/\d{4}-/.test(no)) { fmtCount.withSlashYear++; if (!samples.withSlashYear) samples.withSlashYear = no; }
      else if (/^\d+-\d{4}/.test(no)) { fmtCount.dashOnly++; if (!samples.dashOnly) samples.dashOnly = no; }
      else fmtCount.other++;
    }
    console.log(`=== ${name} 2025：共 ${arr.length} 条 ===`);
    console.log("  notificationCategory 分布：", catCount);
    console.log("  编号格式：", fmtCount);
    console.log("  样例 slash:", samples.withSlashYear, " | dashOnly:", samples.dashOnly);
    await sleep(200);
  }
  // 试 Circular 专用接口
  for (const ep of [
    `/api/cbic-notification-msts/fetchCircularByYearAndCategory?taxId=${TAX.Customs}&year=2025&size=300`,
    `/api/cbic-circular-msts/fetchCircularByYearAndCategory?taxId=${TAX.Customs}&year=2025&size=300`,
    `/api/cbic-notification-msts/fetchCircularUpdatesByTaxId/${TAX.Customs}`,
  ]) {
    const r = await api(ep);
    const len = Array.isArray(r.json) ? r.json.length : r.status;
    console.log(`试 ${ep} => ${len}`);
    await sleep(200);
  }
  console.log("\ndone");
})().catch((e) => { console.error("探针失败:", e.message); process.exitCode = 1; });
