# Local implementation validation

Validated on 2026-09-11 with Node.js 22.20.0 on Windows.

- Installed dependencies and updated the lockfile.
- `npm run lint`: passed.
- `npm run check`: all source, script, and test JavaScript syntax checks passed.
- `npm test` with an isolated local PostgreSQL 18.3 test database: **149 passed, 0 failed, 0 skipped**.
- Database contract tests exercised both persistent SQLite and real PostgreSQL: migrations,
  unique inbox IDs, claims, fencing, lease recovery, atomic CRM checkpoints, contact locks,
  uncertain writes, and reply outbox recovery.
- Provider tests mocked Meta, OpenAI, Gemini, and Zoho HTTP APIs. No account credentials
  or live provider calls were used in these tests.
- `npm audit`: 0 reported vulnerabilities across installed dependencies at validation time.
- Started the local HTTP server on loopback port 5000 with automation disabled and provider
  credential variables blank. The existing `.env` file was not modified.
- `GET /health`: HTTP 200 with `status: ok` and service `whatsapp-lead-automation`.
- `GET /ready`: HTTP 200 with `status: ready` and `automation: disabled`.
- Two local deliveries of the same synthetic webhook ID: both HTTP 200; first inserted one
  message, second inserted zero and counted one duplicate. The unsigned stored record cannot
  be processed by a subsequently enabled worker.
- The temporary PostgreSQL cluster was used only for tests; the running local HTTP server
  uses the separate ignored SQLite development database.

Real number onboarding, API token/scopes/model access, Zoho field/layout configuration,
HTTPS deployment, DNS, and live end-to-end acceptance still require the company's accounts.
Docker deployment files were authored and inspected; the Docker CLI was not available in this
environment, so a container build was not run. Production PostgreSQL was tested directly.

The application handles uncertain external writes conservatively. It does not claim exactly-once
delivery across third-party APIs; uncertain CRM mutations and ambiguous WhatsApp sends require
operator reconciliation. See the root README for setup and recovery procedures.
