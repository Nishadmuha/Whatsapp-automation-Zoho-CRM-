# Implementation plan

Inspection: existing CommonJS / Node 22 / Express 5 receiver, signature validation,
WhatsApp sender, and 18 passing tests. No database or deployment configuration.
Keep the existing health alias, server export, sender export, and legacy Meta env names.

1. Separate app composition, validated configuration, HTTP middleware, and parsing.
2. Commit incoming messages to a durable SQL inbox before returning HTTP 200.
3. Add leased background processing, contact locks and CRM mappings, and a reply outbox.
4. Implement schema-constrained OpenAI/Gemini extraction, grounded contact validation,
   configurable Zoho OAuth/mapping/search/create/update, and sanitized provider errors.
5. Test external integrations using mocks and exercise persistence, failures, concurrency,
   webhook security, and startup; document configuration and deployment.

Credentials stay untouched. Automation stays disabled for the local smoke test.
PostgreSQL is the production database; file SQLite supports local development.
Ambiguous external writes must be reconciled, never blindly repeated.
