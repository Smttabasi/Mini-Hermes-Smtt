-- Lease ownership prevents an expired handler from repeating a database change.
-- The reply is committed with the action, so a Telegram send failure can be retried.
ALTER TABLE processed_updates ADD COLUMN claim_token TEXT;
ALTER TABLE processed_updates ADD COLUMN reply_text TEXT;
ALTER TABLE processed_updates ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0
  CHECK (delivered IN (0, 1));
