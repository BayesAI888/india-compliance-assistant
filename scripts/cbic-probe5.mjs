#!/usr/bin/env node
// 探针5：攻 Circular 按年接口 + 看 fetchCircularUpdatesByTaxId 结构
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
  // A) fetchCircularUpdatesByTaxId 结构
  const up = await api(`/api/cbic-notification-msts/fetchCircularUpdatesByTaxId/${TAX.Customs}`);
  console.log(`fetchCircularUpdatesByTaxId/Customs => ${Array.isArray(up.json) ? up.json.length + " 条" : up.status}`);
  if (Array.isArray(up.json) && up.json[0]) {
    const it = up.json[0];
    console.log("  样例字段：", Object.keys(it).join(", "));
    console.log("  notificationNo:", it.notificationNo, "| docFilePath:", it.docFilePath, "| docFilePathHi:", it.docFilePathHi);
  }
  console.log("");

  // B) 试 Circular 按年接口各种组合（Customs 2025）
  const cands = [
    `/api/cbic-notification-msts/fetchCircularByYearAndCategory?taxId=${TAX.Customs}&year=2025`,
    `/api/cbic-notification-msts/fetchCircularByYearAndCategory?taxId=${TAX.Customs}&year=2025&size=300`,
    `/api/cbic-circular-msts/fetchCircularByYearAndCategory?taxId=${TAX.Customs}&year=2025&size=300`,
    `/api/cbic-circular-msts/fetchCircularUpdatesByTaxId/${TAX.Customs}`,
    `/api/cbic-notification-msts/fetchCircularByYear?taxId=${TAX.Customs}&year=2025&size=300`,
    `/api/cbic-circular-msts/fetchCircularByYear?taxId=${TAX.Customs}&year=2025&size=300`,
  ];
  for (const c of cands) {
    const r = await api(c);
    const len = Array.isArray(r.json) ? r.json.length : (r.json && typeof r.json === "object" ? "obj" : r.status);
    console.log(`[${r.status}] ${c} => ${len}`);
    await sleep(250);
  }
  console.log("\ndone");
})().catch((e) => { console.error("探针失败:", e.message); process.exitCode = 1; });
