/**
 * 知识库巡检规则。《知识库数据规范 V1.4》§11。
 *
 * 本文件只放纯规则，不碰存储，便于单测。
 * 两条线必须同时运行：
 *  - 文件线：比对 anchor_url 上的版本指纹，能发现本文件出新版本；
 *    发现不了「文件本身没变、被另一份文件从外部修订」。
 *  - 领域线：人工看官方发布渠道，专门抓上面那一类。
 *    Press Note 3 (2020) 的 PDF 与链接均未变，是 Press Note 2 (2026 Series) 从外部将其修订。
 */

export type InspectionTier = "A" | "B" | "C" | "D" | "E";
export type InspectionLine = "FILE" | "DOMAIN";

/** §11.1 分层巡检周期（天）。D 档事件驱动，不设固定周期。 */
export const TIER_INTERVAL_DAYS: Record<InspectionTier, number | null> = {
  A: 30,
  B: 90,
  C: 180,
  D: null,
  E: 365,
};

export const TIER_LABEL: Record<InspectionTier, string> = {
  A: "A 高频：Press Note、Notification、Circular、FDI Policy、DGFT 通知",
  B: "B 中频：Rules、Regulations、Master Direction",
  C: "C 低频：Act 等成文法",
  D: "D 事件驱动：法院判决，由复议、推翻或后续修法触发",
  E: "E 极稳定：税收协定及议定书",
};

/** 链接可访问性巡检周期，与法律现行性核验相互独立，不得互相替代。 */
export const LINK_CHECK_INTERVAL_DAYS = 30;

export interface InspectableDocument {
  id: string;
  title: string;
  inspectionTier: InspectionTier;
  /** 法律现行性最近核验时间（ISO）。缺失表示从未核验。 */
  legalCurrencyCheckedAt?: string;
  /** 链接可访问性最近核验时间（ISO）。 */
  linkCheckedAt?: string;
  legalStatus: string;
  /** 官方“最新版本锚点页”。 */
  anchorUrl?: string;
  /** 上次记录的版本标识。 */
  versionFingerprint?: string;
  /** 领域线要盯的官方发布渠道。 */
  domainWatchChannel?: string;
  /** 被哪一份新资料取代。 */
  supersededBySourceId?: string;
  domain?: string;
}

