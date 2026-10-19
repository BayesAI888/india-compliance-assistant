#!/usr/bin/env node
// 探针6：dump Circular 接口真实返回结构 + 400 错误细节
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
  const dump = (label, r) => {
    console.log(`\n=== ${label} (HTTP ${r.status}) ===`);
    if (Array.isArray(r.json)) { console.log(`  数组 len=${r.json.length}`); if (r.json[0]) console.log("  字段:", Object.keys(r.json[0]).join(", ")); }
    else if (r.json && typeof r.json === "object") console.log("  body:", JSON.stringify(r.json).slice(0, 300));
    else console.log("  text:", String(r.text || "").slice(0, 200).replace(/\n/g, " "));
  };
  // 1) fetchCircularUpdatesByTaxId 真实结构
  for (const [name, tid] of Object.entries(TAX)) {
    const r = await api(`/api/cbic-notification-msts/fetchCircularUpdatesByTaxId/${tid}`);
    dump(`fetchCircularUpdatesByTaxId/${name}`, r);
    await sleep(200);
  }
  // 2) fetchCircularByYearAndCategory 400 的 detail
  const r = await api(`/api/cbic-notification-msts/fetchCircularByYearAndCategory?taxId=${TAX.Customs}&year=2025`);
  dump("fetchCircularByYearAndCategory 400 detail", r);
  // 3) cbic-circular-msts 列表端点
  for (const ep of [
    `/api/cbic-circular-msts?taxId=${TAX.Customs}&year=2025&size=300`,
    `/api/cbic-circular-msts/fetchCircularByYearAndCategory?taxId=${TAX.Customs}&year=2025&size=300`,
  ]) {
    const rr = await api(ep);
    const len = Array.isArray(rr.json) ? rr.json.length : (rr.status === 200 && rr.json && rr.json.content ? rr.json.content.length + "(content)" : rr.status);
    console.log(`[${rr.status}] ${ep} => ${len}`);
    await sleep(200);
  }
  console.log("\ndone");
})().catch((e) => { console.error("探针失败:", e.message); process.exitCode = 1; });
