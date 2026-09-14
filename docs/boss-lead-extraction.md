# Phase 1: internal boss lead extraction

> Historical Phase 1 implementation record. New boss receipts now use the exclusive [boss lead chat workflow](boss-chat.md). Every individual field is optional: any grounded lead fact is retained, then explicit boss confirmation is requested before saving. The extraction schema and source-grounding rules below remain in use, with address/TRN added later; Phase 1's parallel conversational reply behavior does not apply to new boss receipts.

Authorized boss messages can produce a validated `LeadExtraction` result while the existing WhatsApp → OpenAI → WhatsApp conversation continues. This phase creates no Zoho records, makes no CRM API requests and adds no approval or extracted-JSON WhatsApp reply.

## Configuration

Keep the existing private `.env` key and model:

```dotenv
AUTOMATION_ENABLED=false
AI_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-6-astra
AI_TIMEOUT_MS=20000
AI_MAX_OUTPUT_TOKENS=512
# Fill privately with explicitly authorized international WhatsApp sender numbers.
BOSS_SENDER_PHONES=
```

The default master switch remains false. An already-enabled private master switch need not change. Blank `BOSS_SENDER_PHONES` disables extraction; multiple boss numbers can be comma-separated with country codes. Number authorization is matched against the sender in the authenticated Meta payload, never a phone number or a claim to be the boss inside the message body. Removing boss authorization prevents a pending extraction result from being accepted on its next processing attempt.

`BOSS_SENDER_PHONES` is independent of `ALLOWED_SENDER_PHONES`. The latter remains the existing optional global receive filter; leaving it blank keeps ordinary customer conversations accessible. If a global filter is configured, a boss must also be allowed through that filter. No new key, model, provider or server is needed. The existing OpenAI timeout, token cap, worker lease, poll interval and processing-attempt settings are reused.

Restart the same backend to reload environment settings and apply migration 003. Keep ngrok and the Meta webhook configuration as they are. Do not replace the private key with the blank documentation placeholder.

## Processing

1. The existing route validates the original HMAC and parses text as before. For a new eligible message from an explicitly configured boss while OpenAI automation is enabled, inbox receipt and a unique extraction job commit in the same database transaction before HTTP 200.
2. The existing conversation worker generates and sends its usual text reply through the unchanged WhatsApp outbox. It receives no extraction result.
3. Another instance of the existing worker runs internal extraction independently inside the same Node process. It does not add a server, Redis or WhatsApp sender. A slow, failed or irrelevant extraction cannot block the conversational worker.
4. `createAiService().extractLeadEnquiry(originalText)` uses the existing Responses integration with [strict Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), the existing configured model/key, verified HTTPS and `store:false`.
5. `leadExtraction.js` validates schema, types, size limits and source grounding. `bossLeadProcessor.js` rechecks authorization and lease ownership, revalidates at the persistence boundary, then stores the result in `lead_extractions.result`.

An authorized boss's text is classified to distinguish an enquiry from a greeting or irrelevant message. This adds an extraction request for those boss texts; ordinary customers use only the existing conversation request. The original `whatsapp_messages.message_text` remains unchanged, linked by message ID for audit. The legacy eight-field extractor, lead processor and `extracted_lead_data` CRM field are not used by this phase.

The internal result is an envelope:

```json
{
  "is_lead": true,
  "lead": {
    "company_name": "ABC",
    "contact_name": "Ahmed",
    "phone": "+971501234567",
    "email": null,
    "project_name": null,
    "project_location": "Dubai",
    "product_or_service": "500A electrical switchgear",
    "requirement": "quotation",
    "quantity": null,
    "deadline": "this week",
    "notes": null
  }
}
```

This example uses mocked provider data for: “Client ABC wants quotation for 500A electrical switchgear for their Dubai warehouse. Contact Ahmed, 0501234567. Need quotation this week.” No real contact or API send is needed to generate the example.

All eleven historical field keys are required in the provider schema and accept only a string or null; the current schema also includes nullable address and TRN keys. Required JSON keys do not require populated values. Quantity is a string so explicitly stated units can be preserved. Missing, unknown or ambiguous fields become null; a malformed shape, extra key or wrong type is rejected. An irrelevant or wholly ungrounded result has `is_lead:false` and all-null fields. Any meaningful grounded field, including a name, company, email or phone alone, is lead information; no requirement or product/service is needed.

## Source validation and limits

The model is instructed to copy concise facts rather than invent or translate them. Non-contact values must appear as whole phrases in the original text, allowing case and whitespace differences; unsupported values are discarded. This conservative check can discard useful paraphrases and leaves them null for later review. Classification and assignment of a source phrase to a field are still model judgments; schema compliance alone does not prove their meaning.

