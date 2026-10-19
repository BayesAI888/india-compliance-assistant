CREATE TYPE "public"."answer_status" AS ENUM('SUFFICIENT', 'NEED_INFORMATION', 'UNABLE_TO_CONFIRM');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('UPLOADED', 'PARSING', 'READY', 'FAILED', 'DELETION_SCHEDULED');--> statement-breakpoint
CREATE TYPE "public"."kb_legal_status" AS ENUM('DRAFT', 'PUBLISHED', 'AMENDED', 'SUPERSEDED', 'REPEALED', 'OMITTED');--> statement-breakpoint
CREATE TYPE "public"."kb_processing_status" AS ENUM('UPLOADED', 'PARSING', 'VALIDATION_FAILED', 'TO_REVIEW', 'READY_TO_PUBLISH', 'PUBLISHED');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('USER', 'ASSISTANT', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('PENDING', 'PAID', 'FAILED', 'REFUNDED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('ACTIVE', 'PAUSED', 'SENT', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('ACTIVE', 'RETRYING', 'CANCELLED', 'EXPIRED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."user_plan" AS ENUM('FREE', 'PROFESSIONAL');--> statement-breakpoint
CREATE TABLE "answer_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"claim_id" varchar(120) NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"display_title" varchar(700) NOT NULL,
	"authority" varchar(300) NOT NULL,
	"locator" varchar(500) NOT NULL,
	"official_url" text NOT NULL,
	"support_result" varchar(40) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answer_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"conversation_id" uuid,
	"question" text NOT NULL,
	"answer_status" "answer_status",
	"failure_code" varchar(64),
	"short_conclusion" text,
	"answer_object" jsonb,
	"query_package" jsonb,
	"locked_versions" jsonb,
	"policy_version" varchar(40) DEFAULT '1.0' NOT NULL,
	"charge_eligible" boolean DEFAULT false NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cost_cny" numeric(12, 6),
	"latency_ms" integer,
	"idempotency_key" varchar(160) NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" varchar(100) NOT NULL,
	"object_type" varchar(100) NOT NULL,
	"object_id" varchar(180) NOT NULL,
	"before_hash" varchar(64),
	"after_hash" varchar(64),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company_name" varchar(300),
	"entity_type" varchar(120),
	"registered_state" varchar(120),
	"industry" varchar(200),
	"foreign_ownership" text,
	"gstin" varchar(32),
	"additional_facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(240) NOT NULL,
	"selected_profile_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"quota_restored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "glossary_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term_zh" varchar(300) NOT NULL,
	"official_term_en" varchar(500) NOT NULL,
	"abbreviation" varchar(120),
	"synonyms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'TO_REVIEW' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_authorities" (
	"id" varchar(80) PRIMARY KEY NOT NULL,
	"name" varchar(300) NOT NULL,
	"allowed_domains" jsonb NOT NULL,
	"status" varchar(40) DEFAULT 'TO_REVIEW' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"order_no" integer NOT NULL,
	"source_label" varchar(700) NOT NULL,
	"major_title" varchar(700) NOT NULL,
	"minor_title" text NOT NULL,
	"body_original" text NOT NULL,
	"official_url" text NOT NULL,
	"locator" jsonb NOT NULL,
	"part_no" integer,
	"part_total" integer,
	"content_hash" varchar(64) NOT NULL,
	"domain_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"search_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedding_model" varchar(160),
	"embedding_version" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(600) NOT NULL,
	"document_type" varchar(80) NOT NULL,
	"authority_id" varchar(80) NOT NULL,
	"legal_effect_level" varchar(80) NOT NULL,
	"jurisdiction" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applicability_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"official_url" text NOT NULL,
	"legal_status" "kb_legal_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"previous_version_id" uuid,
	"version_label" varchar(300) NOT NULL,
	"publication_date" date NOT NULL,
	"effective_date" date,
	"valid_to" date,
	"snapshot_storage_key" varchar(800) NOT NULL,
	"snapshot_sha256" varchar(64) NOT NULL,
	"source_txt_sha256" varchar(64) NOT NULL,
	"processing_status" "kb_processing_status" DEFAULT 'UPLOADED' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"product_type" varchar(32) NOT NULL,
	"provider" varchar(24) NOT NULL,
	"provider_transaction_id" varchar(180),
	"amount_cny" numeric(10, 2) NOT NULL,
	"status" "order_status" DEFAULT 'PENDING' NOT NULL,
	"entitlement_granted_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(24) NOT NULL,
	"provider_event_id" varchar(180) NOT NULL,
	"order_id" uuid,
	"payload_hash" varchar(64) NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"free_remaining" integer DEFAULT 3 NOT NULL,
	"monthly_remaining" integer DEFAULT 0 NOT NULL,
	"add_on_remaining" integer DEFAULT 0 NOT NULL,
	"cycle_starts_at" timestamp with time zone,
	"cycle_ends_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" uuid,
	"bucket" varchar(32) NOT NULL,
	"delta" integer NOT NULL,
	"reason" varchar(80) NOT NULL,
	"balance_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_file_id" uuid,
	"title" varchar(300) NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"deadline_timezone" varchar(80) DEFAULT 'Asia/Kolkata' NOT NULL,
	"notify_at" timestamp with time zone NOT NULL,
	"status" "reminder_status" DEFAULT 'ACTIVE' NOT NULL,
	"user_confirmed_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"device_label" varchar(160),
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(24) NOT NULL,
	"provider_agreement_id" varchar(180) NOT NULL,
	"status" "subscription_status" DEFAULT 'ACTIVE' NOT NULL,
	"price_cny" numeric(10, 2) DEFAULT '9.90' NOT NULL,
	"current_period_starts_at" timestamp with time zone NOT NULL,
	"current_period_ends_at" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"original_name" varchar(500) NOT NULL,
	"mime_type" varchar(160) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"page_count" integer,
	"storage_key" varchar(800) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"status" "file_status" DEFAULT 'UPLOADED' NOT NULL,
	"extracted_fields" jsonb,
	"user_confirmed_at" timestamp with time zone,
	"retain_until" timestamp with time zone,
	"delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"email_verified_at" timestamp with time zone,
	"plan" "user_plan" DEFAULT 'FREE' NOT NULL,
	"status" varchar(32) DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_request_id_answer_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."answer_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_document_id_kb_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_version_id_kb_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."kb_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_chunk_id_kb_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."kb_chunks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_requests" ADD CONSTRAINT "answer_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_requests" ADD CONSTRAINT "answer_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_selected_profile_id_company_profiles_id_fk" FOREIGN KEY ("selected_profile_id") REFERENCES "public"."company_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_request_id_answer_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."answer_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_document_id_kb_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_version_id_kb_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."kb_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_authority_id_kb_authorities_id_fk" FOREIGN KEY ("authority_id") REFERENCES "public"."kb_authorities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_versions" ADD CONSTRAINT "kb_versions_document_id_kb_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_versions" ADD CONSTRAINT "kb_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_accounts" ADD CONSTRAINT "quota_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_ledger" ADD CONSTRAINT "quota_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_ledger" ADD CONSTRAINT "quota_ledger_request_id_answer_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."answer_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_source_file_id_user_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."user_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_files" ADD CONSTRAINT "user_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_files" ADD CONSTRAINT "user_files_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_citations_request_claim_idx" ON "answer_citations" USING btree ("request_id","claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "answer_requests_idempotency_unique" ON "answer_requests" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "answer_requests_user_created_idx" ON "answer_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_object_idx" ON "audit_logs" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "company_profiles_user_unique" ON "company_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversations_user_updated_idx" ON "conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_user_request_unique" ON "feedback" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "glossary_term_pair_unique" ON "glossary_terms" USING btree ("term_zh","official_term_en");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_chunks_version_order_unique" ON "kb_chunks" USING btree ("version_id","order_no");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_chunks_version_hash_unique" ON "kb_chunks" USING btree ("version_id","content_hash");--> statement-breakpoint
CREATE INDEX "kb_chunks_document_version_idx" ON "kb_chunks" USING btree ("document_id","version_id");--> statement-breakpoint
CREATE INDEX "kb_documents_authority_type_idx" ON "kb_documents" USING btree ("authority_id","document_type");--> statement-breakpoint
CREATE INDEX "kb_documents_status_idx" ON "kb_documents" USING btree ("legal_status");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_versions_document_label_unique" ON "kb_versions" USING btree ("document_id","version_label");--> statement-breakpoint
CREATE INDEX "kb_versions_status_date_idx" ON "kb_versions" USING btree ("processing_status","effective_date","valid_to");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_provider_transaction_unique" ON "orders" USING btree ("provider","provider_transaction_id");--> statement-breakpoint
CREATE INDEX "orders_user_created_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_unique" ON "payment_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_ledger_request_reason_unique" ON "quota_ledger" USING btree ("request_id","reason");--> statement-breakpoint
CREATE INDEX "quota_ledger_user_idx" ON "quota_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("status","notify_at");--> statement-breakpoint
CREATE INDEX "reminders_user_idx" ON "reminders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_agreement_unique" ON "subscriptions" USING btree ("provider","provider_agreement_id");--> statement-breakpoint
CREATE INDEX "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_files_owner_idx" ON "user_files" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_files_owner_hash_unique" ON "user_files" USING btree ("user_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");