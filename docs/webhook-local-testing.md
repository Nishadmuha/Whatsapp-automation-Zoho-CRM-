# Local webhook testing

Run all commands from the repository root. These tests use only local HTTP endpoints and synthetic WhatsApp data. Keep `AUTOMATION_ENABLED=false` and use a development database. Configure and start the backend as shown in [README](../README.md).

## Automated checks

Conversational and fixed-reply integration tests use signed local webhook requests, temporary databases, and mocked OpenAI/WhatsApp services:

```powershell
node --test test/aiReply.test.js test/conversationProcessor.test.js test/conversationDatabase.test.js test/autoReply.test.js test/startup.test.js test/worker.test.js
```

They cover the disabled default, exact reply text, duplicate prevention, signature rejection, optional sender filtering, and outbox failures. Real automation remains off during these tests; see the [automatic reply setup](../README.md#8-optional-automatic-text-reply) before deliberately enabling it.

```powershell
npm.cmd run lint
npm.cmd run check
npm.cmd test
```

The tests cover health, successful and rejected verification, missing verification parameters, text receipt, unsupported types, malformed payloads and fields, repeated IDs, raw-body HMAC verification, environment validation, and preservation of the existing database/worker behavior. Provider HTTP calls are mocked. Tests use isolated SQLite; PostgreSQL tests run only with a dedicated `TEST_DATABASE_URL`.

WhatsApp text/template transport and the local sending CLI have focused offline tests:

```powershell
node --test test/whatsapp.test.js test/whatsappCli.test.js
```

For a manual dry run or explicitly requested real send, use `npm.cmd run whatsapp:test` as described in the [main README](../README.md#7-manually-test-whatsapp-sending). Only its `--send` option contacts Meta. It does not require a second server, AI, Zoho, or enabling automation.

With port 5000 free:

```powershell
npm.cmd run smoke:webhook
```

This starts and stops the actual server on `127.0.0.1:5000` using generated credentials and an isolated temporary SQLite database. It checks the health service name, correct and incorrect GET verification, a signed text event, duplicate receipt, and the safe `WhatsApp message received` log. It does not edit `.env` or need Meta account credentials. Its local signature test also works when your personal `.env` contains other configuration because the test server uses isolated settings.

If port 5000 is already in use, run the isolated test on another free port:

```powershell
$env:SMOKE_PORT = '5050'
npm.cmd run smoke:webhook
Remove-Item Env:SMOKE_PORT
```

## Manually check your running local server

The commands below read private environment values into memory and print only response status and body. They do not print verify tokens, signatures, or app secrets. Do not enable HTTP debug logging or paste private request URLs into shared output.

### Health

```powershell
Invoke-RestMethod http://127.0.0.1:5000/health
```

Expected response:

```json
{"status":"ok","service":"voltronix-whatsapp-backend"}
```

### GET verification

This uses your `.env` token without putting its value in shell history. The shell environment still takes precedence over `.env`, so use the same configuration as the server.

```powershell
@'
require('dotenv').config({ quiet: true });
const token = process.env.WEBHOOK_VERIFY_TOKEN?.trim();
if (!token) throw new Error('Set WEBHOOK_VERIFY_TOKEN before testing');
const query = new URLSearchParams({
  'hub.mode': 'subscribe',
  'hub.verify_token': token,
  'hub.challenge': '12345'
});
fetch('http://127.0.0.1:5000/webhook?' + query)
  .then(async (response) => console.log(response.status, await response.text()))
  .catch(() => { console.error('Local verification request failed'); process.exitCode = 1; });
'@ | node
```

Expected output: `200 12345`. For a negative test, replace `token` in the query with a synthetic incorrect value such as `'deliberately-invalid-local-token'`; expect `403 Forbidden`. Omitting the challenge or verify token also returns `403`.

### POST a text event, including HMAC when configured

The [sample JSON](samples/whatsapp-text.json) includes WABA ID, business number metadata, sender contact/profile, message ID, timestamp, and text. All values are synthetic. The command signs the exact bytes sent using your configured app secret, if present. It uses the legacy app-secret alias only when the modern variable is empty, matching the server.

```powershell
@'
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { createHmac } = require('node:crypto');
const payload = JSON.parse(fs.readFileSync('docs/samples/whatsapp-text.json', 'utf8'));
const value = payload.entry[0].changes[0].value;
value.messages[0].timestamp = String(Math.floor(Date.now() / 1000));
const configuredPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
if (configuredPhoneId) value.metadata.phone_number_id = configuredPhoneId;
const body = Buffer.from(JSON.stringify(payload), 'utf8');
const headers = { 'Content-Type': 'application/json' };
const secret = (process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET || '').trim();
if (secret) headers['X-Hub-Signature-256'] = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
fetch('http://127.0.0.1:5000/webhook', { method: 'POST', headers, body })
  .then(async (response) => console.log(response.status, await response.text()))
  .catch(() => { console.error('Local webhook POST failed'); process.exitCode = 1; });
'@ | node
```

If `ALLOWED_SENDER_PHONES` is set, the synthetic sample sender must be in that allowlist or the event will be harmlessly ignored. Use an isolated development configuration with a blank allowlist for this sample. The command fills a configured business Phone Number ID in memory; it does not edit the sample or `.env`.

Expected output: `200 EVENT_RECEIVED`. For the first accepted delivery, the server logs **`WhatsApp message received`** with a masked sender and text character count. Raw text and sender profile names are intentionally absent from logs. Run the same command again: it keeps the same message ID and returns `200`, while the database prevents a second intake record and receipt processing. To exercise a new message, change only the synthetic ID in your local sample.

An app secret enables signature enforcement in development as well as production. Without either app-secret variable, development accepts unsigned requests; use this mode only on localhost. The verification token and app secret serve different purposes; a correct GET token never authorizes an unsigned POST.

## Response expectations

| Request/event | Expected behavior |
| --- | --- |
| Correct GET token, subscribe mode, and challenge | `200` with the unchanged plain-text challenge. |
| Wrong/missing GET parameters | `403`. |
| Valid signed text event | `200 EVENT_RECEIVED` after durable intake. |
| Repeated WhatsApp message ID | `200`, no additional inbox record or repeated receipt processing. |
| Unsupported type, status event, missing arrays, malformed individual fields | `200`, ignored safely; unsupported types have a safe diagnostic log. |
| JSON syntax error | `400`; this differs from valid JSON with an irrelevant/malformed event structure. |
| Missing/invalid signature when app secret is configured | `403`. |
| Unsupported content type / oversized body | `415` / `413`. |
| Storage unavailable for an eligible message | `503` with `Retry-After`; retry after storage recovers. |
| Rate limit exceeded | `429`; wait for the rate-limit window. |

These local checks do not contact Meta, register a number, or establish a real webhook subscription. Next, follow the manual ngrok and dashboard steps in [README](../README.md) and verify an actual inbound WhatsApp text event while keeping automation disabled.
