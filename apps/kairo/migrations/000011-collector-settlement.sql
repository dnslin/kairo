-- Up Migration
ALTER TABLE "kairo"."message_batches"
  ADD COLUMN "finished_at" timestamptz,
  ADD COLUMN "rejection_reason" text,
  ADD COLUMN "settled_at" timestamptz,
  ADD CONSTRAINT "message_batches_rejection_reason_check"
    CHECK ("rejection_reason" IN ('attachment', 'too_long'));

-- 只扫描待执行的批次；旧手工批次保留可空的结束和收尾字段。
CREATE INDEX "message_batches_pending_bot_idx"
  ON "kairo"."message_batches" ("bot_id", "first_observed_at", "batch_id")
  WHERE "status" = 'collecting'
    OR ("status" IN ('ready', 'rejected') AND "settled_at" IS NULL);

-- 唯一当前批次由 context 行锁保证，不限制旧存储接口的手工多批场景。
CREATE INDEX "message_batches_collecting_thread_idx"
  ON "kairo"."message_batches" ("thread_id")
  WHERE "status" = 'collecting';

-- Down Migration
DROP INDEX "kairo"."message_batches_collecting_thread_idx";
DROP INDEX "kairo"."message_batches_pending_bot_idx";
ALTER TABLE "kairo"."message_batches"
  DROP CONSTRAINT "message_batches_rejection_reason_check",
  DROP COLUMN "settled_at",
  DROP COLUMN "rejection_reason",
  DROP COLUMN "finished_at";
