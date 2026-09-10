-- Up Migration
ALTER TABLE "kairo"."tasks"
  ADD COLUMN "execution_budget_ms" bigint CHECK ("execution_budget_ms" > 0),
  ADD COLUMN "queue_notice_required" boolean NOT NULL DEFAULT false,
  ADD COLUMN "current_wait_id" text REFERENCES "kairo"."user_waits" ("wait_id");

-- 旧账本等待态只有一条开放等待，直接关联实际记录，不推测历史轮次先后。
UPDATE "kairo"."tasks" t SET "current_wait_id" = w."wait_id"
  FROM "kairo"."user_waits" w
  WHERE t."task_id" = w."task_id" AND t."input_version" = w."input_version"
    AND t."status" = 'waiting_for_user' AND w."closed_at" IS NULL;

ALTER TABLE "kairo"."message_batches"
  DROP CONSTRAINT "message_batches_rejection_reason_check",
  ADD CONSTRAINT "message_batches_rejection_reason_check"
    CHECK ("rejection_reason" IN ('attachment', 'too_long', 'queue_full'));

-- 调度读取有效上下文内的非终态任务；会话索引覆盖容量、阻塞与先后顺序查询。
CREATE INDEX "tasks_active_created_idx"
  ON "kairo"."tasks" ("created_at", "task_id")
  WHERE "status" IN ('queued', 'running', 'waiting_for_user', 'ready_to_send', 'sending');
CREATE INDEX "tasks_active_session_idx"
  ON "kairo"."tasks" ("bot_id", "session_id", "created_at", "task_id")
  WHERE "status" IN ('queued', 'running', 'waiting_for_user', 'ready_to_send', 'sending');

-- Down Migration
-- 降级前须处理 queue_full 批次及待执行任务；保留严格旧约束，拒绝不兼容数据降级。
DROP INDEX "kairo"."tasks_active_session_idx";
DROP INDEX "kairo"."tasks_active_created_idx";
ALTER TABLE "kairo"."message_batches"
  DROP CONSTRAINT "message_batches_rejection_reason_check",
  ADD CONSTRAINT "message_batches_rejection_reason_check"
    CHECK ("rejection_reason" IN ('attachment', 'too_long'));
ALTER TABLE "kairo"."tasks"
  DROP COLUMN "current_wait_id",
  DROP COLUMN "queue_notice_required",
  DROP COLUMN "execution_budget_ms";
