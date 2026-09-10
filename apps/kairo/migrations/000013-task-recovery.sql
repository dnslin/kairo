-- Up Migration
-- 旧任务没有已检查正文时保留 NULL，不能从其他账本猜造答案或提前写入正式 Memory。
ALTER TABLE "kairo"."tasks"
  ADD COLUMN "answer_text" text,
  ADD COLUMN "recovery_used" boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE "kairo"."tasks"
  DROP COLUMN "recovery_used",
  DROP COLUMN "answer_text";
