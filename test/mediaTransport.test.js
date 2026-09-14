'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const axios = require('axios');
const { createAiService } = require('../src/services/ai/aiService');
const { createWhatsAppService } = require('../src/services/whatsapp/whatsappService');
const { resolveLeadMessageContent } = require('../src/services/leads/leadMedia');
const { LEAD_FIELDS } = require('../src/services/ai/leadExtraction');
const { silent } = require('./helpers');

// Exercise the installed Axios serializer over loopback, not just mocked post()
// arguments. Only synthetic credentials/media are used; no provider can be called.
for (const type of ['image', 'audio']) test(`${type} bytes survive authenticated download and actual Axios upload serialization`, async t => {
  const env = { AI_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-6-astra', OPENAI_API_KEY: 'mock-wire-openai-key',
    WHATSAPP_ACCESS_TOKEN: 'mock-wire-meta-token', WHATSAPP_PHONE_NUMBER_ID: '12345678', META_GRAPH_API_VERSION: 'v25.0' };
  const mimeType = type === 'image' ? 'image/png' : 'audio/ogg';
  const bytes = Buffer.from(type === 'image' ? 'synthetic-image-bytes' : 'OggS-synthetic-voice-bytes');
  const source = 'Company: Wire Test LLC. Requirement: two panels.';
  const extraction = { is_lead: true, lead: { ...Object.fromEntries(LEAD_FIELDS.map(field => [field, null])),
    company_name: 'Wire Test LLC', requirement: 'two panels' } };
  const attachmentUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=12345&signature=mock';
  const requests = [];
  const completed = text => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }] }] });
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const body = Buffer.concat(parts);
    requests.push({ url: request.url, headers: request.headers, body });
    if (request.url.startsWith('/metadata?')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: '12345', url: attachmentUrl, mime_type: mimeType, file_size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('base64') }));
    } else if (request.url === '/attachment') {
      response.setHeader('Content-Type', mimeType + (type === 'audio' ? '; codecs=opus' : ''));
      response.end(bytes);
    } else if (request.url === '/transcriptions') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ text: source }));
    } else if (request.url === '/responses') {
      const input = JSON.parse(body.toString('utf8'));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(completed(input.text.format.type === 'json_schema' ? JSON.stringify(extraction) : source)));
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const whatsapp = createWhatsAppService({ env, logger: silent, http: { get(url, options) {
    assert.ok(['https://graph.facebook.com/v25.0/12345', attachmentUrl].includes(url));
    return axios.get(base + (url === attachmentUrl ? '/attachment' : '/metadata'), options);
  } } });
  const ai = createAiService({ env, logger: silent, http: { post(url, body, options) {
    assert.ok(['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/audio/transcriptions'].includes(url));
    return axios.post(base + (url.endsWith('/transcriptions') ? '/transcriptions' : '/responses'), body, options);
  } } });
  const content = await resolveLeadMessageContent({ message: { message_type: type, message_text: '', media_id: '12345',
    media_mime_type: mimeType + (type === 'audio' ? '; codecs=opus' : '') }, whatsapp, ai });
  assert.equal(content.text, source);
  assert.equal(type === 'audio' ? content.transcription : content.extractedText, source);
  assert.deepEqual(await ai.extractLeadEnquiry(content.text), extraction);
  assert.equal(requests.length, 4);
  assert.equal(requests[0].url, '/metadata?phone_number_id=12345678');
  for (const request of requests.slice(0, 2)) assert.equal(request.headers.authorization, `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`);
  for (const request of requests.slice(2)) assert.equal(request.headers.authorization, `Bearer ${env.OPENAI_API_KEY}`);
  const upload = requests[2];
  if (type === 'audio') {
    assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=/);
    const form = await new globalThis.Request(base, { method: 'POST', headers: upload.headers, body: upload.body }).formData();
    assert.equal(form.get('model'), 'gpt-4o-mini-transcribe');
    assert.equal(form.get('response_format'), 'json');
    assert.equal(form.get('file').name, 'voice.ogg');
    assert.equal(form.get('file').type, 'audio/ogg');
    assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), bytes);
  } else {
    assert.match(upload.headers['content-type'], /^application\/json/);
    const body = JSON.parse(upload.body.toString('utf8'));
    assert.deepEqual(body.reasoning, { effort: 'low' });
    assert.equal(body.model, 'gpt-6-astra');
    assert.equal(body.store, false);
    assert.deepEqual(body.input[1].content, [{ type: 'input_image', image_url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'high' }]);
  }
  const last = JSON.parse(requests[3].body.toString('utf8'));
  assert.equal(last.model, 'gpt-6-astra');
  assert.deepEqual(last.reasoning, { effort: 'low' });
  assert.equal(JSON.parse(last.input[1].content).whatsapp_message, source);
  assert.equal(last.text.format.strict, true);
});
