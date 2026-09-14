CREATE TABLE whatsapp_messages (
  whatsapp_message_id TEXT PRIMARY KEY,
  sender_phone TEXT NOT NULL,
  message_text TEXT NOT NULL,
  message_type TEXT NOT NULL,
  authenticated BOOLEAN NOT NULL DEFAULT FALSE,
  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (processing_status IN ('RECEIVED','PROCESSING','SUCCESS','FAILED','NEEDS_INFORMATION')),
  extracted_lead_data JSONB,
  zoho_lead_id TEXT,
  crm_action TEXT,
  crm_write_started BOOLEAN NOT NULL DEFAULT FALSE,
  error_message TEXT,
  processed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ
);
CREATE INDEX whatsapp_messages_work ON whatsapp_messages(processing_status,next_attempt_at,lease_expires_at,created_at);
CREATE TABLE crm_contacts (
  contact_key TEXT PRIMARY KEY,
  zoho_lead_id TEXT,
  uncertain BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE processing_logs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES whatsapp_messages(whatsapp_message_id),
  event TEXT NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX processing_logs_message ON processing_logs(message_id,created_at);
CREATE TABLE reply_outbox (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_messages(whatsapp_message_id),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','FAILED','UNKNOWN')),
  created_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  provider_message_id TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ
);
CREATE INDEX reply_outbox_work ON reply_outbox(status,created_at);
