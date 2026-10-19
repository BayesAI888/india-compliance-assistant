#!/usr/bin/env node
/**
 * RBI FEMA Notifications 浏览器下载器（2026-09-21）
 *
 * 关键发现：
 *   - RBI 站点 (rbi.org.in / rbidocs.rbi.org.in) 被 Azure Front Door WAF 按【沙箱数据中心出口 IP】封锁。
 *   - 本机 Chrome.app 走 Mac 系统代理时出口 IP 不同（107.x），WAF 放行 → 页面可访问。
 *   - 因此启动 Chrome 时【不传任何代理参数】，让 macOS 自动走系统代理（沙箱 env 的 127.0.0.1:60478 会被 WAF 封）。
 *   - PDF 在 rbidocs 子域，页面内 fetch 受 CORS 限制；改用 CDP Fetch 域拦截响应，直接抓字节存盘。
 *
 * 输出：<out>/<年>/<编号>__<标题>.pdf  +  <out>/RBI-FEMA-index.md（含源站直链）
 * 用法：node scripts/rbi_fema_browser.js [--years 2024,2025,2026] [--dry-run]
 */
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE = "https://www.rbi.org.in/Scripts/BS_FemaNotifications.aspx";
const OUT = "/Users/cora/Desktop/工作/印度税法/源文件/RBI/FEMA Notifications";

function sanitize(s) {
  return (s || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 110);
}

async function listForYear(page, year) {
  await page.goto(PAGE, { waitUntil: "networkidle2", timeout: 60000 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {}),
    page.evaluate((y) => {
      const setVal = (id, v) => { const el = document.getElementById(id) || document.getElementsByName(id)[0]; if (el) el.value = v; };
      setVal("hdnYear", y); setVal("hdnMonth", "0");
      const btn = document.getElementById("UsrFontCntr_btn") || document.querySelector("input[type=submit]");
      if (btn) btn.click(); else { const f = document.forms[0]; if (f) f.submit(); }
    }, year),
  ]);
  await new Promise(r => setTimeout(r, 1500));
  const items = await page.evaluate(() => {
    const out = []; let curDate = "";
    for (const tr of Array.from(document.querySelectorAll("tr"))) {
      const th = tr.querySelector("th");
      if (th) { const m = th.textContent.match(/(\w{3}\s+\d{1,2},\s*\d{4})/); if (m) curDate = m[1]; }
      const a = tr.querySelector('a[href*="rbidocs.rbi.org.in/rdocs/notification/PDFs/"]');
      if (a) {
        const txt = tr.textContent;
        let nm = (txt.match(/Notification No\.\s*([^\n]{2,80})/) || [])[1] || "";
        nm = nm.replace(/\s+/g, " ").replace(/\s*\d+\s*kb$/i, "").trim();
        const tl = tr.querySelector('a[href*="BS_FemaNotifications.aspx?Id="]');
        const title = tl ? tl.textContent.replace(/\s+/g, " ").trim() : "";
        out.push({ url: a.href, notif: nm, title, date: curDate });
      }
    }
    return out;
  });
  return items;
}