function addDays(iso: string, days: number) {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

/**
 * §11.3 财年锚点：每年 2 月（预算案）和 4 月（新财年 + Finance Act 生效）
 * 各做一次全库强制复核，优先于分层周期，不因某来源刚核验过而跳过。
 */
export function latestFiscalAnchor(now: Date): Date {
  const year = now.getUTCFullYear();
  const april = new Date(Date.UTC(year, 3, 1));
  const february = new Date(Date.UTC(year, 1, 1));
  if (now >= april) return april;
  if (now >= february) return february;
  // 1 月：上一年度的 4 月锚点仍是最近一次。
  return new Date(Date.UTC(year - 1, 3, 1));
}

export type DueReason = "NEVER_CHECKED" | "TIER_INTERVAL" | "FISCAL_ANCHOR";

export interface CurrencyDueResult {
  due: boolean;
  reason?: DueReason;
  /** 分层周期下的下次到期时间；D 档为 undefined。 */
  nextDueAt?: string;
}

/** 法律现行性是否到期。D 档不按时间到期，但仍受财年锚点约束。 */
export function evaluateCurrencyDue(
  document: InspectableDocument,
  now: Date = new Date(),
): CurrencyDueResult {
  const checkedAt = document.legalCurrencyCheckedAt;
  if (!checkedAt) return { due: true, reason: "NEVER_CHECKED" };

  const checked = new Date(checkedAt);
  const anchor = latestFiscalAnchor(now);
  if (checked < anchor) {
    return { due: true, reason: "FISCAL_ANCHOR" };
  }

  const interval = TIER_INTERVAL_DAYS[document.inspectionTier];
  if (interval === null) return { due: false };

  const nextDue = addDays(checkedAt, interval);
  if (now >= nextDue) {
    return { due: true, reason: "TIER_INTERVAL", nextDueAt: nextDue.toISOString() };
  }
  return { due: false, nextDueAt: nextDue.toISOString() };
}

/** 链接巡检是否到期。只证明链接能打开，不能顶替法律现行性核验。 */
export function isLinkCheckDue(
  document: InspectableDocument,
  now: Date = new Date(),
) {
  if (!document.linkCheckedAt) return true;
  return now >= addDays(document.linkCheckedAt, LINK_CHECK_INTERVAL_DAYS);
}

/**
 * 超期即置为 CURRENCY_EXPIRED：可召回用于发现问题，
 * 但不得单独支持确定结论，回答状态最高为需要补充信息。
 */
export function isCurrencyExpired(
  document: InspectableDocument,
  now: Date = new Date(),
) {
  if (document.legalStatus !== "PUBLISHED" && document.legalStatus !== "EFFECTIVE") {
    return false;
  }
  return evaluateCurrencyDue(document, now).due;
}

export interface FileLineInput {
  document: InspectableDocument;
  /** 本次从 anchorUrl 抓到的版本标识。抓取失败传 undefined。 */
  observedFingerprint?: string;
}

export interface FileLineOutcome {
  documentId: string;
  changeDetected: boolean;
  conclusion:
    | "NO_CHANGE_AUTO_ADVANCED"
    | "CHANGE_NEEDS_REVIEW"
    | "NO_ANCHOR_CONFIGURED"
    | "FETCH_FAILED";
  fingerprintBefore?: string;
  fingerprintAfter?: string;
  /** 是否可以自动推进 legalCurrencyCheckedAt。有变化时必须人工判断。 */
  canAutoAdvance: boolean;
  message: string;
}

/** 文件线：无变化自动推进核验时间并写审计；有变化才推给管理员。 */
export function runFileLine(input: FileLineInput): FileLineOutcome {
  const { document, observedFingerprint } = input;
  const before = document.versionFingerprint;

  if (!document.anchorUrl) {
    return {
      documentId: document.id,
      changeDetected: false,
      conclusion: "NO_ANCHOR_CONFIGURED",
      fingerprintBefore: before,
      canAutoAdvance: false,
      message: "未配置版本锚点页，无法做文件线比对。请先补 anchor_url。",
    };
  }

  if (observedFingerprint === undefined) {
    return {
      documentId: document.id,
      changeDetected: false,
      conclusion: "FETCH_FAILED",
      fingerprintBefore: before,
      canAutoAdvance: false,
      message: "锚点页抓取失败。抓取失败不等于法律未变，不得据此推进核验时间。",
    };
  }

  if (before && before === observedFingerprint) {
    return {
      documentId: document.id,
      changeDetected: false,
      conclusion: "NO_CHANGE_AUTO_ADVANCED",
      fingerprintBefore: before,
      fingerprintAfter: observedFingerprint,
      canAutoAdvance: true,
      message: "版本标识未变，自动推进法律现行性核验时间并写入审计日志。",
    };
  }

  return {
    documentId: document.id,
    changeDetected: true,
    conclusion: "CHANGE_NEEDS_REVIEW",
    fingerprintBefore: before,
    fingerprintAfter: observedFingerprint,
    canAutoAdvance: false,
    message: before
      ? "版本标识发生变化，须由管理员判断是修订、取代还是撤回。"
      : "首次记录版本标识，须由管理员确认当前版本仍为现行有效。",
  };
}

/**
 * §8：发现某资料已被新资料取代时，必须同时做三件事——
 * 旧资料改 AMENDED/SUPERSEDED、填写 superseded_by_source_id、导入并发布新资料。
 * 三者未同时完成的，该领域问题一律返回“暂时无法确认”。
 */
export interface SupersessionState {
  oldStatusUpdated: boolean;
  supersededByFilled: boolean;
  replacementPublished: boolean;
}

export interface SupersessionCheck {
  complete: boolean;
  missing: string[];
  /** 未完成时该领域必须整体降级。 */
  blocksDomain: boolean;
}

export function checkSupersession(state: SupersessionState): SupersessionCheck {
  const missing: string[] = [];
  if (!state.oldStatusUpdated) missing.push("旧资料未改为 AMENDED 或 SUPERSEDED");
  if (!state.supersededByFilled) missing.push("未填写 superseded_by_source_id");
  if (!state.replacementPublished) missing.push("取代它的新资料尚未导入并发布");
  const started = state.oldStatusUpdated || state.supersededByFilled || state.replacementPublished;
  return {
    complete: missing.length === 0,
    missing,
    // 已经开始但没做完，才是最危险的状态：旧的不能用、新的还没有。
    blocksDomain: started && missing.length > 0,
  };
}

export interface InspectionQueueItem {
  documentId: string;
  title: string;
  tier: InspectionTier;
  line: InspectionLine;
  reason: DueReason | "LINK_CHECK";
  domainWatchChannel?: string;
  nextDueAt?: string;
}

/** 生成当期待巡检清单。文件线与领域线分别出条目。 */
export function buildInspectionQueue(
  documents: InspectableDocument[],
  now: Date = new Date(),
): InspectionQueueItem[] {
  const queue: InspectionQueueItem[] = [];
  for (const document of documents) {
    const currency = evaluateCurrencyDue(document, now);
    if (currency.due) {
      queue.push({
        documentId: document.id,
        title: document.title,
        tier: document.inspectionTier,
        line: document.anchorUrl ? "FILE" : "DOMAIN",
        reason: currency.reason ?? "TIER_INTERVAL",
        domainWatchChannel: document.domainWatchChannel,
        nextDueAt: currency.nextDueAt,
      });
    }
    if (isLinkCheckDue(document, now)) {
      queue.push({
        documentId: document.id,
        title: document.title,
        tier: document.inspectionTier,
        line: "FILE",
        reason: "LINK_CHECK",
      });
    }
  }
  return queue;
}

/**
 * 领域线永远要出条目：外部修改型变更只能靠人看官方发布渠道。
 * 按领域去重，而不是按文件。
 */
export function buildDomainWatchList(documents: InspectableDocument[]) {
  const byDomain = new Map<string, { domain: string; channels: Set<string>; documentCount: number }>();
  for (const document of documents) {
    const domain = document.domain ?? "unknown";
    const entry = byDomain.get(domain)
      ?? { domain, channels: new Set<string>(), documentCount: 0 };
    if (document.domainWatchChannel) entry.channels.add(document.domainWatchChannel);
    entry.documentCount += 1;
    byDomain.set(domain, entry);
  }
  return [...byDomain.values()].map((entry) => ({
    domain: entry.domain,
    channels: [...entry.channels],
    documentCount: entry.documentCount,
  }));
}

/** §11.5 运营指标。 */
export interface MaintenanceMetrics {
  /** 全库 legal_as_of 的中位数，衡量知识库新鲜度。 */
  freshnessMedian?: string;
  /** CURRENCY_EXPIRED 的来源数量，即欠了多少巡检工作。 */
  maintenanceDebt: number;
  /** PENDING_OFFICIAL_SOURCE 的来源数量，即已承诺覆盖但尚未导入的缺口。 */
  pendingSources: number;
  /** 因现行性问题被降级的回答占比。 */
  degradationRate: number;
  totalDocuments: number;
}

export function computeMaintenanceMetrics(
  documents: InspectableDocument[],
  answerStats: { total: number; degradedForCurrency: number },
  now: Date = new Date(),
): MaintenanceMetrics {
  const checkedDates = documents
    .map((document) => document.legalCurrencyCheckedAt)
    .filter((value): value is string => Boolean(value))
    .sort();

  let freshnessMedian: string | undefined;
  if (checkedDates.length) {
    const middle = Math.floor(checkedDates.length / 2);
    freshnessMedian = checkedDates.length % 2 === 1
      ? checkedDates[middle]
      : checkedDates[middle - 1];
  }

  return {
    freshnessMedian,
    maintenanceDebt: documents.filter((document) => isCurrencyExpired(document, now)).length,
    pendingSources: documents.filter((document) =>
      document.legalStatus === "PENDING_OFFICIAL_SOURCE").length,
    degradationRate: answerStats.total === 0
      ? 0
      : answerStats.degradedForCurrency / answerStats.total,
    totalDocuments: documents.length,
  };
}
