import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const userPlan = pgEnum("user_plan", ["FREE", "PROFESSIONAL"]);
export const answerStatus = pgEnum("answer_status", ["SUFFICIENT", "NEED_INFORMATION", "UNABLE_TO_CONFIRM"]);
export const messageRole = pgEnum("message_role", ["USER", "ASSISTANT", "SYSTEM"]);
export const fileStatus = pgEnum("file_status", ["UPLOADED", "PARSING", "READY", "FAILED", "DELETION_SCHEDULED"]);
export const reminderStatus = pgEnum("reminder_status", ["ACTIVE", "PAUSED", "SENT", "CANCELLED"]);
export const subscriptionStatus = pgEnum("subscription_status", ["ACTIVE", "RETRYING", "CANCELLED", "EXPIRED", "REFUNDED"]);
export const orderStatus = pgEnum("order_status", ["PENDING", "PAID", "FAILED", "REFUNDED", "CLOSED"]);
export const kbProcessingStatus = pgEnum("kb_processing_status", ["UPLOADED", "PARSING", "VALIDATION_FAILED", "TO_REVIEW", "READY_TO_PUBLISH", "PUBLISHED"]);
/** 《知识库数据规范 V1.4》§7.2 法律状态 + §11 巡检状态。 */
export const kbLegalStatus = pgEnum("kb_legal_status", [
  "DRAFT", "PUBLISHED", "AMENDED", "SUPERSEDED", "REPEALED", "OMITTED",
  "NOT_YET_EFFECTIVE", "UNKNOWN", "CURRENCY_EXPIRED", "PENDING_OFFICIAL_SOURCE",
]);
/** 《知识库数据规范 V1.4》§11.1 分层巡检周期。 */
export const kbInspectionTier = pgEnum("kb_inspection_tier", ["A", "B", "C", "D", "E"]);
/** 是否允许向普通用户展示被引用段落原文。 */
export const kbSnippetDisplay = pgEnum("kb_snippet_display", ["ALLOW", "DENY"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  plan: userPlan("plan").default("FREE").notNull(),
  status: varchar("status", { length: 32 }).default("ACTIVE").notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("users_email_unique").on(table.email)]);

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 128 }).notNull(),
  deviceLabel: varchar("device_label", { length: 160 }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("sessions_user_idx").on(table.userId), uniqueIndex("sessions_token_unique").on(table.tokenHash)]);

export const companyProfiles = pgTable("company_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  companyName: varchar("company_name", { length: 300 }),
  entityType: varchar("entity_type", { length: 120 }),
  registeredState: varchar("registered_state", { length: 120 }),
  industry: varchar("industry", { length: 200 }),
  foreignOwnership: text("foreign_ownership"),
  gstin: varchar("gstin", { length: 32 }),
  additionalFacts: jsonb("additional_facts").default({}).notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("company_profiles_user_unique").on(table.userId)]);

export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 240 }).notNull(),
  selectedProfileId: uuid("selected_profile_id").references(() => companyProfiles.id, { onDelete: "set null" }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [index("conversations_user_updated_idx").on(table.userId, table.updatedAt)]);

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: messageRole("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("messages_conversation_created_idx").on(table.conversationId, table.createdAt)]);

export const quotaAccounts = pgTable("quota_accounts", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  freeRemaining: integer("free_remaining").default(3).notNull(),
  monthlyRemaining: integer("monthly_remaining").default(0).notNull(),
  addOnRemaining: integer("add_on_remaining").default(0).notNull(),
  cycleStartsAt: timestamp("cycle_starts_at", { withTimezone: true }),
  cycleEndsAt: timestamp("cycle_ends_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const answerRequests = pgTable("answer_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  question: text("question").notNull(),
  answerStatus: answerStatus("answer_status"),
  failureCode: varchar("failure_code", { length: 64 }),
  shortConclusion: text("short_conclusion"),
  answerObject: jsonb("answer_object"),
  queryPackage: jsonb("query_package"),
  lockedVersions: jsonb("locked_versions"),
  policyVersion: varchar("policy_version", { length: 40 }).default("1.0").notNull(),
  chargeEligible: boolean("charge_eligible").default(false).notNull(),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  costCny: numeric("cost_cny", { precision: 12, scale: 6 }),
  latencyMs: integer("latency_ms"),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("answer_requests_idempotency_unique").on(table.idempotencyKey),
  index("answer_requests_user_created_idx").on(table.userId, table.createdAt),
]);

export const quotaLedger = pgTable("quota_ledger", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").references(() => answerRequests.id, { onDelete: "restrict" }),
  bucket: varchar("bucket", { length: 32 }).notNull(),
  delta: integer("delta").notNull(),
  reason: varchar("reason", { length: 80 }).notNull(),
  balanceAfter: integer("balance_after").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("quota_ledger_request_reason_unique").on(table.requestId, table.reason), index("quota_ledger_user_idx").on(table.userId, table.createdAt)]);

