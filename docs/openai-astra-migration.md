# OpenAI model migration to GPT-6 Astra

The configured text/vision model is now `gpt-6-astra`. The existing Axios integration already used the Responses API, so no Chat Completions migration, OpenAI SDK installation, or dependency upgrade was needed.

## Inspection before editing

Repository-wide searches covered OpenAI configuration, endpoints, model names, sampling/token/reasoning parameters, structured outputs, prompts and tool/function calling. Dependencies were inspected through `package.json`, `package-lock.json` and the installed packages. Private configuration was inspected without printing credentials.

| Location | Existing responsibility and migration |
| --- | --- |
| `.env` | Changed only `OPENAI_MODEL`; all other bytes preserved. |
| `.env.example`, `README.md`, `docs/conversational-replies.md`, `docs/boss-lead-extraction.md` | Updated model examples and relevant compatibility notes. |
| `src/server.js` | Loads `.env` and creates the shared AI service; unchanged. |
| `src/config/env.js` | Controls provider/automation routing; unchanged. |
| `src/services/ai/aiService.js` | Reads the selected model/key and performs all OpenAI HTTP requests through Axios. Added low reasoning effort for the exact Astra model on four Responses call sites. |
| `src/services/ai/conversation.js` | Customer reply instructions and input/output validation; unchanged. |
| `src/services/ai/leadExtractor.js` | Legacy eight-field extraction instructions, JSON schema and parser; unchanged. |
| `src/services/ai/leadExtraction.js` | Active lead enquiry instructions, strict schema, source grounding and validation; unchanged. |
| `src/services/ai/aiService.js` media instructions | Image/document transcription prompt and media validation; unchanged. |
| `src/services/ai/conversationProcessor.js`, `src/services/ai/bossLeadProcessor.js`, `src/services/leads/leadExtractor.js`, `src/services/leads/leadMedia.js`, `src/services/leads/leadProcessor.js` | All callers of the AI service, including the deferred CRM path; unchanged. |
| `test/astraMigration.test.js` | Added ten mocked regression cases covering model compatibility and preserved contracts. |

The four Responses call sites serve customer replies, legacy lead extraction, active lead enquiry extraction, and image/document OCR. Each uses `OPENAI_MODEL`. Voice transcription continues using `/v1/audio/transcriptions` with the separate `OPENAI_TRANSCRIPTION_MODEL` or its existing `gpt-4o-mini-transcribe` default. Plain-text documents continue to be decoded locally.

## API and parameter decisions

- Retained `POST https://api.openai.com/v1/responses`, the installed Axios transport, existing HTTPS verification, timeouts, bounded payloads, error sanitization and worker retry handling.
- Added `reasoning: { effort: 'low' }` only when the configured model is exactly `gpt-6-astra`. This is Astra's lowest supported reasoning level and suits the existing short-reply/extraction workload. Other configured models and Gemini receive no new parameter. See the [official Astra migration guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra).
- No incompatible sampling parameters needed removal: `temperature`, `top_p`, `top_logprobs`, `logprobs` and legacy `max_tokens` were already absent. There was no tool/function calling or prompt-cache configuration to migrate.
- Preserved `max_output_tokens`, `store:false`, `truncation:'disabled'`, separate system/user messages, and strict `text.format` JSON schemas. Reasoning items are ignored when reading the completed assistant answer. Incomplete, refused, malformed or unexpected tool output remains rejected.
- Preserved `AI_TIMEOUT_MS=20000`, `AI_MAX_OUTPUT_TOKENS=512`, the independent media limit (default 4096), and all existing validation limits. For reasoning models, the total output cap includes reasoning and answer tokens. Synthetic checks fit these settings; larger or harder inputs can still exceed them and fail safely. There is no silent token increase. See [OpenAI output-budget guidance](https://developers.openai.com/api/docs/guides/reasoning).

## Business behavior preserved

Webhook signature checks, Meta configuration, acknowledgement, deduplication, database schemas, routes, frontend and WhatsApp delivery logic are unchanged. AI work still runs after inbox acknowledgement.

The active lead result remains `{ is_lead, lead }`, with thirteen nullable fields: `company_name`, `contact_name`, `phone`, `email`, `project_name`, `project_location`, `product_or_service`, `requirement`, `quantity`, `deadline`, `notes`, `address`, `trn_no`. Strict JSON requires all keys and rejects extra keys. Missing/ambiguous information stays null; local source grounding rejects invented facts. All individual lead fields remain optional.

Boss intake still extracts facts from the current turn and merges them into the persisted draft. Null does not erase a known fact; corrections and accumulated requirements retain their existing rules. Explicit text confirmation is still required before saving. OCR/voice text cannot authorize saving. Customer replies retain their existing current-message-only context.

The deferred Zoho extraction contract remains `name`, `phone`, `email`, `company`, `service`, `location`, `requirement`, `notes`. Zoho field mappings and validation are unchanged. Zoho writes were already disconnected in the running server; this migration preserves that state and all existing CRM modules.

## Verification

- Baseline: 497 tests passed, zero failed, 96 skipped.
- After migration: `npm.cmd test` passed with 507 tests passed, zero failed, 96 skipped (603 total). All skips are optional PostgreSQL tests requiring a dedicated `TEST_DATABASE_URL`.
- `npm.cmd run lint` passed. `npm.cmd run check` passed JavaScript syntax validation. There is no build script.
- Ten added mocked regression cases cover every Responses workload, strict nullable schemas, reasoning exclusion, preserved input/context boundaries and budgets, independent transcription, other-model isolation, and safe refusal/incomplete/malformed handling.
- A read-only OpenAI model lookup confirmed this account can access `gpt-6-astra`. Four small synthetic pre-change requests tested replies, fuller/partial active leads and legacy extraction with the proposed request settings. A fifth live check through the updated service verified known fields and null missing fields. All completed within the existing 512-token and 20-second limits. No customer records, WhatsApp messages or Zoho records were sent/created by validation. Media/transcription coverage was mocked, not live.
- A final repository search found no remaining references to the former model identifier. A hash comparison verified unchanged runtime files outside `aiService.js`, unchanged package files, and unchanged private configuration except the model line.

## Restart

The private `.env` already contains `OPENAI_MODEL=gpt-6-astra`; no other environment update is required. An already-running Node process retains its old environment and loaded code until restarted. In the localhost terminal, press **Ctrl+C**, then run:

```powershell
Set-Location -LiteralPath 'D:\whatsapp automation backend\voltronix-whatsapp-backend'
npm.cmd start
```

Keep the existing ngrok terminal running. Port 5000 and `/webhook` are unchanged.
