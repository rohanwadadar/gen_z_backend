-- Users table (for password auth)
CREATE TABLE IF NOT EXISTS users (
  email        TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at   TIMESTAMP DEFAULT NOW()
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  sender_email    TEXT NOT NULL,
  message_content TEXT NOT NULL,
  room_id         TEXT NOT NULL,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- Chat requests table
CREATE TABLE IF NOT EXISTS chat_requests (
  id              TEXT PRIMARY KEY,
  requester_email TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  room_id         TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_messages_room    ON messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_recip   ON chat_requests(recipient_email, status);
CREATE INDEX IF NOT EXISTS idx_requests_request ON chat_requests(requester_email, status);
