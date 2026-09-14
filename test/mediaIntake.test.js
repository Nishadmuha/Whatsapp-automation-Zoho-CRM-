'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspect } = require('node:util');
const { createHash } = require('node:crypto');
const { createWhatsAppService } = require('../src/services/whatsapp/whatsappService');
const { createAiService } = require('../src/services/ai/aiService');
const { resolveLeadMessageContent, resolveLeadMessageText } = require('../src/services/leads/leadMedia');
const { createLeadService } = require('../src/services/leads/leadService');
const { LEAD_FIELDS } = require('../src/services/ai/leadExtraction');
const { MAX_MEDIA_BYTES, MAX_IMAGE_BYTES, MAX_TEXT_DOCUMENT_BYTES, DOCUMENT_EXTENSIONS } = require('../src/utils/media');

const env = {
  WHATSAPP_ACCESS_TOKEN: 'private-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: '12345678', META_GRAPH_API_VERSION: 'v25.0',
  AI_PROVIDER: 'openai', OPENAI_API_KEY: 'private-openai-token', OPENAI_MODEL: 'configured-image-model',
};
const attachmentUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=12345&private-signature=value';
function completed(text) {
  return { status: 200, data: { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] } };
}
function downloadHarness({ metadata = {}, content = {}, fail, failAt = 1 } = {}) {
  const calls = [];
  const logs = [];
  const service = createWhatsAppService({ env, logger: { warn: value => logs.push(value) }, http: { async get(url, options) {
    calls.push({ url, options });
    if (fail && calls.length === failAt) throw fail;
    if (calls.length === 1) return { status: 200, data: { url: attachmentUrl, file_size: 4, mime_type: 'image/jpeg', ...metadata } };
    return { status: 200, headers: { 'content-type': 'image/jpeg' }, data: Buffer.from('jpeg'), ...content };
  } } });
  return { service, calls, logs };
}

test('private Meta media uses fixed hosts, bounded verified requests and no public storage', async () => {
  const { service, calls, logs } = downloadHarness();
  assert.deepEqual(await service.downloadMedia('12345'), { buffer: Buffer.from('jpeg'), mimeType: 'image/jpeg' });
  assert.equal(calls[0].url, 'https://graph.facebook.com/v25.0/12345');
  assert.deepEqual(calls[0].options.params, { phone_number_id: '12345678' });
  assert.equal(calls[1].url, attachmentUrl);
  assert.equal(calls[1].options.responseType, 'arraybuffer');
  assert.equal(calls[1].options.maxContentLength, MAX_IMAGE_BYTES);
  for (const { options } of calls) {
    assert.equal(options.headers.Authorization, `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`);
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.timeout, 15000);
    assert.equal(options.httpsAgent.options.rejectUnauthorized, true);
    assert.equal(options.proxy, false);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.validateStatus(302), false);
  }
  assert.deepEqual(logs, []);
});

test('media lookup rejects URL IDs and credentials are never forwarded to untrusted locations', async () => {
  for (const id of ['', '../messages', 'https://evil.invalid', '123\nheader', '1'.repeat(129)]) {
    const h = downloadHarness();
    await assert.rejects(h.service.downloadMedia(id), { code: 'ERR_WHATSAPP_MEDIA' });
    assert.equal(h.calls.length, 0);
  }
  for (const url of [
    'http://lookaside.fbsbx.com/whatsapp_business/attachments/',
    'https://lookaside.fbsbx.com.evil.invalid/whatsapp_business/attachments/',
    'https://lookaside.fbsbx.com@evil.invalid/whatsapp_business/attachments/',
    'https://attacker@lookaside.fbsbx.com/whatsapp_business/attachments/',
    'https://lookaside.fbsbx.com:8443/whatsapp_business/attachments/',
    'https://127.0.0.1/whatsapp_business/attachments/',
    'https://lookaside.fbsbx.com/other-path/',
    'https://lookaside.fbsbx.com/whatsapp_business/attachments/#secret',
  ]) {
    const h = downloadHarness({ metadata: { url } });
    await assert.rejects(h.service.downloadMedia('12345'), error => {
      assert.equal(error.code, 'ERR_WHATSAPP_MEDIA');
      assert.equal(inspect({ error, logs: h.logs }, { depth: null }).includes(url), false);
      return true;
    });
    assert.equal(h.calls.length, 1);
  }
});

