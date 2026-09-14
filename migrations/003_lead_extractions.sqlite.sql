CREATE TABLE lead_extractions (
  message_id TEXT PRIMARY KEY REFERENCES whatsapp_messages(whatsapp_message_id),
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (processing_status IN ('RECEIVED','PROCESSING','SUCCESS','IRRELEVANT','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  result TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX lead_extractions_work
  ON lead_extractions(processing_status,next_attempt_at,lease_expires_at,created_at);
