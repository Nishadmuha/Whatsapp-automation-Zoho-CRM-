ALTER TABLE whatsapp_messages ADD COLUMN processing_flow TEXT
  CHECK (processing_flow IS NULL OR processing_flow = 'conversation');
CREATE INDEX whatsapp_messages_flow_work
  ON whatsapp_messages(processing_flow,processing_status,next_attempt_at,lease_expires_at,created_at);
