-- Up Migration
CREATE TABLE "kairo"."memory_commits" (
  "task_id" text PRIMARY KEY REFERENCES "kairo"."formal_answers" ("task_id"),
  "status" text NOT NULL CHECK ("status" IN ('pending', 'saved', 'observed')),
  "created_at" timestamptz NOT NULL,
  "saved_at" timestamptz,
  "observed_at" timestamptz,
  CHECK (("status" IN ('saved', 'observed')) = ("saved_at" IS NOT NULL)),
  CHECK (("status" = 'observed') = ("observed_at" IS NOT NULL)),
  CHECK ("saved_at" IS NULL OR "saved_at" >= "created_at"),
  CHECK ("observed_at" IS NULL OR "observed_at" >= "saved_at")
);

-- 身份仍由任务提供；两个索引分别支持按 thread 关联和按提交状态筛选。
CREATE INDEX "tasks_memory_thread_idx" ON "kairo"."tasks" ("thread_id", "task_id");
CREATE INDEX "memory_commits_status_created_idx"
  ON "kairo"."memory_commits" ("status", "created_at", "task_id");

-- Down Migration
DROP INDEX "kairo"."tasks_memory_thread_idx";
DROP TABLE "kairo"."memory_commits";
