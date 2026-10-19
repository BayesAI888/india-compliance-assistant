/**
 * 游客试用次数的**服务端**计数。
 *
 * ## 起因：一个 P0 业务漏洞
 *
 * 2026-09-18 用户实测：不带 Cookie 直连 `/api/chat`，**每次请求都拿到全新的试用额度**，
 * 6 线程并发跑完了 100 题验收——付费墙形同虚设，5 行脚本就能刷穿。
 *
 * 根因在设计上：游客额度**只存在 Cookie 里**（`ic_trial=已用次数`）。
 * 服务端拿不到 Cookie 就当"这是个新访客"。可"拿不到 Cookie"有两种可能：
 *
 * 1. 真的是第一次来 —— 应该给试用额度
 * 2. **脚本根本不发 Cookie** —— 不该给
 *
 * 服务端分不出这两种，而旧代码默认按第 1 种处理。
 * 只要计数的唯一副本在客户端手上，客户端就随时可以把它清零。
 * **凡是要拦住人的计数，必须有一份服务端说了算的副本。**
 *
 * ## 这一版怎么做
 *
 * 两把锁，**任意一把到上限就拦**：
 *
 * - **Cookie 锁**（原有）：每个浏览器 1 次。清了 Cookie 能重来——这本来就不是风控，
 *   只是"同一个人别反复白嫖"的软约束。
 * - **IP 锁**（这个文件）：每个 IP 每天 `ANONYMOUS_IP_DAILY_LIMIT` 次，记在服务端。
 *   脚本不发 Cookie 也躲不开它。
 *
 * ## 为什么 IP 锁要按天、而且比 Cookie 锁松
 *
 * 公司、学校、手机基站后面是**共享出口 IP**：一栋楼几百人共用一个地址。
 * 如果 IP 锁也是 1 次，办公室里第一个人试用完，全公司都用不了了——
 * 为了堵脚本把真实用户拒之门外，这笔账划不来。
 *
 * 所以 IP 锁定在一个"一个人试不完、一个脚本刷不动"的中间值，并且**按天滚动**。
 * 它不是精确的身份识别，是**把刷量的成本从零提到不划算**——
 * 真要防死得靠实名，而不是靠 IP。这一点如实写在这里，别让人以为它是铁闸。
 *
 * ## 隐私
 *
 * **不存 IP 原文**，只存 `SHA-256(IP + 服务端密钥)`。
 * 和会话令牌只存哈希是同一个口径：库被人拖走，也拿不到访客的 IP 列表。
 * 密钥缺省时退回一个固定盐值——那样哈希仍然不可读，只是失去了跨库不可关联性，
 * 对这个用途够用，但生产环境应该配 `ANONYMOUS_TRIAL_SALT`。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 每个 IP 每天能试问几次。
 *
 * 比 Cookie 那把锁（1 次）松，原因见文件头：共享出口 IP 太常见，
 * 卡死了会误伤整栋楼的真实用户。
 */
export const ANONYMOUS_IP_DAILY_LIMIT =
  Number(process.env.ANONYMOUS_IP_DAILY_LIMIT?.trim()) || 5;

/** 计数保留几天。过期的记录直接丢掉，这个文件不该无限长大。 */
const RETENTION_DAYS = 7;

interface TrialRecord {
  /** SHA-256(IP + 盐)，不存 IP 原文。 */
  clientHash: string;
  /** 哪一天，YYYY-MM-DD（服务器本地时区）。 */
  day: string;
  used: number;
}

interface TrialStoreFile {
  schemaVersion: "1.0";
  records: TrialRecord[];
}

const dataDirectory = process.env.LOCAL_USER_DIR?.trim()
  || process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "anonymous-trial-store.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

function emptyStore(): TrialStoreFile {
  return { schemaVersion: "1.0", records: [] };
}

async function readStore(): Promise<TrialStoreFile> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as TrialStoreFile;
    return Array.isArray(parsed.records) ? { ...emptyStore(), ...parsed } : emptyStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(store: TrialStoreFile) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, storePath);
}

