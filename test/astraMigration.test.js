'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAiService } = require('../src/services/ai/aiService');

const LEAD_FIELDS = ['company_name', 'contact_name', 'phone', 'email', 'project_name',
  'project_location', 'product_or_service', 'requirement', 'quantity', 'deadline', 'notes', 'address', 'trn_no'];
const LEGACY_FIELDS = ['name', 'phone', 'email', 'company', 'service', 'location', 'requirement', 'notes'];
const SOURCE = 'Ahmed from Al Noor';
const lead = { is_lead: true, lead: { ...Object.fromEntries(LEAD_FIELDS.map(field => [field, null])),
  company_name: 'Al Noor', contact_name: 'Ahmed' } };
const legacyLead = { ...Object.fromEntries(LEGACY_FIELDS.map(field => [field, null])), name: 'Ahmed', company: 'Al Noor' };
const media = (type, mimeType) => ({ type, mimeType, buffer: Buffer.from('mock attachment') });

function completed(text) {
  return { status: 200, data: { status: 'completed', output: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Private reasoning must never become customer data.' }] },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
  ] } };
}

function setup(outcome, overrides = {}) {
  const calls = [];
  const env = { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'mock-astra-test-credential',
    OPENAI_MODEL: 'gpt-6-astra', AI_TIMEOUT_MS: '17000', AI_MAX_OUTPUT_TOKENS: '768',
    AI_MEDIA_MAX_OUTPUT_TOKENS: '3072', ...overrides };
  const service = createAiService({ env, http: { async post(...args) { calls.push(args); return outcome; } } });
  return { calls, service };
}

const cases = [
  { name: 'customer reply', invoke: service => service.generateReply(SOURCE),
    text: 'Thank you. How can we help?', expected: 'Thank you. How can we help?', tokens: 768 },
  { name: 'lead enquiry', invoke: service => service.extractLeadEnquiry(SOURCE),
    text: JSON.stringify({ ...lead, lead: { ...lead.lead, email: 'invented@example.com', requirement: 'invented order' } }),
    expected: lead, tokens: 768, fields: LEAD_FIELDS, schemaName: 'lead_enquiry' },
  { name: 'legacy CRM extraction', invoke: service => service.extractLead(SOURCE),
    text: JSON.stringify(legacyLead), expected: legacyLead, tokens: 768, fields: LEGACY_FIELDS, schemaName: 'customer_lead' },
  { name: 'image OCR', invoke: service => service.extractMediaText(media('image', 'image/jpeg')),
    text: SOURCE, expected: SOURCE, tokens: 3072, contentType: 'input_image' },
  { name: 'document OCR', invoke: service => service.extractMediaText(media('document', 'application/pdf')),
    text: SOURCE, expected: SOURCE, tokens: 3072, contentType: 'input_file' },
];

test('Astra Responses calls preserve each output contract and configured budget while excluding reasoning from customer data', async t => {
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const { service, calls } = setup(completed(scenario.text));
    assert.deepEqual(await scenario.invoke(service), scenario.expected);
    assert.equal(calls.length, 1);
    const [url, body, options] = calls[0];
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(body.model, 'gpt-6-astra');
    assert.deepEqual(body.reasoning, { effort: 'low' });
    assert.equal(body.max_output_tokens, scenario.tokens);
    assert.equal(options.timeout, 17000);
    assert.equal(body.store, false);
    assert.equal(body.truncation, 'disabled');
    for (const parameter of ['temperature', 'top_p', 'max_tokens', 'logprobs', 'response_format',
      'tools', 'tool_choice', 'functions', 'function_call']) assert.equal(Object.hasOwn(body, parameter), false, parameter);
    assert.equal(body.input[0].role, 'system');
    assert.match(body.input[0].content, /untrusted data/);
    assert.equal(body.input[1].role, 'user');
    if (scenario.contentType) assert.equal(body.input[1].content[0].type, scenario.contentType);
    else assert.equal(JSON.parse(body.input[1].content).whatsapp_message, SOURCE);
    if (scenario.fields) {
      const format = body.text.format;
      assert.equal(format.type, 'json_schema');
      assert.equal(format.name, scenario.schemaName);
      assert.equal(format.strict, true);
      assert.equal(format.schema.additionalProperties, false);
      if (scenario.schemaName === 'lead_enquiry') assert.deepEqual(format.schema.required, ['is_lead', 'lead']);
      const schema = scenario.schemaName === 'lead_enquiry' ? format.schema.properties.lead : format.schema;
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, scenario.fields);
      assert.deepEqual(Object.keys(schema.properties), scenario.fields);
      for (const field of scenario.fields) assert.deepEqual(schema.properties[field].type, ['string', 'null']);
    } else assert.deepEqual(body.text.format, { type: 'text' });
  });
});

test('the Astra reasoning setting is not added to other configured Responses models', async () => {
  for (const scenario of cases) {
    const { service, calls } = setup(completed(scenario.text), { OPENAI_MODEL: 'configured-other-model' });
    assert.deepEqual(await scenario.invoke(service), scenario.expected);
    assert.equal(calls[0][1].model, 'configured-other-model');
    assert.equal(Object.hasOwn(calls[0][1], 'reasoning'), false);
  }
});

test('Astra incomplete output cannot become a lead even when the returned JSON is parseable and grounded', async () => {
  const outcome = completed(JSON.stringify(lead));
  outcome.data.status = 'incomplete';
  outcome.data.incomplete_details = { reason: 'max_output_tokens' };
  const { service, calls } = setup(outcome);
  await assert.rejects(service.extractLeadEnquiry(SOURCE), { code: 'AI_MALFORMED_RESPONSE', retryable: false });
  assert.equal(calls.length, 1);
});

test('Astra refusals and malformed lead JSON remain sanitized nonretryable failures', async () => {
  const refused = completed('');
  refused.data.output[1].content = [{ type: 'refusal', refusal: 'private provider refusal' }];
  for (const outcome of [refused, completed('{"is_lead":true,"lead":')]) {
    const { service } = setup(outcome);
    await assert.rejects(service.extractLeadEnquiry(SOURCE), error => {
      assert.equal(error.code, 'AI_MALFORMED_RESPONSE');
      assert.equal(error.retryable, false);
      assert.equal(error.cause, undefined);
      assert.equal(error.response, undefined);
      assert.equal(error.message.includes('private provider refusal'), false);
      return true;
    });
  }
});

test('Astra text configuration leaves audio transcription on its independent endpoint and model', async () => {
  for (const transcriptionModel of [undefined, 'configured-transcription-model']) {
    const { service, calls } = setup({ status: 200, data: { text: SOURCE } },
      { OPENAI_TRANSCRIPTION_MODEL: transcriptionModel });
    assert.equal(await service.extractMediaText(media('audio', 'audio/ogg')), SOURCE);
    assert.equal(calls.length, 1);
    const [url, form, options] = calls[0];
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(form.get('model'), transcriptionModel || 'gpt-4o-mini-transcribe');
    assert.equal(form.get('response_format'), 'json');
    assert.equal(form.has('reasoning'), false);
    assert.equal(form.has('max_output_tokens'), false);
    assert.equal(options.timeout, 17000);
  }
});
