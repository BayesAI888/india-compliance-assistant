#!/usr/bin/env node
/**
 * 阶段二：月度巡检，看目标企业/常见争议类型有没有新增税务判例。
 *
 * 起因：阶段一把判例整理成结构化记录、建好了审核发布流程；阶段二是每月跑一次这个脚本，
 * 看 Indian Kanoon 数据库里有没有新案子值得纳入案例库。按用户的决定，巡检范围"两者都要"：
 *   1. companies：固定公司名单，逐个按公司名搜索
 *   2. keywords：关键词/行业策略，覆盖不针对具体公司、但常见的中资/外资税务争议类型
 * 两份名单都在 scripts/case-monitor-targets.json 里维护，改配置不用碰代码。
 *
 * 这一步只负责"发现新案子"，不自动提炼、不自动上传——提炼要调用 DeepSeek 花token，
 * 而且案例质量需要人工判断，全自动风险太高。真正想收录的案子，看到本脚本报告里的
 * docid 后手动跑：
 *   node scripts/case-extract.mjs extract <docid>
 * 生成结构化草稿，再用 /admin 后台或 scripts/upload-cases.mjs 走正常的审核/上传流程。
 *
 * 避免每个月重复报告同一个案子：脚本在本地维护一份"已上报过"的记录
 * （默认 scripts/.case-monitor-state.json），报过一次的docid以后不会再出现在报告里，
 * 除非你手动删掉这个文件重新来过。这个文件要留在本地、不要删，删了就会全部重报一遍。
 * 另外如果填了 ADMIN_USERNAME/ADMIN_PASSWORD，还会顺带查一下案例库里已经收录（无论是
 * 通过这个巡检脚本还是别的渠道，比如手动整理上传的）的docid，双重防止重复报告。
 *
 * 诚实说明：和 case-extract.mjs 一样，Search API 的请求/响应字段是按官方文档写的，
 * 没有真实token实测过，第一次跑如果报错或者搜不到东西，把报错信息发我看一下。
 *
 * 用法：
 *   INDIANKANOON_API_TOKEN=xxx node scripts/case-monitor.mjs
 *   INDIANKANOON_API_TOKEN=xxx ADMIN_USERNAME=xxx ADMIN_PASSWORD=xxx node scripts/case-monitor.mjs
 *
 * 可选环境变量：
 *   CASE_MONITOR_CONFIG   默认 scripts/case-monitor-targets.json
 *   CASE_MONITOR_STATE    默认 scripts/.case-monitor-state.json（已上报记录，别删）
 *   CASE_MONITOR_REPORT_DIR  默认 ../案例巡检报告
 *   ADMIN_BASE_URL         默认 https://indiacompliance.cn（2026-09-16改：域名和HTTPS配好后，服务器防火墙已经关掉了3000端口，只留80/443，原来那个 IP:3000 的默认值已经连不通）
 *   INDIANKANOON_API_BASE  默认 https://api.indiankanoon.org
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IK_BASE = (process.env.INDIANKANOON_API_BASE?.trim() || "https://api.indiankanoon.org").replace(/\/$/, "");
const ADMIN_BASE_URL = (process.env.ADMIN_BASE_URL || "https://indiacompliance.cn").replace(/\/$/, "");
const CONFIG_PATH = process.env.CASE_MONITOR_CONFIG || path.join(__dirname, "case-monitor-targets.json");
const STATE_PATH = process.env.CASE_MONITOR_STATE || path.join(__dirname, ".case-monitor-state.json");
const REPORT_DIR = process.env.CASE_MONITOR_REPORT_DIR || path.join(__dirname, "..", "案例巡检报告");

const ikToken = process.env.INDIANKANOON_API_TOKEN;
if (!ikToken) {
  console.error("请先设置 INDIANKANOON_API_TOKEN 环境变量（在 api.indiankanoon.org 生成的那个 token）。");
  process.exit(1);
}

const adminUser = process.env.ADMIN_USERNAME;
const adminPass = process.env.ADMIN_PASSWORD;
const canCheckAdmin = Boolean(adminUser && adminPass);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|br|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
}

async function ikSearch(query) {
  const params = new URLSearchParams({ formInput: query, pagenum: "0" });
  const response = await fetch(`${IK_BASE}/search/?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Token ${ikToken}`, Accept: "application/json" },
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Indian Kanoon 返回的不是有效JSON（HTTP ${response.status}）：${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`Indian Kanoon 请求失败（HTTP ${response.status}）：${JSON.stringify(data).slice(0, 300)}`);
  }
  return (data.docs ?? []).map((doc) => ({
    docid: String(doc.tid),
    title: doc.title ?? "",
    docsource: doc.docsource ?? "",
    snippet: stripHtml(doc.headline).slice(0, 160),
  }));
}

async function loadConfig() {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);
  const companies = (config.companies ?? []).filter((name) => {
    const trimmed = String(name).trim();
    return trimmed && !trimmed.includes("示例");
  });
  const keywords = (config.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
  return { companies, keywords };
}

async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return { seen: {} };
    throw error;
  }
}

async function saveState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

async function fetchExistingDocids() {
  if (!canCheckAdmin) return new Set();
  const authHeader = "Basic " + Buffer.from(`${adminUser}:${adminPass}`).toString("base64");
  try {
    const response = await fetch(`${ADMIN_BASE_URL}/api/admin/cases`, { headers: { Authorization: authHeader } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return new Set((data.cases ?? []).map((c) => String(c.docid)));
  } catch (error) {
    console.log(`  （查询案例库已收录docid失败，跳过这道去重：${error.message}）`);
    return new Set();
  }
}

async function main() {
  console.log(`Indian Kanoon：${IK_BASE}`);
  console.log(`管理后台：${ADMIN_BASE_URL}${canCheckAdmin ? "" : "（未提供账号密码，跳过和线上案例库的去重核对）"}`);
  console.log(`配置文件：${CONFIG_PATH}`);
  console.log(`已上报记录：${STATE_PATH}\n`);

  const { companies, keywords } = await loadConfig();
  const state = await loadState();
  const existingDocids = await fetchExistingDocids();

  console.log(`目标公司 ${companies.length} 个，关键词 ${keywords.length} 条。\n`);

  const targets = [
    ...companies.map((name) => ({ kind: "company", query: name, label: `公司「${name}」` })),
    ...keywords.map((kw) => ({ kind: "keyword", query: kw, label: `关键词「${kw}」` })),
  ];

  if (targets.length === 0) {
    console.log("配置文件里公司名单和关键词都是空的（或者只剩示例行没删），没有可巡检的目标。");
    console.log(`打开 ${CONFIG_PATH} 填好再跑。`);
    return;
  }

  const newFindings = [];
  for (const target of targets) {
    console.log(`搜索 ${target.label}（约 ₹0.50）……`);
    try {
      const results = await ikSearch(target.query);
      let freshCount = 0;
      for (const doc of results) {
        if (state.seen[doc.docid] || existingDocids.has(doc.docid)) continue;
        freshCount += 1;
        newFindings.push({ ...doc, foundBy: target.label });
        state.seen[doc.docid] = { firstSeenAt: new Date().toISOString(), foundBy: target.label, title: doc.title };
      }
      console.log(`  共 ${results.length} 条结果，其中 ${freshCount} 条是新面孔。`);
    } catch (error) {
      console.log(`  ✗ 搜索失败：${error.message}`);
    }
    await sleep(600);
  }

  await saveState(state);

  console.log(`\n本次巡检发现 ${newFindings.length} 条新案例候选。`);
  if (newFindings.length === 0) {
    console.log("没有新东西，下个月再跑。");
    return;
  }

  for (const doc of newFindings) {
    console.log(`  - [docid: ${doc.docid}] ${doc.title}`);
    console.log(`    来源：${doc.docsource || "未知"} · 命中：${doc.foundBy}`);
    if (doc.snippet) console.log(`    片段：${doc.snippet}…`);
  }

  const reportMonth = new Date().toISOString().slice(0, 7);
  const reportPath = path.join(REPORT_DIR, `巡检报告_${reportMonth}.md`);
  await mkdir(REPORT_DIR, { recursive: true });
  const reportBody = `# 税务案例库月度巡检报告 · ${reportMonth}

本次新发现 ${newFindings.length} 条候选案例（已排除之前报告过、或已在案例库里的）。
逐条看一眼标题/片段，挑值得收录的，手动跑下面命令生成结构化草稿再走审核流程：

\`\`\`
node scripts/case-extract.mjs extract <docid>
\`\`\`

${newFindings.map((doc) => `## [docid: ${doc.docid}] ${doc.title}

- 来源：${doc.docsource || "未知"}
- 命中：${doc.foundBy}
- 链接：https://indiankanoon.org/doc/${doc.docid}/
${doc.snippet ? `- 片段：${doc.snippet}…\n` : ""}`).join("\n")}`;
  await writeFile(reportPath, reportBody, "utf8");
  console.log(`\n完整报告已写入：${reportPath}`);
}

main().catch((error) => {
  console.error("脚本执行失败：", error.message);
  process.exit(1);
});
