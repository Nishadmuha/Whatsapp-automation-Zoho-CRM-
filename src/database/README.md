# Voltronix WhatsApp CRM Database Layer (MongoDB Atlas)

## Architecture Overview

The Voltronix WhatsApp CRM backend uses **MongoDB Atlas** as its sole, unified persistence layer.
All queues, workers, sessions, messages, leads, outbox messages, distributed locks, and admin APIs interface through `MongoMessageStore` (`src/database/mongoStore.js`), exposed via `src/database/index.js`.

SQLite and PostgreSQL have been completely eliminated from the production runtime and codebase.

---

## Collections & Schema Architecture

To prevent unbounded document growth and maintain high throughput, the data model is partitioned across dedicated collections:

1. **`messages`**: Inbound WhatsApp messages, receipt deduplication, processing leases, and message-level metadata.
2. **`reply_outbox`**: Pending outbound WhatsApp messages with lease tokens, attempt caps, and 23-hour delivery window enforcement.
3. **`reply_history`**: Permanent archive of replaced or cancelled replies for full conversational audit history.
4. **`leads`**: Master lead records containing contact facts, company details, requirements, extraction metadata, and Zoho CRM sync fields (`zoho_lead_id`, `zoho_lead_url`, `zoho_status`, `zoho_synced_at`, `zoho_error`).
5. **`lead_sessions`**: Ephemeral Boss conversation sessions tracking conversation state (`collecting`, `awaiting_confirmation`, `completed`, `discarded`), draft facts, and turnaround checkpoints.
6. **`lead_extractions`**: Asynchronous lead extraction jobs, leases, attempts, and bounded JSON extraction results.
7. **`contact_locks`**: Distributed, lease-fenced contact serialization locks for atomic CRM mutations and race-condition prevention across instances.
8. **`contact_leads`**: Canonical mappings between contact keys (phone numbers) and known Zoho CRM Lead IDs.

---

## Boss Confirmation & Zoho CRM Sync Gate

1. **Mandatory Confirmation Gate**:
   - Zero Zoho CRM API calls happen before explicit Boss confirmation (`YES` / `CONFIRM` / `SAVE`).
   - Boss is prompted with extracted lead details before any sync.
2. **Post-Confirmation Workflow**:
   - On Boss `YES`, the lead is permanently saved in MongoDB Atlas.
   - The backend pushes/creates/updates the lead in Zoho CRM.
   - The authentic Zoho Lead ID from the Zoho API response is recorded in MongoDB.
   - A direct Zoho CRM URL (`https://crm.zoho.com/crm/.../tab/Leads/<zoho_lead_id>`) is generated.
   - A confirmation message is returned to Boss containing the contact details, real Zoho Lead ID, and clickable direct Zoho URL.
3. **Manual Dashboard Fallback**:
   - If Zoho API sync encounters an error or network timeout, the lead remains safely saved in MongoDB with `zoho_status: 'failed'`.
   - The Admin/Leads dashboard retains the manual "Push to Zoho" action for operators to retry synchronization at any time.

---

## Concurrency & Distributed Leases

- **Worker Leases**: Inbox processing, reply dispatch, and lead extraction use TTL-backed lease tokens (`lease_token`, `lease_expires_at`).
- **Contact Locks**: `withContactLock(key, callback)` uses atomic `findAndModify` operations on `contact_locks` with renewable timeouts to serialize operations per phone number across clustered worker processes.

---

## Configuration & Connection

MongoDB connection is configured via standard environment variables:
- `MONGODB_URI`: Primary MongoDB connection string (e.g., `mongodb+srv://...`).
- `DATABASE_NAME`: Database name (defaults to `voltronix_crm`).
- `TEST_MONGODB_URI` / `DATABASE_URL`: Supported test environment overrides.
