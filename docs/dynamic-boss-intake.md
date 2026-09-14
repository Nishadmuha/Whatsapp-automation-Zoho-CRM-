# Dynamic boss intake update

Boss details are extracted and merged before deciding what to ask. The flow accepts a complete message, arbitrary field order, or multiple text/image/document/voice messages. Every lead field is optional. Any meaningful factual subset can be saved after explicit boss confirmation, including a name, company, phone or email alone. There is no mandatory requirement/product field or minimum field combination.

After each message containing lead information, the reply is exactly:

> I have the available information for this lead. Is everything complete and ready to save?

Additional details while awaiting confirmation update the same draft and repeat that question. “No, add the project location as DIP” and “Yes, change quantity to 10” are information, not confirmation. “TRN is ...” now passes labelled tax-ID validation without becoming a phone number. Explicit corrections use the latest factual statement; nulls retain known values.

Standalone confirmation saves the current factual draft through the existing atomic transaction. Supported wording includes yes, save, save it, confirmed, confirm, complete, okay save, proceed and proceed with saving. Only successful persistence closes the session and queues “Lead saved successfully ✅”. No/Not yet/I'll send more retains the draft. A later explicit Yes can save that retained draft after a deferral. Greetings preserve active drafts and do not start an empty lead.

Duplicate claimed jobs now acquire an exclusive execution token before calling media or AI services. Replaying one claim concurrently across processor instances produces one extraction/decision; the existing unique outbox, lease fencing and webhook receipt deduplication retain at most one automatic reply. Expired leases and retryable provider failures remain recoverable.

## Changed files

- `src/services/leads/bossConversation.js`: exact standard question, concise deferral and added confirmation phrases.
- `src/services/leads/leadMerge.js`: merges available facts without requiring individual fields.
- `src/services/leads/leadService.js`: confirmation after each factual update without an extra scripted step.
- `src/services/ai/leadExtraction.js`: arbitrary-order/correction instructions and natural TRN labels.
- `src/services/leads/bossLeadWorkflow.js`, `src/database/index.js`: atomic execution-token acquisition before extraction.
- `test/leadWorkflow.test.js`, `test/leadWorkflowDatabase.test.js`, `test/leadExtraction.test.js`, `test/bossLeadStartup.test.js`: regression coverage.
- `docs/boss-chat.md`, `src/database/README.md`, this report: updated behavior and repository contract.

No migration, API, customer AI flow or Zoho integration change is required. Zoho remains disconnected.

## Earlier verification record

The results below record the earlier dynamic-order update. The current optional-field policy above supersedes its former minimum-field rule; see the latest implementation report linked from the README for current regression results.

- `npm.cmd test`: **522 cases — 449 passed, 0 failed, 73 skipped**. PostgreSQL contract tests require a dedicated `TEST_DATABASE_URL` and were skipped because it was not configured.
- `npm.cmd run lint`: passed.
- `npm.cmd run check`: all JavaScript syntax checks passed.
- All existing tests ran, including webhook/HMAC, customer replies, admin authentication, media, history, session persistence, retries and disconnected Zoho startup. Provider calls were mocked and databases temporary.
- Regression cases cover the literal complete GLOW example, all six company/contact/requirement orderings, further facts after confirmation, mixed Yes/No with corrections, supported confirmations, No retention, duplicate execution across two processor instances, null protection, fresh sessions, greetings and persistence failures.
- Full output: [`data/dynamic-intake-tests.log`](../data/dynamic-intake-tests.log).
