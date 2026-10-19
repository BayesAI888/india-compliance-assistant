-- 问答运营审计：与旧 JSON 用户 ID / 会话 ID 兼容，故使用 text 而非 uuid。
-- 记录只保存问题、处理状态、改写和引用元数据；上传文件原文不进入此表。
CREATE TABLE IF NOT EXISTS "question_audit_records" (
  "request_id" varchar(180) PRIMARY KEY NOT NULL,
  "conversation_id" varchar(180) NOT NULL,
  "user_id" varchar(180),
  "asked_at" timestamp with time zone NOT NULL,
  "status" varchar(32) NOT NULL,
  "delivery_status" varchar(32),
  "failure_code" varchar(64),
  "completed_at" timestamp with time zone,
  "record" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_audit_records_asked_at_idx"
  ON "question_audit_records" ("asked_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_audit_records_user_asked_at_idx"
  ON "question_audit_records" ("user_id", "asked_at" DESC);
--> statement-breakpoint
-- 管理员按需查看完整回答的访问日志。正文仍只在会话存储中，日志只记“谁在何时查看”。
CREATE TABLE IF NOT EXISTS "question_answer_view_events" (
  "id" varchar(180) PRIMARY KEY NOT NULL,
  "request_id" varchar(180) NOT NULL,
  "conversation_id" varchar(180) NOT NULL,
  "admin_username" varchar(180) NOT NULL,
  "viewed_at" timestamp with time zone NOT NULL,
  "outcome" varchar(32) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_answer_view_events_request_viewed_at_idx"
  ON "question_answer_view_events" ("request_id", "viewed_at" DESC);
