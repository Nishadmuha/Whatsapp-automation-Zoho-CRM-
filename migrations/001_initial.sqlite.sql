CREATE TABLE whatsapp_messages (
  whatsapp_message_id TEXT PRIMARY KEY,
  sender_phone TEXT NOT NULL,
  message_text TEXT NOT NULL,
  message_type TEXT NOT NULL,
  authenticated INTEGER NOT NULL DEFAULT 0 CHECK (authenticated IN (0,1)),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (processing_status IN ('RECEIVED','PROCESSING','SUCCESS','FAILED','NEEDS_INFORMATION')),
  extracted_lead_data TEXT,
  zoho_lead_id TEXT,
  crm_action TEXT,
  crm_write_started INTEGER NOT NULL DEFAULT 0 CHECK (crm_write_started IN (0,1)),
  error_message TEXT,
  processed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT
);
CREATE INDEX whatsapp_messages_work ON whatsapp_messages(processing_status,next_attempt_at,lease_expires_at,created_at);
CREATE TABLE crm_contacts (
  contact_key TEXT PRIMARY KEY,
  zoho_lead_id TEXT,
  uncertain INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE TABLE processing_logs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES whatsapp_messages(whatsapp_message_id),
  event TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX processing_logs_message ON processing_logs(message_id,created_at);
CREATE TABLE reply_outbox (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_messages(whatsapp_message_id),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','FAILED','UNKNOWN')),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  error_message TEXT,
  provider_message_id TEXT,
  lease_token TEXT,
  lease_expires_at TEXT
);
CREATE INDEX reply_outbox_work ON reply_outbox(status,created_at);
CREATE TABLE contact_locks (
  contact_key TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL
);
