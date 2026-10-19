/**
 * 二维码编码器（2026-10-12 建）。**零依赖、纯函数**，浏览器和服务端都能跑。
 *
 * ## 为什么自己写而不用 qrcode 这类包
 *
 * 微信 Native 支付要把 `code_url` 渲染成二维码给用户扫，这是**付款的唯一入口**——
 * 二维码画错了，用户就付不了钱。引入一个包意味着：服务器上 `pnpm install` 多一批
 * 间接依赖、前端打包多一份体积，而这个算法本身是标准且稳定的（ISO/IEC 18004）。
 * 项目里 SES 签名、微信 V2 签名都是同一个理由自己实现的。
 *
 * ## 实现范围（刻意收窄）
 *
 * - **只做字节模式**（byte mode）：我们要编码的是 URL，字节模式通用且够用，
 *   不做数字/字母数字的容量优化——那是省几个模块的事，却多两条出错路径。
 * - **只做纠错等级 M**（15% 纠错）：扫码付款的场景，M 是行业惯例。
 * - **版本 1–10**：版本 10 + M 能装 214 个字节，微信 code_url 约 55 字符，绰绰有余。
 *
 * 超出这个范围直接抛错，而不是"尽力编一个可能扫不出来的码"。
 *
 * 正确性已用 Python `qrcode` 库（强制相同 mask）逐模块比对验证，见 scripts/verify-qr.mjs。
 */

/** GF(256) 的指数表与对数表，本原多项式 0x11d。 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** RS 生成多项式，系数按降幂排列（result[0] 是最高次项）。 */
function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** 用生成多项式除数据，得到纠错码字。 */
function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i += 1) {
      result[i] ^= gfMultiply(divisor[i], factor);
    }
  }
  return result;
}

/**
 * 版本 1–10 的纠错等级 M 参数表。
 * totalCodewords＝这个版本的总码字数；ecPerBlock＝每个块的纠错码字数；blocks＝块数。
 * 块数 > 1 时数据要**交错**摆放——这是为了把突发错误摊开到不同块里。
 */
const LEVEL_M: Array<{ totalCodewords: number; ecPerBlock: number; blocks: number } | null> = [
  null,
  { totalCodewords: 26, ecPerBlock: 10, blocks: 1 },
  { totalCodewords: 44, ecPerBlock: 16, blocks: 1 },
  { totalCodewords: 70, ecPerBlock: 26, blocks: 1 },
  { totalCodewords: 100, ecPerBlock: 18, blocks: 2 },
  { totalCodewords: 134, ecPerBlock: 24, blocks: 2 },
  { totalCodewords: 172, ecPerBlock: 16, blocks: 4 },
  { totalCodewords: 196, ecPerBlock: 18, blocks: 4 },
  { totalCodewords: 242, ecPerBlock: 22, blocks: 4 },
  { totalCodewords: 292, ecPerBlock: 22, blocks: 5 },
  { totalCodewords: 346, ecPerBlock: 26, blocks: 5 },
];

/** 对齐图案的中心坐标。版本 1 没有。 */
const ALIGNMENT: Array<number[]> = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/** 字节模式下每个版本能装多少字节。 */
function byteCapacityOf(version: number): number {
  const spec = LEVEL_M[version];
  if (!spec) return 0;
  return spec.totalCodewords - spec.ecPerBlock * spec.blocks - 2; // 2 个码字给模式标识和长度
}

function pickVersion(byteLength: number): number {
  for (let version = 1; version <= 10; version += 1) {
    if (byteLength <= byteCapacityOf(version)) return version;
  }
  throw new Error(`内容太长（${byteLength} 字节），超出版本 10 / 等级 M 的容量`);
}

class BitBuffer {
  readonly bits: number[] = [];
  push(value: number, length: number) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }
}

/** 数据码字：模式标识 + 长度 + 内容 + 结束符 + 补齐。 */
function dataCodewords(text: string, version: number): Uint8Array {
  const spec = LEVEL_M[version]!;
  const capacityBits = (spec.totalCodewords - spec.ecPerBlock * spec.blocks) * 8;
  const bytes = new TextEncoder().encode(text);
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // 字节模式
  buffer.push(bytes.length, 8);
  for (const byte of bytes) buffer.push(byte, 8);

  // 结束符最多 4 个 0；装不下就省略（不是错误，容量刚刚好而已）。
  for (let i = 0; i < Math.min(4, capacityBits - buffer.bits.length); i += 1) buffer.push(0, 1);
  while (buffer.bits.length % 8 !== 0) buffer.push(0, 1);

  const codewords: number[] = [];
  for (let i = 0; i < buffer.bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | buffer.bits[i + j];
    codewords.push(value);
  }
  // 固定填充字节 0xEC / 0x11 交替，直到填满。
  for (let pad = 0; codewords.length < capacityBits / 8; pad += 1) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);
  }
  return new Uint8Array(codewords);
}

