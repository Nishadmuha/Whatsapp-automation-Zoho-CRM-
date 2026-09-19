> Historical reference for the automation code that was already present before the webhook-only phase.
> For the current setup, follow [the root README](../README.md) and keep `AUTOMATION_ENABLED=false`.
> Zoho and boss approval remain deferred. `AUTOMATION_ENABLED=true` starts
> OpenAI conversational replies when `AI_PROVIDER=openai`, or fixed replies when it is blank.
> It does not activate the lead/CRM pipeline below; follow the current root README for setup.
> The new [Phase 2 boss workflow](internal-leads.md) stores and validates enquiries internally;
> it does not use the legacy lead processor or connect Zoho.
> This preserved document describes the earlier implementation, not the current startup behavior.

# Voltronix WhatsApp lead automation

A Node.js/Express backend that turns lead messages from authorized boss numbers into validated Zoho CRM Leads. It receives Meta webhooks, extracts customer details with OpenAI or Gemini, creates or updates CRM records, preserves original messages in SQL, and sends the boss a confirmation.

**Automation is disabled by default.** Installation, local startup, and automated tests need no Meta, AI, or Zoho credentials. Production integration code makes real API calls; mocks exist only in tests.

## Architecture

```text
Boss WhatsApp -> Meta Cloud API -> signed webhook
  -> sender/number/payload checks -> durable SQL inbox -> HTTP 200
  -> worker message lease -> AI extraction -> schema/contact validation
  -> contact locks + saved CRM mapping + Zoho search -> update or create
  -> save CRM result -> terminal status + durable reply outbox
  -> WhatsApp confirmation to the boss
```

The webhook acknowledges after committing eligible messages to SQL. It does not wait for AI, CRM, or replies. Storage failure returns `503` so Meta can redeliver. Unsupported events and non-text messages are acknowledged and ignored. The worker resumes eligible persisted work after restart.

| Path | Responsibility |
| --- | --- |
| `src/app.js`, `src/server.js` | Express app, startup, worker lifecycle and shutdown. |
| `src/config/env.js` | Environment validation and legacy aliases. |
| `src/routes/webhook.js` | Verification, raw-body HMAC signatures and durable intake. |
| `src/services/whatsapp/` | Payload parsing and text sending. |
| `src/services/ai/` | OpenAI/Gemini adapters and strict extraction schema. |
| `src/services/leads/` | Contact validation and processing pipeline. |
| `src/services/zoho/` | OAuth refresh, search, field mapping, create/update/get. |
| `src/database/`, `migrations/` | SQL drivers, durable inbox, contact mapping, leases and outbox. |
| `src/utils/`, `src/middleware/` | Phone normalization, structured logging and HTTP handling. |
| `scripts/`, `test/` | Local operations and automated tests. |

## Install

Use **Node.js 22.20 or newer**. Development uses Node's built-in SQLite; production requires PostgreSQL.

