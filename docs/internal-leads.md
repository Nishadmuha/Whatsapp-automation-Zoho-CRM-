# Phase 2: internal leads and dashboard

> Updated by [Boss lead chat and history](boss-chat.md). New boss intake now uses persistent sessions and explicit save confirmation instead of immediate per-message lead creation. Every individual lead field is optional, and any available factual subset can be confirmed and saved. Migration 005 adds session and media metadata, `/admin/chats` exposes retained inbox/outbox history, and newly confirmed leads keep Zoho `not_started`. The immediate-save workflow and migration 004 details below describe the earlier Phase 2 implementation.

The existing Express server now routes new signed WhatsApp text receipts by the normalized sender phone. Authorized boss messages use OpenAI extraction, business validation and internal database storage. Other customers retain the existing conversational OpenAI processor and WhatsApp response. No Zoho module, OAuth request, CRM search, create or update is connected to this runtime path.

## Configuration

Reuse the private working WhatsApp/Meta credentials, `OPENAI_API_KEY`, `OPENAI_MODEL`, `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, `DATABASE_URL` and worker settings. No extra server, Redis, database or provider is required.

```dotenv
AUTOMATION_ENABLED=false
AI_PROVIDER=openai
AUTHORIZED_BOSS_PHONES=
ADMIN_USERNAME=
ADMIN_PASSWORD=
```

`AUTOMATION_ENABLED` defaults to false and controls extraction, customer generation and outbox delivery. An already enabled private configuration is preserved. It does not disable authenticated read-only access to previously stored leads.

`AUTHORIZED_BOSS_PHONES` is a private comma-separated list. Formats such as `0501234567`, `+971501234567` and `971501234567` resolve to the same UAE sender. International country codes are preserved; foreign local formats are not assigned the UAE country code. Message contents, profile names, forwarded numbers and claims to be the boss cannot authorize a sender. The optional global `ALLOWED_SENDER_PHONES` filter still applies independently.

The legacy `BOSS_SENDER_PHONES` value is used only if the canonical setting is absent. An explicitly blank canonical setting disables boss authorization even if the legacy variable remains populated. Neither list is logged.

The dashboard uses a username/password login on the existing Express server. Set private `ADMIN_USERNAME` and `ADMIN_PASSWORD` together; usernames contain 1–64 letters, numbers, dots, underscores or hyphens, and passwords contain 8–256 characters without control characters. Leaving both blank disables protected API access. Credentials are never embedded in frontend assets or URLs. The earlier token-entry login and `ADMIN_API_TOKEN` authorization have been retired.

Open `/admin/leads` and enter your configured username and password. The form sends credentials once to `POST /api/admin/login`; successful login creates a random, server-managed session in an HttpOnly, SameSite=Strict cookie scoped to `/api`. JavaScript cannot read the cookie. The password input is cleared immediately and no credentials are put in browser local/session storage. `GET /api/admin/session` restores an active login after refresh, and `POST /api/admin/logout` revokes it. Sessions expire after eight hours and are cleared by a backend restart. Session state is bounded in the existing Node process; there is no extra database or Redis dependency. This single-process login does not provide multi-user accounts or sessions shared across production replicas.

Login attempts are rate limited, credentials are compared without exposing which field was wrong, and login/logout reject cross-site browser requests. Cookies are Secure for production, direct HTTPS or a matching HTTPS browser Origin through the existing ngrok tunnel. The authentication layer does not trust arbitrary forwarded headers or change the webhook's proxy configuration. Use the existing HTTPS endpoint for remote access.

## Historical Phase 2 routing, storage and delivery

1. Existing Meta verification and raw-body HMAC validation run before intake. Unsupported message types remain ignored.
2. An eligible new boss receipt is stored with `processing_flow=boss_lead`. Its original inbox text, extraction job and pending lead submission commit in the same transaction. Customer receipts use `conversation` and create no lead.
3. The boss worker rechecks authorization and the master switch, calls the existing OpenAI service and validates its structured response. The Phase 1 schema, bounded input/output, source grounding and conservative contact normalization remain in use.
4. Lead fields, validation result, job completion, terminal inbox status and one confirmation outbox row commit together under the extraction lease. Only then can the existing WhatsApp dispatcher call `sendTextMessage()`.
5. Duplicate webhook deliveries cannot create another lead, job or confirmation. Customer conversation claims cannot take boss jobs. Existing Phase 1 jobs retain their original processing scope rather than being silently replayed as new leads.

Valid lead confirmation:

> ✅ Lead received and saved internally. Zoho CRM sync is currently pending.

The earlier Phase 2 flow retained incomplete submissions for dashboard review and identified missing information in its saved-for-review reply. That mandatory-field behavior is superseded by the current optional-field policy below. Extracted JSON is never sent to WhatsApp. The historical irrelevant-message path removed the unpopulated lead placeholder while retaining the original inbox record and extraction classification for audit.

Customer and boss processing use independent instances of the existing worker in the same Node process and share the existing OpenAI and WhatsApp service instances. Slow or failed extraction does not block the customer reply worker.

## Current validation policy

Schema validation and business validation are separate. Provider failures have `error_stage=extraction`; malformed structured output has `schema`; business/authorization failures have `validation`; database completion failures have `persistence`. Error codes and log summaries contain no provider error bodies, secrets or customer message text.

No individual lead field is mandatory. Company, contact name, phone, email, address, TRN, project, location, quantity, deadline, notes, requirement and product/service are all optional and nullable. A single meaningful factual field is a valid lead draft. No missing details are inferred from the boss's identity. Source matching and schema validation reduce invented data; they do not prove that every model classification or field assignment is correct.

After each factual update, the current flow asks exactly: “I have the available information for this lead. Is everything complete and ready to save?” Only explicit boss confirmation saves the draft. Missing fields do not block saving or trigger a requirement/product loop. No/Not yet keeps the draft open; additional facts merge and prompt confirmation again. Successful persistence replies “Lead saved successfully ✅”.

```json
{"valid": true, "missing_fields": [], "errors": []}
```

## Database migration 004

`004_leads.sqlite.sql` and `004_leads.postgres.sql` use the existing migration runner. SQLite development and PostgreSQL production retain the same driver abstraction. Old migrations remain unchanged. Migration 004 extends the inbox processing-flow constraint to support `boss_lead` and creates `leads`; it does not backfill old receipts into leads or replay provider calls.

| Columns | Purpose |
| --- | --- |
| `id` | UUID primary key. |
| `whatsapp_message_id` | Unique source inbox reference; one submission per WhatsApp message. |
| `sender_phone`, `original_message` | Normalized authenticated sender and exactly preserved original message. |
| `company_name`, `contact_name`, `phone`, `email` | Nullable extracted customer identity and contact details. |
| `project_name`, `project_location`, `product_or_service`, `requirement` | Nullable project/enquiry details. |
| `quantity`, `deadline`, `notes` | Nullable source-derived text; relative deadlines are not guessed into dates. |
| `extraction_status`, `validation_status` | Current extraction and business-validation states. |
| `validation_result` | Structured `{valid,missing_fields,errors}` JSON. |
| `error_stage`, `error_code` | Nullable safe diagnostic classification. |
| `zoho_status`, `zoho_lead_id` | Internal future-sync state and nullable future provider ID. |
| `created_at`, `updated_at` | Database timestamps. |

Extraction states: `pending`, `processing`, `completed`, `failed`. Validation states: `pending`, `valid`, `incomplete`, `invalid`. The future Zoho status vocabulary is `not_started`, `pending`, `existing_found`, `creating`, `updating`, `saved`, `failed`; this phase writes only `not_started` or `pending`, with no Zoho ID. Valid leads are pending future integration. Incomplete and failed submissions are not started. Pending does not mean that a Zoho sync worker exists.

AI failures retain the exact original message and a failed submission with nullable customer fields. Retryable timeouts, rate limits, provider unavailability and persistence failures use the existing bounded retry/lease architecture. A persistence failure never authorizes a success confirmation. A failed or uncertain WhatsApp send does not roll back the lead; the existing outbox failure/reconciliation behavior and customer-service window remain in force.

The historical `messages retry` operator command refuses `boss_lead` jobs before changing any data. That command only resets the old inbox workflow and cannot correctly requeue an independent lead extraction. Automatic lead retries remain supported; a dedicated manual lead retry/edit API is outside this phase.

## Read-only API and dashboard

All `/api/leads` endpoints require a valid dashboard session cookie, use no-store responses and enforce request rate and query bounds. Bearer tokens and credentials in URLs do not authorize API access. Responses use explicit field whitelists. Known configured credentials accidentally present inside a stored string are redacted from the API representation; the original database message remains unchanged.

| Endpoint | Result |
| --- | --- |
| `GET /api/leads` | `{items,total,page,page_size,total_pages}`, newest first. |
| `GET /api/leads/:id` | One lead detail object, including original message and validation; 404 if absent. |
| `GET /api/leads/stats` | Numeric `total`, `valid`, `incomplete`, `extraction_failed`, `zoho_pending`, `zoho_saved` counters. |

List query options: `page` (default 1), `page_size` (default 20, maximum 100), `search` (maximum 200 characters), `validation_status`, `extraction_status`, and `zoho_status`. `status` is an alias for `validation_status`. Conflicting, repeated, unknown or invalid parameters return 400. Search is parameterized and literal wildcard characters cannot broaden it unexpectedly.

`/admin/leads` provides total/valid/incomplete/Zoho-pending cards, a searchable and filterable paginated table, and lead details with original text, extracted fields, validation and Zoho status. It has no Meta, OpenAI or Zoho browser integration. The public login shell contains no lead data; API access requires an authenticated session. Static assets and `/favicon.svg` are served from the same Express app, without a separate frontend build or dependency. Legacy browser requests for `/favicon.ico` return 204.

## Implementation validation

The later username/password login update passed `npm.cmd test` with **367 passed, 0 failed, 61 optional PostgreSQL cases skipped** (428 total), plus lint and syntax checks. The restarted backend verified login, session restoration, authenticated leads list/stats, logout revocation and favicon responses using the configured private credentials. The ngrok process remained running. No OpenAI, WhatsApp, Meta or Zoho provider call was made by these checks.

The implementation report records final test results and changed files below. Tests use mocked OpenAI and WhatsApp services, temporary SQLite files, and optional isolated PostgreSQL fixtures. No live provider call or production migration is part of these checks. The running backend and ngrok are not restarted automatically.

### Phase 2 implementation checks before activation — 12 September 2026

- `npm.cmd test`: **413 tests total; 352 passed, 0 failed, 61 skipped**. The skipped cases require an isolated PostgreSQL `TEST_DATABASE_URL`, which was not configured.
- `npm.cmd run lint`: passed.
- `npm.cmd run check`: passed; all JavaScript syntax checks completed.
- Startup regression tests demonstrate exclusive boss routing, unchanged customer generation, customer delivery while boss extraction waits, and truthful boss confirmations only after database persistence. Mocked extraction authentication failure leaves the webhook and customer reply flow operational.
- Tests cover complete, incomplete, irrelevant and malformed extractions; normalization and impersonation; deduplication; lease expiry/revocation; bounded retries; database failures before and after commit acknowledgement; confirmation failure/uncertainty; API authentication, redaction, detail/stats/search/filters/pagination; dashboard safe rendering, login, filtering, pagination and logout isolation.
- The customer conversation processor, WhatsApp transport, reply dispatcher and shared worker have unchanged SHA-256 hashes from Phase 1. HMAC validation and Meta configuration were not changed.
- A source/documentation scan found zero occurrences of the actual configured private provider credentials, app secret, verification token, phone number ID or authorized boss number.
- No real OpenAI, Meta, WhatsApp or Zoho request was made for implementation or testing. Historical Zoho unit tests still use mocked transport; no Zoho module is loaded by the new live workflow.
- Browser visual review was unavailable: browser control returned no available browser, and automatic approval review rejected launching headless Chrome with “blocked by policy.” Dashboard DOM behavior, local assets, API and security tests passed. A temporary mocked preview was stopped after inspection attempts.
- At the end of implementation, the original backend and ngrok processes were still running and the runtime schema was version **2**. The subsequent user-authorized restart backed up SQLite, applied migrations 003 and 004, and verified readiness, dashboard and protected API access successfully with schema version **4**.
- The initial Phase 2 configuration copied the previously authorized boss list into `AUTHORIZED_BOSS_PHONES` and generated an admin token. The user's later username/password login change retired that token and uses `ADMIN_USERNAME` and `ADMIN_PASSWORD` instead. Existing provider credentials, model, customer access and enabled master-switch value were preserved. Source/example defaults remain disabled.

### Files changed

All paths below are relative to the backend project.

| Area | Files |
| --- | --- |
| Configuration and routing | `.env` (private), `.env.example`, `src/config/env.js`, `src/routes/webhook.js`, `src/server.js`, `src/utils/phone.js`, `src/utils/logger.js`, `src/services/whatsapp/whatsappParser.js` |
| Lead services and operator compatibility | `src/services/leads/leadExtractor.js` (new), `src/services/leads/leadValidator.js`, `src/services/leads/leadService.js` (new), `src/services/leads/bossLeadWorkflow.js` (new), `src/services/admin/messagesAdmin.js` |
| Database | `src/database/index.js`, `src/database/drivers.js`, `migrations/004_leads.sqlite.sql` (new), `migrations/004_leads.postgres.sql` (new) |
| API and dashboard | `src/app.js`, `src/routes/leads.js` (new), `src/middleware/adminAuth.js` (new), `src/admin/leads.html` (new), `src/admin/leads.css` (new), `src/admin/leads.js` (new), `eslint.config.js` |
| Tests | `test/bossRouting.test.js` (new), `test/bossLeadStartup.test.js`, `test/startup.test.js`, `test/leadWorkflow.test.js` (new), `test/leadWorkflowDatabase.test.js` (new), `test/conversationDatabase.test.js`, `test/leadExtractionDatabase.test.js`, `test/leadsApi.test.js` (new), `test/leadsDashboard.test.js` (new), `test/admin.test.js` |
| Documentation | `README.md`, `docs/internal-leads.md` (new), `docs/lead-database.md` (new), `docs/conversational-replies.md`, `docs/boss-lead-extraction.md`, `docs/automation-reference.md`, `src/database/README.md` |
