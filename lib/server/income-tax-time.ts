/**
 * 所得税问题的适用时间解析。
 *
 * 只接受能确定法律版本的时间：具体交易日期优先，其次 FY / AY；模糊的年份或
 * Notice 送达日不冒充交易日期。解析不出来时，由调用方先追问，而不是套当天的法。
 */
export type IncomeTaxTimeSource = "TRANSACTION_DATE" | "FINANCIAL_YEAR" | "ASSESSMENT_YEAR" | "CURRENT";

export interface IncomeTaxTimeResolution {
  targetDate?: string;
  source?: IncomeTaxTimeSource;
}

interface DateMatch {
  index: number;
  text: string;
  date: string;
}

const TRANSACTION_CONTEXT = /交易|付款|支付|付给|收款|取得收入|发生|转让|出售|购入|采购|签约|结算|开票|invoice|transaction|payment|paid|remitted|received|sale|transfer/i;
const CURRENT_CONTEXT = /现在|目前|当前|现行|本财年|本年度|today|currently|current(?:ly)?/i;
const CASE_SEARCH_CONTEXT = /判例|案例|case(?:s)?/i;
const HISTORICAL_CASE_CUTOFF = /(?:20\d{2}\s*年?\s*(?:以前|之前)|before\s+20\d{2})/i;

/**
 * 「找 2026 年以前的案例」限定的是判例的裁判日期，不是在要求对一笔交易
 * 适用某个税法年度。此类问题若仍强制索取 FY，会把用户带入无意义的追问。
 *
 * 范围必须同时满足“找案例”和明确的历史截止年，不能把普通的所得税问题
 * 意外放过时间核验。
 */
export function hasHistoricalCaseCutoff(question: string): boolean {
  return CASE_SEARCH_CONTEXT.test(question) && HISTORICAL_CASE_CUTOFF.test(question);
}

function isoDate(year: number, month: number, day: number): string | undefined {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year
    || value.getUTCMonth() !== month - 1
    || value.getUTCDate() !== day
  ) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function explicitDates(question: string): DateMatch[] {
  const matches: DateMatch[] = [];
  const yearFirstPattern = /(?<!\d)(20\d{2})\s*(?:年|[/.／-])\s*(\d{1,2})\s*(?:月|[/.／-])\s*(\d{1,2})(?:日)?/g;
  for (const match of question.matchAll(yearFirstPattern)) {
    const date = isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date && match.index != null) matches.push({ index: match.index, text: match[0], date });
  }

  // 印度实务里也常见 DD/MM/YYYY。只有“日”大于 12 时才自动换序；10/11/2026
  // 这类日期没有可靠的单一含义，宁可继续追问，也不能静默猜成 10 月或 11 月。
  const unambiguousDayFirstPattern = /(?<!\d)(\d{1,2})\s*[/.／-]\s*(\d{1,2})\s*[/.／-]\s*(20\d{2})(?!\d)/g;
  for (const match of question.matchAll(unambiguousDayFirstPattern)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (day <= 12) continue;
    const date = isoDate(Number(match[3]), month, day);
    if (date && match.index != null) matches.push({ index: match.index, text: match[0], date });
  }
  matches.sort((left, right) => left.index - right.index);
  return matches;
}

function transactionDate(question: string): string | undefined {
  for (const candidate of explicitDates(question)) {
    const start = Math.max(0, candidate.index - 18);
    const end = Math.min(question.length, candidate.index + candidate.text.length + 18);
    if (TRANSACTION_CONTEXT.test(question.slice(start, end))) return candidate.date;
  }
  return undefined;
}

function normalizedStartYear(rawStart: string): number | undefined {
  if (/^20\d{2}$/.test(rawStart)) return Number(rawStart);
  // 仅在 FY/AY 标记已经明确时补全世纪：FY21-22 = FY 2021-22。没有 FY/AY
  // 的“21-22”仍不会走进 period()，因此不会误把普通数字范围当作税期。
  if (/^\d{2}$/.test(rawStart)) return 2000 + Number(rawStart);
  return undefined;
}

function normalizedEndYear(start: number, rawEnd: string): number | undefined {
  const end = rawEnd.length === 2 ? Math.floor(start / 100) * 100 + Number(rawEnd) : Number(rawEnd);
  return end === start + 1 ? end : undefined;
}

function period(question: string, marker: RegExp): { start: number; end: number } | undefined {
  const yearToken = "(20\\d{2}|\\d{2})";
  const prefixes = [
    new RegExp(`${marker.source}\\s*[:：]?\\s*${yearToken}\\s*[-–/]\\s*(\\d{2}|20\\d{2})`, "i"),
    new RegExp(`${yearToken}\\s*[-–/]\\s*(\\d{2}|20\\d{2})\\s*${marker.source}`, "i"),
  ];
  for (const expression of prefixes) {
    const match = expression.exec(question);
    if (!match) continue;
    const start = normalizedStartYear(match[1]);
    if (!start) continue;
    const end = normalizedEndYear(start, match[2]);
    if (end) return { start, end };
  }
  return undefined;
}

/**
 * 用户只给到公历年、月时，按其所在的印度财年处理：4–12 月属于当年开头的 FY，
 * 1–3 月属于上一年开头的 FY。例如 2026年5月 → FY 2026-27，2026年2月 → FY 2025-26。
 *
 * 这条放在具体日期和用户直接写出的 FY/AY 之后：更精确、也更明确的期间始终优先。
 */
function financialYearFromCalendarMonth(question: string): { start: number; end: number } | undefined {
  const pattern = /(?<!\d)(20\d{2})\s*年\s*(\d{1,2})\s*月(?!\s*(?:\d|日))/g;
  for (const match of question.matchAll(pattern)) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) continue;
    const start = month >= 4 ? year : year - 1;
    return { start, end: start + 1 };
  }
  return undefined;
}

/**
 * FY 2024-25 对应 2024-04-01 至 2025-03-31；用于法条适用性时取期间最后一天。
 * AY 2024-25 对应上一财年 FY 2023-24，所以取 2024-03-31。
 */
export function resolveIncomeTaxTime(question: string, today = new Date().toISOString().slice(0, 10)): IncomeTaxTimeResolution {
  const date = transactionDate(question);
  if (date) return { targetDate: date, source: "TRANSACTION_DATE" };

  const financialYear = period(question, /(?:FY|F\.Y\.?|financial\s+year|财(?:政|务)?年(?:度)?)/);
  if (financialYear) return { targetDate: `${financialYear.end}-03-31`, source: "FINANCIAL_YEAR" };

  const assessmentYear = period(question, /(?:AY|A\.Y\.?|assessment\s+year|评(?:估|税)年(?:度)?)/);
  if (assessmentYear) return { targetDate: `${assessmentYear.start}-03-31`, source: "ASSESSMENT_YEAR" };

  const calendarMonthYear = financialYearFromCalendarMonth(question);
  if (calendarMonthYear) {
    return { targetDate: `${calendarMonthYear.end}-03-31`, source: "FINANCIAL_YEAR" };
  }

  if (CURRENT_CONTEXT.test(question)) return { targetDate: today, source: "CURRENT" };
  return {};
}
