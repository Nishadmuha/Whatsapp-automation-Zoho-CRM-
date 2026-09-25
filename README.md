# Whatsapp-automation-Zoho-CRM-

## Voltronix WhatsApp CRM Backend

WhatsApp automation now requires a fresh, newly inserted incoming message from the current backend run. Historical/replayed events and old queued replies cannot restart automation. See the [trigger fix and verification report](docs/whatsapp-trigger-fix.md) for the five-minute freshness window, restart behavior and test coverage.

**Current phase:** All individual boss lead fields are optional. Any meaningful information collects into one persistent draft and prompts for explicit save confirmation. Text, screenshots, company documents and voice messages merge without nulls replacing known details. `/admin/chats` shows inbox/outbox history, OCR, transcripts and retained closed drafts; `/admin/leads` links to the related chat. With authorized Boss senders and OpenAI automation enabled, the Boss lead workflow is available; Zoho CRM synchronization requires configured CRM credentials and explicit lead confirmation. See the [optional-fields implementation report](docs/optional-boss-lead-fields.md) and [boss chat guide](docs/boss-chat.md). These supersede earlier minimum-field, immediate-save and text-only history descriptions below.

The [session/idempotency investigation](docs/lead-session-idempotency-audit.md) traces the two historical Al Noor records and documents current-message extraction, confirmation replay protection and same-customer future leads.

Receive WhatsApp Cloud API events through an ngrok HTTPS URL, verify Meta's callback, parse supported incoming messages, safely log receipt, and prevent duplicate intake with the MongoDB-backed inbox. A local CLI can explicitly send text or template messages through the existing WhatsApp service. Optional automation generates short OpenAI replies through the existing inbox worker and durable outbox.

```text
Meta WhatsApp Cloud API -> Meta webhook -> ngrok HTTPS
  -> Express /webhook -> signature validation -> parser -> durable MongoDB inbox -> HTTP 200
```

**`AUTOMATION_ENABLED=false` is the default.** With `AI_PROVIDER=openai`, explicitly enabling automation starts customer conversations and the configured boss lead workflow. Leaving `AI_PROVIDER` blank retains the earlier fixed reply. The Boss lead workflow requires explicit confirmation before Zoho CRM synchronization; with CRM intentionally unconfigured, Boss-only processing remains available without CRM synchronization. See the [automation reference](docs/automation-reference.md) for historical details and current configuration checks.

Phase 2 routes explicitly authorized bosses to validated internal lead storage and concise confirmations. Set private `AUTHORIZED_BOSS_PHONES`; other customers retain their existing conversational replies. The read-only dashboard is served by this same backend at `/admin/leads`, using private `ADMIN_USERNAME` and `ADMIN_PASSWORD` credentials. See [the Phase 2 workflow and dashboard guide](docs/internal-leads.md) for validation rules, migration 004, API contracts and testing.

## 1. Install dependencies

Use **Node.js 22.20 or newer**. Run these commands in PowerShell:

```powershell
cd "D:\whatsapp automation backend\voltronix-whatsapp-backend"
npm.cmd install --include=dev
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
```

The copy preserves an existing `.env`. `npm.cmd` avoids PowerShell execution-policy issues without changing your system policy. On macOS/Linux, use `npm` and copy `.env.example` only if `.env` does not already exist.

## 2. Configure `.env`

Set these local values in your private `.env`:

```dotenv
PORT=5000
NODE_ENV=development
HOST=127.0.0.1
AUTOMATION_ENABLED=false
WEBHOOK_VERIFY_TOKEN=
META_APP_SECRET=
META_GRAPH_API_VERSION=v25.0
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
```

Fill `WEBHOOK_VERIFY_TOKEN` with a strong random secret of your choice; use at least 32 characters. It is the value you will later enter in Meta's **Verify Token** field. Keep real values out of source code, terminal output, screenshots, and `.env.example`. `.env` and local database files are listed in `.gitignore`.

