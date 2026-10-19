/**
 * 回复截止日归一化（normalizeReplyDeadline）的自检（2026-10-13 建）。
 *
 * 跑法和 membership.check.cjs 一样：先 tsc 编译到 .v14build 再跑——
 *   cd site && /path/to/tsc lib/server/notice-extract.ts --rootDir . --outDir .v14build \
 *     --module commonjs --moduleResolution node --target es2022 --esModuleInterop --skipLibCheck
 *   echo '{"type":"commonjs"}' > .v14build/package.json
 *   cp tests/deadline-normalize.check.cjs .v14build/ && node .v14build/deadline-normalize.check.cjs
 *
 * 这个函数喂的是"红色提示行"上的日期——错了用户就会在错误的日子收到提醒、
 * 或者以为还有时间其实已经过期，所以边界行为必须钉死：
 *   ① 印度 DD/MM/YYYY 数值写法（含 . - 分隔）；
 *   ② ISO YYYY-MM-DD；
 *   ③ 英文月份全词/缩写、"30th September, 2026" / "September 30, 2026" 两种顺序；
 *   ④ 相对期限（"within 30 days"）、两位年份、越界月份 → 一律 null（宁缺勿错）；
 *   ⑤ DD/MM 与 MM/DD 歧义时按印度惯例取 DD/MM。
 */

const { normalizeReplyDeadline } = require("./lib/server/notice-extract.js");

const cases = [
  ["30/09/2026", "2026-09-30"],
  ["2026-09-30", "2026-09-30"],
  ["30.09.2026", "2026-09-30"],
  ["30-09-2026", "2026-09-30"],
  ["30th September, 2026", "2026-09-30"],
  ["September 30, 2026", "2026-09-30"],
  ["30 Sep 2026", "2026-09-30"],
  ["15/10/2026", "2026-10-15"],
  ["05/04/2027", "2027-04-05"],
  ["within 30 days of service", null],
  ["", null],
  [undefined, null],
  ["32/13/2026", null],
  ["30/09/26", null],
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = normalizeReplyDeadline(input);
  const pass = got === expected;
  if (!pass) failed += 1;
  console.log((pass ? "  ✓ " : "  ✗ ") + JSON.stringify(input) + " → " + got + "（期望 " + expected + "）");
}
console.log(failed === 0 ? "全部通过：14 项" : failed + " 项失败");
process.exit(failed === 0 ? 0 : 1);
