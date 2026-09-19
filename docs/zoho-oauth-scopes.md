# Zoho OAuth scope audit — 19 September 2026

## Result

The live read-only CRM and Books checks passed. The current grants are broader than necessary; new OAuth authorization is required to achieve least privilege. No authorization code was exchanged, no `.env` value was changed, and no production customer, lead, bill, attachment or WhatsApp message was created by this audit.

All 723 automated tests passed on the final code (0 failed, 0 skipped, 0 cancelled). The focused CRM/Books/webhook/security run passed 166 tests. JavaScript syntax and ESLint passed. Two additional mocked diagnostic probes exposed existing CRM concurrency/uncertain-write risks; passing the existing suite does not resolve those risks.

## A. CRM scopes

Minimum scope string for the existing endpoints:

```text
ZohoCRM.modules.leads.READ,ZohoCRM.modules.leads.CREATE,ZohoCRM.modules.leads.UPDATE,ZohoCRM.modules.attachments.READ,ZohoCRM.modules.attachments.CREATE,ZohoSearch.securesearch.READ
```

The first five are the requested scopes. `ZohoSearch.securesearch.READ` is additionally documented for the existing `/Leads/search` endpoint used to prevent duplicate phone/email records. It is not an unrelated module permission. See [Zoho Search Records](https://www.zoho.com/crm/developer/docs/api/v8/search-records.html), [upload attachment](https://www.zoho.com/crm/developer/docs/api/v8/upload-attachment.html), and [list attachments](https://www.zoho.com/crm/developer/docs/api/v8/get-attachments.html).

The refreshed live token reported `ZohoCRM.modules.ALL`. That broad grant covers the five module permissions, but does not explicitly list `ZohoSearch.securesearch.READ`. The live search did succeed with the current broad token; this is not a claim that production search currently fails. Use the six explicit scopes above when replacing the broad grant.

## B. Books scopes

Minimum scope string for the existing implementation:

```text
ZohoBooks.contacts.READ,ZohoBooks.bills.READ,ZohoBooks.bills.CREATE,ZohoBooks.settings.READ
```

`settings.READ` is genuinely used by `prepareBill()` for configured currency and tax IDs. Removing it without redesigning validation would break existing bills or require guessing accounting data. It is NOT Chart of Accounts permission. [Currency list](https://www.zoho.com/books/api/v3/currency/) and [tax list](https://www.zoho.com/books/api/v3/taxes/) document this permission. Source-bill attachment upload uses `bills.CREATE`, not an extra update scope, per [the Bills API](https://www.zoho.com/books/api/v3/bills/).

The refreshed live token reported all four scopes above plus `ZohoBooks.bills.UPDATE`. No required Books scope is missing. The UPDATE grant is unnecessary and should be omitted from the replacement authorization. No contacts CREATE, accountants, vendor-payment, settings write or full-access scope is required.

## C. Chart of Accounts

Removed the unused `listChartOfAccounts()` implementation/export and its obsolete positive test. There are no Chart of Accounts API calls or fixed expense-account configuration requirements in runtime code. Regression tests reject unexpected API calls and confirm bill preparation works without an account ID. Existing optional line-item `account_id` pass-through is not a fixed configuration dependency.

The historical production report and setup guide no longer direct operators to grant accountants permissions or configure an expense-account ID.

This is an application dependency finding, not proof that Zoho accepts every bill without line-item accounting data. The [Bills API](https://www.zoho.com/books/api/v3/bills/) documents `account_id` for expense classification. Whether this organization's defaults accept the current payload without one was not tested with a live write. Do not guess an ID or add permissions to conceal a provider validation error.

## D. Tests

| Command | Result |
| --- | --- |
| `npm.cmd test` | 723 total / 723 passed / 0 failed / 0 skipped / 0 cancelled |
| Focused CRM/Books/customer/payment/webhook/security tests | 166 passed / 0 failed |
| `npm.cmd run check` | PASS |
| `npm.cmd run lint` | PASS |

Final full-suite output is in the ignored local `data/oauth-scope-final-tests-20260919.log` (the earlier full run also passed 722 tests before the final redaction regression was added). Tests disable `.env` loading, remove production provider credentials, block non-loopback network access and use randomly named local test databases. No real bill was saved to make a test pass.

## E. CRM verification

- Live: OAuth refresh, synthetic no-match email search, one lead metadata read, and attachment listing passed. The sampled lead returned zero attachments. Upload success was NOT tested live.
- Mocked: create, update, strict response IDs, multipart attachment serialization, original-media association, exact returned lead ID, retained media after failure, and retry without re-creating an already identified lead passed.
- Existing duplicate webhook/YES and lookup-failure protections passed.
- **Remaining duplicate risk:** `handleZohoSync()` reads status and later writes `creating` without an atomic claim. A concurrent mocked invocation produced two create calls. The admin sync route also uses `force: true`.
- **Remaining uncertain-write risk:** a mocked post-send timeout marked `uncertain: true` is converted to `failed`. A subsequent sync with a temporarily empty search result attempted creation again. It needs persistent uncertain-state handling and reconciliation, not another OAuth permission.

Those CRM locking changes were not made as part of this scope/configuration task. Do not concurrently force-sync a lead or blindly retry an uncertain CRM create. Check Zoho first.

## F. Books verification

- Live Contacts lookup through the existing client passed: 10 customers, all 10 with ID/name and email, 9 with phone. No customer details or credential values were printed in the audit output.
- Customer selection tests cover phone-only, email-only, both, no results, failed lookup, similar names and an unoffered ID. Selected ID/name/phone/email persist to both pending bill and session without another AI extraction.
- Fixed a reproduced bug: absent Zoho phone/email previously retained an earlier OCR/customer value. Missing fields now explicitly become `null`; project/site is preserved.
- Cash, Bank Remittance, Bank Transfer, Credit Card and Cheque all persist and reach the mocked bill POST. The exact customer ID remains a string throughout.
- The existing integration records the selected method and customer ID in **bill notes**. It does not create a payment, mark the bill paid, or create a native customer relationship on a bill. No new payment API or account dependency was introduced.
- Bill creation, original-file attachment, duplicate checks, atomic save reservation, uncertain-save lock and PDF delivery were verified with mocks/local test storage only. No live financial write was performed.

## G. WhatsApp verification

Automated signed-webhook boss/worker routing, confirmation gates, media intake, customer selection, saving through mocked transports, and duplicate receipts passed. No live WhatsApp message was sent, and handset delivery was not verified.

## H. Security

- `.env` is ignored and untracked; it was neither modified nor committed.
- Working-tree scan found no configured credential values in source/tests/frontend. A generic key-pattern hit was in a synthetic error-redaction fixture, not a match to a configured credential. This was not an exhaustive Git-history or provider-side security audit.
- Scanned 18 local log files: no configured credential values or long Zoho/Meta token-pattern matches found.
- Shared dashboard response redaction now includes Books credentials and pending OAuth codes, which were previously missing from its key list. Regression test passed.
- Both existing OAuth CLI entrypoints now default to read-only verification, never implicit code exchange or `.env` rewriting. They print scope identifiers and status/counts only, not token fragments, raw errors or customer records.
- The verifier allows only token refresh plus explicitly allowlisted GET endpoints, validates official HTTPS destinations, and disables redirects. It reports undisclosed scope metadata as unknown; a GET cannot certify CREATE/UPDATE operation success.
- Credentials previously pasted into chat should be rotated privately. This audit did not revoke or rotate them.

## I. Remaining blockers and reauthorization

The code is ready for narrowly scoped credentials, but the existing Zoho grants have not been changed. Reauthorization is required to remove excess permissions. Refreshing an old token or editing a scope comment does not change its consent. The two CRM idempotency risks above remain production blockers independent of OAuth.

### What to do in Zoho

1. Sign in to the [Zoho API Console](https://api-console.zoho.com/) in the same data center as your organization. Open the existing Self Client. Use the correct CRM/Books account and organization. Zoho's [Self Client authorization guide](https://www.zoho.com/developer/oauth/self-client/authorization-code-flow.html) describes this flow.
2. In **Generate Code**, paste the CRM scope string from section A. Choose a valid code duration, supply a description and generate the one-time code. Put it privately in `.env` as `ZOHO_AUTHORIZATION_CODE`. Do not paste it into chat or a command argument.
3. From the project directory, run `npm.cmd run zoho:auth -- --exchange`. This explicit setup command exchanges the real code, stores the refresh token privately and consumes the code. It does not create a CRM record.
4. Generate a separate code with the Books scope string from section B. Put it privately in `ZOHO_BOOKS_AUTHORIZATION_CODE`, then run `npm.cmd run zoho:books:test -- --exchange`. Keep the correct existing `ZOHO_BOOKS_ORGANIZATION_ID` and regional endpoints. Separate grants can use the existing client; a new client is not inherently required.
5. Run `node scripts/verify-zoho-scopes.js`. Check that `missing` and `excess` are empty for both services and the read-only checks pass. Unknown scope metadata requires inspection of the grant in Zoho; do not assume success. The command exits nonzero for missing, undisclosed, excess permissions or failed reads.
6. Update the deployment's private secrets and restart the backend to clear cached old access tokens. Revoke only the superseded broad grants/tokens after confirming the replacement works; do not revoke a shared client without checking other integrations. Any optional old `ZOHO_ACCESS_TOKEN`/`ZOHO_BOOKS_ACCESS_TOKEN` should not override the new grant; runtime Books already refreshes from its refresh token.

Zoho documents the regional, single-use authorization-code exchange in [Access & Refresh Tokens](https://www.zoho.com/crm/developer/docs/api/v8/access-refresh.html) and the [Books OAuth flow](https://www.zoho.com/books/api/v3/oauth/). No reauthorization/consent was performed during this audit.

## Configuration and code map

| Area | Existing implementation / configuration |
| --- | --- |
| CRM refresh/cache | `src/services/zoho/zohoAuthService.js`; `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, regional `ZOHO_ACCOUNTS_URL`, `ZOHO_API_BASE_URL`; optional field mapping/timeout |
| CRM records/media | `src/services/zoho/zohoLeadService.js`; `src/services/leads/bossLeadWorkflow.js` |
| Books runtime refresh/cache | `src/services/books/zohoBooksClient.js`; `ZOHO_BOOKS_CLIENT_ID`, `ZOHO_BOOKS_CLIENT_SECRET`, `ZOHO_BOOKS_REFRESH_TOKEN`, `ZOHO_BOOKS_ORGANIZATION_ID`; regional base/accounts URL, timeout/domain overrides |
| Books one-time exchange | `src/services/books/zohoBooksAuthService.js`; explicitly invoked setup CLI only |
| Contacts, bills, currency/tax reads | `src/services/books/zohoBooksClient.js` |
| Customer/payment session | `src/services/books/billWorkflow.js`, `paymentMethods.js`, `src/database/billStore.js`, `src/models/billModel.js` |
| Refresh behavior | Separate CRM/Books in-memory caches and in-flight refresh deduplication; authentication rejection retry; no scopes can be added by refresh |

## Files changed in this audit only

- `.env.example`
- `scripts/zoho-auth.js`
- `scripts/testZohoBooksConnection.js`
- `scripts/verify-zoho-scopes.js` (new)
- `src/services/zoho/oauthScopes.js` (new)
- `src/services/books/zohoBooksClient.js`
- `src/services/books/billWorkflow.js`
- `src/routes/leads.js` (credential redaction only)
- `test/billDocuments.test.js`
- `test/booksCustomerSelection.test.js` (new)
- `test/zohoScopes.test.js` (new)
- `docs/automation-reference.md`
- `docs/production-verification-2026-09-19.md` (obsolete setup guidance)
- `docs/zoho-oauth-scopes.md` (this report)

Earlier uncommitted UI/login/boss-batching changes were preserved. No UI design change, Git commit or push was made in this audit.
