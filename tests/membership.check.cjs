/**
 * 会员时长 + 续费提醒的自检（2026-10-12 建）。
 *
 * 单独成文件，理由和 knowledge-store.check.cjs 一样：这里全是异步文件 IO，
 * v14-rules.check.cjs 的 t() 断言助手是同步的，硬塞进去会破坏那边现有的项数。
 *
 * 覆盖的是"钱"和"骚扰"这两件错了没法回滚的事：
 *   ① 一次付款只能加一次时长（支付平台会重复发回调）；
 *   ② 续费从已有有效期往后叠加，不吃掉剩余天数；
 *   ③ 到期提醒 7 天档 / 3 天档各发一次，不重复、也不补发已经过期的档；
 *   ④ 续费之后提醒记账清零（否则下一个周期永远不再提醒）；
 *   ⑤ 已过期的不催；发信失败可重试，到上限停手。
 *
 * 运行前：先跑一遍 v14-rules.check.cjs 文件头注释里的 tsc 编译命令
 * （已把 lib/server/membership-store.ts 加进那条命令的文件列表），产出 .v14build/。
 * 运行：
 *   cp tests/membership.check.cjs .v14build/ && node .v14build/membership.check.cjs
 *
 * 用临时目录当 LOCAL_KNOWLEDGE_DIR，跑完自动清理，不碰真实的会员与账号数据。
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "membership-test-"));
process.env.LOCAL_KNOWLEDGE_DIR = tempDir;

const storePath = path.join(tempDir, "membership-store.json");
const DAY_MS = 24 * 60 * 60 * 1000;

const {
  PLAN_OPTIONS,
  createOrder,
  payOrder,
  getMembership,
  membershipViewOf,
  dueRenewalMilestones,
  claimDueRenewalNotices,
  markRenewalNoticeSent,
  rollbackRenewalNotice,
} = require("./lib/server/membership-store.js");
const { createUser } = require("./lib/server/user-store.js");

let pass = 0;
let failed = false;

async function check(name, fn) {
  try {
    await fn();
    console.log("  ✓", name);
    pass += 1;
  } catch (error) {
    console.log("  ✗", name, "->", error.message);
    failed = true;
  }
}

/** 直接改文件里的 paidThrough——要造"还剩 X 天"的场景只能从这里下手。 */
function setPaidThrough(userId, offsetMs) {
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  const membership = store.memberships.find((item) => item.userId === userId);
  membership.paidThrough = new Date(Date.now() + offsetMs).toISOString();
  fs.writeFileSync(storePath, JSON.stringify(store));
}

