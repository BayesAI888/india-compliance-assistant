#!/usr/bin/env node
/**
 * 批量把一个文件夹里的 _for_kb.txt 上传到知识库。
 *
 * ## 用法（两步，不要跳过第一步）
 *
 *     export ADMIN_USERNAME='...'
 *     export ADMIN_PASSWORD='...'
 *
 *     # 第一步：只看，不传。生成一份计划表让你核对位阶。
 *     node scripts/upload-knowledge.mjs --dir ~/Desktop/工作/印度税法/9月21日补充 --plan
 *
 *     # 核对并修改生成的 upload-plan.json 里的 hierarchy 那一列，然后：
 *     node scripts/upload-knowledge.mjs --plan-file upload-plan.json --apply
 *
 *     # 确认后台里看着没问题了，再发布：
 *     node scripts/upload-knowledge.mjs --plan-file upload-plan.json --apply --publish
 *
 * ## 为什么分两步
 *
 * 位阶（Act / Rules / Notification / Circular）参与检索配额、结论锚定和冲突提示
 * （见 `legal-hierarchy.ts`）。**判错的后果是一份 circular 被当成 Act 去锚定结论**，
 * 而从文件名推断位阶必然有猜不准的时候——实测《中印 DTAA 议定书》《FEMA 22(R)》
 * 《CAROTAR 2020》这三类都推不出来。
 *
 * 所以脚本不替你拍板：先把推断结果连同"这是猜的还是认准的"一起写进计划表，
 * 你改完再执行。一次性脚本的诱惑很大，但位阶这一列值得多花两分钟。
 *
 * ## 上传的三步和它们的区别
 *
 *   stage         —— 校验 + 暂存。**不会**进入检索。校验不过会返回具体哪个 chunk 缺什么。
 *   setHierarchy  —— 设定位阶。
 *   publish       —— 发布上线，并顺带算向量。**这一步之后才会影响线上回答。**
 *
 * 默认只做前两步。`--publish` 才发布——给你留一次在后台肉眼过一遍的机会。
 *
 * ## 账号密码
 *
 * 从环境变量读，脚本里不写、也不落盘。计划表里同样不含任何凭据。
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE = "https://indiacompliance.cn";

/**
 * 从资料名推断位阶。规则和 `lib/server/legal-hierarchy.ts` 的 `classifyHierarchy`
 * 保持同一个顺序：**具名规范优先于发布载体**（"以通知形式发布的规则"算 RULES）。
 *
 * 这里是复制而不是引用，因为这个脚本是 .mjs、那边是 .ts，跑之前没有编译步骤。
 * 复制的代价是可能走偏，所以下面 `confident` 会标出哪些是猜的——
 * 真正的判定仍然以你在计划表里填的为准，这份推断只是省点打字。
 */
function guessHierarchy(name) {
  // ⚠下划线必须先换成空格：正则的 \b 把下划线算作单词字符，
  // 所以 "FEMA_NDI_Rules_for_kb" 里的 Rules **两边都没有词边界**，`\brules?\b` 匹配不上。
  // 实测就是这么漏的：一批 FEMA/FTP 文件全被判成 UNKNOWN。
  // `document-category.ts` 里记过同一个坑，写这个脚本时还是又踩了一次。
  // 顺便把 "_for_kb" 这个统一后缀去掉，它对判位阶毫无帮助。
  const n = name.toLowerCase().replace(/_for_kb$|_for_kb\./, ".").replace(/_/g, " ");
  if (/\bcirculars?\b|\binstruction\b|通函/.test(n)) return { level: "CIRCULAR", confident: true };
  if (/\brules?\b|\bregulations?\b|\bdirections?\b|规则|条例/.test(n)) return { level: "RULES", confident: true };
  // Press Note / Policy Circular 这类：DPIIT 的 Press Note 在效力上等同通知，
  // Consolidated FDI Policy 本身是 circular 形式发布的政策汇编。
  if (/press\s*note|\bnotification\b|\bg\.?s\.?r\.?\b|通知/.test(n)) return { level: "NOTIFICATION", confident: true };
  if (/\bact\b|\bcode\b|法$/.test(n)) return { level: "ACT", confident: true };
  // 政策文件（FTP / FDI Policy / Handbook of Procedures）：
  // 它们是有授权依据的成文规范，位阶上按 RULES 处理最接近实际效力。
  // 标成"猜的"是因为这是个判断，不是命名规律。
  if (/\bpolicy\b|handbook\s+of\s+procedures|\bhbp\b/.test(n)) return { level: "RULES", confident: false };
  // 推不出来的：条约议定书、只有缩写的（CAROTAR）、Master Direction 之外的 RBI 文件……
  // 给一个最保守的默认值并标成"猜的"。UNKNOWN 在 legal-hierarchy 里按最低位阶处理，
  // 不会让来历不明的资料去支撑结论——但你应该在计划表里把它改成真实位阶。
  return { level: "UNKNOWN", confident: false };
}

