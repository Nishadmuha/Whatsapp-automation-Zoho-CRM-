# Optional boss lead fields

No individual field is required for an internal boss lead. A name, company, email, phone, address, TRN, project, product, requirement, quantity, deadline, or useful note can stand alone. Missing values remain null. Empty drafts, unreadable media and conversational commands do not create invented customer facts.

After each information message, the backend extracts available facts, merges them into the current draft, and replies exactly:

> I have the available information for this lead. Is everything complete and ready to save?

Additional information repeats that question after merging. No, Not yet, I'll send more and No need keep the draft open without saving or deleting facts. Explicit confirmation (yes, save, save it, confirmed, confirm, complete, proceed, okay save) saves the current retained snapshot, including after a deferral. Mixed messages such as “Yes, add Ahmed as contact” update the draft and ask confirmation again.

Successful persistence closes the draft and queues exactly:

> Lead saved successfully ✅

The next information message starts a fresh draft. The existing explicit discard/new-customer decision remains available, with archived history; an ambiguous Yes to a switch-customer question cannot save or discard a draft.

## Implementation

- `leadValidator.js`: the live boss validator accepts any nonempty factual subset, with no missing-field list. The separate deferred CRM validator is unchanged.
- `leadExtraction.js`: provider instructions accept any standalone meaningful fact and keep absent values null. Strict JSON shape, source grounding and placeholder filtering remain in place.
- `leadService.js`, `bossConversation.js`, `leadMerge.js`: exact replies, deferral handling, current-policy revalidation of older drafts, and removal of field-specific missing-information prompts.
- `database/index.js`: nullable snapshot persistence, fresh validation on confirmation, and rejection of empty snapshots. Draft closure, lead creation and the unique reply outbox entry commit atomically.
- Admin lead/chat lists identify a lead using whichever information is available.

The conceptual flow is NEW → COLLECTING → AWAITING_CONFIRMATION → SAVING → CLOSED. New information moves any meaningful draft to `awaiting_confirmation`. Deferral retains it in `collecting`; later explicit confirmation can save that same snapshot. SAVING is the existing database transaction, and CLOSED is the persisted `completed` state. A failed transaction retains the draft. No new migration is necessary because every lead field is already nullable.

Existing inbox deduplication, exclusive extraction tokens, lease fencing and unique outbox entries continue to enforce one processing decision and at most one automatic reply per inbound message. Media source messages, OCR and transcripts remain in chat history. Customer AI routing is unchanged and Zoho remains disconnected.

## Verification

Regression coverage includes all requested cases: name-only, company-only, email-only, phone-only, company plus phone, screenshot-only, voice-only, one-message complete details, multiple messages, additions after the question, No, Yes, a fresh draft after save, duplicate delivery, and protection against null overwrites. It also covers every other individual field, old persisted validation, every supported confirmation, and deferral followed by confirmation.

Tests use temporary databases and mocked provider calls. `npm.cmd test` completed with **583 cases: 490 passed, 0 failed, 93 skipped**. The skipped PostgreSQL contracts require a dedicated `TEST_DATABASE_URL`, which was not configured. All 15 requested regression scenarios passed, as did the customer, webhook/security, media, history, retry and disconnected-Zoho tests. `npm.cmd run lint` and `npm.cmd run check` passed.

The first full run encountered a fetch failure in the existing 1,001-login admin capacity test. That test passed in isolation; its login responses were not consumed. The test now reads and validates each response body while preserving all session-eviction assertions. The final full run above passed; application authentication code was unchanged.

Full output: [final regression log](../data/optional-fields-tests-final.log).

## Local activation

The previous backend and ngrok processes were stopped gracefully and restarted in two visible VS Code terminals. Terminal 1 runs `node src/server.js` on `127.0.0.1:5000`; `/health` returned `ok` and `/ready` returned `ready` with automation enabled. Terminal 2 runs ngrok; its local inspector reports `https://germinate-rash-diminish.ngrok-free.dev` forwarding to `http://127.0.0.1:5000`. No synthetic messages were sent to WhatsApp, OpenAI or Zoho during verification.
