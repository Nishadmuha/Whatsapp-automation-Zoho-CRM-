# Lead session and duplicate-save investigation

The two Al Noor rows are separate records from different intake events. The database does not show the 5:54 PM confirmation saving twice. Existing message/session idempotency remains in place; the small application change isolates new-message extraction from historical draft text.

## Database evidence inspected before editing

Read-only inspection used the configured local `data/messages.sqlite`, including its WAL-backed current contents. Times below are on 12 September 2026 in Dubai (UTC+4).

| Record/event | Evidence |
| --- | --- |
| Al Noor lead `2ec80a1c-117f-47b4-9f5f-d72d5b7a2b27` | Created at 15:32:06.804 from a text enquiry. Its source message has no session ID. The reply was the older immediate-save message. |
| Session migration 005 | Applied at 16:09:00.646, after that first lead was created. |
| Draft `7a4ba5f3-a73f-495a-8077-7f0ffacd1260` | Opened at 16:14:59.979 from a different inbound message: a screenshot whose retained source text contains Al Noor/Ahmed details. |
| Draft lifetime | Later screenshots, text, voice, greetings and deferrals stayed associated with that same draft. An earlier Yes at 17:22 was refused by the old required-product flow, so the draft remained open. |
| Email at 17:53:54.036 | Stored in the same draft's source history, but the persisted merged result still had Al Noor/Ahmed and a null email. |
| Yes at 17:54:03.941 | One unique confirmation message, one extraction attempt, one completed session, and one success outbox entry marked SENT at 17:54:04.967. No archived/replaced replies exist for this conversation. |
| Al Noor lead `44ebbba9-6c9a-4347-b893-7137bbcc5a4f` | Created at 17:54:04.289 by that single confirmation, linked to the 16:14 draft and its distinct first message. |

The admin conversation link correctly uses the boss's normalized WhatsApp phone, not the extracted customer's contact. Both records therefore open the same overall conversation history. A conversation may contain many sequential completed leads, but only one active draft. Matching customer details do not make two different sessions duplicates.

The newer row was created once by the current confirmation flow from an older retained draft. The older row predates that flow. This is historical overlap, not evidence of ongoing repeated saves of a confirmation message. No existing row was deleted, merged, corrected or reset during this work. The older row's historical Zoho status was also left untouched; both Zoho IDs were null.

## Existing idempotency guarantees verified

- Migrations 001/003/004 enforce unique inbound message IDs, extraction message IDs, lead source message IDs and outbox source message IDs.
- Migrations 005/006 enforce a partial unique index on `lead_sessions.sender_phone` for collecting/awaiting drafts.
- Active-session and conversation lookup use normalized boss `sender_phone`. Customer fields are never duplicate keys.
- Inbox receipt insertion ignores duplicate WhatsApp IDs. The durable receipt order prevents later messages for the same boss overtaking an unfinished retry.
- Each claimed job consumes its lease token once before processing. Duplicate invocations, stale claims and completed-job retries cannot acquire execution authority.
- The confirmation transaction fences the job, locks/verifies the active session, saves its stored snapshot, closes it, and inserts the unique success reply together. Failure before commit rolls back all of those writes; acknowledgement loss after commit cannot reopen the successful job.
- Replies use the durable unique outbox. Ambiguous/expired sending attempts become UNKNOWN and are not automatically resent. Operator retry does not accept boss lead messages.
- The retained immediate-save compatibility method is not called by current boss runtime routing.

## Smallest application fix

`src/services/leads/leadService.js` now extracts only the current text, OCR or transcript, once, and merges those grounded facts into the existing stored draft. Previously, the extractor received the complete accumulated draft history; an older customer's details could dominate extraction and the latest email could disappear. Full message history remains retained, and nulls still cannot erase existing fields. The exact raw provider response for the observed email was not logged, so its internal classification cannot be reconstructed; the persisted missing email and the historical input path are verified.

An irrelevant result with no existing draft also no longer opens an empty session (the inspected conversation contained such a session from “oke”). Explicit `New lead` still opens an intentional empty draft. Greetings and deferrals preserve the existing behavior. Neither saved records nor existing empty drafts are automatically removed.

All fields remain optional. Additional facts update the same draft. No/Not yet/I'll send more retain it. Explicit confirmation saves once and closes the draft; the next meaningful message opens another, even with identical customer details. The exact confirmation and success messages are unchanged.

## Changed files and schema

- `src/services/leads/leadService.js`: current-message extraction and no empty session for irrelevant input.
- `src/services/leads/leadMerge.js`: clarified the existing defensive merge comment; behavior unchanged.
- `test/leadWorkflow.test.js`: workflow regression coverage and current-message extraction expectations.
- `test/leadWorkflowDatabase.test.js`: concurrent/restart confirmation and later identical-customer session contracts.
- `docs/boss-chat.md`, `README.md`, and this report: current behavior and investigation evidence.

No database code, migration, unique constraint, customer AI logic or Zoho logic changed. Existing constraints already express the required message/session identity.

## Verification

Tests cover A–F: multiple messages into one lead; one explicit confirmation save; duplicate confirmation receipt; a later lead in the same conversation; identical customer details in later sessions; and concurrent processing of the same confirmation with one success reply. Further checks cover restart and old-confirmation replay while a newer draft is active, stale historical context with a newly supplied email, and irrelevant input after save. All regression providers are mocked and databases temporary.

`npm.cmd test`: **593 cases — 497 passed, 0 failed, 96 skipped**. The skipped PostgreSQL contract variants require a dedicated `TEST_DATABASE_URL`, which is not configured. `npm.cmd run lint` and `npm.cmd run check` passed. Full output: [session idempotency regression log](../data/session-idempotency-tests.log).

The local backend and ngrok were gracefully restarted in the two VS Code terminals to activate the fix. `/health` returned `ok`; `/ready` returned `ready` with automation enabled. The ngrok inspector reports the existing public tunnel forwarding to `127.0.0.1:5000`. A read-only SHA-256 comparison of both complete historical lead rows before and after activation matched; the database still contained exactly those two saved leads. No synthetic messages or provider requests were sent to WhatsApp, OpenAI or Zoho. The temporary VS Code launcher activation key was updated for the restart; no launcher was installed into the application.
