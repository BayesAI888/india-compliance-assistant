#!/usr/bin/env node
/**
 * 定时发信触发器（2026-09-30 建）。由服务器 crontab 每 5 分钟跑一次，
 * 条目由 deploy.sh 的 3b 段自动安装（含 node 的真实路径，不要手抄这里）。
 *
 * 这一层**只负责到点戳一下**：把 /api/cron/reminders 打一次，把结果写进日志，
 * 用退出码告诉 cron 成败。真正的扫库、发信、状态机都在 TS 侧——
 * 逻辑只有一份，不会出现"脚本和接口对同一份 JSON 的理解不一致"。
 *
 * 环境变量从站点目录的 .env.local 读（crontab 的环境里没有那些变量，
 * 而 .env.local 是服务器上本来就有的运维配置）。已有的环境变量优先，不覆盖。
 *
 * 注意：别把 cron 表达式写进块注释——星号紧跟斜杠的那个写法会提前闭合块注释，
 * 表现是文件一运行就报语法错，且报错位置指向注释之后的第一行，很难看出是注释的锅。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

// crontab 条目长这样（node 路径由 deploy.sh 取实际值填入）：
// */5 * * * * cd /home/ubuntu/site && <node> scripts/send-due-reminders.mjs >> /home/ubuntu/reminders-cron.log 2>&1

const SITE_DIR = process.env.REMINDER_SITE_DIR?.trim() || process.cwd();

async function loadEnvFile() {
  try {
    const raw = await readFile(path.join(SITE_DIR, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // 读不到就只用现有环境变量。真正缺 token 会在下面明确报错并退出。
  }
}

await loadEnvFile();

const url = process.env.REMINDER_CRON_URL?.trim() || "https://indiacompliance.cn/api/cron/reminders";
const token = process.env.CRON_TOKEN?.trim();

if (!token) {
  console.error(`[reminders] ${new Date().toISOString()} 缺少 CRON_TOKEN，已跳过（请在 ${path.join(SITE_DIR, ".env.local")} 配置）`);
  process.exit(1);
}

let response;
let text = "";
try {
  response = await fetch(url, {
    method: "POST",
    headers: { "x-cron-token": token, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(60_000),
  });
  text = await response.text();
} catch (error) {
  console.error(`[reminders] ${new Date().toISOString()} 调用 ${url} 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(text);
} catch {
  data = null;
}

if (!response.ok) {
  console.error(`[reminders] ${new Date().toISOString()} HTTP ${response.status}：${text.slice(0, 300)}`);
  process.exit(1);
}

const scanned = data?.scanned ?? 0;
const sent = data?.sent ?? 0;
const failed = data?.failed ?? 0;
console.log(`[reminders] ${new Date().toISOString()} 到期 ${scanned} 条，已发 ${sent} 条，失败 ${failed} 条`);

if (failed > 0) {
  for (const failure of data?.failures ?? []) {
    console.error(`[reminders]   ${failure.id} → ${failure.error}`);
  }
  process.exit(2);
}
