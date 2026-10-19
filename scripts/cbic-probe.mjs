#!/usr/bin/env node
/**
 * CBIC notification 接口**探针**。
 *
 * 用途：把接口真实返回的 JSON 结构打印出来，用来设计 notification 索引。
 * 这一步不能省——字段名靠猜必然会错，而错了之后整条索引链路都要返工。
 *
 * 为什么需要你在本机跑：开发沙箱到不了 `taxinformation.cbic.gov.in`
 * （HTML 页面、API、内置浏览器三条路全部不通；同期 RBI 和 incometaxindia 是通的，
 * 所以是这个域被挡，不是网络整体不通）。你的 Chrome 能打开它，说明从你这边可达。
 *
 * ## 跑法
 *
 *     cd site
 *     node scripts/cbic-probe.mjs
 *
 * 需要 token 时（见下）：
 *
 *     CBIC_HOME_TOKEN='eyJhbGciOi...' node scripts/cbic-probe.mjs
 *
 * ## 关于 token
 *
 * 页面请求带了一个 `Authorization1: homeToken <JWT>`。解出来是
 * `{"sub":"10.2.108.9","auth":"ROLE_ANONYMOUS","exp":...}`——**匿名角色**，
 * 不是用户凭证，是站点发给每个访客的。但它仍可能是接口的硬性要求。
 *
 * 所以这个脚本**先不带 token 试一次**：
 * - 成功 → 正式的索引脚本就不用管 token，最省事
 * - 401/403 → 再用 CBIC_HOME_TOKEN 试一次，确认"带上就行"
 *
 * 这个顺序是有意的：先确认最简单的方案行不行，别一上来就把复杂度引进来。
 *
 * ## 输出
 *
 * 终端打印摘要，完整 JSON 写到 `scripts/cbic-probe-output.json`。
 * 把终端摘要贴给我就够了（完整 JSON 可能有几百 KB）。
 */

const BASE = "https://taxinformation.cbic.gov.in/api/cbic-notification-msts";
const TOKEN = process.env.CBIC_HOME_TOKEN?.trim();

/** 浏览器会带这些。缺了可能被 WAF 拦，所以照抄一份最小集合。 */
function headers(withToken) {
  const h = {
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://taxinformation.cbic.gov.in/content-page/explore-notification",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      + "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    "language": "en",
  };
  if (withToken && TOKEN) h.Authorization1 = `homeToken ${TOKEN}`;
  return h;
}

async function get(url, withToken) {
  const response = await fetch(url, { headers: headers(withToken), redirect: "follow" });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { /* 不是 JSON 就保留原文 */ }
  return { status: response.status, json, text };
}

/**
 * 两次尝试：先裸请求，失败再带 token。
 * 返回时说明是哪一次成功的——这决定了正式脚本要不要维护 token。
 */
async function probe(url, label) {
  process.stdout.write(`\n── ${label}\n   ${url}\n`);
  let result = await get(url, false);
  let mode = "无需 token";
  if (result.status >= 400 || !result.json) {
    if (!TOKEN) {
      console.log(`   ✗ HTTP ${result.status}，且没有 CBIC_HOME_TOKEN 可试`);
      console.log(`   返回前 300 字：${result.text.slice(0, 300)}`);
      return undefined;
    }
    result = await get(url, true);
    mode = "需要 token";
  }
  if (result.status >= 400 || !result.json) {
    console.log(`   ✗ 带 token 仍然 HTTP ${result.status}`);
    console.log(`   返回前 300 字：${result.text.slice(0, 300)}`);
    return undefined;
  }
  console.log(`   ✓ HTTP ${result.status}（${mode}）`);
  return result.json;
}

/** 递归列出 JSON 的字段路径和示例值——这是我要看的东西。 */
function describe(value, prefix = "", depth = 0, out = []) {
  if (depth > 3) return out;
  if (Array.isArray(value)) {
    out.push(`${prefix}[]  长度=${value.length}`);
    if (value.length) describe(value[0], `${prefix}[0]`, depth + 1, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v === null || typeof v !== "object") {
        out.push(`${path} = ${JSON.stringify(v)?.slice(0, 90)}`);
      } else {
        describe(v, path, depth + 1, out);
      }
    }
    return out;
  }
  out.push(`${prefix} = ${JSON.stringify(value)?.slice(0, 90)}`);
  return out;
}

const TAX_IDS = [
  { id: "1000002", guess: "海关（Customs）——知识库里 Customs Valuation Rules 的链接用的就是这个" },
  { id: "1000001", guess: "试探：可能是 GST" },
  { id: "1000003", guess: "试探" },
];

async function main() {
  console.log("CBIC notification 接口探针");
  console.log(TOKEN ? "已提供 CBIC_HOME_TOKEN（仅在裸请求失败时使用）" : "未提供 token，只做裸请求");

  const dump = {};

  // ① 下拉选项接口：能告诉我有哪些 category
  dump.masters = await probe(
    `${BASE}?year=2023&taxId=1000002&category=Tariff`,
    "① 下拉选项（category 清单）",
  );
  if (dump.masters) {
    console.log("   字段结构：");
    describe(dump.masters).slice(0, 25).forEach((line) => console.log(`     ${line}`));
  }

  // ② 列表接口：字段结构 + 分页元数据
  dump.list = await probe(
    `${BASE}/fetchNotificationByYearAndCategory?year=2023&page=0&size=3&taxId=1000002&category=Tariff`,
    "② 通知列表（取 3 条看结构）",
  );
  if (dump.list) {
    console.log("   字段结构：");
    describe(dump.list).slice(0, 40).forEach((line) => console.log(`     ${line}`));
  }

  // ③ size 能不能调大——决定要翻多少页、花多少请求
  const big = await probe(
    `${BASE}/fetchNotificationByYearAndCategory?year=2023&page=0&size=200&taxId=1000002&category=Tariff`,
    "③ size=200 能不能一次拿完（决定翻页成本）",
  );
  if (big) {
    const n = Array.isArray(big) ? big.length
      : Array.isArray(big?.content) ? big.content.length
      : Array.isArray(big?.data) ? big.data.length : "（数组不在预期字段里，看上面结构）";
    console.log(`   实际返回条数：${n}`);
    dump.bigPage = { returned: n };
  }

  // ④ 别的 taxId 是什么——GST 在不在同一个接口里
  console.log("\n── ④ 试探其他 taxId（找 GST）");
  for (const { id, guess } of TAX_IDS) {
    const r = await probe(
      `${BASE}?year=2023&taxId=${id}&category=Tariff`,
      `taxId=${id}  ${guess}`,
    );
    if (r) dump[`taxId_${id}`] = r;
  }

  const outPath = new URL("./cbic-probe-output.json", import.meta.url);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outPath, JSON.stringify(dump, null, 2), "utf8");
  console.log(`\n完整返回已写入：scripts/cbic-probe-output.json`);
  console.log("把上面终端里的「字段结构」几段贴给我就行，JSON 文件不用发。");
}

main().catch((error) => {
  console.error("\n探针失败：", error.message);
  console.error("如果是网络错误，确认这台机器能打开 taxinformation.cbic.gov.in。");
  process.exitCode = 1;
});