/** 分块算纠错码，再交错拼成最终码字流。 */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const spec = LEVEL_M[version]!;
  const blockCount = spec.blocks;
  const shortLength = Math.floor(data.length / blockCount);
  const shortBlockCount = blockCount - (data.length % blockCount);
  const divisor = rsDivisor(spec.ecPerBlock);

  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i += 1) {
    const length = shortLength + (i < shortBlockCount ? 0 : 1);
    const block = data.subarray(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    eccBlocks.push(rsRemainder(block, divisor));
  }

  const result: number[] = [];
  const longest = shortLength + (shortBlockCount < blockCount ? 1 : 0);
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of eccBlocks) result.push(block[i]);
  }
  return new Uint8Array(result);
}

export interface QrMatrix {
  /** 每边多少个模块（不含留白）。 */
  size: number;
  /** modules[row][column]，true＝深色。 */
  modules: boolean[][];
  /** 实际选中的掩码（0–7），验证与调试用。 */
  mask: number;
}

function blankMatrix(size: number): { modules: boolean[][]; reserved: boolean[][] } {
  const modules: boolean[][] = [];
  const reserved: boolean[][] = [];
  for (let i = 0; i < size; i += 1) {
    modules.push(new Array<boolean>(size).fill(false));
    reserved.push(new Array<boolean>(size).fill(false));
  }
  return { modules, reserved };
}

/** 画出定位图案、分隔带、时序图案、对齐图案和那个固定的深色模块。 */
function drawFunctionPatterns(modules: boolean[][], reserved: boolean[][], version: number) {
  const size = modules.length;
  const set = (row: number, column: number, dark: boolean) => {
    modules[row][column] = dark;
    reserved[row][column] = true;
  };

  // 时序图案（第 6 行/列，明暗交替）。
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // 三个定位图案：7×7 的同心方框。用"到中心的距离"画，比手写坐标不易错。
  const finderCenters: Array<[number, number]> = [[3, 3], [3, size - 4], [size - 4, 3]];
  for (const [rowCenter, columnCenter] of finderCenters) {
    for (let row = rowCenter - 4; row <= rowCenter + 4; row += 1) {
      for (let column = columnCenter - 4; column <= columnCenter + 4; column += 1) {
        if (row < 0 || row >= size || column < 0 || column >= size) continue;
        const distance = Math.max(Math.abs(row - rowCenter), Math.abs(column - columnCenter));
        set(row, column, distance !== 2 && distance <= 3);
      }
    }
  }

  const coordinates = ALIGNMENT[version];
  for (const row of coordinates) {
    for (const column of coordinates) {
      // 和定位图案重叠的那三个位置不画。
      if ((row === 6 && column === 6) || (row === 6 && column === size - 7) || (row === size - 7 && column === 6)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const distance = Math.max(Math.abs(dr), Math.abs(dc));
          set(row + dr, column + dc, distance !== 1);
        }
      }
    }
  }

  /*
   * 格式信息区先占住，稍后填真实位（15 个位置，分成两份互为备份）。
   * **第 6 行/第 6 列要跳过**：那是时序图案的交叉点，属于时序图案不是格式区——
   * 把它清掉会让时序图案断掉两个模块，整张码直接扫不出来。
   */
  for (let i = 0; i <= 8; i += 1) {
    if (i === 6) continue;
    set(8, i, false);
    set(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    set(8, size - 1 - i, false);
    set(size - 1 - i, 8, false);
  }
  set(size - 8, 8, true); // 固定深色模块

  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(b, a, false);
      set(a, b, false);
    }
  }
}

/** 数据按"从右往左两列一组、蛇形上下"填充，跳过功能区。 */
function drawCodewords(modules: boolean[][], reserved: boolean[][], codewords: Uint8Array) {
  const size = modules.length;
  let bitIndex = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 竖直时序图案那一列要跳过
    for (let step = 0; step < size; step += 1) {
      for (let j = 0; j < 2; j += 1) {
        const column = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - step : step;
        if (reserved[row][column] || bitIndex >= total) continue;
        modules[row][column] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
        bitIndex += 1;
      }
    }
  }
}

const MASKS: Array<(row: number, column: number) => boolean> = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
];

/**
 * 掩码扣分规则（标准四则）。选扣分最少的掩码——
 * 目的是避免画面里出现大片同色、或和定位图案相似的图形，那会让扫码器认错。
 */
