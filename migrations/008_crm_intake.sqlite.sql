-- Additive CRM extensions. Existing inbox, sessions, leads and IDs are retained.
CREATE TABLE crm_outgoing (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL REFERENCES whatsapp_messages(whatsapp_message_id),
  sender_phone TEXT NOT NULL,
  lead_id TEXT REFERENCES leads(id),
  kind TEXT NOT NULL CHECK (kind IN ('ack','manual')),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','FAILED','UNKNOWN','CANCELLED')),
  provider_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX crm_outgoing_conversation ON crm_outgoing(sender_phone,created_at,id);
CREATE TABLE crm_read_state (sender_phone TEXT PRIMARY KEY,read_at TEXT NOT NULL);

CREATE TABLE lead_details (lead_id TEXT PRIMARY KEY REFERENCES leads(id),document TEXT NOT NULL);
CREATE TABLE lead_groups (
  id TEXT PRIMARY KEY,sender_phone TEXT NOT NULL,source TEXT NOT NULL CHECK (source IN ('boss','client')),
  lead_id TEXT NOT NULL REFERENCES leads(id),state TEXT NOT NULL CHECK (state IN ('open','closed')),
  last_message_at TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX lead_groups_active ON lead_groups(sender_phone,source) WHERE state='open';
CREATE TABLE lead_messages (
  message_id TEXT PRIMARY KEY REFERENCES whatsapp_messages(whatsapp_message_id),
  lead_id TEXT NOT NULL REFERENCES leads(id),group_id TEXT NOT NULL REFERENCES lead_groups(id),
  extracted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL
);
CREATE INDEX lead_messages_lead ON lead_messages(lead_id,created_at,message_id);
CREATE TABLE lead_attachments (
  id TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_messages(whatsapp_message_id),
  lead_id TEXT NOT NULL REFERENCES leads(id),whatsapp_media_id TEXT NOT NULL,type TEXT NOT NULL,
  mime_type TEXT,filename TEXT,storage_path TEXT,status TEXT NOT NULL DEFAULT 'pending',
  size_bytes INTEGER,sha256 TEXT,created_at TEXT NOT NULL
);
CREATE INDEX lead_attachments_lead ON lead_attachments(lead_id,created_at,id);
CREATE TABLE crm_greetings (sender_phone TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES whatsapp_messages(whatsapp_message_id),created_at TEXT NOT NULL);
