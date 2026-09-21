# Boss lead chat and history

This extension runs inside the existing Phase 2 Express process, inbox worker, reply outbox, SQL migration system, WhatsApp webhook, OpenAI service and admin login. Zoho remains disconnected. No additional application or database is required.

## Conversation flow

- A standalone greeting receives a short greeting without extraction or creation of a lead session. Greetings within a draft preserve its ID, details and state.
- Standalone thanks, okay, yes/no, wait and similar conversation messages are not extracted into lead fields.
- Customer details are extracted and merged in any order, through text, screenshots/documents or voice transcriptions. Any meaningful lead fact moves the draft to `awaiting_confirmation`. New nulls never overwrite known facts. One active draft per authorized boss survives restarts.
- Every lead field is optional: company, contact name, phone, email, address, TRN, project, location, product/service, requirement, quantity, deadline and notes. A name, company, email, phone or any other factual field alone can form a lead. Supplied facts are source-grounded and never filled from the boss's identity.
- Text, images, documents and voice messages arriving together are merged into one draft. The bot waits for a five-second pause after the latest incoming boss message and finishes processing the files before sending one confirmation: “I have the available information for this lead. Is everything complete and ready to save?” The configured summary variant remains available. No lead is inserted yet, and missing individual fields do not prompt a mandatory follow-up.
- `MESSAGE_BATCH_QUIET_MS` controls the content batching pause (default `5000`, allowed range `100`–`60000` milliseconds). `BOSS_REPLY_QUIET_MS` continues to control confirmation coalescing. One durable processing acknowledgement is sent for the complete content batch, followed by one final workflow response. Superseded unsent prompts remain in the outbox as `CANCELLED`; errors and explicit save/discard replies remain deliverable.
- In that state, a clear standalone text confirmation such as `Yes`, `Yes save`, `Save`, `Save it`, `Complete`, `Confirm`, `Confirmed`, `Okay, save`, `Looks good`, `Proceed` or `Proceed with saving` commits the lead and closes the session. The outbox receives “Lead saved successfully ✅” in the same transaction. The next customer details start a new draft.
- `No`, `Not yet`, `I'll send more`, `Wait`, `Need to add more` and `More details` keep the same draft in `collecting` without removing information. Further details merge and trigger the same confirmation question. A later explicit `Yes` saves the retained factual draft, including after a deferral; an empty draft does not become a lead merely because the boss says yes.
- Mixed text such as “Yes, change quantity to 10” or “No, add the project location as DIP” is processed as details. Additional information merges into the same draft and refreshes the confirmation after the pause. `TRN is ...` is accepted as a labelled tax identifier. Text recognized inside a screenshot or voice attachment cannot itself authorize saving; confirmation must be a direct text message.

`New lead`, `New customer`, `Next customer` and `Start another lead` open a fresh empty draft when none is active. If an unsaved draft exists, the bot asks for `discard current lead` or `continue`. Discard archives the previous draft without deleting its details and atomically opens a new empty session. A bare `Yes` while this choice is pending cannot accidentally save or discard. Messages sent before resolving that choice remain in history; the bot asks for the choice before merging them into a customer draft.

Lead extraction accepts up to 16,384 characters / 32,768 UTF-8 bytes per call. Independent media reads in one batch run concurrently; their successful OCR/transcription and text are combined for one lead extraction call and merged into the stored draft. A failed attachment does not discard readable siblings. The session retains the latest 64,000 characters as a source summary, while complete original messages and raw media text remain in chat history. Irrelevant input with no current draft does not create an empty session. Existing customer AI input/output bounds are unchanged. Terminal AI errors retain draft source text for clarification, record safe diagnostics and never claim a save. A wholly unreadable batch returns one resend request and puts any existing draft back into `collecting`.

## Media

See the [image and voice audit](image-voice-audit.md) for supported audio formats, mixed-message regression coverage, transport checks and validation limits.

The existing WhatsApp service privately retrieves media by Meta ID with TLS verification, no redirects, bounded size/time and a fixed Meta attachment host. The same OpenAI service reads JPEG, PNG and WebP screenshots, PDF/DOC/DOCX/ODT/RTF company documents, and transcribes supported audio. UTF-8 text documents are decoded safely before extraction. Images sent as documents also use vision. Images are limited to 5 MiB, audio/Office/PDF documents to 16 MiB, and plain-text documents to 32 KiB. Video and unsupported attachments remain visible with resend/screenshot guidance. Embedded images in non-PDF documents require a PDF or separate screenshot.

Images/documents use `OPENAI_MODEL`, with `AI_MEDIA_MAX_OUTPUT_TOKENS` defaulting to 4096 independently of short customer replies. Audio uses `OPENAI_TRANSCRIPTION_MODEL` when configured, otherwise `gpt-4o-mini-transcribe`, with the existing `OPENAI_API_KEY`. Successfully read OCR and transcription are checkpointed before lead extraction; a subsequent extraction retry reuses them. The history page shows media indicators, filenames, transcriptions and extracted source text, without exposing download URLs or credentials. Unclear fields are omitted. Any readable lead fact prompts the standard confirmation, including screenshot-only or voice-only leads; wholly unreadable media requests a resend without inventing information.

