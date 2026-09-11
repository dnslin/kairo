-- Up Migration
-- 检查结果属于原执行尝试；被拒绝的模型原文不保存为可采用答案。
ALTER TABLE "kairo"."task_attempts"
  ADD COLUMN "answer_result" jsonb,
  ADD COLUMN "answer_diagnostics" text[];

-- Down Migration
ALTER TABLE "kairo"."task_attempts"
  DROP COLUMN "answer_diagnostics",
  DROP COLUMN "answer_result";