| Variable | Requirement for this phase |
| --- | --- |
| `WEBHOOK_VERIFY_TOKEN` | Required to start; used only for `GET /webhook` verification. |
| `AUTOMATION_ENABLED` | Defaults to `false`. Only the exact value `true` enables automatic replies. |
| `AI_PROVIDER` | Set `openai` for conversational replies; blank retains the fixed reply. Other values are rejected when automation is enabled. |
| `OPENAI_API_KEY`, `OPENAI_MODEL_DEFAULT` / `OPENAI_MODEL` | Required for enabled OpenAI generation; supplied by the private environment, never source code. `OPENAI_MODEL_DEFAULT` takes precedence, with `OPENAI_MODEL` as a fallback. Missing/invalid AI configuration fails `/ready` and `/health` without breaking webhook receipt. |
| `META_APP_SECRET` | Set the matching Meta app secret before public ngrok testing. Any nonempty value enables POST HMAC validation. Required in production or with automation enabled. |
| `META_GRAPH_API_VERSION` | Optional for receipt; required for manual sending or automatic replies. Use `v25.0` for this setup. Legacy `WHATSAPP_API_VERSION` remains supported. |
| `WHATSAPP_PHONE_NUMBER_ID` | Optional intake filter, required for sending. Any nonempty value must be numeric; malformed values fail startup. It is not the displayed phone number. |
| `WHATSAPP_ACCESS_TOKEN` | Optional for receipt, required for sending. It is not the verify token or app secret. |
| `MONGODB_URI` | Primary runtime database connection. Required in production; MongoDB stores messages, drafts, leads, outbox state and GridFS media. |
| `ALLOWED_SENDER_PHONES` | Optional comma-separated sender allowlist. Blank permits any valid sender; a configured list filters intake and automatic replies. |
| `AUTHORIZED_BOSS_PHONES` | Optional private comma-separated boss numbers; international and recognized UAE local formats normalize before sender comparison. An explicit blank disables boss routing. The legacy `BOSS_SENDER_PHONES` applies only when the canonical key is absent. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Private dashboard credentials. Configure both for browser access. Passwords require 8–256 characters. Login creates an HttpOnly session cookie. |
| `ADMIN_API_TOKEN` | Optional API bearer token: 32–256 visible ASCII characters, checked by the same admin middleware. Blank retains cookie-only access; never put this token in frontend code or URLs. |
| `AI_MEDIA_MAX_OUTPUT_TOKENS` | Image/document OCR output limit, default 4096, permitted 256–16384. Customer replies keep their existing output setting. |
| `LOG_LEVEL` | Use `info` to see receipt logs. |

Zoho CRM settings are optional for Boss-only processing; complete CRM credentials are needed for synchronization after explicit confirmation. Zoho Books settings are required when Books automation is enabled. Existing AI settings serve both conversations and boss extraction. Keep automation disabled until you intentionally enable it. Existing shell environment variables override `.env`; restart the backend after configuration changes. Legacy `WHATSAPP_APP_SECRET` and `WHATSAPP_API_VERSION` aliases remain supported, with the `META_*` names preferred.

For localhost-only development, leaving **both** app-secret names empty permits unsigned POSTs. This is a deliberate local test mode: the backend warns that signature checking is disabled. A configured app secret requires `X-Hub-Signature-256: sha256=<hex HMAC>` over the **exact raw request bytes**, checked using a timing-safe comparison. Missing or invalid signatures return `403`. Production startup fails without an app secret, a verification token of at least 32 characters, and MongoDB.

### MongoDB Atlas connection

The backend uses one Mongoose connection configured by `MONGODB_URI`. MongoDB is the production and development runtime store for WhatsApp messages, drafts, leads, outbox state, contact locks, and GridFS media. `DATABASE_URL` is accepted only as a MongoDB-compatible alias; PostgreSQL and SQLite URLs are rejected in production.

In the private file `D:\whatsapp automation backend\voltronix-whatsapp-backend\.env`, fill the existing blank line with your real Atlas driver connection string:

```dotenv
MONGODB_URI=
```