```powershell
cd "D:\whatsapp automation backend\voltronix-whatsapp-backend"
npm install --include=dev
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put the generated secret in `WEBHOOK_VERIFY_TOKEN`. Preserve any existing `.env`; it may already contain your settings. On macOS/Linux, use `cp .env.example .env` only if the destination does not exist. Keep `.env` private and never put real credentials in `.env.example` or source files.

If PowerShell blocks `npm.ps1`, use `npm.cmd install --include=dev`, `npm.cmd start`, and `npm.cmd run ...`; no execution-policy change is needed. Shell environment variables override `.env`. `--include=dev` ensures lint tools are installed even if the shell already sets production mode. Deployment installs can use `npm ci --omit=dev` with the committed lockfile.

## Environment configuration

Use `.env.example` as the checklist. Leave external credentials blank until account connection.

| Variable | Purpose / default |
| --- | --- |
| `NODE_ENV` | `development` locally; `production` enables deployment checks. |
| `HOST`, `PORT` | Host defaults to `127.0.0.1` locally and `0.0.0.0` in production; port `5000`. |
| `AUTOMATION_ENABLED` | Default `false`; literal `true` enables CRM processing and replies. |
| `WEBHOOK_VERIFY_TOKEN` | Required startup secret. Production minimum: 32 characters. |
| `META_APP_SECRET` | Required in production or with automation; authenticates webhook POSTs. |
| `META_GRAPH_API_VERSION` | Explicit supported Graph version, `vNN.N`; no code default. |
| `WHATSAPP_PHONE_NUMBER_ID` | Numeric ID of the dedicated business number, not its visible number. |
| `WHATSAPP_ACCESS_TOKEN` | Meta token authorized for the intended number. |
| `ALLOWED_SENDER_PHONES` | Comma-separated authorized boss numbers in E.164; required with automation. |
| `AI_PROVIDER` | `openai` or `gemini`. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Both required when OpenAI is selected. |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Both required when Gemini is selected; use a bare model ID. |
| `AI_TIMEOUT_MS` | Default `20000`; range `1000`â€“`60000`. |
| `AI_MAX_OUTPUT_TOKENS` | Default `4096`; range `256`â€“`16384`. |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` | OAuth client and offline refresh credential. |
| `ZOHO_ACCOUNTS_URL` | Official regional Accounts origin, e.g. `https://accounts.zoho.com`. |
| `ZOHO_API_BASE_URL` | Matching CRM environment and version, e.g. `https://www.zohoapis.com/crm/v8`. |
| `ZOHO_FIELD_MAPPING` | Optional JSON field mapping; see below. |
| `ZOHO_TIMEOUT_MS` | Default `15000`; range `1000`â€“`60000`. |
| `DATABASE_URL` | Development default `file:./data/messages.sqlite`; production requires PostgreSQL. |
| `WORKER_POLL_MS` | Default `1000`; range `50`â€“`60000`. |
| `WORKER_LEASE_MS` | Default `120000`; range `30000`â€“`600000`. |
| `PROCESSING_MAX_ATTEMPTS` | Default `3`; range `1`â€“`10`, for eligible safe retries. |
| `WEBHOOK_RATE_LIMIT` | Default `600` requests per IP per minute. |
| `TRUST_PROXY_HOPS` | Default `0`; exact trusted proxy hop count, maximum `3`. |
| `CORS_ORIGINS` | Optional comma-separated browser origins; unnecessary for Meta server webhooks. |
| `LOG_LEVEL` | Default `info`; Pino levels or `silent`. |
| `TEST_DATABASE_URL` | Optional dedicated PostgreSQL test database; never production. |

Legacy aliases remain supported: `WHATSAPP_APP_SECRET` falls back for `META_APP_SECRET`, and `WHATSAPP_API_VERSION` falls back for `META_GRAPH_API_VERSION`. Modern names take precedence.

## Run locally and check health

Set your verification token, keep external keys blank, and explicitly select development mode:

```powershell
$env:NODE_ENV = 'development'
$env:AUTOMATION_ENABLED = 'false'
npm run db:migrate
npm start
```

Use `npm run dev` for source-change restarts. Restart after changing `.env`; stop with `Ctrl+C`. In another terminal:

```powershell
Invoke-RestMethod http://localhost:5000/health
Invoke-RestMethod http://localhost:5000/ready
```

`GET /health` returns:

```json
{"status":"ok","service":"whatsapp-lead-automation"}
```

`GET /ready` checks database availability and reports whether automation is enabled; storage failure returns `503`. It does not test provider credentials. The legacy `GET /api/health` still returns:

```json
{"success":true,"message":"Voltronix WhatsApp backend is running"}
```

Disabled automation still persists eligible webhook messages. Once enabled, the worker only processes records accepted with a valid webhook signature whose sender remains authorized; unsigned development records fail without external calls. Signed queued messages can run after enabling, so use a separate development database and do not promote a synthetic local inbox into production.

## Local webhook smoke test

With automation disabled and the app secret empty on localhost only:

```powershell
$payload = @{
  object = 'whatsapp_business_account'
  entry = @(@{
    changes = @(@{
      field = 'messages'
      value = @{
        messaging_product = 'whatsapp'
        messages = @(@{
          from = '971501234567'
          id = 'local-smoke-message-001'
          timestamp = [string][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
          type = 'text'
          text = @{ body = 'Ahmed from ABC Contracting, 0501234567, needs AC maintenance in Dubai.' }
        })
      }
    })
  })
} | ConvertTo-Json -Depth 10
Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://localhost:5000/webhook -ContentType 'application/json' -Body $payload
npm run messages -- show local-smoke-message-001
```

