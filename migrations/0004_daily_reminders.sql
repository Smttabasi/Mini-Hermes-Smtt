-- A daily receipt avoids repeating a successfully recorded reminder.
-- Failed sends can be retried by the next cron invocation during the target hour.
CREATE TABLE IF NOT EXISTS daily_reminders (
  day TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  updated_at INTEGER NOT NULL,
  claim_token TEXT NOT NULL
);
