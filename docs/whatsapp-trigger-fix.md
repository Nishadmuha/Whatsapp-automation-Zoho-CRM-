# WhatsApp incoming-message trigger fix

## Confirmed cause

The guidance reply sent on 13 September 2026 at 18:01 Dubai time was linked to an incoming message timestamped 12 September at 19:27. That event first reached the local inbox on 13 September at 18:01, about 22.5 hours late. The parser rejected far-future timestamps but had no historical-message cutoff. A previously unseen old ID therefore became a new extraction job. The guidance text is a fixed workflow reply; it is not a scheduled greeting.

The startup workers could also resume older unfinished extraction jobs and pending replies. Unique inbox IDs already prevented duplicate inserts, but uniqueness did not establish that a message was fresh.

## Trigger rules

- A valid, authenticated incoming webhook must pass the existing sender and destination checks.
- Verification requests, status notifications, outgoing/self echoes, messages before this application run, and messages five minutes old or older do not authorize automation. Meta timestamps have one-second precision; the startup boundary uses that precision.
- Only an ID returned by a successful new inbox insert can enter the current process's automation list. The persistent unique WhatsApp message ID remains the cross-restart replay protection.
- Workers and reply dispatchers select only currently admitted IDs. Old inbox jobs, drafts, extraction jobs and outbox entries remain stored but cannot authorize a reply in the new run.
- Each newly admitted message gets one processing attempt. A transient failure cannot schedule another AI attempt for that same message. The user can send a new message to continue the retained draft.
- The trigger expires five minutes after the message timestamp and closes during shutdown. Checks before AI work, after asynchronous work, and before reply delivery reject expired or stopped work. An external request already dispatched cannot be recalled.
- Non-boss media remains available in existing chat history without occupying the automation list. Existing boss text/image/voice/document handling, per-sender draft merging, explicit save confirmation and fixed greeting text are retained.

The runtime list is for this existing single-backend-process deployment. It is not a shared queue for horizontally scaled backend replicas. SQL still stores all existing lead fields and saved leads; MongoDB, Zoho and credentials are unchanged.

## Files

- `src/services/whatsapp/incomingTriggerGate.js`: current-run admission, expiry and one-attempt guard.
- `src/routes/webhook.js`, `src/services/whatsapp/whatsappParser.js`: historical/status/outgoing filtering, durable-ID admission and safe ignore logs.
- `src/app.js`, `src/server.js`, `src/worker.js`: runtime lifecycle and scoped worker claims.
- `src/database/index.js`: optional message-ID scope for inbox, extraction and outbox selection; no schema changes.
- `src/services/ai/conversationProcessor.js`, `src/services/ai/bossLeadProcessor.js`, `src/services/leads/bossLeadWorkflow.js`: AI and completion guards.
- `src/services/leads/leadService.js`, `src/services/leads/leadMedia.js`: guard pending session/media work before further AI calls.
- `src/services/whatsapp/replyDispatcher.js`, `src/services/whatsapp/autoReply.js`: current-run reply delivery guard.
- `test/incomingTrigger.test.js`, `test/incomingTriggerGate.test.js`, `test/triggerScope.test.js`: new regressions.
- `test/conversationProcessor.test.js`: historical-webhook expectation plus retained stored-expiry coverage.
- `README.md`, this report: behavior documentation.

## Verification

Tests use temporary databases and mocked AI, media downloads and WhatsApp delivery. They do not send real WhatsApp messages or change the live leads.

Covered: silent startup/restart and idle polling; old pending and retrying jobs; old queued replies; concurrent duplicate IDs; one fresh greeting; verification and sent/delivered/read/failed statuses; self/outgoing echoes; delayed previously unseen IDs; fresh boss text; text/image/voice draft merging and one explicit save; no retry without another incoming message; shutdown during pending AI or media download; and retained non-boss media.

Run `npm.cmd test`, `npm.cmd run lint`, and `npm.cmd run check`. Restart the backend after installing the change; keep the existing ngrok tunnel running. Old queued work is deliberately not replayed, so send a fresh message to continue an existing draft.

Final validation: **672 tests total; 570 passed, 102 optional PostgreSQL tests skipped, zero failures**. ESLint and JavaScript syntax checks passed. The `.env` fingerprint, MongoDB connection module, dependency manifests and migration files are unchanged; no secret values were found in changed files.

Live activation was deferred: the Atlas preflight and TLS handshake failed with `ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR`. The existing backend and ngrok were kept running. Once Atlas connectivity is restored, stop the existing backend with Ctrl+C and run `npm.cmd start` from the project directory to load this fix. The automated restart tests above use isolated temporary databases and mocked providers.