export const userFiles = pgTable("user_files", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  originalName: varchar("original_name", { length: 500 }).notNull(),
  mimeType: varchar("mime_type", { length: 160 }).notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  pageCount: integer("page_count"),
  storageKey: varchar("storage_key", { length: 800 }).notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  status: fileStatus("status").default("UPLOADED").notNull(),
  extractedFields: jsonb("extracted_fields"),
  userConfirmedAt: timestamp("user_confirmed_at", { withTimezone: true }),
  retainUntil: timestamp("retain_until", { withTimezone: true }),
  deleteAfter: timestamp("delete_after", { withTimezone: true }),
  ...timestamps,
}, (table) => [index("user_files_owner_idx").on(table.userId, table.createdAt), uniqueIndex("user_files_owner_hash_unique").on(table.userId, table.sha256)]);

export const reminders = pgTable("reminders", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sourceFileId: uuid("source_file_id").references(() => userFiles.id, { onDelete: "set null" }),
  title: varchar("title", { length: 300 }).notNull(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  deadlineTimezone: varchar("deadline_timezone", { length: 80 }).default("Asia/Kolkata").notNull(),
  notifyAt: timestamp("notify_at", { withTimezone: true }).notNull(),
  status: reminderStatus("status").default("ACTIVE").notNull(),
  userConfirmedAt: timestamp("user_confirmed_at", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  retryCount: integer("retry_count").default(0).notNull(),
  ...timestamps,
}, (table) => [index("reminders_due_idx").on(table.status, table.notifyAt), index("reminders_user_idx").on(table.userId)]);

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  provider: varchar("provider", { length: 24 }).notNull(),
  providerAgreementId: varchar("provider_agreement_id", { length: 180 }).notNull(),
  status: subscriptionStatus("status").default("ACTIVE").notNull(),
  priceCny: numeric("price_cny", { precision: 10, scale: 2 }).default("9.90").notNull(),
  currentPeriodStartsAt: timestamp("current_period_starts_at", { withTimezone: true }).notNull(),
  currentPeriodEndsAt: timestamp("current_period_ends_at", { withTimezone: true }).notNull(),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
  retryCount: integer("retry_count").default(0).notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("subscriptions_provider_agreement_unique").on(table.provider, table.providerAgreementId), index("subscriptions_user_idx").on(table.userId)]);

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  productType: varchar("product_type", { length: 32 }).notNull(),
  provider: varchar("provider", { length: 24 }).notNull(),
  providerTransactionId: varchar("provider_transaction_id", { length: 180 }),
  amountCny: numeric("amount_cny", { precision: 10, scale: 2 }).notNull(),
  status: orderStatus("status").default("PENDING").notNull(),
  entitlementGrantedAt: timestamp("entitlement_granted_at", { withTimezone: true }),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("orders_provider_transaction_unique").on(table.provider, table.providerTransactionId), index("orders_user_created_idx").on(table.userId, table.createdAt)]);

