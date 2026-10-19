#!/usr/bin/env node
/**
 * 批量上传知识库资料到线上后台，并按需先把现有资料全部下架。
 *
 * 起因：用户整理好了一批"_for_kb.txt"格式的法律资料，想整批替换掉线上现有的知识库。
 * 后台本身只有单份上传的界面（/admin 一次传一个txt），这个脚本把"下架现有全部
 * → 逐个上传发布新资料"这个流程自动化，跑在你自己的电脑上，密码只在你本地输入，
 * 不会发给任何人（包括我）。
 *
 * 下架用的是软删除（withdrawKnowledgeDocument），正文和Chunk都还在，
 * 总览里随时能看到、也能一键恢复——不是真的删库，出问题可以退回去。
 *
 * 用法：
 *   1. 先跑一次不带 --commit 的，看看会操作哪些东西，确认没问题：
 *        ADMIN_USERNAME=xxx ADMIN_PASSWORD=xxx node scripts/upload-knowledge-base.mjs
 *   2. 确认无误后加 --commit 真正执行：
 *        ADMIN_USERNAME=xxx ADMIN_PASSWORD=xxx node scripts/upload-knowledge-base.mjs --commit
 *
 * 可选环境变量：
 *   ADMIN_BASE_URL   默认 https://indiacompliance.cn（2026-09-16改：域名和HTTPS配好后，服务器防火墙已经关掉了3000端口，只留80/443，原来那个 IP:3000 的默认值已经连不通）
 *   KB_SOURCE_DIR    默认 /Users/cora/Documents/印度合规/txt
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = (process.env.ADMIN_BASE_URL || "https://indiacompliance.cn").replace(/\/$/, "");
const SOURCE_DIR = process.env.KB_SOURCE_DIR || "/Users/cora/Documents/印度合规/txt";
const COMMIT = process.argv.includes("--commit");

const user = process.env.ADMIN_USERNAME;
const pass = process.env.ADMIN_PASSWORD;
if (!user || !pass) {
  console.error("请先设置 ADMIN_USERNAME 和 ADMIN_PASSWORD 环境变量（后台登录用的那对账号密码）。");
  process.exit(1);
}
const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

async function callApi(payload) {
  const response = await fetch(`${BASE_URL}/api/admin/knowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.message === "string" ? data.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function getOverview() {
  const response = await fetch(`${BASE_URL}/api/admin/knowledge?view=overview`, {
    headers: { Authorization: authHeader },
  });
  if (!response.ok) throw new Error(`获取现有知识库总览失败：HTTP ${response.status}`);
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`目标服务器：${BASE_URL}`);
  console.log(`本地资料目录：${SOURCE_DIR}`);
  console.log(COMMIT ? "模式：真正执行（--commit）\n" : "模式：预演，不会改动任何数据（不带 --commit）\n");

  // 第一步：看线上现在有什么。
  const overview = await getOverview();
  const documents = overview.documents ?? [];
  const toWithdraw = documents.filter((doc) => doc.status !== "WITHDRAWN");
  console.log(`线上现有资料 ${documents.length} 份，其中 ${toWithdraw.length} 份不是"已下架"状态：`);
  for (const doc of toWithdraw) {
    console.log(`  - [${doc.status}] ${doc.fileName}`);
  }

  // 第二步：本地要上传哪些txt。
  const entries = await readdir(SOURCE_DIR);
  const txtFiles = entries.filter((name) => name.toLowerCase().endsWith(".txt")).sort();
  console.log(`\n本地待上传 ${txtFiles.length} 份txt：`);
  for (const name of txtFiles) console.log(`  - ${name}`);

  if (!COMMIT) {
    console.log("\n这是预演结果，没有对线上做任何改动。确认无误后加 --commit 重新运行即可真正执行。");
    return;
  }

  // 第三步：先把现有资料全部下架（软删除，随时能在总览里恢复）。
  console.log("\n开始下架现有资料……");
  for (const doc of toWithdraw) {
    try {
      await callApi({ action: "withdraw", documentId: doc.id });
      console.log(`  ✓ 已下架：${doc.fileName}`);
    } catch (error) {
      console.log(`  ✗ 下架失败：${doc.fileName} -> ${error.message}`);
    }
    await sleep(200);
  }

  // 第四步：逐个上传并发布新资料。stage 失败（格式校验不通过）会打印具体原因，
  // 不会中断整个批次——一份文件的问题不该拖累其它 49 份。
  console.log("\n开始上传并发布新资料……");
  const failed = [];
  let published = 0;
  for (const name of txtFiles) {
    const fullPath = path.join(SOURCE_DIR, name);
    try {
      const text = await readFile(fullPath, "utf8");
      const staged = await callApi({ action: "stage", fileName: name, text });
      await callApi({ action: "publish", documentId: staged.documentId });
      published += 1;
      console.log(`  ✓ ${name}（${staged.chunkCount} 个Chunk${staged.duplicate ? "，内容与已有资料重复，已复用" : ""}）`);
    } catch (error) {
      failed.push(name);
      console.log(`  ✗ ${name} -> ${error.message}`);
    }
    // 给服务器喘口气：发布会触发向量生成，连续甩50个大文件容易把单核小机器打满。
    await sleep(800);
  }

  console.log(`\n完成：成功发布 ${published}/${txtFiles.length} 份。`);
  if (failed.length) {
    console.log(`失败 ${failed.length} 份，需要单独重跑或去后台手动检查：`);
    for (const name of failed) console.log(`  - ${name}`);
  }
  console.log("\n建议现在打开 /admin 总览页确认一遍，再挑一两个问题实测验证。");
}

main().catch((error) => {
  console.error("脚本执行失败：", error.message);
  process.exit(1);
});
