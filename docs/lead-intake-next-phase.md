# WhatsApp lead intake implementation report

> This report records the earlier media/merge/history repair. The boss intake behavior below reflects the final optional-field policy; historical changed-file and verification records remain for that earlier pass. See the README for the latest implementation report.

Implemented in the existing Express application, webhook, workers, SQLite/PostgreSQL repository, OpenAI service and WhatsApp outbox. Zoho remains disconnected in server startup. No new backend, database, webhook or authentication system was introduced. Existing implementation already contained migrations 001–006, lead sessions, media extraction and the chat pages; this work reviewed them and repaired the remaining merge, media and history issues.

## Files changed in this pass

| Area | Files |
| --- | --- |
| Lead merging | `src/services/leads/leadMerge.js`, `src/services/leads/leadService.js` |
| Media and factual validation | `src/utils/media.js`, `src/services/leads/leadMedia.js`, `src/services/ai/aiService.js`, `src/services/ai/leadExtraction.js`, `src/services/whatsapp/whatsappService.js` |
| History persistence | `src/database/index.js`, `src/database/drivers.js`, `src/services/admin/messagesAdmin.js` |
| Migration | `migrations/007_reply_history.sqlite.sql`, `migrations/007_reply_history.postgres.sql` |
| Admin | `src/routes/chats.js`, `src/admin/chats.js`, `src/admin/leads.js`, `src/admin/leads.html` |
| Regression tests | `test/leadMerge.test.js`, `test/leadWorkflow.test.js`, `test/leadExtraction.test.js`, `test/mediaIntake.test.js`, `test/admin.test.js`, `test/conversationDatabase.test.js`, `test/leadExtractionDatabase.test.js`, `test/leadWorkflowDatabase.test.js`, `test/chatsApi.test.js`, `test/chatsDashboard.test.js`, `test/leadsDashboard.test.js` |
| Documentation | `README.md`, `src/database/README.md`, `docs/boss-chat.md`, this report |

## Database migration

The next available migration is **007_reply_history**, provided for both SQLite and PostgreSQL. It adds a history-only archive for outbound replies replaced by the existing explicit operator retry command. Original text, source message, provider message ID, timestamps and final delivery status are retained atomically before the outbox slot is freed. Unsent replaced replies are labelled `CANCELLED`; archived rows can never be dispatched. If the retry transaction fails, archive insertion and outbox removal both roll back.

The existing `whatsapp_messages`, `reply_outbox`, `message_receipts`, `lead_sessions` and `leads` tables remain authoritative. The chat repository reads them plus the reply archive without duplicating normal messages. Migration 006 already provides `address`, `trn_no`, media transcription/extracted text and retained discarded drafts. No existing migration was rewritten, and no operational database was modified during implementation.

Replies removed by operator retries before migration 007 may already have lost their text; that unavailable text cannot be reconstructed from the older audit records. Future retries retain it.

## API and admin pages

The existing authenticated endpoints remain:

- `GET /api/chats?page=1&page_size=20&search=`
- `GET /api/chats/:id`
- `GET /api/chats/:id/messages?page=1&page_size=100`

`id` remains the URL-encoded real WhatsApp sender phone. These routes use the existing shared ADMIN_API_TOKEN / dashboard-session authentication middleware. No second login or credentials in browser JavaScript were added. Message responses now include `sender_type`, derived from the source message's persisted processing role. This avoids relabelling earlier customer messages as boss messages after a role change.

`/admin/chats` retains its simple conversation-list/history layout, media indicators, OCR/transcription, current draft and retained closed drafts. Pagination exposes all retained messages. Saved leads now display their useful fields and link to exact lead details. `/admin/leads` remains available and now has direct conversation links in its rows. No new pages or duplicate API routes were needed.

Conversation identity follows the actual sender. A customer's phone mentioned in boss intake is a lead field and does not transfer the boss's internal history into that customer's conversation. Existing histories for the same actual sender remain on that sender's thread, with individual message roles preserved.

## Boss intake behavior

- Greetings such as Hi/Hello/Hey and time-of-day greetings receive one natural readiness reply without extraction, a new lead, or resetting the active draft.
- Unstructured text, readable screenshots, company documents and voice transcripts merge into one durable active draft. Null or ungrounded updates do not overwrite known facts. Corrected fields cannot revert solely because the AI repeated old context on a later unrelated turn. Additional requirements, products and notes are retained within field bounds; full source messages remain in history.
- Every lead field is optional, including company/contact identity and requirement/product/service. A name, email, phone, company or any other meaningful factual subset is enough to request confirmation; other fields remain null.
- Factual drafts enter `awaiting_confirmation` and reply exactly: “I have the available information for this lead. Is everything complete and ready to save?” No saved lead is inserted until direct, clear text confirmation. Yes, Yes save, Save it, Confirm, Confirmed, Complete, Okay save, Proceed and Looks good are supported. Conversational commands never become lead facts.
- No/Not yet/I'll send more/Wait/Need to add more/More details keep the same draft collecting. A later explicit confirmation can save its available facts. Successful persistence replies “Lead saved successfully ✅” and closes the session; subsequent details start another. New lead/New customer/Next customer/Start another lead ask for an explicit decision if a draft is open. Discard archives that draft instead of deleting its details.
- Save/discard/new-lead commands recognized inside an attachment cannot authorize a transition; the bot requests a direct text command. This protects against instructions inside screenshots/documents and mistaken transcription.