function parseArgs(argv) {
  const args = {
    dir: "", planFile: "", base: DEFAULT_BASE,
    plan: false, apply: false, publish: false, skipPublished: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dir") args.dir = argv[++i] ?? "";
    else if (a === "--plan-file") args.planFile = argv[++i] ?? "";
    else if (a === "--base") args.base = argv[++i] ?? DEFAULT_BASE;
    else if (a === "--plan") args.plan = true;
    else if (a === "--apply") args.apply = true;
    else if (a === "--publish") args.publish = true;
    else if (a === "--skip-published") args.skipPublished = true;
  }
  return args;
}

function authHeader() {
  const user = process.env.ADMIN_USERNAME;
  const pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) {
    console.error(
      "✗ 缺少后台账号密码。先设置环境变量再跑：\n"
      + "    export ADMIN_USERNAME='...'\n"
      + "    export ADMIN_PASSWORD='...'\n"
      + "  （脚本不会把它们写进任何文件）",
    );
    process.exit(1);
  }
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

async function post(base, auth, payload) {
  // 网络错误按"这一份失败"处理，不抛出去。
  // 34 份传到第 20 份时网断一下，就让前面 19 份的结果全部丢失、还得从头猜哪些成了——
  // 那是这个脚本最不该有的失败方式。失败落进汇总表，下一轮 --skip-published 自动跳过成功的。
  let response;
  try {
    response = await fetch(`${base}/api/admin/knowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),   // 大文件切块慢，给足时间
    });
  } catch (error) {
    return { ok: false, status: 0, data: { message: `网络错误：${error?.message ?? error}` } };
  }
  let data = {};
  try { data = await response.json(); } catch { /* 非 JSON 响应，下面按状态码处理 */ }
  return { ok: response.ok, status: response.status, data };
}

/**
 * 服务端**已发布**的文件名集合。
 *
 * 用途：重传时跳过上一轮已经成功的那些。
 *
 * 为什么值得专门做这一步——`publish` 本身是幂等的（`knowledge-store.ts` 里有
 * `if (document.status !== "PUBLISHED")` 的判断），重跑不会出错。
 * 但发布会**连带重算向量**，一份 270 个 chunk 的政策文件重算一遍是实打实的时间和额度。
 * 34 份里已经成了 15 份，没道理再付一次这个钱。
 *
 * ⚠**按文件名匹配，不看内容**。所以如果你改的是一份**已经发布过**的资料，
 * 加了 --skip-published 反而会把它跳过去。那种情况下不要用这个开关，
 * 或者先在后台把旧的那份下架。
 */
async function publishedFileNames(base, auth) {
  // 整个包在 try 里：这只是一项**优化**（省掉重复的向量计算），
  // 不是上传的必要条件。拉不到就当"不知道谁已发布"，全部照常处理——
  // 让一次网络抖动打断整轮上传，是拿大的换小的。
  try {
    const response = await fetch(`${base}/api/admin/knowledge`, { headers: { Authorization: auth } });
    if (!response.ok) {
      console.log(`⚠ 拉总览失败（HTTP ${response.status}），--skip-published 不生效，将全部重传。`);
      return new Set();
    }
    const { documents = [] } = await response.json();
    return new Set(documents.filter((d) => d.status === "PUBLISHED").map((d) => d.fileName));
  } catch (error) {
    console.log(`⚠ 拉总览出错（${error?.message ?? error}），--skip-published 不生效，将全部重传。`);
    return new Set();
  }
}

// ---------------------------------------------------------------- 第一步：出计划

async function makePlan(dir) {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".txt"))
    .map((e) => e.name)
    .sort();

  if (entries.length === 0) {
    console.error(`✗ ${dir} 里没有找到 .txt 文件。`);
    process.exit(1);
  }

  const items = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    const text = await readFile(full, "utf8");
    const guess = guessHierarchy(name);
    items.push({
      file: full,
      fileName: name,
      // ⚠这一列是给你改的。推断不准时 confident 为 false。
      hierarchy: guess.level,
      _推断是否有把握: guess.confident,
      _体积KB: Math.round(Buffer.byteLength(text, "utf8") / 1024),
      _Chunk数: (text.match(/^-----[ \t]*$/gm) ?? []).length,
    });
  }
  return items;
}

function printPlan(items) {
  console.log(`\n共 ${items.length} 份：\n`);
  console.log("  位阶          把握   Chunk   体积     文件名");
  console.log("  " + "-".repeat(78));
  for (const it of items) {
    console.log(
      `  ${it.hierarchy.padEnd(13)} ${it._推断是否有把握 ? "有  " : "★猜 "} `
      + `${String(it._Chunk数).padStart(5)}  ${String(it._体积KB).padStart(5)}KB  ${it.fileName.slice(0, 44)}`,
    );
  }
  const guessed = items.filter((i) => !i._推断是否有把握);
  if (guessed.length > 0) {
    console.log(`\n★ 有 ${guessed.length} 份推不出位阶，必须手工改：`);
    for (const g of guessed) console.log(`    ${g.fileName}`);
  }
}

// ---------------------------------------------------------------- 第二步：执行

async function apply(items, { base, publish, skipPublished }) {
  const auth = authHeader();
  const results = [];

  const alreadyPublished = skipPublished ? await publishedFileNames(base, auth) : new Set();
  if (skipPublished) {
    const hit = items.filter((i) => alreadyPublished.has(i.fileName)).length;
    console.log(`已发布因而跳过：${hit} 份；本轮实际处理：${items.length - hit} 份`);
  }

  for (const item of items) {
    if (alreadyPublished.has(item.fileName)) {
      results.push({ file: item.fileName, stage: "跳过（已发布）" });
      continue;
    }
    const label = item.fileName.slice(0, 46);
    process.stdout.write(`\n▶ ${label}\n`);

    if (!["ACT", "RULES", "NOTIFICATION", "CIRCULAR", "UNKNOWN"].includes(item.hierarchy)) {
      results.push({ file: item.fileName, stage: "位阶值非法", detail: item.hierarchy });
      console.log(`   ✗ 位阶「${item.hierarchy}」不合法，跳过。`);
      continue;
    }

    const text = await readFile(item.file, "utf8");

    // ---- stage：校验 + 暂存 ----
    const staged = await post(base, auth, { action: "stage", fileName: item.fileName, text });
    if (!staged.ok) {
      // 422 会带上逐条校验结果——把它原样打出来，这是最有用的信息。
      console.log(`   ✗ 暂存失败（HTTP ${staged.status}）：${staged.data.message ?? ""}`);
      for (const err of staged.data.validation?.errors ?? []) console.log(`      · ${err}`);
      results.push({ file: item.fileName, stage: "暂存失败", detail: staged.data.message ?? staged.status });
      continue;
    }
    const documentId = staged.data.documentId;
    if (staged.data.duplicate) {
      console.log(`   ⓘ 库里已有同样内容的一份（documentId=${documentId}），不重复暂存。`);
    } else {
      console.log(`   ✓ 已暂存 ${staged.data.chunkCount} 个 chunk，${staged.data.warningCount} 条提醒`);
    }

    // ---- setHierarchy ----
    const hier = await post(base, auth, { action: "setHierarchy", documentId, hierarchyLevel: item.hierarchy });
    if (!hier.ok) {
      console.log(`   ✗ 设位阶失败：${hier.data.message ?? hier.status}`);
      results.push({ file: item.fileName, stage: "设位阶失败", documentId });
      continue;
    }
    console.log(`   ✓ 位阶 ${item.hierarchy}`);

    if (!publish) {
      results.push({ file: item.fileName, stage: "已暂存待发布", documentId });
      continue;
    }

    // ---- publish ----
    const published = await post(base, auth, { action: "publish", documentId });
    if (!published.ok) {
      console.log(`   ✗ 发布失败：${published.data.message ?? published.status}`);
      results.push({ file: item.fileName, stage: "发布失败", documentId });
      continue;
    }
    console.log(`   ✓ 已发布 ${published.data.chunkCount} 个 chunk`);
    results.push({ file: item.fileName, stage: "已发布", documentId });
  }
  return results;
}

/**
 * 传完之后把后台总览拉下来，逐份打印**服务端实际判出的法域和位阶**。
 *
 * 为什么要这一步：法域是服务端自动判的，判成「其他」的资料在检索上
 * **永远剔不掉**（`domain-scope.ts` 规则 4：没有被任何 profile 覆盖的资料永不剔除），
 * 等于往每道题的候选池里长期塞一份挡不住的资料。传完当场看一眼，比上线后查便宜得多。
 */
async function verify(base, fileNames) {
  const auth = authHeader();
  let response;
  try {
    response = await fetch(`${base}/api/admin/knowledge`, { headers: { Authorization: auth } });
  } catch (error) {
    // 核对只是事后确认，不该反过来让整个脚本以非零码退出——
    // 上传本身可能已经全成了。
    console.log(`\n⚠ 拉总览出错（${error?.message ?? error}），跳过核对。请去后台自己看一眼。`);
    return;
  }
  if (!response.ok) {
    console.log(`\n⚠ 拉总览失败（HTTP ${response.status}），跳过核对。请去后台自己看一眼。`);
    return;
  }
  const { documents = [] } = await response.json();
  const mine = documents.filter((d) => fileNames.includes(d.fileName));

  console.log("\n=== 服务端实际判出的类别与位阶 ===\n");
  let other = 0;
  for (const d of mine) {
    const bad = d.category === "other" || d.categoryLabel === "其他";
    if (bad) other += 1;
    console.log(`  ${bad ? "⚠️" : "  "} ${String(d.categoryLabel ?? d.category).padEnd(24)} `
      + `${String(d.hierarchyLevel ?? "-").padEnd(13)} ${String(d.fileName).slice(0, 40)}`);
  }
  if (other > 0) {
    console.log(
      `\n⚠ 有 ${other} 份判进了「其他」。这类资料任何法域闸门都挡不住它，`
      + "\n  会长期留在每一道题的候选池里。请在 document-category.ts 的规则表里补上对应关键词，"
      + "\n  重新部署后把这几份下架重传。",
    );
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.plan) {
    if (!args.dir) { console.error("✗ 需要 --dir <文件夹>"); process.exit(1); }
    const items = await makePlan(args.dir);
    printPlan(items);
    const out = path.join(process.cwd(), "upload-plan.json");
    await writeFile(out, JSON.stringify(items, null, 2), "utf8");
    console.log(`\n计划表已写到：${out}`);
    console.log("请核对 hierarchy 那一列（尤其是标★的），改完执行：");
    console.log(`    node scripts/upload-knowledge.mjs --plan-file ${out} --apply`);
    return;
  }

  if (args.apply) {
    if (!args.planFile) { console.error("✗ 需要 --plan-file <upload-plan.json>"); process.exit(1); }
    const items = JSON.parse(await readFile(args.planFile, "utf8"));
    const unresolved = items.filter((i) => i.hierarchy === "UNKNOWN");
    if (unresolved.length > 0) {
      console.error(`✗ 还有 ${unresolved.length} 份位阶是 UNKNOWN，先在计划表里填好再跑：`);
      for (const u of unresolved) console.error(`    ${u.fileName}`);
      console.error("  （确实判不出位阶的，可以显式填 UNKNOWN 之外的值；");
      console.error("    真要按未知处理就把这份先拿出批次，单独讨论。）");
      process.exit(1);
    }

    console.log(`目标：${args.base}`);
    console.log(`模式：${args.publish ? "暂存 + 设位阶 + 发布" : "暂存 + 设位阶（不发布）"}`);
    const results = await apply(items, {
      base: args.base, publish: args.publish, skipPublished: args.skipPublished,
    });

    console.log("\n=== 汇总 ===\n");
    for (const r of results) console.log(`  ${String(r.stage).padEnd(16)} ${r.file.slice(0, 50)}`);
    const failed = results.filter((r) => r.stage.includes("失败") || r.stage.includes("非法"));
    const skipped = results.filter((r) => r.stage.startsWith("跳过"));
    console.log(`\n成功 ${results.length - failed.length - skipped.length} / `
      + `${results.length - skipped.length}（另有 ${skipped.length} 份跳过）`);

    // 把结果落盘，下一轮重传不用靠人眼从终端里挑失败的那几份。
    const resultPath = path.join(path.dirname(path.resolve(args.planFile)), "upload-result.json");
    await writeFile(resultPath, JSON.stringify(results, null, 2), "utf8");
    console.log(`结果已写到：${resultPath}`);

    if (failed.length > 0) {
      console.log(`\n✗ ${failed.length} 份没成，上面每一份的具体原因都打出来了。`);
      console.log("  改好那几个文件之后，同一条命令加 --skip-published 再跑一次，");
      console.log("  已经成了的不会重传（也就不会重算一遍向量）：");
      console.log(`    node scripts/upload-knowledge.mjs --plan-file ${args.planFile} --apply --publish --skip-published`);
    }

    await verify(args.base, items.map((i) => i.fileName));

    if (!args.publish) {
      console.log(`\n都对的话，去后台过一眼，然后加 --publish 再跑一次发布：`);
      console.log(`    node scripts/upload-knowledge.mjs --plan-file ${args.planFile} --apply --publish`);
      console.log(`  后台地址：${args.base}/admin`);
    }
    if (failed.length > 0) process.exit(1);
    return;
  }

  console.error("用法见文件头部注释。要么 --plan，要么 --plan-file ... --apply。");
  process.exit(1);
}

// ⚠不要写成 `import.meta.url === \`file://${process.argv[1]}\``：
// 路径里有中文时 import.meta.url 会被百分号编码，两边永远不相等，main() 一次都不会跑，
// 脚本"成功"结束、零输出。2026-09-20 在 fema-notification-index.mjs 上栽过一次。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`✗ ${error?.message ?? error}`);
    process.exit(1);
  });
}
