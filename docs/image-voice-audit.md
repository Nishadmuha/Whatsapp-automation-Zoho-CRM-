# Image and voice intake audit

Image and standard WhatsApp voice intake are already implemented in the existing backend. The audit found no production defect in the supported image/audio paths. This update adds 26 regression tests and documents the supported formats and limits; runtime code, prompts, lead schemas, routes, database, frontend, dependencies and private configuration are unchanged.

**Verification scope:** signed local webhook requests, temporary SQLite databases, real service code with mocked Meta/OpenAI responses, and actual Axios HTTP serialization against loopback mock servers. No real WhatsApp, OpenAI or Zoho API request was made for this audit. Handset delivery and real OCR/transcription accuracy were not tested.

## Verified pipelines

| Stage | Image | Voice/audio |
| --- | --- | --- |
| Intake | Signed Meta webhook retains media ID, caption, MIME and boss identity. | Same webhook retains audio media ID and boss identity. |
| Download | Authenticated Graph lookup, then authenticated private media download. | Same bounded in-memory download. |
| Media understanding | `POST /v1/responses`, `gpt-6-astra`, high-detail base64 `input_image`, low reasoning effort, `store:false`. | `POST /v1/audio/transcriptions`, multipart file and `response_format=json`; `OPENAI_TRANSCRIPTION_MODEL` or existing `gpt-4o-mini-transcribe` default. |
| Lead extraction | Readable source text feeds the existing Astra `extractLeadEnquiry` call. | The original-language transcript feeds the same Astra call. |
| Persistence | OCR is checkpointed before lead extraction, then grounded fields merge into the active boss draft. | Transcription is checkpointed before extraction, then merges into the same draft. |

The API shapes match the official [OpenAI vision guide](https://developers.openai.com/api/docs/guides/images-vision) and [audio transcription reference](https://developers.openai.com/api/reference/typescript/resources/audio/subresources/transcriptions/methods/create). Astra text extraction remains untouched.

All thirteen existing lead fields remain nullable. Local source grounding rejects unsupported extracted facts and retains null for missing fields. Null cannot erase a previously known value. Text, image and voice turns retain their receipt order and share one active session. Explicit **text** confirmation is still required to save; an image or voice saying “save it” cannot authorize a save. Duplicated webhook IDs and replayed worker claims do not repeat media analysis or create duplicate leads.

## Supported formats and failure behavior

- Images: JPEG, PNG and WebP, maximum 5 MiB. Images received as documents also use vision.
- Audio: OGG/Opus (normal WhatsApp voice notes), MP3/MPEG, MP4/M4A, WAV, WebM and FLAC, maximum 16 MiB. MIME parameters such as `audio/ogg; codecs=opus` are normalized.
- AAC and AMR are accepted by WhatsApp but are **not supported by this backend's direct transcription path**. They remain safely rejected with a resend request; use a normal WhatsApp voice note or a supported file. No transcoding dependency was added. Meta lists its formats in its [official media collection](https://www.postman.com/meta/whatsapp-business-platform/folder/13382743-ecb27be5-4d27-4763-bbee-6a8002c04bf3).
- Existing PDF/Office/plain-text document behavior is preserved.
- Media stays in bounded buffers and is uploaded from memory; there are no temporary media files to clean up. Stored OCR/transcripts remain in existing protected chat history.
- Media IDs, exact private attachment host, TLS, redirects, MIME, size, optional SHA-256 and returned byte counts are checked. Meta URLs are retrieved for each fresh download instead of retained past their [short lifetime](https://www.postman.com/meta/whatsapp-business-platform/request/fpj02x0/retrieve-media-url).
- Invalid IDs, unsupported/empty media, lookup/download failures and unsuccessful or malformed AI responses fail safely. Existing draft facts survive, no lead is automatically saved, and one safe clarification is queued.
- Existing media-stage errors request a resend rather than retrying automatically. A successful OCR/transcription followed by a transient Astra extraction failure uses the existing bounded retries and durable checkpoint without another media download/analysis.
- Existing timeouts, output caps, field validation and input-length limits remain enforced. These limits can reject long or unreadable recordings/documents; the audit does not claim that every valid-size attachment will yield usable facts.

## Tests

| Requested coverage | Verification |
| --- | --- |
| Text, image, voice leads | Signed webhook integration tests for each standalone type. |
| Text + text, text + image, text + voice | One session, accumulated exact fields, no saved lead until text confirmation. |
| Image + voice, text + image + voice | Same active draft, retained per-message raw OCR/transcript and ordered processing. |
| Multiple images, multiple voice messages | Three sequential attachments merge once, with one confirmed saved lead. |
| Missing information | Unprovided fields remain null through draft and save; failure cannot invent replacements. |
| Invalid media | IDs, MIME/format, checksum/size, empty audio and unsupported AAC/AMR checks. |
| OpenAI failure | Vision/transcription failures, empty/refused/malformed output and malformed Astra JSON. |
| Meta media download failure | Second-GET authentication, missing media, server and network/timeout failures, with redacted errors. |
| Duplicate protection | Repeated signed webhook IDs and concurrent/replayed image/audio claims perform one analysis and one reply. |
| Retry recovery | Image checkpoint survives Astra timeout; later voice cannot overtake the retry. Existing voice checkpoint test also remains. |
| Real transport format | Installed Axios serializes actual base64 image JSON and multipart audio bytes to local mock HTTP servers. |
| Backward compatibility | Complete existing suite covers text/conversations, webhook, workers, SQLite, admin/frontend contracts and deferred Zoho code. |

Final validation: `npm.cmd test` passed with **533 passed, 0 failed, 96 skipped** (629 total), including all 26 added cases. `npm.cmd run lint` and `npm.cmd run check` both passed. All skips are optional PostgreSQL tests requiring a dedicated `TEST_DATABASE_URL`; there is no build script.

## Configuration and Zoho

No environment variables were added or changed. The existing `OPENAI_MODEL=gpt-6-astra`, OpenAI credential, Meta credential/phone ID, authorized boss list, automation switch and transcription default are reused. No new Meta subscription, callback route or configuration is required for these message types; the existing signed `messages` webhook handles them.

**Zoho writes were already disconnected in server startup and remain disconnected.** Confirmed local leads retain `zoho_status=not_started`; existing Zoho modules, field names and tests are preserved. This media audit does not activate CRM synchronization.

The source/configuration/documentation scan found no configured credential values or recognizable OpenAI/Meta/Zoho token literals outside private `.env`. Reviewed literal matches were synthetic boundary-test fixtures. No former model identifier remains in the final repository search. Private runtime data and dependency directories were excluded from the credential audit; this folder has no Git history to audit.

Changed files: `test/mediaIntake.test.js`, `test/mediaWorkflow.test.js`, `test/mediaTransport.test.js`, `docs/boss-chat.md`, and this report. Hash comparison against the pre-audit snapshot verifies that all production files, package manifests and private `.env` are unchanged.

These test/documentation additions do not require a restart. When restarting the backend (including to load the earlier Astra migration), press **Ctrl+C** in the localhost terminal, then run:

```powershell
Set-Location -LiteralPath 'D:\whatsapp automation backend\voltronix-whatsapp-backend'
npm.cmd start
```

Keep the ngrok terminal running. Port 5000 and `/webhook` are unchanged.