## Images, documents and voice

Signed webhook media IDs go through the existing authenticated WhatsApp download service. Downloads enforce HTTPS, a fixed Meta attachment host, no redirects, time/size/MIME limits, returned media ID consistency and SHA-256 matching when metadata provides a checksum. Provider errors expose neither credentials nor private download URLs.

Vision/file extraction uses the existing Responses API integration; audio uses multipart transcription with a filename and content type. JPEG/PNG/WebP screenshots are supported, including images sent as documents. PDF, DOC/DOCX, ODT, RTF and UTF-8 text documents are supported. OGG voice notes and supported audio formats merge through the same lead workflow. Successfully read source text/transcription is checkpointed before extraction retries and remains available in admin history.

Unreadable-only output, including `Company: [unreadable]`, requests clarification and cannot become a company or other lead value. Partly readable source text is retained; uncertain placeholder values are omitted. AI recognition quality still depends on the supplied media; the automated tests use deterministic mocks rather than measuring real OCR accuracy.

Current limits: images 5 MiB; audio and Office/PDF documents 16 MiB; UTF-8 text documents 32 KiB. Embedded images in non-PDF documents need a separate screenshot or PDF. Video is retained with a media indicator and a request for a screenshot, rather than transcribed as a lead. Oversized or unreadable content requests a resend.

API contracts were checked against official OpenAI documentation: [image inputs](https://developers.openai.com/api/docs/guides/images-vision), [file inputs](https://developers.openai.com/api/docs/guides/file-inputs), and [audio transcription](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).

## Idempotency and security

The signed webhook still commits its inbox receipt before acknowledgement. Unique WhatsApp IDs prevent duplicate receipt jobs; boss messages are ordered by durable receipt sequence; lease checks fence stale workers; draft/save/outbox changes commit atomically; and a unique outbox slot limits automatic replies per incoming message. Uncertain sends remain subject to the existing reconciliation rules instead of being blindly resent. Webhook retries cannot produce additional replies. The legacy explicit operator retry command retains its intentional retry behavior and now preserves prior history.

Existing webhook verification, HMAC validation, boss authorization, customer AI replies, bounded APIs, no-store responses, rate limits, safe text rendering and configured-secret redaction remain in place. No provider calls were made during automated tests. Zoho service modules remain available for existing unit tests, but runtime startup does not construct or call them.

## Validation and activation

Historical validation for this repair pass (2026-09-12):

- `npm.cmd test`: **510 cases, 440 passed, 0 failed, 70 skipped**. The skipped cases are PostgreSQL contracts without a dedicated `TEST_DATABASE_URL`.
- `npm.cmd run lint`: passed.
- `npm.cmd run check`: passed; syntax checked throughout `src`, `test` and `scripts`.
- All existing tests were included. Regression coverage includes greetings, one-draft merging, screenshots, voice checkpoints, null protection, awaiting-confirmation/yes/no, saved-session closure, new/discard transitions, webhook duplicates, incoming/outgoing history, chat API authentication and secret redaction, HMAC, and disconnected Zoho startup. This pass adds correction/addition/uncertainty/history-retention and navigation/role regressions.
- Full test output: [`data/verification-final-tests.log`](../data/verification-final-tests.log). Tests used temporary databases and mocked WhatsApp/OpenAI/Zoho providers. Actual WhatsApp delivery and real-media OCR/transcription were not exercised.

To activate the changes:

1. Stop the existing backend worker process, keeping the same project and database configuration. Take your normal operational database backup before deployment.
2. From the project directory run `npm.cmd run db:migrate` to apply pending migrations using the existing runner. Startup also applies pending migrations.
3. Restart with `npm.cmd start`. The existing ngrok tunnel and `/webhook` callback can be reused.
4. Keep existing private WhatsApp/OpenAI/admin/boss configuration. `AUTOMATION_ENABLED=true` and `AI_PROVIDER=openai` enable this intake flow. `OPENAI_MODEL` must support vision and structured extraction; `OPENAI_TRANSCRIPTION_MODEL` defaults to `gpt-4o-mini-transcribe`. No credentials need to be placed in frontend assets, and Zoho must remain disabled.
5. Sign in at `/admin/chats` or use the already supported ADMIN_API_TOKEN for API requests. Handset verification with a greeting, readable screenshot, voice note, extra details and final text confirmation is a manual provider test; it was not run by automated verification.

PostgreSQL contract tests require a dedicated `TEST_DATABASE_URL`; otherwise those cases are explicitly skipped. No schema/data migration or live server restart was performed against the operational database during this task.
