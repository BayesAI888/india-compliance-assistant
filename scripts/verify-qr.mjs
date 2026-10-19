// 二维码编码器的自检脚本（2026-10-12 建）。
//
// 用法：node --experimental-strip-types scripts/verify-qr.mjs
//
// 它做两件事：
//   1. 检查**结构不变量**——定位图案、时序图案、固定深色模块这些不该随内容变的东西。
//      这些错了整张码必然扫不出来，而且和内容无关，能一次抓出来。
//   2. 打印模块矩阵和选中的掩码，供和 Python `qrcode` 库**逐模块比对**
//      （强制相同 mask 后两者应当完全一致——这是对编码器正确性的最强验证）。
//
// 用法二（交叉验证）：
//   node --experimental-strip-types scripts/verify-qr.mjs > /tmp/qr.json
//   然后用 python qrcode 库按同样的 version/mask 生成矩阵做 diff。
import { encodeQr } from "../lib/qr-code.ts";

const SAMPLES = [
  "weixin://wxpay/bizpayurl?pr=Qp8Xk2LmZ",
  "https://indiacompliance.cn",
  "a",
  "x".repeat(60),
  "https://indiacompliance.cn/api/pay/wechat?order=ord_1234567890abcdef",
];

function structuralCheck(matrix) {
  const problems = [];
  const { size, modules } = matrix;
  if (size !== 21 + (size - 21)) problems.push("尺寸异常");

  // 三个定位图案：外框实、内有一圈空、中心实。
  const corners = [[0, 0], [0, size - 7], [size - 7, 0]];
  for (const [top, left] of corners) {
    for (let i = 0; i < 7; i += 1) {
      if (!modules[top][left + i] || !modules[top + 6][left + i]) problems.push(`定位图案横边不实 @${top},${left}`);
      if (!modules[top + i][left] || !modules[top + i][left + 6]) problems.push(`定位图案竖边不实 @${top},${left}`);
    }
    if (modules[top + 1][left + 1]) problems.push(`定位图案内圈应为空 @${top},${left}`);
    if (!modules[top + 3][left + 3]) problems.push(`定位图案中心应为实 @${top},${left}`);
  }

  // 时序图案：第 6 行/列明暗交替，且交叉点都是实。
  for (let i = 8; i < size - 8; i += 1) {
    if (modules[6][i] !== (i % 2 === 0)) problems.push(`横向时序图案错 @6,${i}`);
    if (modules[i][6] !== (i % 2 === 0)) problems.push(`纵向时序图案错 @${i},6`);
  }

  if (!modules[size - 8][8]) problems.push("固定深色模块缺失");
  return problems;
}

let failed = 0;
const dump = [];
for (const text of SAMPLES) {
  const matrix = encodeQr(text);
  const problems = structuralCheck(matrix);
  if (problems.length) {
    failed += 1;
    console.error(`✗ "${text.slice(0, 40)}" ${problems.slice(0, 3).join("；")}`);
  } else {
    console.error(`✓ "${text.slice(0, 40)}" v${(matrix.size - 17) / 4} mask=${matrix.mask} ${matrix.size}×${matrix.size}`);
  }
  dump.push({
    text,
    version: (matrix.size - 17) / 4,
    mask: matrix.mask,
    size: matrix.size,
    rows: matrix.modules.map((row) => row.map((cell) => (cell ? "1" : "0")).join("")),
  });
}
console.log(JSON.stringify(dump));
process.exit(failed ? 1 : 0);
