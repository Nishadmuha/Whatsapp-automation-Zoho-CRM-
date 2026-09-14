ALTER TABLE leads ADD COLUMN address TEXT CHECK (address IS NULL OR length(address)<=1000);
ALTER TABLE leads ADD COLUMN trn_no TEXT CHECK (trn_no IS NULL OR length(trn_no)<=40);
ALTER TABLE whatsapp_messages ADD COLUMN transcription TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN extracted_text TEXT;

-- The driver disables foreign-key enforcement before its migration transaction
-- and verifies all references before committing this parent-table replacement.
CREATE TABLE lead_sessions_v6 (
  id TEXT PRIMARY KEY,
  sender_phone TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('collecting','awaiting_confirmation','completed','discarded')),
  result TEXT NOT NULL,
  validation_result TEXT NOT NULL,
  original_message TEXT NOT NULL,
  first_message_id TEXT NOT NULL REFERENCES whatsapp_messages(whatsapp_message_id),
  lead_id TEXT REFERENCES leads(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  pending_action TEXT CHECK (pending_action IS NULL OR pending_action='new_lead'),
  CHECK ((state='completed' AND lead_id IS NOT NULL AND completed_at IS NOT NULL AND pending_action IS NULL)
    OR (state='discarded' AND lead_id IS NULL AND completed_at IS NOT NULL AND pending_action IS NULL)
    OR (state IN ('collecting','awaiting_confirmation') AND lead_id IS NULL AND completed_at IS NULL))
);
INSERT INTO lead_sessions_v6(id,sender_phone,state,result,validation_result,original_message,first_message_id,lead_id,created_at,updated_at,completed_at)
  SELECT id,sender_phone,state,result,validation_result,original_message,first_message_id,lead_id,created_at,updated_at,completed_at FROM lead_sessions;
DROP TABLE lead_sessions;
ALTER TABLE lead_sessions_v6 RENAME TO lead_sessions;
CREATE UNIQUE INDEX lead_sessions_active_sender ON lead_sessions(sender_phone) WHERE state IN ('collecting','awaiting_confirmation');
CREATE INDEX lead_sessions_sender ON lead_sessions(sender_phone,created_at,id);
