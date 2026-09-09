-- Up Migration
-- 逐消息忙碌检查和上下文切换按 thread 定位，避免扫描其他会话的历史批次。
CREATE INDEX "message_batches_thread_idx" ON "kairo"."message_batches" ("thread_id");

-- Down Migration
DROP INDEX "kairo"."message_batches_thread_idx";
