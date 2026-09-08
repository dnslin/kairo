-- Up Migration
CREATE TABLE "kairo"."raw_messages" (
  "session_id" text NOT NULL,
  "message_id" text NOT NULL,
  "direction" text NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "text" text NOT NULL,
  "message_type" text,
  "attachments" jsonb NOT NULL,
  "employee_id" text,
  "processing_result" text,
  CONSTRAINT "raw_messages_pkey"
    PRIMARY KEY ("session_id", "message_id"),
  CONSTRAINT "raw_messages_direction_check"
    CHECK ("direction" IN ('inbound', 'outbound', 'unknown')),
  CONSTRAINT "raw_messages_employee_matches_session_check"
    CHECK (
      "employee_id" IS NULL
      OR ("employee_id" <> '' AND "session_id" = '0-' || "employee_id")
    ),
  CONSTRAINT "raw_messages_attachments_object_check"
    CHECK (jsonb_typeof("attachments") = 'object')
);

CREATE TABLE "kairo"."contexts" (
  "thread_id" text NOT NULL,
  "employee_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "session_id" text NOT NULL,
  "version" integer NOT NULL,
  "created_at" timestamptz NOT NULL,
  "invalidated_at" timestamptz,
  "idle_since" timestamptz,
  CONSTRAINT "contexts_pkey"
    PRIMARY KEY ("thread_id"),
  CONSTRAINT "contexts_scope_version_key"
    UNIQUE ("employee_id", "bot_id", "session_id", "version"),
  CONSTRAINT "contexts_thread_scope_key"
    UNIQUE ("thread_id", "employee_id", "bot_id", "session_id"),
  CONSTRAINT "contexts_version_check"
    CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "contexts_active_scope_key"
  ON "kairo"."contexts" ("employee_id", "bot_id", "session_id")
  WHERE "invalidated_at" IS NULL;

CREATE TABLE "kairo"."message_batches" (
  "batch_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "employee_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "session_id" text NOT NULL,
  "first_observed_at" timestamptz NOT NULL,
  "quiet_deadline" timestamptz NOT NULL,
  "max_deadline" timestamptz NOT NULL,
  "status" text NOT NULL,
  CONSTRAINT "message_batches_pkey"
    PRIMARY KEY ("batch_id"),
  CONSTRAINT "message_batches_batch_session_key"
    UNIQUE ("batch_id", "session_id"),
  CONSTRAINT "message_batches_thread_scope_fkey"
    FOREIGN KEY ("thread_id", "employee_id", "bot_id", "session_id")
    REFERENCES "kairo"."contexts" ("thread_id", "employee_id", "bot_id", "session_id"),
  CONSTRAINT "message_batches_status_check"
    CHECK ("status" IN ('collecting', 'ready', 'rejected', 'discarded')),
  CONSTRAINT "message_batches_quiet_deadline_check"
    CHECK ("quiet_deadline" >= "first_observed_at"),
  CONSTRAINT "message_batches_max_deadline_check"
    CHECK ("max_deadline" >= "first_observed_at")
);

CREATE TABLE "kairo"."batch_messages" (
  "batch_id" text NOT NULL,
  "session_id" text NOT NULL,
  "message_id" text NOT NULL,
  "position" integer NOT NULL,
  CONSTRAINT "batch_messages_pkey"
    PRIMARY KEY ("batch_id", "position"),
  CONSTRAINT "batch_messages_raw_message_key"
    UNIQUE ("session_id", "message_id"),
  CONSTRAINT "batch_messages_raw_message_fkey"
    FOREIGN KEY ("session_id", "message_id")
    REFERENCES "kairo"."raw_messages" ("session_id", "message_id"),
  CONSTRAINT "batch_messages_batch_session_fkey"
    FOREIGN KEY ("batch_id", "session_id")
    REFERENCES "kairo"."message_batches" ("batch_id", "session_id"),
  CONSTRAINT "batch_messages_position_check"
    CHECK ("position" > 0)
);

CREATE TABLE "kairo"."notice_limits" (
  "bot_id" text NOT NULL,
  "session_id" text NOT NULL,
  "notice_type" text NOT NULL,
  "last_notified_at" timestamptz NOT NULL,
  "next_allowed_at" timestamptz NOT NULL,
  CONSTRAINT "notice_limits_pkey"
    PRIMARY KEY ("bot_id", "session_id", "notice_type"),
  CONSTRAINT "notice_limits_deadline_check"
    CHECK ("next_allowed_at" >= "last_notified_at")
);

-- Down Migration
DROP TABLE "kairo"."notice_limits";
DROP TABLE "kairo"."batch_messages";
DROP TABLE "kairo"."message_batches";
DROP TABLE "kairo"."contexts";
DROP TABLE "kairo"."raw_messages";
