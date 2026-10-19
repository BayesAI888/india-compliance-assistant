#!/usr/bin/env node
/**
 * 从 Indian Kanoon 下载印度税务判例，并用模型提炼成案例库的结构化模板。
 *
 * 诚实说明：这份脚本是按 Indian Kanoon 官方文档（api.indiankanoon.org/documentation）
 * 描述的接口字段写的，我没有你的 token，没法拿真实请求实测过——接口地址、鉴权头、
 * 请求方式（POST）都是按文档来的，但 Document API 具体返回的 JSON 字段名（比如正文
 * 是不是真的叫 `doc`）有可能和文档描述略有出入。第一次跑如果报"解析不出正文"，
 * 把打印出来的原始JSON结构发我，我改字段映射，不会是大改。
 *
 * 两个子命令：
 *
 *   1. 先搜索，看有哪些候选案例（每次 ₹0.50）：
 *      INDIANKANOON_API_TOKEN=xxx node scripts/case-extract.mjs search "transfer pricing AMP China"
 *
 *   2. 挑中具体案例后，用 docid 下载正文并提炼成结构化模板（下载₹0.20 + 一次模型调用）：
 *      INDIANKANOON_API_TOKEN=xxx DEEPSEEK_API_KEY=xxx node scripts/case-extract.mjs extract 135502389
 *      也可以一次传多个 docid，用空格分开，会依次处理。
 *
 * 产出：每个案例一份 markdown，默认存到项目根目录的 `案例库_草稿/` 文件夹
 * （可用 CASE_OUTPUT_DIR 环境变量改路径），文件名是 `<docid>_<案件名称>.md`。
 * 这是草稿，不会自动进正式知识库——阶段一的审核发布流程做好之后，
 * 这些草稿文件会作为素材导入，中间还是要有人看一遍。
 *
 * 模板字段和顺序是产品定好的，不要自己改：
 * 案件名称 / 法院与年份 / IndianKanoon文档ID / 争议税种以及主管税局 /
 * 税局主张(Revenue's Position) / 企业抗辩方向(Assessee's Argument) /
 * 最终裁定结果 / 证据支撑要点 / 印度数据库链接
 *
 * 其中"IndianKanoon文档ID"和"印度数据库链接"这两项，脚本自己按传入的 docid 拼出来，
 * 不问模型要——这两项是确定性数据，没有必要冒让模型编错编号的风险。
 *
 * 案件里出现的纳税人/公司名称保留英文原文，不翻译（产品要求）。
 */

const IK_BASE = (process.env.INDIANKANOON_API_BASE?.trim() || "https://api.indiankanoon.org").replace(/\/$/, "");
const OUTPUT_DIR = process.env.CASE_OUTPUT_DIR || "../案例库_草稿";
const MAX_DOC_CHARS = Number(process.env.CASE_MAX_DOC_CHARS?.trim()) || 60000;

const ikToken = process.env.INDIANKANOON_API_TOKEN;
const deepseekKey = process.env.DEEPSEEK_API_KEY;

function requireIkToken() {
  if (!ikToken) {
    console.error("请先设置 INDIANKANOON_API_TOKEN 环境变量（在 api.indiankanoon.org 生成的那个 token）。");
    process.exit(1);
  }
}

async function ikRequest(path) {
  const response = await fetch(`${IK_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${ikToken}`,
      Accept: "application/json",
    },
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
  return data;
}

