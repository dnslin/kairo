-- Up Migration
CREATE TABLE "kairo"."send_operations" (
  "operation_id" text PRIMARY KEY,
  "target_session_id" text NOT NULL,
  "message_type" text NOT NULL,
  "content_digest" text NOT NULL,
  "native_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'unknown',
  "message_id" text,
  "error" text,
  "is_pre_trigger" boolean DEFAULT false,
  "verify_latency_ms" integer,
  "claim_token" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "send_operations_message_type_check"
    CHECK ("message_type" IN ('text', 'rich-text', 'reply', 'image', 'file')),
  CONSTRAINT "send_operations_status_check"
    CHECK ("status" IN ('delivered', 'failed', 'unknown'))
);

-- Down Migration
DROP TABLE "kairo"."send_operations";
