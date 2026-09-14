# Webhook phase validation

Validated locally on 2026-09-11 using Node.js 22.20.0 on Windows. This report covers webhook verification and receipt only; previous automation reports are historical.

- Dependencies were already installed and `npm.cmd ls --depth=0` passed; no dependency changes or installation were needed.
- `npm.cmd run lint` and `npm.cmd run check` passed.
- `npm.cmd test`: **149 passed, 0 failed, 17 skipped** (166 tests). The skipped tests require a separately configured PostgreSQL test database. SQLite persistence and restart/concurrent duplicate protection were exercised. External API dependencies are mocked.
- `npm.cmd run smoke:webhook` passed on **127.0.0.1:5000**, starting the real server with generated, temporary credentials and a separate temporary SQLite database.
- `GET /health`: HTTP 200 with `{"status":"ok","service":"voltronix-whatsapp-backend"}`.
- Correct `GET /webhook` verification: HTTP 200, plain-text challenge `12345`. Incorrect verification token: HTTP 403.
- Signed `POST /webhook` with a synthetic Meta text payload: HTTP 200. Repeating the message: HTTP 200, one total inbox row, one `WhatsApp message received` log, masked sender, no message body in logs, and no reply rows.
- Unsigned POST while signature validation was enabled: HTTP 403.
- Smoke checks confirmed no credentials or full sender phone appeared in captured server logs. The smoke server stopped and its temporary database was removed.
- The older local backend was restarted with current source. The backend is left listening on port 5000 with `AUTOMATION_ENABLED=false`; its health, readiness, and verification were checked again. It uses local SQLite. Runtime logs are ignored under `data/webhook-server.log` and `data/webhook-server.err`.
- The private `.env` was preserved. `.env.example` credential fields remain empty, and `.gitignore` already excludes `.env` and local data. A comparison against the configured private credential values found none in deliverable source or documentation. There is no Git repository metadata in this workspace, so no commit was created.

## Files changed or added

| Files | Change |
| --- | --- |
| `src/app.js` | Requested health service name. |
| `src/config/env.js` | Correct missing-variable startup guidance. |
| `src/server.js` | Initialize existing automation services only when explicitly enabled; explain unsigned local mode. |
| `src/routes/webhook.js` | Nonempty verification challenge, reusable parser, safe receipt/unsupported logs, immediate irrelevant-event ACK, bounded SQL batches. |
| `src/services/whatsapp/whatsappParser.js` | Full reusable message parser and preserved legacy adapter. |
| `src/database/index.js`, `src/database/README.md` | Optional committed insertion IDs for duplicate-safe receipt logs, preserving the existing repository return shape by default. |
| `test/webhook.test.js`, `test/startup.test.js`, `test/database.test.js`, `test/whatsappParser.test.js` | Webhook, startup, privacy, parsing and persistent deduplication regressions. |
| `scripts/smoke-webhook.js`, `package.json` | Repeatable isolated HTTP smoke command. |
| `README.md`, `.env.example` | Current webhook-only setup and placeholder configuration. |
| `docs/webhook-local-testing.md`, `docs/samples/whatsapp-text.json` | Verified private local GET/HMAC POST commands and synthetic payload. |
| `docs/automation-reference.md` | Preserved previous README as deferred-phase reference. |
| `docs/webhook-validation.md` | This validation record. |

## Remaining manual work

Configure the intended Meta app/WABA and WhatsApp business number, matching app secret and optional number filter. Start `ngrok http 5000`, use `https://YOUR-NGROK-DOMAIN/webhook`, enter the exact `WEBHOOK_VERIFY_TOKEN`, subscribe to `messages` and the intended WABA, and send a real inbound text message. Local tests establish backend behavior, not real Meta connectivity. Keep automation disabled for this phase.