Phone normalization reuses `utils/phone.js`: supported complete UAE local numbers become international form, and valid explicit international numbers retain their country. The original message must contain a whole phone candidate that normalizes to the same value. Incomplete or masked values such as `050xxxxxxx` become null; no digits are guessed. Email must be valid and present as a whole original contact token. Dates such as “this week” remain literal instead of becoming guessed calendar dates. Electrical ratings belong to the product specification, not an inferred order quantity.

The existing 4,000-character / 16,000-byte AI input limit applies. The extraction JSON has field-specific limits, a 32,768-byte parse limit, and a 24,000-byte database result limit. Truncated, refused or incomplete model responses fail safely. The configured output token cap is preserved; no hidden larger model or token-budget override is added.

## Persistence, failures and logging

`lead_extractions` has separate attempts, leases and result status: `RECEIVED`, `PROCESSING`, `SUCCESS`, `IRRELEVANT`, or `FAILED`. Duplicate webhook deliveries cannot add jobs, and migrations never backfill earlier customer/boss messages. The processor checks current boss authorization before making the request and before accepting its result. Revoked, unsigned or unsupported jobs cannot extract successfully.

Transient timeout/network/server errors and ordinary rate limits use the existing bounded retry schedule: 5 seconds, doubling up to 5 minutes, with `PROCESSING_MAX_ATTEMPTS` (default 3). Authentication, exhausted quota, configuration, invalid input and malformed results fail without an automatic retry. Expired leases can recover unfinished work; an old lease cannot overwrite another worker's result. An interrupted generation may repeat if no result committed, but extraction never sends or queues a WhatsApp message.

Successful extraction logs `boss_lead_extracted` with the message ID, `is_lead`, and populated/missing field counts. Irrelevant messages log `boss_message_not_lead`. Failures log only allowlisted codes and retry metadata. No result JSON, customer contact values, original body, access token or provider response is copied into these summaries. The result is available through the internal `store.getLeadExtraction(messageId)` method and private database inspection, with no new public endpoint.

Zoho stays completely disconnected from runtime startup. No create/update operation, credentials validation, contact lock, OAuth request, boss approval or legacy lead processor is invoked. The master switch controls both workers.

## Automated validation

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run check
```

Tests use mocked OpenAI/WhatsApp services and temporary databases. Coverage includes complete and partial leads, missing fields, irrelevant messages, malformed/refused output, source grounding, phone/email normalization, boss authorization, deduplication, lease recovery, retries, migration preservation, safe logs and unchanged conversational delivery. Optional PostgreSQL tests skip unless a dedicated `TEST_DATABASE_URL` is provided. No real OpenAI, WhatsApp or Zoho request is required by these tests.

## Implementation report — 2026-09-12

- `npm.cmd test`: 345 total; 296 passed, 0 failed, 49 optional PostgreSQL tests skipped because `TEST_DATABASE_URL` was not configured.
- `npm.cmd run lint`: passed.
- `npm.cmd run check`: passed.
- All provider calls in validation were mocked; no live OpenAI, WhatsApp or Zoho request was made for this implementation or its tests.
- The authorized boss supplied by the user was saved only in the private `.env` as `BOSS_SENDER_PHONES`. Existing private key/model, master-switch and customer-access values were preserved. Source defaults remain disabled.
- The existing conversation processor, parser, WhatsApp transport, reply dispatcher and shared worker files have unchanged hashes. HMAC validation was not changed; the webhook addition only derives the private extraction-job flag from configured boss authorization.
- Startup tests hold extraction pending until both normal replies are `SENT`, then release it into successful or failed extraction. Both cases preserve health/readiness and webhook HTTP 200, with no legacy lead/Zoho module loads.
- The live backend remained running and returned readiness HTTP 200. It was not restarted and its database remains at schema version 2. Restarting the same backend loads Phase 1 and transactionally applies migration 003; old messages are not backfilled.

Files changed (relative to the repository):

| Area | Files |
| --- | --- |
| AI integration | `src/services/ai/aiService.js` |
| New extraction modules | `src/services/ai/leadExtraction.js`, `src/services/ai/bossLeadProcessor.js` |
| Authorization and runtime | `src/config/env.js`, `src/routes/webhook.js`, `src/server.js` |
| Internal job persistence | `src/database/index.js`, `src/database/drivers.js`, `migrations/003_lead_extractions.sqlite.sql`, `migrations/003_lead_extractions.postgres.sql` |
| New tests | `test/leadExtraction.test.js`, `test/leadExtractionDatabase.test.js`, `test/bossLeadProcessor.test.js`, `test/bossLeadStartup.test.js` |
| Updated regression tests | `test/security.test.js`, `test/startup.test.js`, `test/conversationDatabase.test.js` |
| Environment | Private `.env` (boss authorization only), `.env.example` |
| Documentation | `README.md`, `docs/boss-lead-extraction.md`, `docs/conversational-replies.md`, `docs/automation-reference.md`, `src/database/README.md` |