test('media size and MIME validation reject oversized, empty, changed and unsupported content', async () => {
  for (const metadata of [{ file_size: MAX_IMAGE_BYTES + 1 }, { file_size: -1 }, { file_size: '4' }, { mime_type: 'text/html' }, { mime_type: 'audio/ogg', file_size: MAX_MEDIA_BYTES + 1 }]) {
    const h = downloadHarness({ metadata });
    await assert.rejects(h.service.downloadMedia('12345'), { code: 'ERR_WHATSAPP_MEDIA' });
    assert.equal(h.calls.length, 1);
  }
  for (const content of [{ status: 302 }, { headers: { 'content-type': 'text/html' } }, { data: Buffer.alloc(0) }, { data: Buffer.alloc(5) }, { data: 'jpeg' }]) {
    const h = downloadHarness({ content });
    await assert.rejects(h.service.downloadMedia('12345'), { code: 'ERR_WHATSAPP_MEDIA' });
    assert.equal(h.calls.length, 2);
  }
  const h = downloadHarness({ fail: Object.assign(new Error(attachmentUrl), { config: { headers: { Authorization: env.WHATSAPP_ACCESS_TOKEN } } }) });
  await assert.rejects(h.service.downloadMedia('12345'), error => {
    const output = inspect({ error, logs: h.logs }, { depth: null });
    assert.equal(output.includes(attachmentUrl), false);
    assert.equal(output.includes(env.WHATSAPP_ACCESS_TOKEN), false);
    return true;
  });
});

test('downloaded bytes must match the Meta media identity and checksum when supplied', async () => {
  for (const encoding of ['hex', 'base64']) {
    const checksum = createHash('sha256').update('jpeg').digest(encoding);
    const valid = downloadHarness({ metadata: { id: '12345', sha256: checksum } });
    assert.deepEqual(await valid.service.downloadMedia('12345'), { buffer: Buffer.from('jpeg'), mimeType: 'image/jpeg' });
    const changed = downloadHarness({ metadata: { sha256: checksum }, content: { data: Buffer.from('evil') } });
    await assert.rejects(changed.service.downloadMedia('12345'), { code: 'ERR_WHATSAPP_MEDIA' });
    assert.equal(changed.calls.length, 2);
  }
  for (const metadata of [{ id: '54321' }, { sha256: null }, { sha256: 'not-a-checksum' }, { sha256: 'a'.repeat(63) }]) {
    const invalid = downloadHarness({ metadata });
    await assert.rejects(invalid.service.downloadMedia('12345'), { code: 'ERR_WHATSAPP_MEDIA' });
    assert.equal(invalid.calls.length, 1);
  }
});

