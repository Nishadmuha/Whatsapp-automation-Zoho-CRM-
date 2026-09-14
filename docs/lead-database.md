# Lead database contract

Phase 2 uses the existing message store, SQLite development database, PostgreSQL production database, and leased workers. Migration `004_leads` adds the `leads` table and permits the `boss_lead` inbox processing flow. It creates no leads from old receipts or extraction results.

## Intake and ownership

The webhook derives the trusted per-message `request_lead_workflow` boolean from authenticated sender authorization. `enqueueMany` accepts it only for a newly inserted, authenticated, nonblank text receipt. The transaction stores the exact sender and original message, creates one extraction job and one UUID lead placeholder, and assigns `processing_flow='boss_lead'`. The message ID remains unique in each table. Duplicate delivery never adds, retags, or overwrites lead work.

Customer conversation claims and generic legacy inbox claims exclude `boss_lead`. `claimLeadExtraction` supports both old Phase 1 `conversation` jobs and new `boss_lead` jobs; each claim returns its original source metadata and an independently fenced extraction lease. Phase 1 completion cannot finish a Phase 2 job. Internal extraction has no WhatsApp service-window cutoff.

The user workflow, eleven nullable lead fields and status model are documented in [Internal leads](internal-leads.md). `validation_result` is JSON text on SQLite and JSONB on PostgreSQL. IDs are generated with `crypto.randomUUID()`; original messages are retained without rewriting.

## Atomic completion and failure

`completeLeadWorkflow(messageId, leaseToken, {result, validation, replyText})` requires a current extraction lease and `boss_lead` source. It commits the extraction result, structured lead, validation, terminal inbox status, and unique confirmation outbox entry together. A valid lead becomes Zoho `pending`; incomplete or invalid leads remain `not_started`. An irrelevant message removes only its pristine placeholder while retaining the original inbox, `IRRELEVANT` extraction result, and guidance reply. The method returns `false` for stale ownership.

`failLeadWorkflow(messageId, leaseToken, {code, stage, nextAttemptAt, replyText})` atomically records safe extraction/schema/validation/persistence failure details. Scheduled retries keep the inbox waiting and cannot enqueue a terminal reply. Terminal failures finish the inbox and may queue one failure response. Attempts and expired leases remain bounded. No error path fabricates lead fields or changes a completed lead.

Confirmation sending uses `claimReply({processingFlow:'boss_lead'})` after the persistence transaction commits. The existing 23-hour window, lease, delivery state and reconciliation rules apply. A later failed, expired or uncertain send leaves the saved lead intact. These methods make no Zoho or other provider calls.

## Dashboard reads

- `getLead(id)` accepts a UUID and returns a whitelisted lead row or `null`.
- `listLeads({page=1,pageSize=20,search='',validationStatus,extractionStatus,zohoStatus})` returns `{items,total,page,pageSize,totalPages}`. Page size is 1–100; search is at most 200 characters. Filters use the persisted status values. Search matches literal substrings across the eleven fields, sender and original message; SQL wildcard characters are escaped. Ordering is newest creation time first, then descending UUID for deterministic ties.
- `getLeadStats()` returns numeric `total`, `valid`, `incomplete`, `extraction_failed`, `zoho_pending`, and `zoho_saved` counts. Saved counts require the actual `saved` status and a nonempty Zoho record ID; pending work is never counted as saved.

Reads use an explicit field whitelist and parameterized SQL. The internal API remains responsible for authentication and credential redaction in its output DTO, including values pasted into original messages.

## Migration and verification

SQLite migration 004 rebuilds the inbox table to widen its existing flow constraint while preserving all columns, message IDs and child references. The driver disables foreign-key enforcement before the migration transaction, verifies every reference before commit, and restores enforcement for normal queries. PostgreSQL changes the existing check constraint in place. Both drivers retain transactional, ordered and idempotent migration tracking.

Database tests cover upgrades from versions 1, 2 and 3; reference preservation; no backfill; duplicate intake; independent job fencing and retries; atomic rollback; confirmation failure; literal search, combined filters, pagination and stats. PostgreSQL counterparts run only when an isolated `TEST_DATABASE_URL` is supplied. Tests use temporary stores and synthetic data, never the runtime database or real provider calls.
