-- حافظهٔ کوتاه مکالمه برای پاسخ‌های مرتبط
CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_user_id
  ON conversation_messages (user_id, id);

-- ثبت وضعیت پردازش هر آپدیت تلگرام
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL
    CHECK (status IN ('processing', 'completed', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