test('attachment download failures after successful lookup omit private URLs and authorization', async () => {
  for (const details of [
    ...[401, 403, 404, 500, 503].map(status => ({ response: { status, data: 'private-media-error-body' } })),
    ...['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].map(code => ({ code })),
  ]) {
    const failure = Object.assign(new Error(attachmentUrl), details, {
      config: { url: attachmentUrl, headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` } },
    });
    const h = downloadHarness({ fail: failure, failAt: 2 });
    await assert.rejects(h.service.downloadMedia('12345'), error => {
      assert.equal(error.code, 'ERR_WHATSAPP_MEDIA');
      assert.equal(error.cause, undefined);
      const output = inspect({ error, logs: h.logs }, { depth: null });
      for (const value of [attachmentUrl, env.WHATSAPP_ACCESS_TOKEN, 'private-media-error-body']) {
        assert.equal(output.includes(value), false);
      }
      return true;
    });
    assert.equal(h.calls.length, 2, 'A failed attachment download must not retry or become another lookup.');
    assert.equal(h.calls[0].url, 'https://graph.facebook.com/v25.0/12345');
    assert.equal(h.calls[1].url, attachmentUrl);
    assert.deepEqual(h.logs, [{ event: 'whatsapp_media_download_failed', code: 'ERR_WHATSAPP_MEDIA' }]);
  }
});

test('downloaded OGG codec MIME parameters normalize while ArrayBuffer bytes and checksum stay intact', async () => {
  const bytes = Uint8Array.from([0x4f, 0x67, 0x67, 0x53]);
  const expected = Buffer.from(bytes);
  for (const [metadataMime, responseMime] of [
    ['audio/ogg; codecs=opus', 'audio/ogg'],
    ['audio/ogg', 'Audio/Ogg; codecs=opus'],
    [' AUDIO/OGG ; codecs=opus', 'audio/ogg; codecs=opus'],
  ]) {
    const h = downloadHarness({
      metadata: { mime_type: metadataMime, sha256: createHash('sha256').update(expected).digest('base64') },
      content: { headers: { 'content-type': responseMime }, data: bytes.buffer },
    });
    assert.deepEqual(await h.service.downloadMedia('12345'), { buffer: expected, mimeType: 'audio/ogg' });
    assert.equal(h.calls[1].options.maxContentLength, MAX_MEDIA_BYTES);
  }
});

test('unsupported AAC and AMR fail before media bytes download or OpenAI transcription', async () => {
  let aiRequests = 0;
  const ai = createAiService({ env, http: { async post() { aiRequests += 1; return { data: { text: 'Unexpected' } }; } } });
  for (const mimeType of ['audio/aac', 'audio/amr']) {
    const h = downloadHarness({ metadata: { mime_type: mimeType } });
    await assert.rejects(h.service.downloadMedia('12345'), { code: 'ERR_WHATSAPP_MEDIA' });
    assert.equal(h.calls.length, 1);
    await assert.rejects(ai.extractMediaText({ buffer: Buffer.from('unsupported-audio'), mimeType, type: 'audio' }), { code: 'AI_MEDIA_INPUT_INVALID' });
    const intake = downloadHarness({ metadata: { mime_type: mimeType } });
    await assert.rejects(resolveLeadMessageContent({
      message: { message_type: 'audio', media_id: '12345', media_mime_type: mimeType }, ai,
      whatsapp: intake.service,
    }), { code: 'LEAD_MEDIA_UNAVAILABLE' });
    assert.equal(intake.calls.length, 1);
  }
  assert.equal(aiRequests, 0);
});

test('empty voice attachments fail safely at metadata, download and transcription input boundaries', async () => {
  const emptyMetadata = downloadHarness({ metadata: { mime_type: 'audio/ogg', file_size: 0 } });
  await assert.rejects(emptyMetadata.service.downloadMedia('12345'), { code: 'ERR_WHATSAPP_MEDIA' });
  assert.equal(emptyMetadata.calls.length, 1);
  const emptyBody = downloadHarness({ metadata: { mime_type: 'audio/ogg' }, content: { headers: { 'content-type': 'audio/ogg' }, data: Buffer.alloc(0) } });
  await assert.rejects(emptyBody.service.downloadMedia('12345'), { code: 'ERR_WHATSAPP_MEDIA' });
  assert.equal(emptyBody.calls.length, 2);
  let aiRequests = 0;
  const ai = createAiService({ env, http: { async post() { aiRequests += 1; return { data: { text: 'Unexpected' } }; } } });
  await assert.rejects(ai.extractMediaText({ buffer: Buffer.alloc(0), mimeType: 'audio/ogg; codecs=opus', type: 'audio' }), { code: 'AI_MEDIA_INPUT_INVALID' });
  assert.equal(aiRequests, 0);
});

test('screenshot text extraction reuses configured OpenAI model and private in-memory image input', async () => {
  const calls = [];
  const logs = [];
  const service = createAiService({ env, logger: { info: value => logs.push(value) }, http: { async post(...args) { calls.push(args); return completed('Ahmed +971501234567'); } } });
  assert.equal(await service.extractMediaText({ buffer: Buffer.from('image-bytes'), mimeType: 'image/jpeg', type: 'image' }), 'Ahmed +971501234567');
  const [url, body, options] = calls[0];
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(body.model, env.OPENAI_MODEL);
  assert.equal(body.store, false);
  assert.equal(body.input[1].content[0].image_url, 'data:image/jpeg;base64,' + Buffer.from('image-bytes').toString('base64'));
  assert.match(body.input[0].content, /untrusted data/);
  assert.equal(body.tools, undefined);
  assert.equal(options.headers.Authorization, `Bearer ${env.OPENAI_API_KEY}`);
  assert.equal(options.maxRedirects, 0);
  assert.equal(options.proxy, false);
  assert.equal(options.httpsAgent.options.rejectUnauthorized, true);
  assert.equal(inspect(logs).includes('Ahmed'), false);
});

test('vision and document output budgets are independent of concise reply and lead extraction budgets', async () => {
  for (const override of [undefined, '8192']) {
    const calls = [];
    const configuration = { ...env, AI_MAX_OUTPUT_TOKENS: '512', ...(override ? { AI_MEDIA_MAX_OUTPUT_TOKENS: override } : {}) };
    const service = createAiService({ env: configuration, http: { async post(...args) {
      calls.push(args);
      return args[1].text?.format?.name === 'lead_enquiry'
        ? completed(JSON.stringify({ is_lead: false, lead: Object.fromEntries(LEAD_FIELDS.map(field => [field, null])) }))
        : completed('Company: GLOW');
    } } });
    for (const [type, mimeType] of [['image', 'image/jpeg'], ['document', 'application/pdf'], ['document', 'application/msword']]) {
      await service.extractMediaText({ buffer: Buffer.from('private-media'), mimeType, type });
      assert.equal(calls.at(-1)[1].max_output_tokens, override ? 8192 : 4096);
    }
    await service.generateReply('Hello');
    assert.equal(calls.at(-1)[1].max_output_tokens, 512);
    await service.extractLeadEnquiry('Hi');
    assert.equal(calls.at(-1)[1].max_output_tokens, 512);
  }
});

test('invalid media output limits fail safely before image/document HTTP without changing audio or reply settings', async () => {
  for (const value of ['0', '255', '16385', '-1', '1.5', 'private-invalid-setting']) {
    let requests = 0;
    const service = createAiService({ env: { ...env, AI_MEDIA_MAX_OUTPUT_TOKENS: value }, http: { async post() {
      requests += 1;
      return { status: 200, data: { text: 'Need two MDB' } };
    } } });
    for (const [type, mimeType] of [['image', 'image/jpeg'], ['document', 'application/pdf']]) {
      await assert.rejects(service.extractMediaText({ buffer: Buffer.from('private-media'), mimeType, type }), error => {
        assert.equal(error.code, 'AI_CONFIGURATION_ERROR');
        assert.equal(inspect(error).includes('private-invalid-setting'), false);
        return true;
      });
    }
    assert.equal(requests, 0);
    assert.equal(await service.extractMediaText({ buffer: Buffer.from('OggS'), mimeType: 'audio/ogg', type: 'audio' }), 'Need two MDB');
    assert.equal(requests, 1);
  }
});

test('WhatsApp OGG voice messages use bounded OpenAI multipart transcription', async () => {
  const calls = [];
  const service = createAiService({ env, http: { async post(...args) { calls.push(args); return { status: 200, data: { text: 'Need two MDB in DIP' } }; } } });
  assert.equal(await service.extractMediaText({ buffer: Buffer.from('OggS'), mimeType: 'audio/ogg; codecs=opus', type: 'audio' }), 'Need two MDB in DIP');
  const [url, form, options] = calls[0];
  assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(form.get('model'), 'gpt-4o-mini-transcribe');
  assert.equal(form.get('file').name, 'voice.ogg');
  assert.equal(form.get('file').type, 'audio/ogg');
  assert.equal(await form.get('file').text(), 'OggS');
  assert.equal(form.get('response_format'), 'json');
  assert.equal(options.headers['Content-Type'], undefined);
  assert.equal(options.maxBodyLength, MAX_MEDIA_BYTES + 65536);
});

test('malformed, empty and refused transcription responses cannot become spoken lead facts', async () => {
  const responses = [
    { status: 200, data: null }, { status: 200, data: {} },
    ...[null, 42, { private: 'private-transcript' }, '', ' \n ', 'private-transcript\0', 'x'.repeat(16385),
      '[inaudible]', 'I cannot transcribe this audio.', 'Company: [unknown]\nPhone: [inaudible]']
      .map(text => ({ status: 200, data: { text } })),
    { status: 200, data: { text: 'private-transcript', error: { message: 'private-provider-error' } } },
    { status: 503, data: { text: 'private-transcript' } },
  ];
  for (const response of responses) {
    let requests = 0;
    const logs = [];
    const service = createAiService({ env, logger: { error: value => logs.push(value) }, http: { async post() {
      requests += 1;
      return response;
    } } });
    await assert.rejects(service.extractMediaText({ buffer: Buffer.from('OggS'), mimeType: 'audio/ogg', type: 'audio' }), error => {
      assert.equal(error.code, 'AI_MEDIA_EXTRACTION_FAILED');
      const output = inspect({ error, logs }, { depth: null });
      for (const value of ['private-transcript', 'private-provider-error', env.OPENAI_API_KEY]) assert.equal(output.includes(value), false);
      return true;
    });
    assert.equal(requests, 1);
    assert.deepEqual(logs, [{ event: 'ai.media.failed', provider: 'openai', type: 'audio', code: 'AI_MEDIA_EXTRACTION_FAILED' }]);
  }
});

test('image responses reject incomplete output, refusal and malformed envelopes without exposing provider content', async () => {
  const partial = completed('private-image-text');
  partial.data.status = 'incomplete';
  partial.data.incomplete_details = { reason: 'max_output_tokens' };
  const refusal = completed('');
  refusal.data.output[0].content = [{ type: 'refusal', refusal: 'private-provider-refusal' }];
  const malformed = completed('private-image-text');
  malformed.data.output[0].content[0].text = { private: 'private-image-text' };
  for (const response of [{ status: 200, data: null }, { status: 200, data: { status: 'completed', output: [] } }, partial, refusal, malformed]) {
    const logs = [];
    const service = createAiService({ env, logger: { error: value => logs.push(value) }, http: { async post() { return response; } } });
    await assert.rejects(service.extractMediaText({ buffer: Buffer.from('image-bytes'), mimeType: 'image/jpeg', type: 'image' }), error => {
      assert.equal(error.code, 'AI_MEDIA_EXTRACTION_FAILED');
      const output = inspect({ error, logs }, { depth: null });
      for (const value of ['private-image-text', 'private-provider-refusal', env.OPENAI_API_KEY]) assert.equal(output.includes(value), false);
      return true;
    });
  }
});

test('supported company documents reuse private bounded Meta media download', async () => {
  for (const mimeType of Object.keys(DOCUMENT_EXTENSIONS)) {
    const h = downloadHarness({ metadata: { mime_type: mimeType }, content: { headers: { 'content-type': mimeType } } });
    assert.deepEqual(await h.service.downloadMedia('12345'), { buffer: Buffer.from('jpeg'), mimeType });
    assert.equal(h.calls[1].options.maxContentLength, mimeType === 'text/plain' ? MAX_TEXT_DOCUMENT_BYTES : MAX_MEDIA_BYTES);
  }
  const h = downloadHarness({ metadata: { mime_type: 'text/plain', file_size: MAX_TEXT_DOCUMENT_BYTES + 1 } });
  await assert.rejects(h.service.downloadMedia('12345'), { code: 'ERR_WHATSAPP_MEDIA' });
  assert.equal(h.calls.length, 1);
});

test('PDF and Word company documents use configured Responses file input with fixed safe filenames', async () => {
  for (const [mimeType, extension] of Object.entries(DOCUMENT_EXTENSIONS).filter(([mime]) => mime !== 'text/plain')) {
    const calls = [];
    const service = createAiService({ env, http: { async post(...args) { calls.push(args); return completed('Company: Glow\nTRN No.: 104249196700003'); } } });
    assert.equal(await service.extractMediaText({ buffer: Buffer.from('document-bytes'), mimeType, type: 'document' }), 'Company: Glow\nTRN No.: 104249196700003');
    const [url, body, options] = calls[0];
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(body.model, env.OPENAI_MODEL);
    assert.equal(body.store, false);
    assert.deepEqual(body.input[1].content, [{ type: 'input_file', filename: `lead-document.${extension}`,
      file_data: `data:${mimeType};base64,${Buffer.from('document-bytes').toString('base64')}` }]);
    assert.equal(body.tools, undefined);
    assert.equal(options.maxBodyLength, Math.ceil(MAX_MEDIA_BYTES * 4 / 3) + 65536);
    assert.match(body.input[0].content, /partial information/);
    assert.match(body.input[0].content, /uncertain or unreadable rather than guessing/);
    assert.match(body.input[0].content, /TRN\/tax registration/);
  }
});

test('bounded UTF-8 text documents retain verbatim content without a transcription API call', async () => {
  const service = createAiService({ env, http: { async post() { assert.fail('Plain text needs no OCR provider.'); } } });
  const text = 'Company: GLOW\nAddress: Dubai\nTRN No.: 104249196700003';
  assert.equal(await service.extractMediaText({ buffer: Buffer.from(text), mimeType: 'text/plain', type: 'document' }), text);
  for (const buffer of [Buffer.from([0xc3, 0x28]), Buffer.from('private\0binary')]) {
    await assert.rejects(service.extractMediaText({ buffer, mimeType: 'text/plain', type: 'document' }), { code: 'AI_MEDIA_EXTRACTION_FAILED' });
  }
  await assert.rejects(service.extractMediaText({ buffer: Buffer.alloc(MAX_TEXT_DOCUMENT_BYTES + 1), mimeType: 'text/plain', type: 'document' }), { code: 'AI_MEDIA_INPUT_INVALID' });
});

test('images sent as WhatsApp documents still use vision rather than a filename-based parser', async () => {
  const calls = [];
  const ai = createAiService({ env, http: { async post(...args) { calls.push(args); return completed('Company: GLOW'); } } });
  const message = { message_type: 'document', message_text: 'Company card', media_id: '12345', media_mime_type: 'image/jpeg' };
  const whatsapp = { async downloadMedia() { return { buffer: Buffer.from('image-bytes'), mimeType: 'image/jpeg' }; } };
  assert.deepEqual(await resolveLeadMessageContent({ message, whatsapp, ai }), { text: 'Company card\nCompany: GLOW', transcription: null, extractedText: 'Company: GLOW' });
  assert.equal(calls[0][1].input[1].content[0].type, 'input_image');
});

test('media content preserves raw OCR and voice transcription independently of captions and reuses checkpoints', async () => {
  for (const type of ['image', 'audio', 'document']) {
    let downloads = 0;
    let extractions = 0;
    const mimeType = { image: 'image/jpeg', audio: 'audio/ogg', document: 'application/pdf' }[type];
    const raw = 'Company: GLOW\nReference: customer-card-42';
    const message = { message_type: type, message_text: 'Customer details', media_id: '12345', media_mime_type: mimeType };
    const whatsapp = { async downloadMedia() { downloads += 1; return { buffer: Buffer.from('private-bytes'), mimeType }; } };
    const ai = { async extractMediaText() { extractions += 1; return raw; } };
    const content = await resolveLeadMessageContent({ message, whatsapp, ai });
    assert.deepEqual(content, { text: `Customer details\n${raw}`, transcription: type === 'audio' ? raw : null, extractedText: type === 'audio' ? null : raw });
    const retryMessage = { ...message, transcription: content.transcription, extracted_text: content.extractedText };
    assert.deepEqual(await resolveLeadMessageContent({ message: retryMessage, whatsapp, ai }), content);
    assert.equal(downloads, 1);
    assert.equal(extractions, 1);
  }
});

test('unreadable media and unsupported document types request clarification without invented data or exposed source', async () => {
  const message = { message_type: 'image', media_id: '12345', media_mime_type: 'image/jpeg' };
  const whatsapp = { async downloadMedia() { return { buffer: Buffer.from('private-bytes'), mimeType: 'image/jpeg' }; } };
  for (const text of ['', '[unreadable]', 'Unclear', 'I cannot read this image.', 'Unable to extract the content.',
    'Company: [unreadable]', 'Company Name: [unclear].\nTRN No.: (illegible)', 'No readable details in this image.']) {
    const ai = createAiService({ env, http: { async post() { return completed(text); } } });
    await assert.rejects(resolveLeadMessageContent({ message, whatsapp, ai }), error => {
      assert.equal(error.code, 'LEAD_MEDIA_UNAVAILABLE');
      assert.match(error.message, /resend it or send the details as text/);
      assert.equal(inspect(error).includes('private-bytes'), false);
      return true;
    });
  }
  await assert.rejects(resolveLeadMessageContent({ message: { ...message, message_type: 'document', media_mime_type: 'application/zip' }, whatsapp: { async downloadMedia() { assert.fail('Unsupported formats must not download.'); } } }), { code: 'LEAD_MEDIA_UNSUPPORTED' });
});

test('unreadable labelled output from a checkpoint or substituted provider also requests clarification', async () => {
  for (const checkpoint of [false, true]) {
    const extractedText = 'Company Name: [unreadable]\nEmail ID: [unclear]';
    const message = { message_type: 'image', media_id: '12345', media_mime_type: 'image/jpeg',
      ...(checkpoint ? { extracted_text: extractedText } : {}) };
    const whatsapp = { async downloadMedia() {
      assert.equal(checkpoint, false);
      return { buffer: Buffer.from('private-bytes'), mimeType: 'image/jpeg' };
    } };
    const ai = { async extractMediaText() { assert.equal(checkpoint, false); return extractedText; } };
    await assert.rejects(resolveLeadMessageContent({ message, whatsapp, ai }), { code: 'LEAD_MEDIA_UNAVAILABLE' });
  }
});

test('partly readable media retains source text for review and extraction of grounded facts', async () => {
  const text = 'Company: GLOW POWER EQUIPMENT RENTAL LLC\nContact Name: [unreadable]\nPhone: [unclear]';
  const ai = createAiService({ env, http: { async post() { return completed(text); } } });
  const whatsapp = { async downloadMedia() { return { buffer: Buffer.from('private-bytes'), mimeType: 'image/jpeg' }; } };
  const message = { message_type: 'image', media_id: '12345', media_mime_type: 'image/jpeg' };
  assert.deepEqual(await resolveLeadMessageContent({ message, whatsapp, ai }), { text, transcription: null, extractedText: text });
});

test('AI media failures are sanitized and unsupported input is rejected before HTTP', async () => {
  let requests = 0;
  const logs = [];
  const service = createAiService({ env, logger: { error: entry => logs.push(entry) }, http: { async post() {
    requests += 1;
    throw Object.assign(new Error(env.OPENAI_API_KEY + ' private-attachment'), { response: { data: 'private data' } });
  } } });
  for (const input of [{ buffer: Buffer.alloc(0), mimeType: 'image/jpeg', type: 'image' }, { buffer: Buffer.from('x'), mimeType: 'image/svg+xml', type: 'image' }, { buffer: Buffer.from('x'), mimeType: 'audio/ogg', type: 'image' }]) {
    await assert.rejects(service.extractMediaText(input), { code: 'AI_MEDIA_INPUT_INVALID' });
  }
  assert.equal(requests, 0);
  await assert.rejects(service.extractMediaText({ buffer: Buffer.from('x'), mimeType: 'image/jpeg', type: 'image' }), error => {
    assert.equal(error.code, 'AI_MEDIA_EXTRACTION_FAILED');
    const output = inspect({ error, logs }, { depth: null });
    for (const secret of [env.OPENAI_API_KEY, 'private-attachment', 'private data']) assert.equal(output.includes(secret), false);
    return true;
  });
  const malformed = createAiService({ env, http: { async post() { return completed(''); } } });
  await assert.rejects(malformed.extractMediaText({ buffer: Buffer.from('x'), mimeType: 'image/jpeg', type: 'image' }), { code: 'AI_MEDIA_EXTRACTION_FAILED' });
});

test('lead media helper merges captions with extracted text without treating missing media as lead data', async () => {
  const message = { message_type: 'image', message_text: 'Al Noor Contracting', media_id: '12345', media_mime_type: 'image/jpeg' };
  const whatsapp = { async downloadMedia() { return { buffer: Buffer.from('x'), mimeType: 'image/jpeg' }; } };
  const ai = { async extractMediaText() { return 'Ahmed +971501234567'; } };
  assert.equal(await resolveLeadMessageText({ message, whatsapp, ai }), 'Al Noor Contracting\nAhmed +971501234567');
  assert.equal(await resolveLeadMessageText({ message: { message_type: 'text', message_text: 'Hi' } }), 'Hi');
  await assert.rejects(resolveLeadMessageText({ message: { message_type: 'video' } }), { code: 'LEAD_MEDIA_UNSUPPORTED' });
  for (const modified of [{ media_id: null }, { media_mime_type: 'audio/ogg' }, { message_type: 'audio' }]) {
    await assert.rejects(resolveLeadMessageText({ message: { ...message, ...modified }, whatsapp, ai }), { code: 'LEAD_MEDIA_UNAVAILABLE' });
  }
  await assert.rejects(resolveLeadMessageText({ message, whatsapp, ai: { async extractMediaText() { return ''; } } }), { code: 'LEAD_MEDIA_UNAVAILABLE' });
});

test('confirmation words inside screenshots or voice transcription cannot authorize saving an awaiting lead', async () => {
  for (const type of ['image', 'audio']) {
    for (const transcription of ['Yes', 'Save it', 'Confirmed', 'Okay, save']) {
      const session = { id: 'existing-session', state: 'awaiting_confirmation',
        result: { is_lead: true, lead: { ...Object.fromEntries(LEAD_FIELDS.map(field => [field, null])), company_name: 'Al Noor', requirement: 'MDB' } },
        validation_result: { valid: true, missing_fields: [], errors: [] }, original_message: 'Al Noor needs MDB' };
      const turns = [];
      const store = {
        async getActiveLeadSession() { return session; },
        async checkpointLeadMedia() { return true; },
        async completeLeadSessionTurn(_id, _token, turn) { turns.push(turn); return true; },
      };
      const mimeType = type === 'image' ? 'image/jpeg' : 'audio/ogg';
      const whatsapp = { async downloadMedia() { return { buffer: Buffer.from('private-media'), mimeType }; } };
      const ai = { async extractMediaText() { return transcription; },
        async extractLeadEnquiry() { assert.fail('Attachment confirmation words must not become lead fields.'); } };
      const service = createLeadService({ store, ai, resolveMessageText: message => resolveLeadMessageText({ message, whatsapp, ai }) });
      await service.saveIncomingLead({ message_id: 'attachment-message', lease_token: 'lease', sender_phone: '+971551234567',
        message_type: type, message_text: '', media_id: '12345', media_mime_type: mimeType }, { async assertLease() {} });
      assert.equal(turns.length, 1);
      assert.equal(turns[0].sessionId, session.id);
      assert.equal(turns[0].kind, 'conversation');
      assert.notEqual(turns[0].state, 'completed');
      assert.match(turns[0].replyText, /text message/);
      assert.equal(turns[0].result, undefined);
      assert.equal(session.state, 'awaiting_confirmation');
    }
  }
});
