-- Retain outbound text and delivery evidence when an operator replaces a failed
-- job's outbox slot. This archive is history only and is never dispatched.
CREATE TABLE reply_history (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES whatsapp_messages(whatsapp_message_id),
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SENT','FAILED','CANCELLED')),
  provider_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX reply_history_message_idx ON reply_history(message_id,created_at);
