ALTER TABLE leads ADD COLUMN address TEXT CHECK (address IS NULL OR length(address)<=1000);
ALTER TABLE leads ADD COLUMN trn_no TEXT CHECK (trn_no IS NULL OR length(trn_no)<=40);
ALTER TABLE whatsapp_messages ADD COLUMN transcription TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN extracted_text TEXT;
ALTER TABLE lead_sessions ADD COLUMN pending_action TEXT CHECK (pending_action IS NULL OR pending_action='new_lead');
ALTER TABLE lead_sessions DROP CONSTRAINT lead_sessions_state_check;
ALTER TABLE lead_sessions ADD CONSTRAINT lead_sessions_state_check CHECK (state IN ('collecting','awaiting_confirmation','completed','discarded'));
ALTER TABLE lead_sessions DROP CONSTRAINT lead_sessions_check;
ALTER TABLE lead_sessions ADD CONSTRAINT lead_sessions_check CHECK (
  (state='completed' AND lead_id IS NOT NULL AND completed_at IS NOT NULL AND pending_action IS NULL)
  OR (state='discarded' AND lead_id IS NULL AND completed_at IS NOT NULL AND pending_action IS NULL)
  OR (state IN ('collecting','awaiting_confirmation') AND lead_id IS NULL AND completed_at IS NULL)
);
