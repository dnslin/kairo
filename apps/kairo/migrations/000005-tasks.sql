-- Up Migration
CREATE TABLE "kairo"."tasks" (
  "task_id" text PRIMARY KEY,
  "batch_id" text NOT NULL UNIQUE REFERENCES "kairo"."message_batches" ("batch_id"),
  "thread_id" text NOT NULL,
  "employee_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "session_id" text NOT NULL,
  "input_version" integer NOT NULL CHECK ("input_version" > 0),
  "config_digest" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN (
    'queued', 'running', 'waiting_for_user', 'ready_to_send', 'sending',
    'completed', 'failed', 'cancelled', 'timed_out', 'send_unconfirmed'
  )),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "queue_deadline" timestamptz NOT NULL,
  "execution_started_at" timestamptz,
  "execution_deadline" timestamptz,
  "current_attempt_id" text,
  "ended_at" timestamptz,
  UNIQUE ("task_id", "bot_id", "session_id"),
  FOREIGN KEY ("thread_id", "employee_id", "bot_id", "session_id")
    REFERENCES "kairo"."contexts" ("thread_id", "employee_id", "bot_id", "session_id"),
  CHECK ("queue_deadline" > "created_at"),
  CHECK (("status" IN ('completed', 'failed', 'cancelled', 'timed_out', 'send_unconfirmed'))
    = ("ended_at" IS NOT NULL))
);

CREATE TABLE "kairo"."task_attempts" (
  "attempt_id" text PRIMARY KEY,
  "task_id" text NOT NULL REFERENCES "kairo"."tasks" ("task_id"),
  "input_version" integer NOT NULL CHECK ("input_version" > 0),
  "run_id" text NOT NULL,
  "config_digest" text NOT NULL,
  "started_at" timestamptz NOT NULL,
  "finished_at" timestamptz,
  "error_type" text CHECK ("error_type" IN (
    'configuration', 'identity', 'storage', 'driver', 'model', 'knowledge',
    'timeout', 'cancelled', 'send_unknown', 'internal'
  )),
  "adopted" boolean NOT NULL DEFAULT false,
  UNIQUE ("task_id", "attempt_id"),
  CHECK ("finished_at" IS NULL OR "finished_at" >= "started_at"),
  CHECK ("error_type" IS NULL OR "finished_at" IS NOT NULL),
  CHECK (NOT "adopted" OR ("finished_at" IS NOT NULL AND "error_type" IS NULL))
);

ALTER TABLE "kairo"."tasks" ADD CONSTRAINT "tasks_current_attempt_fkey"
  FOREIGN KEY ("task_id", "current_attempt_id")
  REFERENCES "kairo"."task_attempts" ("task_id", "attempt_id");

CREATE TABLE "kairo"."user_waits" (
  "wait_id" text PRIMARY KEY,
  "task_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "session_id" text NOT NULL,
  "input_version" integer NOT NULL CHECK ("input_version" > 0),
  "question" text NOT NULL,
  "allowed_question_ids" text[] NOT NULL CHECK (cardinality("allowed_question_ids") > 0),
  "created_at" timestamptz NOT NULL,
  "deadline" timestamptz NOT NULL,
  "remaining_execution_ms" bigint NOT NULL CHECK ("remaining_execution_ms" > 0),
  "closed_at" timestamptz,
  "resolution" text CHECK ("resolution" IN ('accepted', 'declined', 'cancelled', 'timed_out')),
  "answer_message_id" text,
  FOREIGN KEY ("task_id", "bot_id", "session_id")
    REFERENCES "kairo"."tasks" ("task_id", "bot_id", "session_id"),
  FOREIGN KEY ("session_id", "answer_message_id")
    REFERENCES "kairo"."raw_messages" ("session_id", "message_id"),
  UNIQUE ("session_id", "answer_message_id"),
  CHECK ("deadline" = "created_at" + interval '10 minutes'),
  CHECK (("closed_at" IS NULL) = ("resolution" IS NULL)),
  CHECK ("closed_at" IS NULL OR "closed_at" >= "created_at"),
  CHECK (("resolution" IS NOT NULL AND "resolution" IN ('accepted', 'declined'))
    = ("answer_message_id" IS NOT NULL))
);

CREATE UNIQUE INDEX "user_waits_active_session_key"
  ON "kairo"."user_waits" ("bot_id", "session_id") WHERE "closed_at" IS NULL;

-- Down Migration
DROP TABLE "kairo"."user_waits";
ALTER TABLE "kairo"."tasks" DROP CONSTRAINT "tasks_current_attempt_fkey";
DROP TABLE "kairo"."task_attempts";
DROP TABLE "kairo"."tasks";
