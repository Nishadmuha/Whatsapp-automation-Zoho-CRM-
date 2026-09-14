ALTER TABLE whatsapp_messages DROP CONSTRAINT whatsapp_messages_processing_flow_check;
ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_messages_processing_flow_check
  CHECK (processing_flow IS NULL OR processing_flow IN ('conversation','boss_lead'));

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
  validation_result JSONB,
  error_stage TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX leads_created ON leads(created_at,id);
CREATE INDEX leads_status ON leads(validation_status,extraction_status,zoho_status,created_at);