/** Document API 返回的正文一般是HTML片段（官方AJAX示例直接把它塞进一个div），这里粗略剥掉标签喂给模型用。 */
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
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function searchCases(query, { doctypes, fromdate, todate, pagenum = 0 } = {}) {
  requireIkToken();
  const params = new URLSearchParams({ formInput: query, pagenum: String(pagenum) });
  if (doctypes) params.set("doctypes", doctypes);
  if (fromdate) params.set("fromdate", fromdate);
  if (todate) params.set("todate", todate);

  console.log(`搜索："${query}"（本次调用约 ₹0.50）……\n`);
  const data = await ikRequest(`/search/?${params.toString()}`);
  const docs = data.docs ?? [];
  if (docs.length === 0) {
    console.log("没有搜到结果。可以换个关键词，或者加 doctypes 缩小范围（比如 --doctypes=itat）。");
    return;
  }
  console.log(`共 ${data.found ?? docs.length} 条结果，本页 ${docs.length} 条：\n`);
  docs.forEach((doc, index) => {
    console.log(`${index + 1}. [docid: ${doc.tid}] ${doc.title}`);
    console.log(`   来源：${doc.docsource ?? "未知"}`);
    if (doc.headline) console.log(`   片段：${stripHtml(doc.headline).slice(0, 160)}…`);
    console.log("");
  });
  console.log(`看中哪个案例，记下它的 docid，下一步执行：\n  node scripts/case-extract.mjs extract <docid>`);
}

async function fetchDocument(docid) {
  requireIkToken();
  console.log(`下载 docid=${docid} 的判决书全文（本次调用约 ₹0.20）……`);
  const data = await ikRequest(`/doc/${docid}/`);
  const rawText = data.doc ?? data.content ?? "";
  if (!rawText) {
    console.error("解析不出正文字段。原始返回的顶层字段是：", Object.keys(data));
    throw new Error("Document API 返回里没有找到预期的正文字段（doc/content）。");
  }
  return {
    docid: data.tid ?? docid,
    title: data.title ?? "",
    docsource: data.docsource ?? "",
    publishdate: data.publishdate ?? "",
    text: stripHtml(rawText),
  };
}

async function extractStructured(doc) {
  if (!deepseekKey) {
    console.error("请先设置 DEEPSEEK_API_KEY 环境变量（提炼结构化字段需要调用模型）。");
    process.exit(1);
  }

  let bodyText = doc.text;
  let truncated = false;
  if (bodyText.length > MAX_DOC_CHARS) {
    bodyText = bodyText.slice(0, MAX_DOC_CHARS);
    truncated = true;
  }

  const baseUrl = (process.env.DEEPSEEK_API_BASE?.trim() || "https://api.deepseek.com").replace(/\/$/, "");
  const model = process.env.DEEPSEEK_ANSWER_MODEL?.trim() || "deepseek-v4-pro";

  const systemPrompt = `你是印度税务判例的结构化提炼助手。这份数据将进一个面向中资企业的印度合规问答产品的
"税务判例库"，供AI回答用户问题时引用，准确性要求很高：只能写文档原文里明确出现的信息，
不能推断、不能编造、不能用你自己的法律知识补全文档没写的内容。某个字段确实找不到依据时，
填 "文档中未明确提及"，不要猜。

案件中出现的纳税人/公司/当事人名称一律保留英文原文，不要翻译成中文。

只输出JSON，字段如下：
{
  "case_name": "案件名称（当事人英文原名，不翻译）",
  "court_and_year": "法院名称、审理层级、裁决年份/日期，覆盖的评估年度（如有）",
  "tax_type_and_authority": "争议税种，以及主管税局/机构名称",
  "revenue_position": ["税局主张的第1点", "第2点", "……"],
  "assessee_argument": ["纳税人抗辩的第1点", "第2点", "……"],
  "final_ruling": ["最终裁定的第1点", "第2点", "……"],
  "evidence_support": ["案件中被采信/讨论的具体证据类型，第1点", "第2点", "……"],
  "reference_value_note": "1-2句话说明这个案子对中资企业印度税务合规有没有直接参考价值"
}

revenue_position、assessee_argument、final_ruling、evidence_support 都要求分点、有实质内容，
不是一句话空泛概括——这是产品的核心价值所在，读者要能看懂双方到底在争什么、法院是怎么判的。`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${deepseekKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `案件标题：${doc.title}\n来源：${doc.docsource}\n发布日期：${doc.publishdate}\n\n判决书正文：\n${bodyText}`,
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 4000,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`模型调用失败：HTTP ${response.status}`);
  }
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型没有返回内容。");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("模型返回的不是有效JSON，原始内容：\n" + content.slice(0, 500));
  }
  return { ...parsed, truncated };
}

function toList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return ["文档中未明确提及"];
}

