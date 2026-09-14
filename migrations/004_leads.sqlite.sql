CREATE TABLE whatsapp_messages_v4 (
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
  lease_expires_at TEXT,
  processing_flow TEXT CHECK (processing_flow IS NULL OR processing_flow IN ('conversation','boss_lead'))
);
INSERT INTO whatsapp_messages_v4 SELECT * FROM whatsapp_messages;
DROP TABLE whatsapp_messages;
ALTER TABLE whatsapp_messages_v4 RENAME TO whatsapp_messages;
CREATE INDEX whatsapp_messages_work ON whatsapp_messages(processing_status,next_attempt_at,lease_expires_at,created_at);
CREATE INDEX whatsapp_messages_flow_work ON whatsapp_messages(processing_flow,processing_status,next_attempt_at,lease_expires_at,created_at);

CREATE TABLE leads (
  id TEXT NOT NULL PRIMARY KEY,
  whatsapp_message_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_messages(whatsapp_message_id),
  sender_phone TEXT NOT NULL,
  original_message TEXT NOT NULL,
  company_name TEXT,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  project_name TEXT,
  project_location TEXT,
  product_or_service TEXT,
  requirement TEXT,
  quantity TEXT,
  deadline TEXT,
  notes TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending','processing','completed','failed')),
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending','valid','incomplete','invalid')),
  zoho_status TEXT NOT NULL DEFAULT 'not_started' CHECK (zoho_status IN ('not_started','pending','existing_found','creating','updating','saved','failed')),
  zoho_lead_id TEXT,
  validation_result TEXT,
  error_stage TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX leads_created ON leads(created_at,id);
CREATE INDEX leads_status ON leads(validation_status,extraction_status,zoho_status,created_at);