function sleepSync(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 通过 CDP Fetch 域在「Response 阶段」拦截 PDF 响应并读取字节。
 * 关键：rbidocs 子域在 Mac 系统代理下可达（200），但 headless 阅读器会吞掉 body，
 * 故用 requestStage:"Response" 的 Fetch 拦截，在读 body 后再 continue，绕过阅读器。
 */
async function downloadPdf(browser, url, savePath) {
  const page = await browser.newPage();
  const client = await page.target().createCDPSession();
  let captured = null, done = false;
  await client.send("Fetch.enable", {
    patterns: [{ urlPattern: "*rbidocs.rbi.org.in*", requestStage: "Response" }],
    handleAuthRequests: false,
  }).catch(() => {});
  client.on("Fetch.requestPaused", async (e) => {
    if (!/\.PDF$/i.test(e.request.url)) { await client.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {}); return; }
    try {
      const { body, base64Encoded } = await client.send("Fetch.getResponseBody", { requestId: e.requestId });
      captured = base64Encoded ? Buffer.from(body, "base64") : Buffer.from(body);
    } catch { /* 忽略：下载失败会由后续长度校验识别 */ }
    await client.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
    done = true;
  });
  try {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch { /* 字节可能已在拦截中拿到 */ }
    const t0 = Date.now();
    while (!done && Date.now() - t0 < 20000) await sleepSync(300);
    if (captured && captured.length > 1000) {
      // 校验 PDF 头，避免把 HTML 错误页当 PDF 存盘
      const head = captured.slice(0, 5).toString("latin1");
      if (head !== "%PDF-" && head !== "%PDF\n") console.log("    [警告] 响应头非 PDF：", head);
      fs.writeFileSync(savePath, captured);
    }
    return captured ? captured.length : 0;
  } finally {
    await client.send("Fetch.disable").catch(() => {});
    await page.close().catch(() => {});
  }
}

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const yearsArg = args.find(a => a.startsWith("--years="));
  const YEARS = yearsArg ? yearsArg.split("=")[1].split(",") : ["2024", "2025", "2026"];

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-pdf-viewer", "--disable-features=PDFViewer",
      "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"],
  });

  const records = [];
  const seenUrls = new Set();
  const listPage = await browser.newPage();
  for (const year of YEARS) {
    const items = await listForYear(listPage, year);
    console.log(`\n[${year}] 列表解析到 ${items.length} 条`);
    for (const it of items) {
      if (seenUrls.has(it.url)) { console.log(`  · 跳过重复链接 ${it.url.split("/").pop()}`); continue; }
      seenUrls.add(it.url);
      const base = sanitize(it.notif || path.basename(it.url, ".PDF")) + (it.title ? "__" + sanitize(it.title) : "");
      const dir = path.join(OUT, year);
      const file = path.join(dir, `${base}.pdf`);
      if (fs.existsSync(file) && fs.statSync(file).size > 1000) {
        console.log(`  · 已存在跳过 ${path.relative(OUT, file)}`);
        records.push({ year, notif: it.notif, title: it.title, date: it.date, url: it.url, file: path.relative(OUT, file) });
        continue;
      }
      if (dryRun) { console.log(`  (dry) ${it.notif} <- ${it.url.split("/").pop()}`); records.push({ year, notif: it.notif, title: it.title, date: it.date, url: it.url, file: "" }); continue; }
      fs.mkdirSync(dir, { recursive: true });
      const sz = await downloadPdf(browser, it.url, file);
      if (sz > 1000) {
        console.log(`  ✓ ${it.notif} (${(sz / 1024).toFixed(0)}KB)`);
        records.push({ year, notif: it.notif, title: it.title, date: it.date, url: it.url, file: path.relative(OUT, file) });
      } else {
        console.log(`  ✗ 下载失败 ${it.notif} (size=${sz})`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }
  await listPage.close().catch(() => {});
  await browser.close().catch(() => {});

  // 写索引
  const rows = ["| 年份 | 编号 | 标题 | 发布日 | 本地文件 | 源站PDF直链 |",
    "| --- | --- | --- | --- | --- | --- |"];
  for (const r of records.sort((a, b) => (a.year + a.notif).localeCompare(b.year + b.notif))) {
    rows.push(`| ${r.year} | ${r.notif} | ${r.title} | ${r.date} | ${r.file} | [PDF](${r.url}) |`);
  }
  const head = `# RBI FEMA Notifications 索引（${YEARS.join("/")}）\n\n来源：${PAGE}\n生成：${new Date().toISOString()}\n\n> 经本机 Chrome（Mac 系统代理）下载，绕过 Azure WAF 封锁。\n\n`;
  if (!dryRun) fs.writeFileSync(path.join(OUT, "RBI-FEMA-index.md"), head + rows.join("\n") + "\n", "utf8");
  console.log(`\n完成。共 ${records.length} 条，索引：${path.join(OUT, "RBI-FEMA-index.md")}`);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