/**
 * 串行化写入。**这一条是这次修复的关键**：用户是用 6 线程并发打进来的，
 * 读-改-写不串起来的话，六个请求会同时读到 used=0、同时写回 used=1，
 * 计数器等于没有。和 user-store 用的是同一套队列写法。
 */
function serializedMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** 今天是哪一天，YYYY-MM-DD。 */
export function currentDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
    + `-${String(date.getDate()).padStart(2, "0")}`;
}

/** 纯函数：把过期记录清掉。导出供单测。 */
export function pruneOldRecords(records: TrialRecord[], now = new Date()): TrialRecord[] {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffDay = currentDay(cutoff);
  return records.filter((record) => record.day >= cutoffDay);
}

/**
 * 把客户端标识哈希掉。
 *
 * 纯函数，导出供单测——**要能验证"同一个 IP 得到同一个哈希、不同 IP 不同哈希、
 * 而且哈希里读不出 IP"**，这三件事光看代码是看不出来的。
 */
export function hashClientId(clientId: string): string {
  const salt = process.env.ANONYMOUS_TRIAL_SALT?.trim() || "india-compliance-anonymous-trial";
  return createHash("sha256").update(`${clientId}|${salt}`).digest("hex");
}

/** 查这个客户端今天已经试问了几次（不写）。 */
export async function getIpTrialUsed(clientId: string, day = currentDay()): Promise<number> {
  if (!clientId) return 0;
  const hash = hashClientId(clientId);
  const store = await readStore();
  return store.records.find((record) => record.clientHash === hash && record.day === day)?.used ?? 0;
}

/**
 * 计数 +1，返回加完之后的值。
 *
 * 和 `consumeQuota` 一样放在**产生了要计费的回答之后**才调用——
 * 拒答、超范围、追问免费的那些轮次不该消耗试用次数。
 */
export async function recordIpTrial(clientId: string, day = currentDay()): Promise<number> {
  if (!clientId) return 0;
  const hash = hashClientId(clientId);
  return serializedMutation(async () => {
    const store = await readStore();
    store.records = pruneOldRecords(store.records);
    const existing = store.records.find((record) => record.clientHash === hash && record.day === day);
    if (existing) {
      existing.used += 1;
      await writeStore(store);
      return existing.used;
    }
    store.records.push({ clientHash: hash, day, used: 1 });
    await writeStore(store);
    return 1;
  });
}

/**
 * 从请求头里取客户端 IP。
 *
 * ⚠️ **这个值的可信度完全取决于 nginx 有没有正确设置 `X-Forwarded-For`。**
 * 没设的话所有请求都显示成 127.0.0.1，IP 锁会退化成"全站共用一个计数器"——
 * 那比没有还糟（所有真实游客互相挤掉对方的试用额度）。
 * 部署手册里写了怎么确认，`isTrustworthyClientIp` 就是用来在代码里也能察觉这件事的。
 *
 * 取 `X-Forwarded-For` 的**第一段**：那是最初的客户端地址，后面几段是各级代理。
 * 客户端可以伪造这个头，但请求要经过我们自己的 nginx，nginx 会把真实来源
 * 追加在最后并覆写——所以在"nginx 配置正确"的前提下第一段是可信的。
 */
export function clientIpFrom(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("cf-connecting-ip")?.trim()
    || headers.get("x-real-ip")?.trim()
    || "";
}

/**
 * 这个 IP 值是不是"能用来计数"的。
 *
 * 本机回环和空值说明**代理头没配对**，此时 IP 锁必须**整体让开**——
 * 宁可退回到只有 Cookie 那把锁（等于修复前的状态），
 * 也不能把所有访客算进同一个计数器，让第 6 个访客莫名其妙被拒。
 */
export function isTrustworthyClientIp(ip: string): boolean {
  if (!ip) return false;
  return ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1";
}