Expect HTTP `200` and one stored inbox record. Repeating the same message ID does not insert another. These IDs/numbers are synthetic and the disabled worker sends nothing. If a business phone ID or sender allowlist is configured, the event must include matching `value.metadata.phone_number_id` and an allowed sender. Configured signatures make unsigned requests return `403`; use signed automated tests instead of disabling signatures publicly.

## Tests and checks

```powershell
npm run lint
npm run check
npm test
```

Tests mock Meta, AI, and Zoho HTTP requests. Coverage includes health/verification, signatures, payload filtering, duplicate deliveries, leases/restart recovery, AI schemas/refusals, missing contacts, UAE/international numbers, CRM create/update paths, failures, and confirmations. SQLite tests use temporary databases. Optional PostgreSQL tests run when `TEST_DATABASE_URL` points to a dedicated test database; otherwise they skip. They need database access, not external API credentials. Test output supplies actual pass/skip counts.

## ngrok development setup

Install the ngrok agent from its [official download page](https://ngrok.com/download), authenticate it using your account's setup instructions, and keep the backend running. In another terminal:

```powershell
ngrok http 5000
```

Use the resulting HTTPS host plus `/webhook`, such as `https://your-assigned-host.ngrok.app/webhook`. Keep both processes running and update Meta if the host changes. ngrok's [localhost guide](https://ngrok.com/use-cases/share-localhost) describes agent installation and account authentication. Configure `META_APP_SECRET` before exposing the webhook publicly. A domain still needs a reachable running backend behind it.

## Meta webhook and dedicated WhatsApp number

Complete these account steps when your real number and credentials are ready:

1. Configure WhatsApp Cloud API and the intended WhatsApp Business Account (WABA) in the [Meta app dashboard](https://developers.facebook.com/apps/). Use Meta's [setup guide](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started) for your account's number registration/onboarding requirements.
2. Obtain the dedicated number's Phone Number ID, associated app secret, and properly permissioned access token. Set the matching environment variables and choose a supported Graph version. Messaging requires `whatsapp_business_messaging` access to that number; WABA management operations require suitable management permission.
3. Configure `ALLOWED_SENDER_PHONES` with the boss's real international numbers. The webhook sender is the boss; the phone extracted from the message belongs to the customer. Events also have to match the configured business Phone Number ID.
4. Set Meta's callback to `https://YOUR_HOST/webhook` and its Verify Token to the exact `WEBHOOK_VERIFY_TOKEN`. Verify and save. The backend validates `hub.mode`, `hub.verify_token`, and `hub.challenge`; successful verification returns the unchanged challenge as plain text.
5. Subscribe to the `messages` webhook field and ensure the app is subscribed to the correct WABA. The WABA association is separate from saving a callback; see Meta's official [WABA subscription operation](https://www.postman.com/meta/whatsapp-business-platform/request/c1ai24q/subscribe-to-your-waba).
6. Finish AI and Zoho configuration, confirm field mapping and `/ready`, then set `AUTOMATION_ENABLED=true` and restart. Startup requires an app secret and explicit boss allowlist before enabling the worker.
7. In a controlled live acceptance test, have the authorized boss send one complete lead to the dedicated number. Check its stored message, actual Zoho record, and confirmation. This is real traffic, separate from local mocked tests.

Configured POST signatures are HMAC-SHA256 over the original bytes, checked against `X-Hub-Signature-256`. The verify token does not replace the app secret. Status notifications, unauthorized senders, malformed messages, and non-text media never become CRM actions. Images, audio, documents, and conversation merging are outside this implementation.

## WhatsApp sending service

`createWhatsAppService({ env, http, logger }).sendTextMessage(to, text)` uses `https://graph.facebook.com/{configured-version}/{phone-number-id}/messages`. The existing CommonJS `sendWhatsAppTextMessage(to, message)` export in `src/services/whatsapp.js` remains available. There is no public send/admin HTTP endpoint.

The service validates recipients, limits text to 4096 characters, verifies TLS, disables redirects, bounds bodies, and uses a 15-second timeout. Failures expose sanitized metadata. Replies use the durable outbox and go to the original boss sender. Free-form replies require an applicable customer-service window; queued replies expire at 23 hours after the triggering inbound message, conservatively before 24 hours. The foundation now also exposes `sendTemplateMessage(to, templateName, languageCode)` and a manual local CLI for templates without dynamic components; the dormant worker still sends only text. See the [current foundation README](../README.md#7-manually-test-whatsapp-sending) for explicit manual sends and outcome/reconciliation behavior, and Meta's [messages reference](https://www.postman.com/meta/whatsapp-business-platform/folder/o48mro7/messages) for account messaging rules.

## AI extraction and validation

Choose one provider and a compatible model explicitly; no model is hard-coded. OpenAI uses Responses with strict `text.format` JSON schema and `store:false`. Gemini uses `generateContent` with a JSON response schema. Follow the official [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) and [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/generate-content/structured-output) guides when selecting model access.

The original message is untrusted data. Extraction instructions forbid fabricated facts and following embedded commands. Zod separately validates exactly eight nullable string fields, required keys, and size limits. Invalid JSON, wrong types, extra fields, refusal, truncation, and unexpected output fail safely. No commands/tools from WhatsApp content are executed.

A lead requires a customer name plus a valid phone or reliable email. UAE `0501234567`, `+971501234567`, and `971501234567` normalize to `+971501234567`. Explicit international numbers retain their country; ambiguous non-UAE domestic numbers require a country code. The extracted phone/email must occur in the original message after safe normalization. Missing phone is allowed with a valid, grounded email; supplied invalid or ungrounded contacts block CRM writes.

Missing information produces `NEEDS_INFORMATION`. The boss must **resend the complete corrected lead in a new message**. A phone-only reply is not merged with an earlier name-only message.

## Zoho OAuth setup

Create/use an OAuth client for the intended Zoho account and data center. Authorize an offline refresh token using Zoho's [access/refresh-token flow](https://www.zoho.com/crm/developer/docs/api/v8/access-refresh.html). Minimum CRM scopes are `ZohoCRM.modules.leads.READ,ZohoCRM.modules.leads.CREATE,ZohoCRM.modules.leads.UPDATE,ZohoCRM.modules.attachments.READ,ZohoCRM.modules.attachments.CREATE,ZohoSearch.securesearch.READ`. Initial consent/token issuance remains an account setup step, not an automatic backend action. See [the OAuth scope audit and reauthorization guide](zoho-oauth-scopes.md) for Books permissions, read-only verification, and exact setup commands. Neither Chart of Accounts nor a fixed expense-account ID is required.

Store your real client ID, client secret, and refresh token only in environment secrets. The backend refreshes at `{ZOHO_ACCOUNTS_URL}/oauth/v2/token`, caches access tokens, refreshes before expiry, and retries a definite token rejection once. See Zoho's [refresh guide](https://www.zoho.com/crm/developer/docs/api/v8/refresh.html).

For a US production account, the URL shape is `https://accounts.zoho.com` and `https://www.zohoapis.com/crm/v8`; choose your actual regional account/API origins. The Accounts value is an origin; the API value includes `/crm/v{version}`. Official regional and sandbox/developer origins are supported. The OAuth response's API domain must match the configured CRM environment. Custom destinations, insecure URLs, redirects, and guessed tokens are not used.

## Zoho matching and field mapping

The service implements `searchLeadByPhone`, `searchLeadByEmail`, `createLead`, `updateLead`, and `getLead`. Phone search examines normalized exact matches in the configured phone field, `Phone`, and `Mobile`; email-only leads use email search. Multiple matches or incomplete bounded searches require review. Local contact mappings protect recent creations while Zoho search indexing catches up; see [Zoho search behavior](https://www.zoho.com/crm/developer/docs/api/v8/search-records.html).

| Source | Default Zoho field |
| --- | --- |
| Name tokens before the final token | `First_Name`, if present |
| Final name token / single-word name | `Last_Name` |
| Phone, email, company, location | `Phone`, `Email`, `Company`, `City` |
| Constant `WhatsApp` | `Lead_Source` |
| Original text plus service, requirement, notes | `Description` |

Absent optional values are omitted. Updates read the existing record, preserve description history, and use an optimistic modification check. `Last_Name` is retained; custom fields are not assumed. Confirm your layout's required fields, field permissions and the `WhatsApp` Lead Source picklist value. Organization-specific rules can reject a valid lead; the backend does not invent missing company/customer values.

`ZOHO_FIELD_MAPPING` supports `name`, `firstName`, `lastName`, `phone`, `email`, `company`, `location`, `leadSource`, `originalMessage`, `service`, `requirement`, and `notes`. Values are actual Zoho field **API names**, or `null` for permitted disabled mappings. Destination fields must be unique. Phone, email, lead source, original message, and a name mapping must remain enabled. To store the full name in `Last_Name` without custom fields:

```dotenv
ZOHO_FIELD_MAPPING='{"name":"Last_Name","firstName":null}'
```

Map a key such as `service` to a custom destination only after that field exists. Service/requirement/notes also remain in the description. Original text is preserved without silent truncation; overlong CRM descriptions fail while the original stays in SQL. Consult [insert records](https://www.zoho.com/crm/developer/docs/api/v8/insert-records.html) and [update records](https://www.zoho.com/crm/developer/docs/api/v8/update-records.html) for CRM record/layout rules.

## Database, duplicates and recovery

`npm run db:migrate` applies versioned migrations; startup also initializes the schema. Keep SQLite on a persistent local file for development. Production requires a PostgreSQL database shared by all app replicas. Use direct PostgreSQL connections or a session-pooling endpoint: contact advisory locks belong to the database session, so transaction-pooling endpoints such as PgBouncer transaction mode are unsuitable. Preserve the database across deployments: deleting it removes duplicate protection and CRM mappings.

| Table | Stored state |
| --- | --- |
| `whatsapp_messages` | Unique WhatsApp ID, authenticated intake flag, sender, original text, timestamps, status, extracted data, Zoho ID, attempts, lease, safe error and CRM-write state. |
| `crm_contacts` | Normalized contact-to-Zoho-ID mapping and uncertainty flag. |
| `processing_logs` | Processing events and bounded safe metadata. |
| `reply_outbox` | One reply per message, text, send status/lease and provider message ID. |
| `contact_locks` | SQLite contact lease records; PostgreSQL uses advisory locks. |
| `schema_migrations` | Applied schema versions. |

Message statuses are `RECEIVED`, `PROCESSING`, `SUCCESS`, `FAILED`, and `NEEDS_INFORMATION`. The unique message ID suppresses redeliveries. Worker leases prevent competing claims; contact locks serialize this application's CRM work for the same customer. CRM results and contact mappings are saved before completion. A terminal status and reply are persisted together.

This does **not** guarantee exactly-once execution across independent APIs. Zoho might accept a write before a timeout/crash hides the response. Uncertain mutations are held for reconciliation, with no blind write replay. Contact uncertainty also prevents later messages from creating another record before review. Manual CRM users and other integrations do not acquire these locks: investigate existing duplicates and configure CRM duplicate controls.

Outbox statuses are `PENDING`, `SENDING`, `SENT`, `FAILED`, and `UNKNOWN`. An uncertain send or expired send lease becomes `UNKNOWN` and is not automatically replayed. `SENT` means provider acceptance, not confirmed handset delivery. CRM `SUCCESS` stays successful when a confirmation fails. Expired reply windows do not trigger template sends.

Local operator commands require database access; no HTTP admin endpoints exist:

```powershell
npm run messages -- list 20
npm run messages -- show WHATSAPP_MESSAGE_ID
npm run messages -- retry WHATSAPP_MESSAGE_ID
```

Retry is only for eligible failed work after its cause is fixed. It refuses active/protected terminal work, existing CRM-write markers, or uncertainty that could repeat a mutation. A permitted retry archives any prior failure-reply delivery record in the audit and frees its outbox slot so the worker can issue a fresh result confirmation; `SENDING` and `UNKNOWN` replies prevent retry. For uncertain CRM writes, inspect the original/extracted data and actual Zoho record before controlled manual reconciliation. Do not clear uncertainty flags or replay unknown replies merely to empty a queue. CLI inspection can show customer data; use an authorized private terminal.

Back up PostgreSQL, test restoring it, and restrict database/backups access. Set your organization's retention policy for original messages, audit records, and backups. Retention deletion is an explicit operator task; no automatic purge is implemented. Preserve deduplication records while old deliveries may still arrive.

## Production deployment

Deploy with PostgreSQL and a stable public HTTPS endpoint. Set `NODE_ENV=production`, a strong verification token, app secret, production database URL and full integration configuration. Initially keep automation disabled while validating configuration and reviewing queued work. Supply secrets through deployment environment settings, not the image. Use verified database TLS for remote PostgreSQL, for example the provider's `sslmode=verify-full` connection settings and its CA certificate when required; never disable certificate verification.

A `Dockerfile` and `compose.yaml` are supplied. Compose starts the application and expects PostgreSQL separately through `DATABASE_URL`; it does not provision a database or TLS endpoint. After securely configuring the required environment:

```powershell
docker compose build
docker compose run --rm backend npm run db:migrate
docker compose up -d
```

The compose port binds to localhost for a host reverse proxy. Terminate HTTPS at the trusted proxy/load balancer, preserve the signed body, and restrict direct backend access. Set `TRUST_PROXY_HOPS` to the actual fixed proxy count and overwrite forwarded headers at the proxy. Follow [Express proxy configuration](https://expressjs.com/en/guide/behind-proxies/) and [TLS guidance](https://expressjs.com/en/advanced/best-practice-security/).

Monitor `/health` and `/ready`; alert on failed processing, old queued messages, stale leases, uncertain CRM writes and unknown/failed replies. Logs contain structured processing metadata and redact secrets/raw message fields. Input is bounded to 3 MB, text to 4096 characters, and webhook rate limiting is per process; use a shared edge limit for multiple replicas. CORS should name only required browser origins.

Run under a supervisor/restart policy, allow graceful shutdown, preserve database volumes, and test recovery. Number activation, permissions, model access, Zoho layout validation, production TLS/DNS, backups and a controlled live acceptance test still require your real account configuration.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Startup configuration error | Verify token; production PostgreSQL/app secret; complete credentials/models/allowlist when automation is enabled. |
| GET verification `403` | Exact verify token, `hub.mode=subscribe`, callback `/webhook`, host and tunnel port. |
| POST `403` | App secret belongs to the sending app, valid signature, unmodified raw body. |
| Dashboard tests work but leads do not arrive | `messages` field and WABA subscriptions, destination number ID, authorized sender, text message type. |
| Webhook `503` / readiness failure | Database URL/connectivity, migrations, permissions, capacity and connection limits. |
| Messages stay `RECEIVED` | Automation disabled, worker unavailable, or processing backlog. |
| `NEEDS_INFORMATION` | Resend one complete lead with the actual name and phone/email; fragments are not merged. |
| AI extraction failure | Key/model access, structured-output support, response limits, timeout or rejected provider output. |
| Zoho OAuth failure | Correct client/refresh pair, scopes, region and sandbox/production origin. |
| Zoho lead failure | Field API names, required layout fields, `WhatsApp` picklist value, permissions or ambiguous matches. |
| CRM saved but no reply | Inspect outbox and service-window expiry; do not recreate the lead. |
| Retry refused | Inspect and reconcile protected/uncertain CRM state first. |
| Port in use | Stop the other server or change `PORT` and matching local/tunnel URLs. |

## Example messages, extracted JSON and CRM result

These examples are synthetic:

```text
Ahmed from ABC Contracting, 0501234567, needs AC maintenance in Dubai.
Sara at sara@example.com needs a maintenance quotation in Abu Dhabi.
```

The first lead after validation (AI extraction may preserve original phone formatting until normalization):

```json
{
  "name": "Ahmed",
  "phone": "+971501234567",
  "email": null,
  "company": "ABC Contracting",
  "service": "AC maintenance",
  "location": "Dubai",
  "requirement": "AC maintenance",
  "notes": null
}
```

Illustrative default Zoho record payload:

```json
{
  "Last_Name": "Ahmed",
  "Phone": "+971501234567",
  "Company": "ABC Contracting",
  "City": "Dubai",
  "Lead_Source": "WhatsApp",
  "Description": "Original WhatsApp message:\nAhmed from ABC Contracting, 0501234567, needs AC maintenance in Dubai.\n\nService: AC maintenance\n\nRequirement: AC maintenance"
}
```

Zoho's real record ID is stored only after a successful create/update. The boss's confirmation summarizes the saved name, company, service and location; an existing match is updated rather than creating another lead. A message such as `Ahmed needs AC maintenance in Dubai` requests a customer phone or email and creates no CRM lead. Resend the whole corrected message with the missing contact.

Example confirmation for the first message:

```text
âœ… Lead saved successfully.

Name: Ahmed
Phone: +971501234567
Company: ABC Contracting
Service: AC maintenance
Location: Dubai
```

