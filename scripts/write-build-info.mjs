#!/usr/bin/env node
/**
 * 构建前写入版本信息，解决一个反复出现的问题：**「到底部没部上去」说不清。**
 *
 * 真实代价（都发生过）：
 * - 排查导出 PDF 的空白页，来回三轮都卡在"分不清用户手上那份是哪一版样式"；
 * - 后台位阶按钮不显示，我判断是没部署、但只能靠推理，没有证据。
 *
 * 光有"构建时间"不够——**重新构建但没解压新包，时间照样会变**，
 * 那个数字反而会让人误以为新代码上去了。所以写两个值：
 *
 *   buildTime   这次 build 的时刻      → 回答"有没有重新构建"
 *   sourceHash  源码内容的指纹          → 回答"代码到底换没换"
 *
 * 两个一起看才有结论：
 *   时间变了、hash 没变  → 重新构建了，但**代码是旧的**（包没解压对）
 *   时间和 hash 都变了   → 新代码确实上去了
 *   两个都没变           → 压根没重新构建
 *
 * ## 为什么不用 git commit
 *
 * 部署是「打 tar 包 → 服务器解压」，服务器上没有 git 历史，
 * 拿不到 commit。指纹必须能从**服务器上的文件本身**算出来。
 */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 参与指纹计算的目录。**只算源码**，不算 node_modules、构建产物和运行时数据——
 * 那些每次都变，混进来指纹就永远在变，等于没有指纹。
 */
const HASHED_DIRS = ["app", "lib"];
const HASHED_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);
/**
 * **必须排除自己生成的那个文件。**
 *
 * 不排除的话：算 hash → 写文件 → 下次算 hash 时把这个文件也算进去 → hash 变了。
 * 自引用会让指纹**永远不稳定**，而一个每次都变的指纹比没有指纹更糟——
 * 它会让人以为代码变了。
 *
 * 实测发现：连跑两次脚本，文件数 80 → 81、hash 从 e9e07a 变成 f71a04。
 */
const EXCLUDED = new Set([path.join("lib", "build-info.ts")]);

async function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;   // 目录不存在就跳过，不因此让构建失败
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      await collectFiles(full, out);
    } else if (HASHED_EXTENSIONS.has(path.extname(entry.name))
      && !EXCLUDED.has(path.relative(siteRoot, full))) {
      out.push(full);
    }
  }
  return out;
}

async function main() {
  const files = (await Promise.all(HASHED_DIRS.map((dir) => collectFiles(path.join(siteRoot, dir)))))
    .flat()
    // 排序是必须的：readdir 的返回顺序不保证跨平台一致，
    // 不排序的话同一份代码在 Mac 和服务器上会算出不同的 hash。
    .sort();

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(siteRoot, file));
    hash.update(await readFile(file));
  }

  const info = {
    buildTime: new Date().toISOString(),
    sourceHash: hash.digest("hex").slice(0, 12),
    fileCount: files.length,
  };

  // 写成 .ts 而不是 .json：JSON 要靠打包器的 resolveJsonModule，
  // 而这个值要在 Workers 运行时读到，TS 模块最稳。
  const target = path.join(siteRoot, "lib", "build-info.ts");
  await writeFile(target, `/**
 * **这个文件是构建时自动生成的，不要手工改。**
 * 生成脚本：scripts/write-build-info.mjs（由 package.json 的 build 钩子调用）
 *
 * 用途：在 /api/health 和后台页面上显示"当前跑的是哪一版"，
 * 终结"到底部没部上去"这类靠推理的争论。判读方法见生成脚本的注释。
 */
export const BUILD_INFO = ${JSON.stringify(info, null, 2)} as const;
`, "utf8");

  console.log(`build-info: ${info.sourceHash}  (${info.fileCount} 个源文件)  ${info.buildTime}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // 生成失败不能让构建挂掉——版本信息是辅助功能，
    // 为它中断一次部署是本末倒置。写个占位值让构建继续。
    console.error("build-info 生成失败，用占位值继续：", error.message);
    writeFile(
      path.join(siteRoot, "lib", "build-info.ts"),
      `export const BUILD_INFO = { buildTime: "unknown", sourceHash: "unknown", fileCount: 0 } as const;\n`,
      "utf8",
    ).catch(() => undefined);
  });
}