export const paymentEvents = pgTable("payment_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: varchar("provider", { length: 24 }).notNull(),
  providerEventId: varchar("provider_event_id", { length: 180 }).notNull(),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("payment_events_provider_event_unique").on(table.provider, table.providerEventId)]);

export const kbAuthorities = pgTable("kb_authorities", {
  id: varchar("id", { length: 80 }).primaryKey(),
  name: varchar("name", { length: 300 }).notNull(),
  allowedDomains: jsonb("allowed_domains").notNull(),
  status: varchar("status", { length: 40 }).default("TO_REVIEW").notNull(),
  ...timestamps,
});

export const kbDocuments = pgTable("kb_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: varchar("title", { length: 600 }).notNull(),
  documentType: varchar("document_type", { length: 80 }).notNull(),
  authorityId: varchar("authority_id", { length: 80 }).notNull().references(() => kbAuthorities.id, { onDelete: "restrict" }),
  legalEffectLevel: varchar("legal_effect_level", { length: 80 }).notNull(),
  jurisdiction: jsonb("jurisdiction").default([]).notNull(),
  applicabilityTags: jsonb("applicability_tags").default([]).notNull(),
  officialUrl: text("official_url").notNull(),
  legalStatus: kbLegalStatus("legal_status").default("DRAFT").notNull(),
  /** 被哪一份新资料取代，例如 Press Note 3 (2020) 指向 Press Note 2 (2026 Series)。 */
  supersededBySourceId: varchar("superseded_by_source_id", { length: 80 }),
  /** 官方“最新版本锚点页”，巡检比对版本标识用，与正文链接可以不同。 */
  anchorUrl: text("anchor_url"),
  /** 从 anchorUrl 提取的版本标识，例如 as amended up to 日期或最新文号。 */
  versionFingerprint: varchar("version_fingerprint", { length: 300 }),
  /** A/B/C/D/E 五档巡检层级，决定法律现行性核验周期。 */
  inspectionTier: kbInspectionTier("inspection_tier").default("C").notNull(),
  /** 所属领域的官方发布渠道，用于领域线巡检。 */
  domainWatchChannel: varchar("domain_watch_channel", { length: 300 }),
  /** 链接可访问性的最近核验时间。只证明链接能打开。 */
  linkCheckedAt: timestamp("link_checked_at", { withTimezone: true }),
  /** 法律现行性的最近核验时间。用于推导 legal_as_of，与 linkCheckedAt 不得互相替代。 */
  legalCurrencyCheckedAt: timestamp("legal_currency_checked_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  index("kb_documents_authority_type_idx").on(table.authorityId, table.documentType),
  index("kb_documents_status_idx").on(table.legalStatus),
  index("kb_documents_currency_idx").on(table.inspectionTier, table.legalCurrencyCheckedAt),
]);

export const kbVersions = pgTable("kb_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  documentId: uuid("document_id").notNull().references(() => kbDocuments.id, { onDelete: "restrict" }),
  previousVersionId: uuid("previous_version_id"),
  versionLabel: varchar("version_label", { length: 300 }).notNull(),
  publicationDate: date("publication_date").notNull(),
  effectiveDate: date("effective_date"),
  validTo: date("valid_to"),
  snapshotStorageKey: varchar("snapshot_storage_key", { length: 800 }).notNull(),
  snapshotSha256: varchar("snapshot_sha256", { length: 64 }).notNull(),
  sourceTxtSha256: varchar("source_txt_sha256", { length: 64 }).notNull(),
  processingStatus: kbProcessingStatus("processing_status").default("UPLOADED").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  publishedBy: uuid("published_by").references(() => users.id, { onDelete: "restrict" }),
  /** 该版本是否允许向普通用户展示被引用段落原文。官方成文法与判决默认 ALLOW。 */
  snippetDisplay: kbSnippetDisplay("snippet_display").default("ALLOW").notNull(),
  /**
   * 该辖区通过本邦修正案采纳某项中央修订的生效日。
   * 中央与各邦不同步：CGST s74A 中央自 2024-11-01 生效，各邦在此后数月内陆续采纳。
   */
  stateAdoptionDate: date("state_adoption_date"),
  ...timestamps,
}, (table) => [uniqueIndex("kb_versions_document_label_unique").on(table.documentId, table.versionLabel), index("kb_versions_status_date_idx").on(table.processingStatus, table.effectiveDate, table.validTo)]);

