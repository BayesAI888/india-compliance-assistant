/**
 * 只创建问答运营审计表，不触碰现有 JSON 用户/会员/附件数据。
 *
 * 用法（在服务器 site 目录）：
 *   DATABASE_URL='postgres://...' pnpm db:audit-migrate
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

/**
 * 迁移脚本由 Node 直接执行，不能依赖 Next/Vinext 在启动时才会加载的环境变量包。
 * 只解析本脚本需要的 DATABASE_URL，支持普通、单引号、双引号和 `export KEY=...` 写法；
 * shell 里已提供的变量优先，避免覆盖运维临时注入的连接串。
 */
async function databaseUrlFromEnvironment() {
  const direct = process.env.DATABASE_URL?.trim();
  if (direct) return direct;

  const envPath = path.join(process.cwd(), ".env.local");
  let source = "";
  try {
    source = await readFile(envPath, "utf8");
  } catch (error) {
    if ((error).code === "ENOENT") return undefined;
    throw error;
  }

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const value = match[1];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1).trim();
    }
    return value.trim();
  }
  return undefined;
}

const url = await databaseUrlFromEnvironment();
if (!url) {
  console.log("未配置 DATABASE_URL，跳过问答运营审计表迁移（将继续使用受限权限的本地审计文件）。");
  process.exit(0);
}

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 10 });
const migrationPath = path.join(process.cwd(), "drizzle", "0002_question_audit_records.sql");

try {
  const source = await readFile(migrationPath, "utf8");
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await sql.unsafe(statement);
  console.log("✓ question_audit_records 已就绪。");
} finally {
  await sql.end({ timeout: 5 });
}