async function main() {
  console.log("会员时长与续费提醒自检");

  // ---------- 价格档位 ----------
  await check("三档价格是 1 月 9.9 / 3 月 27 / 12 月 99 元", () => {
    assert.deepEqual(
      PLAN_OPTIONS.map((option) => [option.months, option.priceFen]),
      [[1, 990], [3, 2700], [12, 9900]],
    );
  });

  const user = await createUser({ email: "member@example.com", passwordHash: "x", yearMonth: "2026-10" });
  assert.ok(user, "建测试用户失败");

  await check("档位不存在时拒绝下单（价格只来自服务端）", async () => {
    assert.equal(await createOrder({ userId: user.id, channel: "WECHAT", months: 7 }), null);
  });

  const order = await createOrder({ userId: user.id, channel: "WECHAT", months: 1 });
  assert.ok(order, "下单失败");

  await check("首次回调加时长：1 个月 = 30 天", async () => {
    assert.equal(await payOrder(order.outTradeNo, "wx-123"), true);
    const membership = await getMembership(user.id);
    const expected = Date.now() + 30 * DAY_MS;
    assert.ok(Math.abs(new Date(membership.paidThrough).getTime() - expected) < 5000);
  });

  const paidThroughAfterFirst = (await getMembership(user.id)).paidThrough;

  await check("重复回调返回 false（幂等）", async () => {
    assert.equal(await payOrder(order.outTradeNo, "wx-123"), false);
  });

  await check("重复回调后有效期没变（不会白送一个月）", async () => {
    assert.equal((await getMembership(user.id)).paidThrough, paidThroughAfterFirst);
  });

  await check("会员视图：在有效期内", async () => {
    const view = await membershipViewOf(user.id);
    assert.equal(view.active, true);
    assert.ok(view.daysLeft >= 29);
  });

  // ---------- 续费从已有有效期往后叠加 ----------
  const renew = await createOrder({ userId: user.id, channel: "ALIPAY", months: 3 });
  await payOrder(renew.outTradeNo, "ali-456");

  await check("续费从已有有效期往后叠加，不吃掉剩余天数", async () => {
    const membership = await getMembership(user.id);
    const expected = new Date(paidThroughAfterFirst).getTime() + 90 * DAY_MS;
    assert.ok(Math.abs(new Date(membership.paidThrough).getTime() - expected) < 5000);
  });

  // ---------- 到期提醒的档位判定（纯函数） ----------
  const base = await getMembership(user.id);

  function milestonesIn(days) {
    return dueRenewalMilestones({
      ...base,
      paidThrough: new Date(Date.now() + days * DAY_MS).toISOString(),
    });
  }

  await check("剩 8 天：还没到任何一档", () => {
    assert.deepEqual(milestonesIn(8), []);
  });
  await check("剩 6.5 天：只到 7 天档", () => {
    assert.deepEqual(milestonesIn(6.5), [7]);
  });
  await check("剩 2 天：两档都合格（实际只发最紧迫那一档）", () => {
    assert.deepEqual(milestonesIn(2), [3, 7]);
  });
  await check("已过期：不催", () => {
    assert.deepEqual(milestonesIn(-1), []);
  });
  await check("该档发过就不再发", () => {
    const membership = {
      ...base,
      paidThrough: new Date(Date.now() + 2 * DAY_MS).toISOString(),
      renewalNotices: { "3": new Date().toISOString() },
    };
    assert.deepEqual(dueRenewalMilestones(membership), [7]);
  });

  // ---------- claim：一次只发最紧迫那一档，其余合格档位一并作废 ----------
  setPaidThrough(user.id, 2 * DAY_MS);
  const firstClaim = await claimDueRenewalNotices();

  await check("claim 取最紧迫那一档，并带上收件邮箱", () => {
    assert.equal(firstClaim.length, 1);
    assert.equal(firstClaim[0].milestoneDays, 3);
    assert.equal(firstClaim[0].email, "member@example.com");
    assert.equal(firstClaim[0].daysLeft, 2);
  });

  await markRenewalNoticeSent(user.id);

  await check("发信后两档都记了账：不会隔天补发「还剩 7 天」", async () => {
    const membership = await getMembership(user.id);
    assert.ok(membership.renewalNotices["3"]);
    assert.ok(membership.renewalNotices["7"]);
  });

  await check("同一天再扫：没有待发的", async () => {
    assert.equal((await claimDueRenewalNotices()).length, 0);
  });

  // ---------- 失败可重试，到上限停手 ----------
  await rollbackRenewalNotice(user.id, "SES 失败：测试");

  await check("失败后撤占位、失败计数 +1", async () => {
    const membership = await getMembership(user.id);
    assert.equal(membership.renewalNotices, undefined);
    assert.equal(membership.renewalNoticeAttempts, 1);
    assert.equal(membership.renewalNoticeError, "SES 失败：测试");
  });

  await check("撤占位后能被重新扫到（可重试）", async () => {
    const claim = await claimDueRenewalNotices();
    assert.equal(claim.length, 1);
    assert.equal(claim[0].milestoneDays, 3);
  });

  await rollbackRenewalNotice(user.id, "SES 失败：测试");
  await claimDueRenewalNotices();
  await rollbackRenewalNotice(user.id, "SES 失败：测试");

  await check("连续失败到上限就停手，不再刷接口", async () => {
    assert.equal((await claimDueRenewalNotices()).length, 0);
  });

  // ---------- 续费后提醒记账清零 ----------
  await markRenewalNoticeSent(user.id);
  const third = await createOrder({ userId: user.id, channel: "WECHAT", months: 1 });
  await payOrder(third.outTradeNo, "wx-789");

  await check("续费后提醒记账清零，下一周期会重新提醒", async () => {
    const membership = await getMembership(user.id);
    assert.equal(membership.renewalNotices, undefined);
    assert.equal(membership.renewalNoticeAttempts, undefined);
  });

  // ---------- 已过期的会员不催 ----------
  setPaidThrough(user.id, -DAY_MS);
  await check("已过期会员不进待发队列", async () => {
    assert.equal((await claimDueRenewalNotices()).length, 0);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(failed ? `\n有用例未通过（通过 ${pass} 项）` : `\n全部通过：${pass} 项`);
  process.exit(failed ? 1 : 0);
}

main();