function penaltyOf(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;

  // 规则 1：连续同色 ≥5 个模块，每超一个扣 3 分。
  const lineScore = (cells: boolean[]) => {
    let run = 1;
    let total = 0;
    for (let i = 1; i < cells.length; i += 1) {
      if (cells[i] === cells[i - 1]) {
        run += 1;
      } else {
        if (run >= 5) total += run - 2;
        run = 1;
      }
    }
    if (run >= 5) total += run - 2;
    return total;
  };

  for (let row = 0; row < size; row += 1) score += lineScore(modules[row]);
  for (let column = 0; column < size; column += 1) {
    const cells: boolean[] = [];
    for (let row = 0; row < size; row += 1) cells.push(modules[row][column]);
    score += lineScore(cells);
  }

  // 规则 2：2×2 同色块，每块扣 3 分。
  for (let row = 0; row + 1 < size; row += 1) {
    for (let column = 0; column + 1 < size; column += 1) {
      const a = modules[row][column];
      if (a === modules[row][column + 1] && a === modules[row + 1][column] && a === modules[row + 1][column + 1]) {
        score += 3;
      }
    }
  }

  // 规则 3：出现和定位图案相似的 1:1:3:1:1 条纹，每次扣 40 分。正反两个方向都要查。
  const FINDER_LIKE = [true, false, true, true, true, false, true, false, false, false, false];
  const FINDER_REVERSED = [...FINDER_LIKE].reverse();
  const matches = (cells: boolean[], start: number, pattern: boolean[]) =>
    pattern.every((value, index) => cells[start + index] === value);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column + 10 < size; column += 1) {
      if (matches(modules[row], column, FINDER_LIKE)) score += 40;
      if (matches(modules[row], column, FINDER_REVERSED)) score += 40;
    }
  }
  for (let column = 0; column < size; column += 1) {
    const cells: boolean[] = [];
    for (let row = 0; row < size; row += 1) cells.push(modules[row][column]);
    for (let row = 0; row + 10 < size; row += 1) {
      if (matches(cells, row, FINDER_LIKE)) score += 40;
      if (matches(cells, row, FINDER_REVERSED)) score += 40;
    }
  }

  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark += 1;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

function applyMask(modules: boolean[][], reserved: boolean[][], mask: number) {
  const size = modules.length;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (!reserved[row][column] && MASKS[mask](row, column)) modules[row][column] = !modules[row][column];
    }
  }
}

function drawFormatBits(modules: boolean[][], mask: number) {
  const size = modules.length;
  const data = 0b00 << 3 | mask; // 纠错等级 M 的编码是 0b00
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = (index: number) => ((bits >>> index) & 1) !== 0;

  for (let i = 0; i <= 5; i += 1) modules[i][8] = bit(i);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i < 15; i += 1) modules[8][14 - i] = bit(i);

  for (let i = 0; i < 8; i += 1) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i += 1) modules[size - 15 + i][8] = bit(i);
  modules[size - 8][8] = true;
}

function drawVersionBits(modules: boolean[][], version: number) {
  if (version < 7) return;
  const size = modules.length;
  let remainder = version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ (((remainder >>> 11) & 1) * 0x1f25);
  const bits = (version << 12) | remainder;
  for (let i = 0; i < 18; i += 1) {
    const bit = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b][a] = bit;
    modules[a][b] = bit;
  }
}

/** 把文本编成二维码模块矩阵。 */
export function encodeQr(text: string): QrMatrix {
  const version = pickVersion(new TextEncoder().encode(text).length);
  const size = version * 4 + 17;
  const { modules, reserved } = blankMatrix(size);
  drawFunctionPatterns(modules, reserved, version);
  drawCodewords(modules, reserved, interleave(dataCodewords(text, version), version));

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row) => row.slice());
    applyMask(candidate, reserved, mask);
    drawFormatBits(candidate, mask);
    drawVersionBits(candidate, version);
    const penalty = penaltyOf(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
  }
  applyMask(modules, reserved, bestMask);
  drawFormatBits(modules, bestMask);
  drawVersionBits(modules, version);
  return { size, modules, mask: bestMask };
}

/**
 * 把模块矩阵转成一条 SVG path，前端直接渲染。
 * 每个深色模块画成 1×1 的方块，用 path 而不是几十个 <rect>——DOM 节点少两个数量级。
 */
export function qrSvgPath(matrix: QrMatrix, margin = 4): { viewBox: string; path: string } {
  const total = matrix.size + margin * 2;
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (!matrix.modules[row][column]) continue;
      parts.push(`M${column + margin} ${row + margin}h1v1h-1z`);
    }
  }
  return { viewBox: `0 0 ${total} ${total}`, path: parts.join("") };
}
