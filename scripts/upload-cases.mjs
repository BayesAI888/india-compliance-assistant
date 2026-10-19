#!/usr/bin/env node
/**
 * 批量上传税务案例到线上后台，跳过"待审核"，上传即发布。
 *
 * 起因：用户想自己整理一批案例（按九字段模板手动整理或复制现成的md/txt），一次性
 * 初始化案例库，不想每份都经过 DeepSeek 再提炼一遍（省 token），也不想在后台一个个
 * 点"确认发布"（自己整理的内容信得过，跳过复核）。
 *
 * 和 upload-knowledge-base.mjs 是同一个思路：脚本跑在你自己的电脑上，密码只在你本地
 * 输入，不会发给任何人（包括我）。不同点：这个脚本不会下架任何现有案例——案例库是
 * 按 IndianKanoon文档ID 去重的，同一个案例重复上传会自动复用已有记录，不用先清空。
 *
 * 每份文件必须是 lib/case-validator.ts 能解析的九字段模板格式（案件名称/法院与年份/
 * IndianKanoon文档ID/争议税种以及主管税局/税局主张/企业抗辩方向/最终裁定结果/
 * 证据支撑要点/印度数据库链接），文件扩展名可以是 .md 或 .txt，解析不认扩展名只认内容。
 * 没有现成案例、想要一份空白模板可以照着填，见 scripts/case-template-blank.txt。
 *
 * 用法：
 *   1. 先跑一次不带 --commit 的，看看会上传哪些文件，确认没问题：
 *        ADMIN_USERNAME=xxx ADMIN_PASSWORD=xxx node scripts/upload-cases.mjs
 *   2. 确认无误后加 --commit 真正执行：
 *        ADMIN_USERNAME=xxx ADMIN_PASSWORD=xxx node scripts/upload-cases.mjs --commit
 *
 * 可选环境变量：
 *   ADMIN_BASE_URL    默认 https://indiacompliance.cn（2026-09-16改：域名和HTTPS配好后，服务器防火墙已经关掉了3000端口，只留80/443，原来那个 IP:3000 的默认值已经连不通）
 *   CASE_SOURCE_DIR   默认 /Users/cora/Documents/印度合规/案例
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = (process.env.ADMIN_BASE_URL || "https://indiacompliance.cn").replace(/\/$/, "");
const SOURCE_DIR = process.env.CASE_SOURCE_DIR || "/Users/cora/Documents/印度合规/案例";
const COMMIT = process.argv.includes("--commit");

const user = process.env.ADMIN_USERNAME;
const pass = process.env.ADMIN_PASSWORD;
if (!user || !pass) {
  console.error("请先设置 ADMIN_USERNAME 和 ADMIN_PASSWORD 环境变量（后台登录用的那对账号密码）。");
  process.exit(1);
}
const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

/**
 * 认证失败要和"这份文件内容有问题"区分开，而且必须立刻停——
 * 2026-09-16 的真实教训：密码没传对，21份文件挨个撞 401，脚本却一条条报"失败"，
 * 最后还总结成"多半是九字段缺了必填项"，把人往改文件的方向带了一圈。
 * 账号密码不对的话，后面每一份都会一样地失败，继续跑没有任何意义。
 */
class AuthError extends Error {}

async function callApi(payload) {
  const response = await fetch(`${BASE_URL}/api/admin/cases`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(payload),
  });

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(
      "管理后台拒绝了这对账号密码（HTTP 401）。\n"
      + "   这不是文件的问题，是 ADMIN_USERNAME / ADMIN_PASSWORD 没对上服务器 .env.local 里配置的那对。\n"
      + "   最常见的原因是密码里有特殊字符（! $ ( ) & ; ' \" 空格等）在命令行里被 shell 吃掉了——\n"
      + "   把密码用单引号包起来再试：ADMIN_PASSWORD='你的密码'",
    );
  }
  if (response.status === 503) {
    throw new AuthError(
      "服务器上还没有配置管理后台的账号密码（HTTP 503）。\n"
      + "   需要在服务器的 site/.env.local 里填好 ADMIN_USERNAME 和 ADMIN_PASSWORD，再 pm2 restart。",
    );
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.message === "string" ? data.message : `HTTP ${response.status}`;
    const errors = Array.isArray(data.errors) && data.errors.length ? `（${data.errors.join("；")}）` : "";
    throw new Error(message + errors);
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`目标服务器：${BASE_URL}`);
  console.log(`本地案例目录：${SOURCE_DIR}`);
  console.log(COMMIT ? "模式：真正执行（--commit），上传即发布，不经过待审核\n" : "模式：预演，不会改动任何数据（不带 --commit）\n");

  const entries = await readdir(SOURCE_DIR);
  const caseFiles = entries
    .filter((name) => /\.(md|txt)$/i.test(name))
    .sort();
  console.log(`本地待上传 ${caseFiles.length} 份案例草稿：`);
  for (const name of caseFiles) console.log(`  - ${name}`);

  if (caseFiles.length === 0) {
    console.log("\n没有找到 .md 或 .txt 文件，检查一下 CASE_SOURCE_DIR 指向的目录对不对。");
    return;
  }

  if (!COMMIT) {
    console.log("\n这是预演结果，没有对线上做任何改动。确认无误后加 --commit 重新运行即可真正执行。");
    return;
  }

  console.log("\n开始上传并发布……");
  const failed = [];
  let published = 0;
  let duplicated = 0;
  for (const name of caseFiles) {
    const fullPath = path.join(SOURCE_DIR, name);
    try {
      const text = await readFile(fullPath, "utf8");
      const staged = await callApi({ action: "stage", fileName: name, text });
      if (staged.duplicate) {
        duplicated += 1;
        console.log(`  ~ ${name} -> docid ${staged.docid} 已存在，复用已有记录《${staged.caseName}》，不重复发布`);
      } else {
        await callApi({ action: "publish", id: staged.id });
        published += 1;
        console.log(`  ✓ ${name} -> 《${staged.caseName}》已发布`);
      }
    } catch (error) {
      // 账号密码不对：立刻停，不要拿同一对错密码把剩下的文件也撞一遍。
      if (error instanceof AuthError) {
        console.log(`\n✗ 已停止，一份都没有上传。\n\n   ${error.message}\n`);
        process.exit(1);
      }
      failed.push(name);
      console.log(`  ✗ ${name} -> ${error.message}`);
    }
    // 给服务器喘口气，也避免一次性甩太多请求。
    await sleep(500);
  }

  console.log(`\n完成：新发布 ${published} 份，${duplicated} 份docid重复已复用，共处理 ${caseFiles.length} 份。`);
  if (failed.length) {
    console.log(`失败 ${failed.length} 份，失败原因见上面每一行末尾（常见是九字段缺了必填项），修好后单独重跑即可：`);
    for (const name of failed) console.log(`  - ${name}`);
  }
  console.log("\n建议现在打开 /admin 的「税务案例库」tab 确认一遍，挑一两条展开核对字段。");
}

main().catch((error) => {
  console.error("脚本执行失败：", error.message);
  process.exit(1);
});
