/**
 * 反馈补回次数规则。《产品规则表 V1.4》§2.2、PR-06、PR-12、PR-13。
 *
 * 要点：
 *  - 原因去除空格后须超过 10 个中文字符，才允许补回 1 次；
 *  - 同一回答最多补回 1 次，重复提交不重复补回；
 *  - 同一账号每自然月最多补回 3 次，达到上限后仍受理反馈但不再补回；
 *  - 连续两个自然月触及上限则冻结补回能力并转人工复核；
 *  - 补回不改变余额数字本身，只生成一条与原扣次流水互相引用的补回流水；
 *  - 补回动作、原因、原扣次流水和操作者必须写入审计日志。
 */

/** 每自然月补回上限。 */
export const MONTHLY_RESTORE_LIMIT = 3;
/** 连续触顶多少个自然月后冻结。 */
export const CONSECUTIVE_MONTHS_TO_FREEZE = 2;
/** 原因的最小有效中文字符数（需“超过”该值）。 */
export const MIN_REASON_CHARS = 10;

export type RestoreDecision =
  | "RESTORED"
  | "REASON_TOO_SHORT"
  | "ALREADY_RESTORED"
  | "NOT_CHARGED"
  | "MONTHLY_LIMIT_REACHED"
  | "RESTORE_FROZEN";

export interface RestoreCounter {
  yearMonth: string;
  restoredCount: number;
  reachedLimitAt?: string;
}

export interface RestoreContext {
  /** 原回答是否真的扣过次。没扣次的回答不存在补回。 */
  originalCharged: boolean;
  /** 该回答此前是否已补回过。 */
  alreadyRestored: boolean;
  /** 账号当前是否处于冻结状态。 */
  frozen: boolean;
  /** 本月计数。 */
  currentMonth: RestoreCounter;
  /** 上一自然月计数，用于判断是否连续触顶。 */
  previousMonth?: RestoreCounter;
}

export interface RestoreResult {
  decision: RestoreDecision;
  restored: boolean;
  /** 处理后的本月计数。 */
  nextCounter: RestoreCounter;
  /** 本次是否应当冻结账号的补回能力。 */
  shouldFreeze: boolean;
  /** 面向用户的固定文案。 */
  userMessage: string;
  /** 写入审计日志的说明。 */
  auditNote: string;
}

/** 取自然月键，格式 YYYY-MM。 */
export function yearMonthOf(date: Date = new Date()) {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

export function previousYearMonth(yearMonth: string) {
  const [year, month] = yearMonth.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return yearMonthOf(date);
}

/**
 * 原因有效性：去除所有空白后统计中文字符数，须“超过” 10 个。
 * 只数中文，避免用标点或英文字母凑长度。
 */
export function countReasonChars(reason: string) {
  const stripped = reason.replace(/\s+/g, "");
  const chinese = stripped.match(/[一-鿿]/g);
  return chinese ? chinese.length : 0;
}

export function isReasonAcceptable(reason: string) {
  return countReasonChars(reason) > MIN_REASON_CHARS;
}

export function evaluateRestore(
  reason: string,
  context: RestoreContext,
  now: Date = new Date(),
): RestoreResult {
  const counter = context.currentMonth;
  const unchanged = { ...counter };

  if (context.frozen) {
    return {
      decision: "RESTORE_FROZEN",
      restored: false,
      nextCounter: unchanged,
      shouldFreeze: false,
      userMessage: "该账号的补回能力已冻结，正在人工复核。反馈仍会受理并记录。",
      auditNote: "补回被拒：账号处于冻结状态。",
    };
  }

  if (!context.originalCharged) {
    return {
      decision: "NOT_CHARGED",
      restored: false,
      nextCounter: unchanged,
      shouldFreeze: false,
      userMessage: "这条回答本身没有扣次，不需要补回。反馈已记录。",
      auditNote: "补回被拒：原回答未扣次。",
    };
  }

  if (context.alreadyRestored) {
    return {
      decision: "ALREADY_RESTORED",
      restored: false,
      nextCounter: unchanged,
      shouldFreeze: false,
      userMessage: "这条回答已经补回过 1 次，不重复补回。反馈已记录。",
      auditNote: "补回被拒：同一回答已补回。",
    };
  }

  if (!isReasonAcceptable(reason)) {
    return {
      decision: "REASON_TOO_SHORT",
      restored: false,
      nextCounter: unchanged,
      shouldFreeze: false,
      userMessage: `请把问题说清楚一些，原因需要超过 ${MIN_REASON_CHARS} 个中文字符。反馈已记录。`,
      auditNote: "补回被拒：原因过短。",
    };
  }

  if (counter.restoredCount >= MONTHLY_RESTORE_LIMIT) {
    // 达到上限后仍受理反馈，但不再补回，页面须明确告知。
    const consecutive = Boolean(context.previousMonth?.reachedLimitAt);
    return {
      decision: "MONTHLY_LIMIT_REACHED",
      restored: false,
      nextCounter: unchanged,
      shouldFreeze: consecutive,
      userMessage: `本月补回次数已达上限（${MONTHLY_RESTORE_LIMIT} 次），本次不再补回。反馈仍会受理并记录。`,
      auditNote: consecutive
        ? `补回被拒：本月已达上限，且上月同样触顶，连续 ${CONSECUTIVE_MONTHS_TO_FREEZE} 个月触顶，触发冻结。`
        : "补回被拒：本月已达上限。",
    };
  }

  const nextCount = counter.restoredCount + 1;
  const reachedLimitNow = nextCount >= MONTHLY_RESTORE_LIMIT;
  const nextCounter: RestoreCounter = {
    yearMonth: counter.yearMonth,
    restoredCount: nextCount,
    reachedLimitAt: reachedLimitNow
      ? counter.reachedLimitAt ?? now.toISOString()
      : counter.reachedLimitAt,
  };

  // 本月刚触顶，且上月也触过顶 → 连续两个自然月，冻结。
  const shouldFreeze = reachedLimitNow && Boolean(context.previousMonth?.reachedLimitAt);

  return {
    decision: "RESTORED",
    restored: true,
    nextCounter,
    shouldFreeze,
    userMessage: `已补回 1 次。本月还可补回 ${Math.max(MONTHLY_RESTORE_LIMIT - nextCount, 0)} 次。`,
    auditNote: shouldFreeze
      ? `补回成功（本月第 ${nextCount} 次）。连续 ${CONSECUTIVE_MONTHS_TO_FREEZE} 个月触顶，触发冻结并转人工复核。`
      : `补回成功（本月第 ${nextCount} 次）。`,
  };
}

/**
 * 补回流水。余额数字不能直接改，
 * 补回只生成一条与原扣次流水互相引用的记录。
 */
export interface RestoreLedgerEntry {
  userId: string;
  requestId: string;
  bucket: string;
  delta: 1;
  reason: "FEEDBACK_RESTORE";
  /** 原扣次流水 ID，双向引用。 */
  originalLedgerId: string;
  operatorUserId: string;
  createdAt: string;
}

export function buildRestoreLedgerEntry(input: {
  userId: string;
  requestId: string;
  bucket: string;
  originalLedgerId: string;
  operatorUserId: string;
  now?: Date;
}): RestoreLedgerEntry {
  return {
    userId: input.userId,
    requestId: input.requestId,
    bucket: input.bucket,
    delta: 1,
    reason: "FEEDBACK_RESTORE",
    originalLedgerId: input.originalLedgerId,
    operatorUserId: input.operatorUserId,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}