function renderMarkdown(doc, extracted) {
  const list = (items) => toList(items).map((item, index) => `${index + 1}. ${item}`).join("\n");
  const link = `https://indiankanoon.org/doc/${doc.docid}/`;

  const warning = extracted.truncated
    ? `\n> ⚠️ 原文超过 ${MAX_DOC_CHARS} 字符，本次提炼只喂了截断后的前半部分给模型，` +
      `完整论证（尤其是中后段的裁定理由）建议人工对照原文核对一遍，不要直接当最终稿发布。\n`
    : "";

  return `# 税务判例结构化记录（草稿，待人工审核）
${warning}
**案件名称**：${extracted.case_name ?? "文档中未明确提及"}

**法院与年份**：${extracted.court_and_year ?? "文档中未明确提及"}

**IndianKanoon文档ID**：${doc.docid}

**争议税种以及主管税局**：${extracted.tax_type_and_authority ?? "文档中未明确提及"}

**税局主张（Revenue's Position）**：
${list(extracted.revenue_position)}

**企业抗辩方向（Assessee's Argument）**：
${list(extracted.assessee_argument)}

**最终裁定结果**：
${list(extracted.final_ruling)}

**证据支撑要点**：
${list(extracted.evidence_support)}

**印度数据库链接**：${link}

---

## 对中资企业的参考价值

${extracted.reference_value_note ?? "文档中未明确提及"}
`;
}

