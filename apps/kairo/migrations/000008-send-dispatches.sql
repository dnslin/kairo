-- Up Migration
CREATE TABLE "kairo"."send_dispatches" (
  "operation_id" text PRIMARY KEY,
  "intent_key" text NOT NULL UNIQUE,
  "task_id" text REFERENCES "kairo"."tasks" ("task_id"),
  "purpose" text NOT NULL,
  "session_id" text NOT NULL,
  "content_digest" text NOT NULL,
  "status" text NOT NULL DEFAULT 'prepared' CHECK ("status" IN (
    'prepared', 'sending', 'retryable', 'unknown', 'querying',
    'delivered', 'failed', 'send_unconfirmed', 'cancelled'
  )),
  "send_calls" integer NOT NULL DEFAULT 0 CHECK ("send_calls" BETWEEN 0 AND 2),
  "query_used" boolean NOT NULL DEFAULT false,
  "query_due_at" timestamptz,
  "message_id" text,
  "revision" integer NOT NULL DEFAULT 0 CHECK ("revision" >= 0)
);

-- Down Migration
DROP TABLE "kairo"."send_dispatches";
