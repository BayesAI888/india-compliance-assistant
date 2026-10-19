#!/usr/bin/env node
// 探针：测试 taxinformation.cbic.gov.in 是否提供「按年/税目」的历史列表接口。
import https from "node:https";

const HOST = "https://taxinformation.cbic.gov.in";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
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
      req.on("error", (e) => {
        if (attempt < retry - 1) { attempt++; return void setTimeout(once, 700 * attempt); }
        resolve({ ok: false, status: 0, text: `网络错误：${e.message}` });
      });
      req.setTimeout(12000, () => req.destroy(new Error("timeout")));
      if (payload) req.write(payload);
      req.end();
    };
    once();
  });
}

let TOKEN = null;
async function ensureToken() {
  if (TOKEN) return TOKEN;
  const r = await request(`${HOST}/api/authenticate-token`, { method: "POST", body: {} });
  TOKEN = r.json?.id_token; return TOKEN;
}

async function api(url, method = "GET", body = null) {
  if (url.startsWith("/")) url = HOST + url;
  const t = await ensureToken();
  const r = await request(url, { token: t, method, body });
  if (r.status === 401) { const t2 = await ensureToken(true); return request(url, { token: t2, method, body }); }
  return r;
}

const TAX = { GST: "1000001", Customs: "1000002", "Central Excise": "1000003" };
const YEAR = 2025;

const cands = [
  [`GET`, `/api/cbic-notification-msts/fetchNotificationByYear/${TAX.Customs}?year=${YEAR}`],
  [`GET`, `/api/cbic-notification-msts/fetchNotificationByYear?taxId=${TAX.Customs}&year=${YEAR}`],
  [`POST`, `/api/cbic-notification-msts/fetchNotificationByYear?taxId=${TAX.Customs}&year=${YEAR}`],
  [`GET`, `/api/cbic-notification-msts/fetchNotificationByYearAndCategory/${TAX.Customs}?year=${YEAR}&category=Notification`],
  [`GET`, `/api/cbic-notification-msts/fetchNotificationByYearAndCategory?taxId=${TAX.Customs}&year=${YEAR}&category=Notification`],
  [`GET`, `/api/cbic-notification-msts?taxId=${TAX.Customs}&year=${YEAR}&page=0&size=50`],
  [`GET`, `/api/cbic-notification-msts/findByTaxIdAndYear?taxId=${TAX.Customs}&year=${YEAR}`],
  [`GET`, `/api/cbic-notification-msts/fetchAllByTaxId/${TAX.Customs}?year=${YEAR}`],
];

(async () => {
  await ensureToken();
  console.log(`探针：Customs(${TAX.Customs}) year=${YEAR}\n`);
  for (const [m, c] of cands) {
    const r = await api(c, m);
    let info = "";
    if (Array.isArray(r.json)) info = `数组 len=${r.json.length}`;
    else if (r.json && typeof r.json === "object") info = `obj keys=${Object.keys(r.json).slice(0, 6).join(",")}`;
    else info = (r.text || "").slice(0, 140).replace(/\s+/g, " ");
    console.log(`[${m}] ${c}\n    => HTTP ${r.status}  ${info}\n`);
    await sleep(300);
  }
  console.log("done");
})().catch((e) => { console.error("探针失败:", e.message); process.exitCode = 1; });
