/**
 * 阿拉伯数字与英文基数词之间的确定性转换。
 *
 * 印度法规常把期限写成 "one hundred and eighty-two days"，而中文回答自然会写成
 * "182天"。维护一张零散的数字对照表，必然会漏掉某个数（线上已经漏过 182），
 * 所以这里统一生成 0–9,999 的英文写法，供核验和补充检索共用。
 *
 * 不依赖模型；无法转换的值直接返回空数组，调用方仍会保守地保留警示。
 */

const UNDER_TWENTY = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen",
] as const;

const TENS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
] as const;

function underOneHundred(value: number): string {
  if (value < 20) return UNDER_TWENTY[value];
  const tens = TENS[Math.floor(value / 10)];
  const remainder = value % 10;
  return remainder === 0 ? tens : `${tens}-${UNDER_TWENTY[remainder]}`;
}

function underOneThousand(value: number): string {
  if (value < 100) return underOneHundred(value);
  const hundreds = `${UNDER_TWENTY[Math.floor(value / 100)]} hundred`;
  const remainder = value % 100;
  return remainder === 0 ? hundreds : `${hundreds} and ${underOneHundred(remainder)}`;
}

/** 将 0–9,999 的整数转为英式法规中常见的英文基数词。 */
export function toEnglishCardinal(value: number): string | undefined {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9999) return undefined;
  if (value < 1000) return underOneThousand(value);

  const thousands = `${UNDER_TWENTY[Math.floor(value / 1000)]} thousand`;
  const remainder = value % 1000;
  if (remainder === 0) return thousands;
  // 英式立法文本通常保留 thousand 后的 and，例如 "one thousand and twenty days"。
  return remainder < 100
    ? `${thousands} and ${underOneThousand(remainder)}`
    : `${thousands} ${underOneThousand(remainder)}`;
}

/**
 * 同一个数在 PDF 中可能有连字符、空格，或省略英式 and。全部给出，避免把纯排版差异
 * 误报成无依据。
 */
export function englishCardinalVariants(value: number): string[] {
  const cardinal = toEnglishCardinal(value);
  if (!cardinal) return [];
  return [...new Set([
    cardinal,
    cardinal.replace(/-/g, " "),
    cardinal.replace(/\s+and\s+/g, " "),
    cardinal.replace(/\s+and\s+/g, " ").replace(/-/g, " "),
  ])];
}