async function runExtract(docid) {
  const doc = await fetchDocument(docid);
  console.log(`提炼中（调用模型）……`);
  const extracted = await extractStructured(doc);

  const { mkdir, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  await mkdir(OUTPUT_DIR, { recursive: true });
  const safeName = (extracted.case_name || doc.title || docid)
    .replace(/[\\/:*?"<>|]/g, "")
    .slice(0, 60)
    .trim();
  const filePath = path.join(OUTPUT_DIR, `${docid}_${safeName}.md`);
  await writeFile(filePath, renderMarkdown(doc, extracted), "utf8");
  console.log(`✓ 已生成草稿：${filePath}`);
  if (extracted.truncated) console.log(`  ⚠️ 原文被截断提炼，见文件顶部提示，建议人工核对。`);
}

function pickArg(args, key) {
  for (const a of args) {
    const m = a.match(/^--([\w-]+)=(.+)$/);
    if (m && m[1] === key) return m[2];
  }
  return undefined;
}

// 每项挑战对应的"短关键词"，用于和企业名组合检索（比整段英文短语命中率高）
const SHORT_KW = {
  1: "royalty", 2: "FEMA", 3: "PMLA", 4: "transfer pricing", 5: "customs",
  6: "income tax", 7: "FDI", 8: "FDI", 9: "equity", 10: "telecom",
  11: "data privacy", 12: "visa", 13: "PLI", 14: "value addition", 15: "anti-dumping",
  16: "customs", 17: "beneficial ownership", 18: "FEMA", 19: "permanent establishment", 20: "labour",
};

function brandOf(company) {
  let b = String(company).split("/")[0].trim();
  b = b.replace(/\b(Pvt\.?\s*Ltd\.?|Private\s+Limited|Ltd\.?|Limited|India|Pvt|Private|Inc\.?|LLC|L\.?L\.?C\.?|B\.?V\.?|A\.?G\.?|Co\.?|Corporation|Corp\.?|Group|Holdings?|International|Maharashtra|Electronics|Mobility|Solutions\s+and\s+Networks|Friction\s+Materials|\(India\)|\.com)\b/gi, " ");
  return b.replace(/\s+/g, " ").trim();
}

// 为每个任务构造多轮回退查询：企业名+短关键词 → 企业名 → 品牌名
function buildQueries(task) {
  const kw = SHORT_KW[task.rank] || task.keyword;
  const c = task.company;
  const brand = brandOf(c);
  const qs = [`"${c}" ${kw}`, `"${c}"`];
  if (brand && brand !== c) qs.push(`"${brand}"`);
  return [...new Set(qs)];
}

const MAX_PAGES = 5; // 单条查询最多翻几页，控制搜索成本

function parseFound(totalStr) {
  if (typeof totalStr === "number") return totalStr;
  const m = String(totalStr || "").match(/of\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : NaN;
}

function dateVal(s) {
  if (!s) return 0;
  const t = Date.parse(String(s));
  return Number.isNaN(t) ? 0 : t;
}

function stripTags(html) {
  return String(html || "").replace(/<[^>]+>/g, "").trim();
}

async function runBatch(tasksPath, outDir, limit) {
  requireIkToken();
  const { readFile, mkdir, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  await mkdir(path.join(outDir, "raw"), { recursive: true });

  const tasks = JSON.parse(await readFile(tasksPath, "utf8"));
  const limited = typeof limit === "number" && !Number.isNaN(limit) ? tasks.slice(0, limit) : tasks;

  const index = [];
  const fetchedDocids = new Set();
  let costSearch = 0, costDoc = 0;
  let totalDownloaded = 0, totalReused = 0;

  for (const task of limited) {
    const entry = {
      id: task.id, rank: task.rank, type: task.type, company: task.company,
      challenge: (task.challenge || "").replace(/\*\*/g, ""), keyword: task.keyword,
      query: null, status: "pending", note: "", downloads: [],
    };

    // 1) 多轮回退选查询式；命中后翻页取全部候选
    let chosen = null, allDocs = [];
    for (const q of buildQueries(task)) {
      try {
        console.error(`[${task.id}/100] search(${q})`);
        let pagenum = 0, collected = [], total = Infinity;
        while (pagenum < MAX_PAGES) {
          const sp = new URLSearchParams({ formInput: q, pagenum: String(pagenum) });
          const r = await ikRequest(`/search/?${sp.toString()}`);
          costSearch += 0.5;
          const docs = r.docs ?? [];
          if (pagenum === 0) total = parseFound(r.found);
          collected.push(...docs);
          pagenum++;
          if (docs.length === 0) break;
          if (collected.length >= total) break;
        }
        if (collected.length > 0) { chosen = q; allDocs = collected; break; }
      } catch { /* 该变体失败，尝试下一个 */ }
    }

    if (!chosen || allDocs.length === 0) {
      entry.status = "no_result";
      entry.note = "多轮回退后仍无命中";
      index.push(entry);
      continue;
    }
    entry.query = chosen;

    // 去重（防止翻页重叠），按发布日期降序取前 5
    const seen = new Set();
    allDocs = allDocs.filter((d) => { if (seen.has(d.tid)) return false; seen.add(d.tid); return true; });
    const ranked = allDocs
      .map((d) => ({ d, t: dateVal(d.publishdate) }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 5)
      .map((x) => x.d);

    // 2) 逐个下载（跨任务去重，避免重复文件与重复计费）
    for (const doc of ranked) {
      const tid = doc.tid;
      const dl = {
        docid: tid,
        title: stripTags(doc.title),
        docsource: doc.docsource ?? "",
        publishdate: doc.publishdate ?? "",
        link: `https://indiankanoon.org/doc/${tid}/`,
        file: `raw/${tid}.html`,
        status: "pending", note: "",
      };
      if (fetchedDocids.has(tid)) {
        dl.status = "reused";
        dl.note = "本批次已由其他任务下载，复用本地文件";
        totalReused++;
        entry.downloads.push(dl);
        continue;
      }
      try {
        console.error(`        fetch docid=${tid} (${(dl.title || "").slice(0, 50)})`);
        const ddata = await ikRequest(`/doc/${tid}/`);
        costDoc += 0.2;
        const rawHtml = ddata.doc ?? ddata.content ?? "";
        if (!rawHtml) {
          dl.status = "no_body";
          dl.note = "Document API 无正文字段";
          entry.downloads.push(dl);
          continue;
        }
        await writeFile(path.join(outDir, "raw", `${tid}.html`), rawHtml, "utf8");
        await writeFile(path.join(outDir, "raw", `${tid}.meta.json`),
          JSON.stringify({
            docid: ddata.tid ?? tid,
            title: stripTags(ddata.title ?? doc.title),
            docsource: ddata.docsource ?? doc.docsource ?? "",
            publishdate: ddata.publishdate ?? doc.publishdate ?? "",
            link: dl.link,
          }, null, 2), "utf8");
        fetchedDocids.add(tid);
        dl.status = "downloaded";
        totalDownloaded++;
      } catch (e) {
        dl.status = "error";
        dl.note = e.message;
      }
      entry.downloads.push(dl);
      await new Promise((r) => setTimeout(r, 400));
    }
    entry.status = entry.downloads.some((d) => d.status === "downloaded" || d.status === "reused")
      ? "ok" : "no_result";
    index.push(entry);
  }

  await writeFile(path.join(outDir, "index.json"), JSON.stringify(index, null, 2), "utf8");
  await writeFile(path.join(outDir, "run_meta.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      tasks: index.length,
      costSearchINR: Number(costSearch.toFixed(2)),
      costDocINR: Number(costDoc.toFixed(2)),
      totalCostINR: Number((costSearch + costDoc).toFixed(2)),
      uniqueDownloaded: totalDownloaded,
      reused: totalReused,
    }, null, 2), "utf8");
  console.error(`\n完成。任务 ${index.length} 个；搜索花费 ≈ ₹${costSearch.toFixed(2)}，文书下载 ≈ ₹${costDoc.toFixed(2)}（其中新下载 ${totalDownloaded} 份、复用 ${totalReused} 份）。`);
}

async function runManifest(outDir) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const index = JSON.parse(await readFile(path.join(outDir, "index.json"), "utf8"));
  let meta = {};
  try {
    meta = JSON.parse(await readFile(path.join(outDir, "run_meta.json"), "utf8"));
  } catch { /* ignore */ }

  // 去重收集实际下载的文件，并记录每个 docid 关联的任务
  const byDoc = new Map();
  const taskMap = new Map();
  for (const task of index) {
    for (const dl of (task.downloads || [])) {
      if (dl.status === "downloaded" || dl.status === "reused") {
        if (!byDoc.has(dl.docid)) byDoc.set(dl.docid, dl);
        if (!taskMap.has(dl.docid)) taskMap.set(dl.docid, []);
        taskMap.get(dl.docid).push(`#${task.id} ${task.company}`);
      }
    }
  }

  const lines = [];
  lines.push(`# Indian Kanoon 下载文件清单（按发布日期降序取前 5）`);
  lines.push("");
  lines.push(`- 生成时间：${meta.generatedAt || new Date().toISOString()}`);
  lines.push(`- 任务总数：${meta.tasks ?? index.length}`);
  lines.push(`- 本次搜索花费（估算）：₹${meta.costSearchINR ?? "?"}`);
  lines.push(`- 本次文书下载花费（估算）：₹${meta.costDocINR ?? "?"}`);
  lines.push(`- 实际下载文件数（去重后）：${meta.uniqueDownloaded ?? byDoc.size}`);
  lines.push(`- 跨任务复用文件数：${meta.reused ?? 0}`);
  lines.push("");
  lines.push(`> 说明：每项挑战检索后，对返回结果按发布日期降序排序、取前 5 个 docid 下载；同一 docid 若被多个任务命中只存一份。文件为 Indian Kanoon API 返回的 HTML 原文，未做格式转换。`);
  lines.push("");
  lines.push(`## 一、所有下载文件清单（去重）`);
  lines.push("");
  lines.push(`| # | docid | 案件标题 | 法院/来源 | 发布日期 | 本地文件 | 印度数据库链接 | 关联任务 |`);
  lines.push(`|---:|---:|---|---|---|---|---|---|---|`);
  let i = 0;
  for (const [docid, dl] of byDoc) {
    i++;
    const link = dl.link ? `[打开](${dl.link})` : "";
    const local = dl.file ? `\`${dl.file}\`` : "";
    const tasks = (taskMap.get(docid) || []).join("、");
    lines.push(`| ${i} | ${docid} | ${dl.title || ""} | ${dl.docsource || ""} | ${dl.publishdate || ""} | ${local} | ${link} | ${tasks} |`);
  }
  lines.push("");
  lines.push(`## 二、按任务对照（每项取前 5，按时间降序）`);
  lines.push("");
  lines.push(`| 任务# | 企业 | 挑战 | 使用查询式 | 选取 docid（状态） | 任务状态 |`);
  lines.push(`|---:|---|---|---|---|---|`);
  for (const task of index) {
    const dls = task.downloads || [];
    const ids = dls.map((d) =>
      d.status === "reused" ? `${d.docid}(复用)` :
      d.status === "downloaded" ? `${d.docid}(新)` :
      `${d.docid}(${d.status})`
    ).join("、") || "—";
    lines.push(`| #${task.id} | ${task.company} | ${task.challenge} | ${task.query || "—"} | ${ids} | ${task.status} |`);
  }
  lines.push("");

  const out = path.join(outDir, "manifest.md");
  await writeFile(out, lines.join("\n"), "utf8");
  console.error(`已生成清单：${out}（共 ${byDoc.size} 个去重文件）`);
}

async function runPdf(outDir) {
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const py = process.env.PYTHON_PDF_BIN || "python3";
  const scriptPath = path.join(path.dirname(process.argv[1]), "make_pdf.py");
  const r = spawnSync(py, [scriptPath, outDir], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("PDF 转换失败，退出码", r.status);
    process.exit(1);
  }
}

async function main() {
  const [, , command, ...rest] = process.argv;

  if (command === "search") {
    const query = rest.filter((arg) => !arg.startsWith("--")).join(" ");
    if (!query) {
      console.error('用法：node scripts/case-extract.mjs search "关键词" [--doctypes=itat] [--fromdate=DD-MM-YYYY] [--todate=DD-MM-YYYY]');
      process.exit(1);
    }
    const opts = {};
    for (const arg of rest) {
      const match = arg.match(/^--(\w+)=(.+)$/);
      if (match) opts[match[1]] = match[2];
    }
    await searchCases(query, opts);
    return;
  }

  if (command === "extract") {
    const docids = rest.filter((arg) => !arg.startsWith("--"));
    if (docids.length === 0) {
      console.error("用法：node scripts/case-extract.mjs extract <docid> [docid2 ...]");
      process.exit(1);
    }
    for (const docid of docids) {
      try {
        await runExtract(docid);
      } catch (error) {
        console.error(`✗ docid=${docid} 处理失败：${error.message}`);
      }
      // 给API和模型调用之间留点间隔，不要连续甩请求。
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return;
  }

  if (command === "batch") {
    const tasksPath = pickArg(rest, "tasks");
    const outDir = pickArg(rest, "out") || OUTPUT_DIR;
    if (!tasksPath) {
      console.error("用法：node case-extract.mjs batch --tasks=<任务JSON路径> --out=<输出目录> [--limit=N]");
      process.exit(1);
    }
    const limitArg = pickArg(rest, "limit");
    const limit = limitArg ? parseInt(limitArg, 10) : undefined;
    await runBatch(tasksPath, outDir, limit);
    return;
  }

  if (command === "pdf") {
    const outDir = pickArg(rest, "out") || OUTPUT_DIR;
    await runPdf(outDir);
    return;
  }

  if (command === "manifest") {
    const outDir = pickArg(rest, "out") || OUTPUT_DIR;
    await runManifest(outDir);
    return;
  }

  console.log(`用法：
  node scripts/case-extract.mjs search "关键词"            # 先搜索看候选案例
  node scripts/case-extract.mjs extract <docid> [docid2..]  # 下载并提炼成结构化草稿
  node scripts/case-extract.mjs batch --tasks=<任务JSON> --out=<目录> [--limit=N]  # 批量检索+按时间取前5下载(HTML)
  node scripts/case-extract.mjs manifest --out=<目录>      # 由 index.json 生成下载清单 manifest.md
  node scripts/case-extract.mjs pdf --out=<目录>           # 把 raw/*.html 转成 pdf/*.pdf

需要的环境变量：INDIANKANOON_API_TOKEN（必须）、DEEPSEEK_API_KEY（extract时需要）、PYTHON_PDF_BIN（pdf时需要，指向装了 reportlab 的 python）`);
}

main().catch((error) => {
  console.error("脚本执行失败：", error.message);
  process.exit(1);
});
