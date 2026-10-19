-- 对齐《产品规则表 / 知识库数据规范 / AI检索与回答规范》V1.4
-- ① 法律状态与巡检层级枚举
-- ② 条文级生效日（中央与邦两个维度）
-- ③ 法律现行性核验与取代关系
-- ④ 引用展示的原文段落与适用期间
-- ⑤ 补回次数月度上限计数

ALTER TYPE "public"."kb_legal_status" ADD VALUE IF NOT EXISTS 'NOT_YET_EFFECTIVE';--> statement-breakpoint
ALTER TYPE "public"."kb_legal_status" ADD VALUE IF NOT EXISTS 'UNKNOWN';--> statement-breakpoint
ALTER TYPE "public"."kb_legal_status" ADD VALUE IF NOT EXISTS 'CURRENCY_EXPIRED';--> statement-breakpoint
ALTER TYPE "public"."kb_legal_status" ADD VALUE IF NOT EXISTS 'PENDING_OFFICIAL_SOURCE';--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."kb_inspection_tier" AS ENUM('A', 'B', 'C', 'D', 'E');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."kb_snippet_display" AS ENUM('ALLOW', 'DENY');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

ALTER TABLE "kb_documents" ADD COLUMN IF NOT EXISTS "superseded_by_source_id" varchar(80);--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN IF NOT EXISTS "anchor_url" text;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN IF NOT EXISTS "version_fingerprint" varchar(300);--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN IF NOT EXISTS "inspection_tier" "public"."kb_inspection_tier" DEFAULT 'C' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN IF NOT EXISTS "domain_watch_channel" varchar(300);--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN IF NOT EXISTS "link_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN IF NOT EXISTS "legal_currency_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_documents_currency_idx" ON "kb_documents" ("inspection_tier", "legal_currency_checked_at");--> statement-breakpoint

ALTER TABLE "kb_versions" ADD COLUMN IF NOT EXISTS "snippet_display" "public"."kb_snippet_display" DEFAULT 'ALLOW' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_versions" ADD COLUMN IF NOT EXISTS "state_adoption_date" date;--> statement-breakpoint

ALTER TABLE "kb_chunks" ADD COLUMN IF NOT EXISTS "provision_effective_from" date;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN IF NOT EXISTS "provision_effective_to" date;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN IF NOT EXISTS "applicability_note" text;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN IF NOT EXISTS "centre_effective_from" date;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN IF NOT EXISTS "parallel_provision_ref" varchar(300);--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN IF NOT EXISTS "jurisdiction_code" varchar(12) DEFAULT 'CENTRE' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN IF NOT EXISTS "needs_effective_date_confirmation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN IF NOT EXISTS "effective_date_confirmed_by" uuid REFERENCES "users"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN IF NOT EXISTS "effective_date_confirmed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_chunks_jurisdiction_period_idx" ON "kb_chunks" ("jurisdiction_code", "provision_effective_from", "provision_effective_to");--> statement-breakpoint

ALTER TABLE "answer_citations" ADD COLUMN IF NOT EXISTS "snippet" text;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD COLUMN IF NOT EXISTS "snippet_start_offset" integer;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD COLUMN IF NOT EXISTS "snippet_end_offset" integer;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD COLUMN IF NOT EXISTS "effective_from" date;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD COLUMN IF NOT EXISTS "effective_to" date;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD COLUMN IF NOT EXISTS "jurisdiction_code" varchar(12);--> statement-breakpoint
ALTER TABLE "answer_citations" ADD COLUMN IF NOT EXISTS "non_binding_jurisdiction" boolean DEFAULT false NOT NULL;--> statement-breakpoint

ALTER TABLE "answer_requests" ALTER COLUMN "policy_version" SET DEFAULT '1.4';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "feedback_restore_counters" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "year_month" varchar(7) NOT NULL,
  "restored_count" integer DEFAULT 0 NOT NULL,
  "reached_limit_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_restore_user_month_unique" ON "feedback_restore_counters" ("user_id", "year_month");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "kb_inspections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid REFERENCES "kb_documents"("id") ON DELETE cascade,
  "line" varchar(16) NOT NULL,
  "domain" varchar(64),
  "fingerprint_before" varchar(300),
  "fingerprint_after" varchar(300),
  "change_detected" boolean DEFAULT false NOT NULL,
  "conclusion" varchar(64) NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE restrict,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_inspections_document_idx" ON "kb_inspections" ("document_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_inspections_line_idx" ON "kb_inspections" ("line", "created_at");
