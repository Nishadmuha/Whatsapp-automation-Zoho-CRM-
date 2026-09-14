CREATE TABLE lead_sessions (
  id TEXT PRIMARY KEY,
  sender_phone TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('collecting','awaiting_confirmation','completed')),
  result TEXT NOT NULL,
  validation_result TEXT NOT NULL,
  original_message TEXT NOT NULL,
  first_message_id TEXT NOT NULL REFERENCES whatsapp_messages(whatsapp_message_id),
  lead_id TEXT REFERENCES leads(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK ((state='completed' AND lead_id IS NOT NULL AND completed_at IS NOT NULL)
    OR (state<>'completed' AND lead_id IS NULL AND completed_at IS NULL))
);
CREATE UNIQUE INDEX lead_sessions_active_sender ON lead_sessions(sender_phone) WHERE state IN ('collecting','awaiting_confirmation');
CREATE INDEX lead_sessions_sender ON lead_sessions(sender_phone,created_at,id);
ALTER TABLE whatsapp_messages ADD COLUMN sender_name TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN media_id TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN media_mime_type TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN media_filename TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN session_id TEXT REFERENCES lead_sessions(id);
ALTER TABLE whatsapp_messages ADD COLUMN conversation_kind TEXT;
CREATE TABLE message_receipts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_messages(whatsapp_message_id)
);
INSERT INTO message_receipts(message_id) SELECT whatsapp_message_id FROM whatsapp_messages ORDER BY created_at,whatsapp_message_id;
CREATE INDEX whatsapp_messages_sender_history ON whatsapp_messages(sender_phone,created_at,whatsapp_message_id);
