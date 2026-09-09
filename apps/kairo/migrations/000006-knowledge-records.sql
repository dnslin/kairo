-- Up Migration
CREATE TABLE "kairo"."runtime_boots" (
  "boot_id" text PRIMARY KEY,
  "git_commit" text NOT NULL,
  "config_digest" text NOT NULL,
  "started_at" timestamptz NOT NULL,
  "closed_at" timestamptz,
  "status" text NOT NULL CHECK ("status" IN ('starting', 'running', 'closed', 'failed')),
  CHECK (("status" IN ('closed', 'failed')) = ("closed_at" IS NOT NULL)),
  CHECK ("closed_at" IS NULL OR "closed_at" >= "started_at")
);
CREATE INDEX "runtime_boots_started_idx" ON "kairo"."runtime_boots" ("started_at", "boot_id");

CREATE TABLE "kairo"."knowledge_queries" (
  "query_id" text PRIMARY KEY,
  "task_id" text NOT NULL REFERENCES "kairo"."tasks" ("task_id"),
  "attempt_id" text NOT NULL,
  "boot_id" text NOT NULL REFERENCES "kairo"."runtime_boots" ("boot_id"),
  "tool_id" text NOT NULL,
  "call_index" integer NOT NULL CHECK ("call_index" > 0),
  "query" text NOT NULL,
  "dataset_id" text NOT NULL,
  "started_at" timestamptz NOT NULL,
  "duration_ms" double precision NOT NULL CHECK ("duration_ms" >= 0 AND "duration_ms" < 'Infinity'::float8),
  "result_category" text NOT NULL CHECK ("result_category" IN (
    'found', 'empty', 'format_error', 'service_error', 'auth_error', 'parameter_error', 'cancelled', 'timeout'
  )),
  "raw_result" jsonb,
  UNIQUE ("task_id", "call_index"),
  UNIQUE ("task_id", "query_id"),
  FOREIGN KEY ("task_id", "attempt_id") REFERENCES "kairo"."task_attempts" ("task_id", "attempt_id")
);
CREATE INDEX "knowledge_queries_attempt_idx" ON "kairo"."knowledge_queries" ("attempt_id", "call_index");
CREATE INDEX "knowledge_queries_boot_idx" ON "kairo"."knowledge_queries" ("boot_id", "started_at");

CREATE TABLE "kairo"."knowledge_evidence" (
  "evidence_id" text PRIMARY KEY,
  "task_id" text NOT NULL,
  "query_id" text NOT NULL,
  "position" integer NOT NULL CHECK ("position" >= 0),
  "document_id" text NOT NULL,
  "document_name" text NOT NULL,
  "chunk_id" text NOT NULL,
  "content" text NOT NULL,
  "page_numbers" integer[],
  "positions" jsonb,
  "similarity" double precision,
  "conflict" boolean NOT NULL,
  UNIQUE ("task_id", "evidence_id"),
  UNIQUE ("query_id", "position"),
  FOREIGN KEY ("task_id", "query_id") REFERENCES "kairo"."knowledge_queries" ("task_id", "query_id")
);
CREATE INDEX "knowledge_evidence_task_idx" ON "kairo"."knowledge_evidence" ("task_id", "query_id", "position");
CREATE INDEX "knowledge_evidence_document_idx" ON "kairo"."knowledge_evidence" ("document_id", "chunk_id");

-- 正式回答与发送事实分开保存正文；不实现模型生成、证据裁决或消息发送。
CREATE TABLE "kairo"."formal_answers" (
  "task_id" text PRIMARY KEY REFERENCES "kairo"."tasks" ("task_id"),
  "operation_id" text NOT NULL UNIQUE REFERENCES "kairo"."send_operations" ("operation_id"),
  "boot_id" text NOT NULL REFERENCES "kairo"."runtime_boots" ("boot_id"),
  "native_message_id" text NOT NULL,
  "question" text NOT NULL,
  "answer" text NOT NULL,
  "delivered_at" timestamptz NOT NULL
);
CREATE INDEX "formal_answers_boot_idx" ON "kairo"."formal_answers" ("boot_id", "delivered_at");
CREATE TABLE "kairo"."formal_answer_evidence" (
  "task_id" text NOT NULL REFERENCES "kairo"."formal_answers" ("task_id"),
  "evidence_id" text NOT NULL,
  "position" integer NOT NULL CHECK ("position" >= 0),
  PRIMARY KEY ("task_id", "evidence_id"),
  UNIQUE ("task_id", "position"),
  FOREIGN KEY ("task_id", "evidence_id") REFERENCES "kairo"."knowledge_evidence" ("task_id", "evidence_id")
);

-- 员工更正只有未验证状态，不提供成为知识事实或正式 Memory 的入口。
CREATE TABLE "kairo"."feedback" (
  "feedback_id" text PRIMARY KEY,
  "task_id" text NOT NULL REFERENCES "kairo"."formal_answers" ("task_id"),
  "text" text NOT NULL,
  "suggested_answer" text,
  "verification" text NOT NULL DEFAULT 'unverified' CHECK ("verification" = 'unverified'),
  "created_at" timestamptz NOT NULL
);
CREATE INDEX "feedback_task_created_idx" ON "kairo"."feedback" ("task_id", "created_at", "feedback_id");

-- Down Migration
DROP TABLE "kairo"."feedback";
DROP TABLE "kairo"."formal_answer_evidence";
DROP TABLE "kairo"."formal_answers";
DROP TABLE "kairo"."knowledge_evidence";
DROP TABLE "kairo"."knowledge_queries";
DROP TABLE "kairo"."runtime_boots";
