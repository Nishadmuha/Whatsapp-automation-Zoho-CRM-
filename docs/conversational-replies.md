# OpenAI conversational replies

The existing Node server, SQL inbox worker, OpenAI service and WhatsApp outbox handle non-boss customer replies. The Meta webhook configuration is unchanged. No Zoho records, boss approval, Redis or additional runtime server is connected. The [Phase 2 boss workflow](internal-leads.md) routes new authorized boss messages to internal lead storage and a confirmation instead of conversational generation. It runs independently in the same process, so slow or failed extraction does not block customer replies. Previously queued Phase 1 conversation receipts retain their original scope.

## Private environment

```dotenv
# Safe default. Change to true explicitly to run automatic replies.
AUTOMATION_ENABLED=false
AI_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-6-astra
AI_TIMEOUT_MS=20000
AI_MAX_OUTPUT_TOKENS=512
```

Use the existing key from the private `.env`; never paste it into source, tests or logs. `OPENAI_MODEL` is required and has no runtime fallback. The example [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) uses the existing Responses endpoint with low reasoning effort. The token cap includes reasoning and final output; configured limits are preserved. Model access/billing are not checked by unit tests or `/ready`. See the [Astra migration report](openai-astra-migration.md) for separate live synthetic validation.

Retain the already-working `WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET` (or legacy `WHATSAPP_APP_SECRET`), `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `META_GRAPH_API_VERSION` (or legacy `WHATSAPP_API_VERSION`). Leave the Meta dashboard settings unchanged. Existing `DATABASE_URL`, `WORKER_POLL_MS`, `WORKER_LEASE_MS`, `PROCESSING_MAX_ATTEMPTS` and optional `ALLOWED_SENDER_PHONES` continue to apply.

`AI_TIMEOUT_MS` defaults to 20,000 and accepts 1,000-60,000 milliseconds. `AI_MAX_OUTPUT_TOKENS` keeps the existing service default of 4,096 and range of 256-16,384; the example sets 512 for short replies. Input/output character validation applies independently of the token budget. Existing shell environment variables take precedence over `.env`; restart the same server to reload configuration.

Blank `AI_PROVIDER` retains the previous fixed reply. Other nonempty providers are rejected at startup when automation is enabled. With automation disabled, no AI or WhatsApp service is initialized and no worker starts. AI credentials are checked lazily: incorrect credentials/model/limits fail a conversation job rather than preventing webhook receipt.

## Message processing and persistence

1. Validate HMAC over the raw webhook bytes and parse supported, authenticated text messages.
2. Commit each new message to the inbox with `processing_flow=conversation` only when OpenAI automation is enabled, then return HTTP 200. Duplicate IDs are never re-tagged.
3. Claim that flow with the existing inbox lease and bounded attempts; renew the lease while OpenAI works. Only the current customer message is sent, with separate system instructions. There is no conversation history in this phase.
4. Call the existing AI service's `generateReply()` using the [Responses API](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create), verified HTTPS, explicit timeout, `store:false` and no tools.
5. Validate the response and commit it to the existing unique outbox in the same transaction as inbox completion.
6. Claim only conversational outbox rows and send via `sendTextMessage()`. `SENT` means provider acceptance; handset delivery is confirmed separately by WhatsApp status events.

Migration 002 adds nullable `processing_flow` to the inbox. Existing rows remain null and are not candidates for the conversational worker. Migration execution is transactional and occurs on normal startup; this implementation's tests use temporary databases. Old disabled receipts, old fixed replies, and preserved CRM replies are not replayed into the new flow. Pending conversational replies remain durable across a normal restart. Inbox jobs/replies outside the existing 23-hour window stop without a template send.

Customer input is capped at 4,000 JavaScript UTF-16 characters and 16,000 UTF-8 bytes before any AI request. The existing webhook parser additionally ignores messages beyond 4,096 Unicode code points. Generated text must be nonempty and at most 1,000 UTF-16 characters / 4,000 UTF-8 bytes. Disallowed control characters are rejected. The prompt requests 1-3 professional sentences in the customer's language and forbids invented prices, availability, appointments or claims of actions performed.

## Safe failure behavior

| Failure | Worker behavior |
| --- | --- |
| Timeout, transient network failure, HTTP 5xx, ordinary rate limit | Persist `FAILED` with a future retry, bounded by `PROCESSING_MAX_ATTEMPTS` (default 3). Delays start at 5 seconds and double up to 5 minutes. |
| 401/403 authentication/access failure, exhausted quota, invalid provider/key/model configuration | Terminal `FAILED`, no automatic retry or customer error reply. |
| Invalid input, refused/incomplete/malformed/oversize generated response, other request errors | Terminal `FAILED`, no outbox or customer error reply. |
| Lost inbox lease | Discard that worker's generated result; it cannot queue or send. |
| Database failure saving the generated reply | No direct send; unfinished processing remains recoverable through the bounded inbox retry/lease mechanism. |
| Uncertain WhatsApp delivery | Existing `UNKNOWN` state and reconciliation rules; never automatically resend. |

These classifications follow [OpenAI's error documentation](https://developers.openai.com/api/docs/guides/error-codes). Only fixed error codes, attempt counts and message IDs are logged. Provider errors, headers, API keys and customer bodies are not copied into errors or logs. AI processing never executes inside the webhook response path.

An interrupted generation may be generated again if its result never committed; the durable outbox prevents a second automatic WhatsApp send for the same inbox message. Corrected credentials apply to new messages after restart; failed records retain safe error codes for diagnosis. Do not clear unknown-send evidence to force a resend.

## Verification

```powershell
npm.cmd run lint
npm.cmd run check
npm.cmd test
```

OpenAI and WhatsApp are mocked in automated tests. No test should use a live access token or trigger a real API request. Startup tests run isolated child servers on temporary ports/databases with fake service factories. Optional PostgreSQL cases require a dedicated `TEST_DATABASE_URL`; otherwise they skip. A live conversation test is a separate action after restarting the backend with the intended private configuration.

## Implementation verification — 2026-09-12

- `npm.cmd run lint`: passed.
- `npm.cmd run check`: passed.
- `npm.cmd test`: 284 total, 246 passed, 0 failed, 38 skipped. The skips are optional PostgreSQL cases; no `TEST_DATABASE_URL` was configured.
- All OpenAI and WhatsApp requests made by tests were mocked. No real provider request was made for this implementation or its validation; official documentation was fetched separately.
- A scan of 66 source/test/documentation/configuration files found no values matching the private API tokens, app secrets, verification token or actual phone number ID.
- The code default and `.env.example` remain `AUTOMATION_ENABLED=false`. The user's already-enabled private flag remains `true`.
- The original conversational-reply setup selected the model through `OPENAI_MODEL` and set `AI_PROVIDER=openai`, `AI_TIMEOUT_MS=20000`, and `AI_MAX_OUTPUT_TOKENS=512`. The later [Astra migration](openai-astra-migration.md) updates only that model value in the private `.env`; the API key and all other values remain preserved.
- The running backend was not restarted. The live database was inspected read-only and remains at schema version 1; normal restart will apply migration 002 and load the conversational worker. No Meta configuration was changed.

Files changed for this phase (paths relative to the repository):

| Area | Files |
| --- | --- |
| Existing AI integration | `src/services/ai/aiService.js` |
| New prompt/validation and processor | `src/services/ai/conversation.js`, `src/services/ai/conversationProcessor.js` |
| Runtime/configuration | `src/config/env.js`, `src/server.js`, `src/worker.js`, `src/routes/webhook.js` |
| Existing outbox dispatcher | `src/services/whatsapp/replyDispatcher.js` |
| Database scope and migrations | `src/database/index.js`, `src/database/drivers.js`, `migrations/002_conversation.sqlite.sql`, `migrations/002_conversation.postgres.sql` |
| New tests | `test/aiReply.test.js`, `test/conversationProcessor.test.js`, `test/conversationDatabase.test.js` |
| Updated tests | `test/startup.test.js`, `test/security.test.js`, `test/worker.test.js` |
| Configuration files | Private `.env` (four non-secret settings only), `.env.example` |
| Documentation | `README.md`, `docs/conversational-replies.md`, `docs/webhook-local-testing.md`, `docs/automation-reference.md`, `src/database/README.md` |