Copy the URI from your Atlas cluster's **Connect → Drivers → Node.js** screen, use your existing database user's credentials, and select the intended database in the URI. URL-encode reserved characters in the username/password. In Atlas **Network Access**, allow the public IP of the computer/server running this backend; verify that the existing database user has access to the intended database. See [Atlas driver connection instructions](https://www.mongodb.com/docs/atlas/driver-connection/). Never paste the real URI into JavaScript, logs, screenshots or Git. `.env` is already ignored by `.gitignore`.

`src/config/db.js` reuses a single Mongoose connection and coalesces simultaneous initialization. Startup awaits it before HTTP listening. Initial connection failure stops startup with a fixed message without printing the URI or password. The initial server-selection timeout is 30 seconds, and shutdown/startup-failure cleanup releases MongoDB. No extra connection is made by the Express routes.

When the URI is blank in development, startup reports `MongoDB not configured. Set MONGODB_URI in .env to enable Atlas.`. Production requires a valid URI. With a valid URI, the existing JSON startup logs contain:

```text
MongoDB connected successfully
Server running on port 5000
```

Restart using `npm.cmd start` after changing the URI. `/health` checks MongoDB and the configuration required by enabled features; it returns HTTP 503 when a critical dependency is unhealthy. `/ready` checks MongoDB and the configuration required by enabled automation before returning HTTP 200. Automated MongoDB tests use isolated databases and synthetic credentials. A real Atlas connection can only be verified after you supply the URI.

## 3. Start the backend

```powershell
$env:NODE_ENV = 'development'
$env:AUTOMATION_ENABLED = 'false'
npm.cmd start
```

Startup initializes MongoDB indexes automatically. Use `npm.cmd run dev` for source-change restarts. Stop the server with `Ctrl+C`. In a second terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:5000/health
Invoke-RestMethod http://127.0.0.1:5000/ready
```

`GET /health` returns HTTP `200` when MongoDB and the configuration required by enabled features are healthy (otherwise HTTP `503` with `status: "unavailable"`):

```json
{"status":"ok","service":"voltronix-whatsapp-backend"}
```

`GET /ready` checks database availability and reports whether automation is `disabled` or `enabled`; with automation enabled it also fails closed when WhatsApp sending is not configured. The existing `GET /api/health` alias is retained.

## 4. Run ngrok

Install and authenticate the agent using [ngrok's official quickstart](https://ngrok.com/docs/getting-started/). With the backend still listening on port 5000, run in another terminal:

```powershell
ngrok http 5000
```

Copy the HTTPS forwarding domain shown by ngrok. Your callback URL is:

```text
https://YOUR-NGROK-DOMAIN/webhook
```

No tunnel URL is hard-coded. Temporary/random ngrok URLs change when the tunnel restarts unless a reserved/static domain is used. Current ngrok accounts have an assigned stable Dev Domain that can remain the same across restarts; check the URL actually displayed and update Meta whenever it changes. Keep both ngrok and the backend running. See [ngrok domain behavior](https://ngrok.com/docs/gateway/domains).

`TRUST_PROXY_HOPS=0` conservatively rate-limits the tunnel connection. Only change it when you know and control the exact proxy path; it is not necessary for callback verification or receipt.

## 5. Configure Meta manually

In your own [Meta Developer Dashboard](https://developers.facebook.com/apps/):

1. Open the WhatsApp webhook configuration for the intended app and WhatsApp Business Account (WABA).
2. Enter **Callback URL:** `https://YOUR-NGROK-DOMAIN/webhook`.
3. Enter **Verify Token:** the exact private value of `WEBHOOK_VERIFY_TOKEN`.
4. Verify and save. Meta sends `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge`; the endpoint returns the unchanged challenge as plain text when valid, or `403` otherwise.
5. Subscribe to the **`messages`** webhook field and ensure the app is subscribed to the intended WABA. The WABA subscription is separate from saving a callback; see [Meta's official WABA subscription operation](https://www.postman.com/meta/whatsapp-business-platform/request/c1ai24q/subscribe-to-your-waba).
6. Send a text message to the configured WhatsApp business test/real number, using any test-recipient setup required by your account. Check the backend receipt log and database deduplication.

Set `META_APP_SECRET` from this same Meta app before the public test, then restart. Automated tests use mocks; the manual sending command below contacts Meta only with `--send`. Passing local checks proves the backend behavior; only your dashboard verification and an actual inbound WhatsApp message confirm the real Meta connection.

## 6. Test the webhook

```powershell
npm.cmd run lint
npm.cmd run check
npm.cmd test
```

With port 5000 free, run the repeatable local server test:

```powershell
npm.cmd run smoke:webhook
```

The smoke test creates temporary in-memory credentials and an isolated MongoDB test database, starts the actual server on loopback, checks health, GET verification, signed POST receipt, duplicate delivery, and the safe receipt log, then shuts it down. It does not need real Meta credentials or modify `.env`. Stop your manually started server first if it already occupies the test port.

For exact GET and signed POST commands against a server you started, use [local webhook testing](docs/webhook-local-testing.md) and the [synthetic sample payload](docs/samples/whatsapp-text.json). The automated suite uses isolated MongoDB databases and mocks external APIs; no provider secrets are required.

## 7. Manually test WhatsApp sending

Keep `AUTOMATION_ENABLED=false`. This command loads the private `.env`, preserves shell overrides and legacy Graph-version compatibility, and uses only the WhatsApp service. It neither starts another server nor invokes AI, Zoho, or the worker.

Run from the project root. The default is a dry run: validate sending configuration and input without contacting Meta. Enter the recipient at the local prompt, or supply `WHATSAPP_TEST_TO` in your private environment. Prompts avoid putting the recipient in command history; result output masks the number.

```powershell
npm.cmd run whatsapp:test -- --template hello_world --language en_US
```

When you intend to send one real message, explicitly add `--send`:

```powershell
npm.cmd run whatsapp:test -- --send --template hello_world --language en_US
```

For a text message, supply the text at the prompt or through private `WHATSAPP_TEST_TEXT`:

```powershell
npm.cmd run whatsapp:test -- --send --mode text
```

`--to` and `--text` are also supported, but their values can appear in shell history. `--help` prints usage without requiring credentials. The three-argument template method supports templates without dynamic components; parameterized templates are outside this foundation change. The template name/language must match an approved template available to your number. Freeform text requires an applicable customer service window.

An exit code of 0 with `DRY_RUN` means no request was made. With `SENT`, it means Meta accepted the request, not that the handset received it. Failures exit 1 and expose only safe error codes and one of the delivery outcomes below. The CLI never retries; reconcile an unknown result before any manual resend. It does not write to the automated reply outbox or create a public send endpoint.

```powershell
node --test test/whatsapp.test.js test/whatsappCli.test.js
```

These automated tests inject mocked HTTP. Do not add `--send` to an automated validation script.

## 8. Optional automatic text reply

Configure the existing private `.env` for short, professional OpenAI customer replies:

```dotenv
AUTOMATION_ENABLED=false
AI_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-6-astra
AI_TIMEOUT_MS=20000
AI_MAX_OUTPUT_TOKENS=512
```

Fill the API key privately. `OPENAI_MODEL_DEFAULT` takes precedence when set; otherwise the runtime uses `OPENAI_MODEL` as a compatibility fallback. There is no built-in model when both are unset. The example uses [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) through the existing Axios Responses integration, with `reasoning.effort=low`. No OpenAI SDK installation or dependency upgrade is needed. `AI_MAX_OUTPUT_TOKENS` includes reasoning and answer tokens; the configured cap and validation limits remain unchanged. Set the master switch to `true` only when ready, then restart the same backend. See the [Astra migration report](docs/openai-astra-migration.md) for the inspected call sites, preserved lead contracts and validation. Customer replies need no Meta webhook change, second server, or Redis. If Boss senders are configured, the Boss workflow is also available; Zoho CRM synchronization still requires configured credentials and explicit lead confirmation.

The webhook validates HMAC and commits a new inbox message tagged `conversation` before returning HTTP 200. The existing worker calls `createAiService().generateReply()` with only that customer's current message. It commits the generated response and successful inbox completion atomically, then the existing outbox sends through `sendTextMessage()`. This phase does not add conversation history or shared cross-customer context.

OpenAI failures happen after acknowledgement and cannot change the webhook response. Transient timeouts, connection failures, server errors and ordinary rate limits use the existing bounded inbox retry schedule. Authentication/configuration failures, quota exhaustion, invalid input and malformed/refused/incomplete output stop safely without a customer error reply. Input is limited to 4,000 JavaScript characters / 16,000 UTF-8 bytes; output is limited to 1,000 characters / 4,000 bytes. The prompt asks for 1-3 concise sentences without invented prices, appointments or commitments.

Duplicate deliveries do not generate additional replies. Old receipts, messages accepted while disabled, and preserved CRM replies are outside the conversational worker's scope. Generated pending replies survive restarts. Outbound failure classification and reconciliation remain unchanged. See [the conversational reply guide](docs/conversational-replies.md) for limits, errors and configuration.

For the earlier fixed-reply behavior, leave `AI_PROVIDER` blank. Each new authenticated incoming text message then queues this exact reply:

> Thanks for contacting Voltronix Contracting LLC. How can we help you?

Set `AUTOMATION_ENABLED=true` in your private environment only when ready to send these replies, then restart the existing backend. The startup command in section 3 explicitly sets it to `false`; change that shell override to `true` when enabling, or remove the override so `.env` applies. The supplied VS Code task now uses the environment and `.env` without forcing a separate value. Its default remains disabled when the flag is absent or false.

All automatic replies require the app secret, WhatsApp access token, numeric phone number ID, and Graph API version. The sender allowlist remains optional. In fixed mode, AI and CRM services are not initialized.

In fixed mode the webhook commits the incoming message and its pending reply in one transaction before returning HTTP 200. Duplicate message IDs produce no additional reply. Messages collected while disabled do not gain replies when automation is later enabled. Status notifications, unsupported message types, and invalid signatures do not queue replies. Previously queued fixed replies survive restarts in fixed mode while they remain eligible for the existing 23-hour sending window.

The incoming row's `SUCCESS` means receipt and reply queuing committed; actual sending is tracked separately in `reply_outbox`. Failed or uncertain sends retain the existing failure classification and reconciliation behavior below. No webhook response waits for Meta to send a reply.

Run the mocked automatic-reply coverage without enabling live automation:

```powershell
node --test test/aiReply.test.js test/conversationProcessor.test.js test/conversationDatabase.test.js test/autoReply.test.js test/startup.test.js test/worker.test.js
```

## Sending outcomes and outbox reconciliation

The service keeps its existing raw success response and adds `deliveryState`, `attempted`, and `uncertain` to sanitized errors. Outbox statuses and sending guarantees remain unchanged:

| Delivery outcome | Meaning | Existing outbox representation |
| --- | --- | --- |
| `NOT_ATTEMPTED` | Local input/configuration/authorization failed before an HTTP attempt. | `FAILED`, with `error_message=NOT_ATTEMPTED`. |
| `ATTEMPTED_FAILED` | Meta returned a definite failure response, including HTTP 5xx. | `FAILED`, with `error_message=ATTEMPTED_FAILED`; no automatic retry. |
| `SENT` | Meta returned a valid acceptance ID. | `SENT` only after database completion is confirmed. |
| `UNKNOWN` | A request started but timed out, lost its response, or returned an untrustworthy success payload. | `UNKNOWN`; never automatically resent. |

If Meta accepts a reply but database completion fails or the lease expires, the original attempt can record its provider message ID on an `UNKNOWN` row with `PROVIDER_ACCEPTED_RECONCILIATION_REQUIRED`. This preserves evidence without granting another send. If the database had committed `SENT` before losing its acknowledgement, the processor recognizes that exact provider ID without downgrading it. If storage remains unavailable, a safe reconciliation log retains message/reply/provider IDs and explicitly states that neither completion nor reconciliation was persisted. The sending lease later expires to `UNKNOWN`; it is never requeued automatically.

`whatsapp_reply_sent` is emitted only after confirmed persisted completion. `whatsapp_send_accepted` records the distinct transport outcome. Invalid webhook signatures emit a fixed `webhook_signature_invalid` event without signature values, headers, or bodies.

## Intake, parsing and duplicate protection

The reusable `parseWhatsAppWebhook(payload)` export lives in `src/services/whatsapp/whatsappParser.js`. It safely traverses multiple entries, changes, and messages and extracts `messageId`, `senderWhatsappId`, `senderPhone`, `senderName`, `timestamp`, `messageType`, `text`, `phoneNumberId`, and `wabaId`. The legacy parser adapter remains available to the existing architecture. The existing inbox schema stores the ID, sender phone, text, type, timestamp, and authentication state; optional contact name, WABA ID, and destination metadata are available from the parser without a schema change.

Eligible messages are inserted into the durable MongoDB inbox before acknowledgement. The WhatsApp message ID has a unique database constraint, so repeated or concurrent deliveries do not create a second inbox item. This survives restarts when the database is retained. Use persistent storage shared by replicas in production; deleting or replacing the database removes its deduplication history. No in-memory deduplication fallback is used.

Receipt logs contain **`WhatsApp message received`**, the message ID, a masked sender, type, and safe text character count. Message bodies, contact names, raw webhook payloads, access tokens, app secrets, provider keys, and Authorization headers are not logged. Original message text remains in the database, so restrict database access.

The endpoint returns `200 EVENT_RECEIVED` after intake without waiting for AI, CRM, or replies. Duplicate IDs, unsupported message types, status-only events, and structurally irrelevant JSON are acknowledged with `200`; unsupported types have a safe diagnostic log. A storage failure for an eligible message returns `503` with `Retry-After` so the sender can retry without silently losing the message.

The fixed-reply worker drains only its reply outbox entries. It never claims existing inbox records for AI or CRM processing, and it never adds replies retroactively to messages received while disabled.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Startup configuration error | Set `WEBHOOK_VERIFY_TOKEN`; keep `AUTOMATION_ENABLED=false`. Production additionally requires an app secret, strong token, and MongoDB. Shell variables override `.env`. |
| GET verification `403` | Exact token value, `hub.mode=subscribe`, nonempty challenge, HTTPS host, and `/webhook` path. Do not paste the token into shared logs. |
| POST `403` | App secret belongs to the sending app; signature header is present and valid; body bytes were not reformatted after signing. |
| POST `400` | Invalid JSON syntax. Send valid UTF-8 JSON with `Content-Type: application/json`. When signatures are enabled, the signature must also match. |
| POST `415` or `413` | Use `application/json`; stay within the 3 MB request limit. |
| POST `200`, no receipt log | Check `LOG_LEVEL=info`, supported message type, required message fields, number-ID/sender filters, and whether the ID was already stored. Status events, unsupported types, or irrelevant structures are intentionally ignored. |
| Repeated ID returns `200` | Expected: database deduplication skips the repeated ID. Change the sample ID only when testing a new message. |
| POST `503` / readiness `503` | MongoDB connectivity, required-index initialization, permissions, capacity, or missing WhatsApp sender configuration while automation is enabled. Fix the dependency before retrying. |
| Webhook `429` | Per-IP rate limit reached; wait for the minute window. Check trusted proxy settings before altering client-IP handling. |
| Tunnel failure / callback unreachable | Backend is on port 5000, ngrok is still running, and the dashboard uses the current HTTPS domain plus `/webhook`. |
| Dashboard verifies, real messages absent | Subscribe to `messages` and the correct WABA; check business number/test-recipient setup, app secret, and configured intake filters. |
| Messages remain `RECEIVED` | Expected for messages collected while automation was disabled. Enabling fixed replies affects new eligible messages only. |
| No automatic reply | Check `/ready` reports `automation: enabled`, send a new authenticated text message, check optional sender filters and the outbox status. Shell environment variables override `.env`. |
| Port 5000 already in use | Stop only the server you own, or adjust `PORT` and all matching test/tunnel URLs. For the isolated smoke test, use a free `SMOKE_PORT`, for example `5050`. |

Local checks do not register a real number, validate account permissions, or confirm delivery from Meta. Those account steps and the controlled live inbound message test remain manual.
