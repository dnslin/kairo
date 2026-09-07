-- Up Migration
ALTER TABLE "kairo"."send_operations"
  DROP CONSTRAINT "send_operations_message_type_check";

ALTER TABLE "kairo"."send_operations"
  ADD CONSTRAINT "send_operations_message_type_check"
  CHECK (
    "message_type" IN (
      'text',
      'rich-text',
      'reply',
      'image',
      'file',
      'url-card',
      'biz-message',
      'app-message',
      'chat-record',
      'voice'
    )
  );

-- Down Migration
ALTER TABLE "kairo"."send_operations"
  DROP CONSTRAINT "send_operations_message_type_check";

ALTER TABLE "kairo"."send_operations"
  ADD CONSTRAINT "send_operations_message_type_check"
  CHECK ("message_type" IN ('text', 'rich-text', 'reply', 'image', 'file'));