export const kbChunks = pgTable("kb_chunks", {
  id: uuid("id").defaultRandom().primaryKey(),
  documentId: uuid("document_id").notNull().references(() => kbDocuments.id, { onDelete: "restrict" }),
  versionId: uuid("version_id").notNull().references(() => kbVersions.id, { onDelete: "restrict" }),
  orderNo: integer("order_no").notNull(),
  sourceLabel: varchar("source_label", { length: 700 }).notNull(),
  majorTitle: varchar("major_title", { length: 700 }).notNull(),
  minorTitle: text("minor_title").notNull(),
  bodyOriginal: text("body_original").notNull(),
  officialUrl: text("official_url").notNull(),
  locator: jsonb("locator").notNull(),
  partNo: integer("part_no"),
  partTotal: integer("part_total"),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  /**
   * 条文级生效日。留空表示与所属版本的 effectiveDate 一致。
   * 例如 CGST s74A 适用于 FY 2024-25 起，而整部法自 2017-07-01 生效。
   */
  provisionEffectiveFrom: date("provision_effective_from"),
  provisionEffectiveTo: date("provision_effective_to"),
  /** 条文适用范围的自然语言说明，例如“适用于 FY 2024-25 及以后税期”。 */
  applicabilityNote: text("applicability_note"),
  /** 州级 chunk 专用：中央对应条文的生效日。适用起点取其与该辖区采纳日的较晚者。 */
  centreEffectiveFrom: date("centre_effective_from"),
  /** 本条文对应的中央或州条文引用，用于标注镜像关系。 */
  parallelProvisionRef: varchar("parallel_provision_ref", { length: 300 }),
  /** 所属辖区代码，CENTRE 或邦代码。 */
  jurisdictionCode: varchar("jurisdiction_code", { length: 12 }).default("CENTRE").notNull(),
  /** 正文含 with effect from 等措辞时为 true，发布前必须由管理员确认条文级生效日。 */
  needsEffectiveDateConfirmation: boolean("needs_effective_date_confirmation").default(false).notNull(),
  effectiveDateConfirmedBy: uuid("effective_date_confirmed_by").references(() => users.id, { onDelete: "restrict" }),
  effectiveDateConfirmedAt: timestamp("effective_date_confirmed_at", { withTimezone: true }),
  domainTags: jsonb("domain_tags").default([]).notNull(),
  searchFields: jsonb("search_fields").default({}).notNull(),
  embeddingModel: varchar("embedding_model", { length: 160 }),
  embeddingVersion: varchar("embedding_version", { length: 120 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("kb_chunks_version_order_unique").on(table.versionId, table.orderNo), uniqueIndex("kb_chunks_version_hash_unique").on(table.versionId, table.contentHash), index("kb_chunks_document_version_idx").on(table.documentId, table.versionId)]);

export const answerCitations = pgTable("answer_citations", {
  id: uuid("id").defaultRandom().primaryKey(),
  requestId: uuid("request_id").notNull().references(() => answerRequests.id, { onDelete: "cascade" }),
  claimId: varchar("claim_id", { length: 120 }).notNull(),
  documentId: uuid("document_id").notNull().references(() => kbDocuments.id, { onDelete: "restrict" }),
  versionId: uuid("version_id").notNull().references(() => kbVersions.id, { onDelete: "restrict" }),
  chunkId: uuid("chunk_id").notNull().references(() => kbChunks.id, { onDelete: "restrict" }),
  displayTitle: varchar("display_title", { length: 700 }).notNull(),
  authority: varchar("authority", { length: 300 }).notNull(),
  locator: varchar("locator", { length: 500 }).notNull(),
  officialUrl: text("official_url").notNull(),
  supportResult: varchar("support_result", { length: 40 }).notNull(),
  /** 实际展示给用户的原文段落，用于事后核对是否越界。 */
  snippet: text("snippet"),
  snippetStartOffset: integer("snippet_start_offset"),
  snippetEndOffset: integer("snippet_end_offset"),
  /** 展示的适用期间，取条文级日期，留空回落到版本级。 */
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  /** 判例或州级来源的辖区；非管辖法院须标注“仅供参考”。 */
  jurisdictionCode: varchar("jurisdiction_code", { length: 12 }),
  nonBindingJurisdiction: boolean("non_binding_jurisdiction").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("answer_citations_request_claim_idx").on(table.requestId, table.claimId)]);

export const glossaryTerms = pgTable("glossary_terms", {
  id: uuid("id").defaultRandom().primaryKey(),
  termZh: varchar("term_zh", { length: 300 }).notNull(),
  officialTermEn: varchar("official_term_en", { length: 500 }).notNull(),
  abbreviation: varchar("abbreviation", { length: 120 }),
  synonyms: jsonb("synonyms").default([]).notNull(),
  domains: jsonb("domains").default([]).notNull(),
  status: varchar("status", { length: 32 }).default("TO_REVIEW").notNull(),
  version: integer("version").default(1).notNull(),
  ...timestamps,
}, (table) => [uniqueIndex("glossary_term_pair_unique").on(table.termZh, table.officialTermEn)]);

export const feedback = pgTable("feedback", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  requestId: uuid("request_id").notNull().references(() => answerRequests.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  status: varchar("status", { length: 32 }).default("PENDING").notNull(),
  quotaRestoredAt: timestamp("quota_restored_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("feedback_user_request_unique").on(table.userId, table.requestId)]);

/**
 * 《产品规则表 V1.4》§2.2：同一账号每自然月最多补回3次；
 * 连续两个自然月触及上限则冻结补回能力并转人工复核。
 */
export const feedbackRestoreCounters = pgTable("feedback_restore_counters", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  yearMonth: varchar("year_month", { length: 7 }).notNull(),
  restoredCount: integer("restored_count").default(0).notNull(),
  reachedLimitAt: timestamp("reached_limit_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("feedback_restore_user_month_unique").on(table.userId, table.yearMonth)]);

/** 巡检执行记录：文件线与领域线分开记账。 */
export const kbInspections = pgTable("kb_inspections", {
  id: uuid("id").defaultRandom().primaryKey(),
  documentId: uuid("document_id").references(() => kbDocuments.id, { onDelete: "cascade" }),
  line: varchar("line", { length: 16 }).notNull(),
  domain: varchar("domain", { length: 64 }),
  fingerprintBefore: varchar("fingerprint_before", { length: 300 }),
  fingerprintAfter: varchar("fingerprint_after", { length: 300 }),
  changeDetected: boolean("change_detected").default(false).notNull(),
  conclusion: varchar("conclusion", { length: 64 }).notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("kb_inspections_document_idx").on(table.documentId, table.createdAt),
  index("kb_inspections_line_idx").on(table.line, table.createdAt),
]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
  action: varchar("action", { length: 100 }).notNull(),
  objectType: varchar("object_type", { length: 100 }).notNull(),
  objectId: varchar("object_id", { length: 180 }).notNull(),
  beforeHash: varchar("before_hash", { length: 64 }),
  afterHash: varchar("after_hash", { length: 64 }),
  metadata: jsonb("metadata").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("audit_logs_object_idx").on(table.objectType, table.objectId), index("audit_logs_created_idx").on(table.createdAt)]);