## Storage and ordering

Migration `005_lead_sessions` extends the existing inbox with contact/media/session metadata and adds `message_receipts` for durable receipt sequence plus `lead_sessions` for drafts. SQLite and PostgreSQL use the same store contract. Existing messages and outbox replies appear in history without duplicating their contents into another message store.

Migration `006_lead_details_media` adds nullable `address` and `trn_no` to leads, `transcription`/`extracted_text` to the existing inbox, and `pending_action`/`discarded` support to sessions. Historical populated rows, session JSON and foreign-key links are preserved. Address is limited to 1,000 characters; TRN to 40. Tax identifiers require a matching source label and are not guessed into phone fields. Extra information remains in notes and the original message/OCR text even if no dedicated lead field exists.

Boss jobs and boss replies are ordered per sender across workers and retries. A later message cannot overtake an earlier unfinished extraction. Lease fencing, duplicate message IDs, the unique outbox constraint, atomic completion, sender reauthorization and existing uncertain-send reconciliation remain in use. Each incoming ID can create at most one outgoing reply. The confirmed lead references its originating session message and retains working source text; the related chat retains every full original. New confirmed leads have `zoho_status=not_started` and no Zoho ID.

Before boss media/AI processing, `beginLeadExtractionProcessing` atomically consumes the claimed lease token and returns a new execution token. Concurrent replay of the same claimed job, even through separate processor instances/connections, loses ownership before extraction. The original claim object remains unchanged. Normal retries still recover expired leases. This uses existing columns and requires no new migration. Saving remains a single transaction: `completed` is the existing closed state; no externally visible partial `saving` state or success message can survive a failed commit.

## Admin chat page

Open `/admin/chats` using the same credentials as `/admin/leads`. The existing HttpOnly session cookie protects browser access. Optional `ADMIN_API_TOKEN` bearer access is supported by that same middleware for API clients; configure 32–256 visible ASCII characters privately. No token is generated, embedded in assets, stored by frontend JavaScript or accepted in URLs. Missing/wrong credentials cannot access chat/lead data.

The left side lists name/phone, last message, time and conversation type/status. The right side shows chronological incoming/outgoing messages, delivery state, media/voice/document indicators, raw text, current draft fields and linked saved leads. Saved and archived lead labels use whichever factual field is available when company and contact names are absent. Discarded drafts remain inspectable. Pagination makes full retained history reachable; Refresh reloads it. Lead details link directly to `/admin/chats?conversation=<encoded sender phone>`. The conversation follows the real WhatsApp participant, not phone numbers extracted from a boss's lead text.

| Endpoint | Response |
| --- | --- |
| `GET /api/chats?page=1&page_size=20&search=` | Conversation list: `{items,total,page,page_size,total_pages}`. |
| `GET /api/chats/:phone` | Contact details, active draft and saved lead summaries. Encode the phone in the path. |
| `GET /api/chats/:phone/messages?page=1&page_size=100` | Messages in chronological order; page size at most 200. |

These endpoints already existed and are extended in this phase; no duplicate endpoints or frontend pages were created. Message DTOs include `whatsapp_message_id` (provider ID on outgoing messages, null until accepted) and `in_reply_to_message_id` (outgoing source inbox ID), retaining the earlier `message_id` field for compatibility.

These APIs reuse authentication, rate limiting, no-store caching, input bounds and configured-secret redaction. Browser rendering uses text nodes, not HTML interpolation. Invalid signatures and filtered senders remain rejected before storage; status callbacks continue through the existing handling. All valid accepted incoming envelopes, including unsupported media, and all automatic outbound messages are retained in the existing inbox/outbox.

## Local verification

```powershell
npm.cmd run lint
npm.cmd run check
npm.cmd test -- --test-concurrency=1
```

Tests use temporary databases and mocked providers. PostgreSQL contract tests run only when a dedicated `TEST_DATABASE_URL` is configured. For a local signed webhook smoke test while port 5000 is occupied, set `SMOKE_PORT=5050` for `npm.cmd run smoke:webhook`.

Run `npm.cmd start` in Terminal 1 and `ngrok http http://127.0.0.1:5000` in Terminal 2. An already running tunnel with that target can be reused. `/health` checks the process, `/ready` checks the database/automation state, and `/webhook` remains the only Meta callback path. Actual handset delivery requires a real incoming WhatsApp message; automated verification does not contact Meta or OpenAI.

## Follow-up repairs (migration 007)

Migration `007_reply_history` retains original outbound text and delivery evidence after the legacy explicit operator retry command replaces an outbox slot. Archived unsent replies are cancelled and cannot be dispatched. Chat APIs now expose per-message `sender_type`; historical customer messages keep their role if the sender later becomes an authorized boss. Lead rows link directly to chats, and saved chat leads expose full useful fields with exact lead-detail links. Merge validation protects corrections from stale history, preserves additive facts, and rejects unreadable placeholders. See the [implementation report](lead-intake-next-phase.md) for files, validation and activation steps.
