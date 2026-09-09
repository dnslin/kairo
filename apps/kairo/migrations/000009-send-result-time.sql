-- Up Migration
ALTER TABLE "kairo"."send_dispatches"
  ADD COLUMN "result_at" timestamptz;

-- Down Migration
ALTER TABLE "kairo"."send_dispatches"
  DROP COLUMN "result_at";
