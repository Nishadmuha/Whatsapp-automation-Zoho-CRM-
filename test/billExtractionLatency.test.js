'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBillExtractionService, computeGrounding, BILL_EXTRACTION_INSTRUCTIONS, BILL_MEDIA_EXTRACTION_INSTRUCTIONS } = require('../src/services/ai/billExtractionService');
const { billCoreSchema, billExtractionJsonSchema } = require('../src/services/books/billSchema');

const PRIVATE = 'PRIVATE PROVIDER / INVOICE / CREDENTIAL CONTENT';
const MODEL = 'gpt-5.6-luna';
const sourceText = 'Example Supplier INV-42 7-Oct-26 due 7-Nov-2026 AED Cable 2 50 100 VAT 5 Total 105';
const media = [{ buffer: Buffer.from(PRIVATE), mimeType: 'image/jpeg', filename: 'private-invoice.jpg' }];

function envelope() {
  return { bill: billCoreSchema.parse({ vendor_name: 'Example Supplier', bill_number: 'INV-42',
    bill_date: '7-Oct-26', due_date: '7-Nov-2026', currency: 'AED', subtotal: 100, tax_amount: 5, total_amount: 105,
    line_items: [{ name: 'Cable', quantity: 2, rate: 50, amount: 100, tax_percentage: 5 }], notes: PRIVATE,
  }), confidence: {} };
}

function response(data = {}) {
  return { status: 200, data: { id: 'resp-private-identifier', status: 'completed', model: `${MODEL}-snapshot`,
    usage: { input_tokens: 1200, output_tokens: 350, total_tokens: 1550,
      input_tokens_details: { cached_tokens: 1024 }, output_tokens_details: { reasoning_tokens: 30 } },
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(envelope()) }] }],
    ...data,
  } };
}

function setup(outcome = () => response()) {
  const logs = [], calls = [];
  const env = { OPENAI_API_KEY: 'synthetic-private-key', OPENAI_MODEL: MODEL, AI_TIMEOUT_MS: '5000', AI_MAX_OUTPUT_TOKENS: '512' };
  const service = createBillExtractionService({ env, logger: {
    info(record) { logs.push({ level: 'info', record }); },
    error(record) { logs.push({ level: 'error', record }); },
  }, http: { async post(...args) { calls.push(args); return outcome(); } } });
  return { service, logs, calls, env };
}

for (const [candidate, source] of [
  ['2026-10-07', 'Invoice date: 2026-10-07'],
  ['2026-10-07', 'Invoice date: 7-Oct-26'],
  ['2026-10-07', 'Invoice date: 7-Oct-2026'],
  ['2026-10-07', 'Invoice date: October 7, 2026'],
  ['7-Oct-26', 'Invoice date: 2026/10/07'],
  ['2026-10-17', 'Invoice date: 17/10/2026'],
]) {
  test(`complete source date ${source} grounds its normalized date`, () => {
    const grounding = computeGrounding({ bill_date: candidate, due_date: candidate }, source);
    assert.equal(grounding.bill_date, 'explicit');
    assert.equal(grounding.due_date, 'explicit');
  });
}

for (const [candidate, source] of [
  ['2026-10-07', 'Invoice date: 7-Oct-25. Reference 2026.'],
  ['2026-11-07', 'Invoice date: 7-Oct-26. Due date: 7-Nov-27.'],
  ['2026-10-07', 'Reference 2026. Quantity 07.'],
  ['2026-04-03', 'Invoice date: 03/04/2026'],
  ['03/04/2026', 'Invoice date: 03/04/2026'],
  ['2026-02-28', 'Invoice date: 31-Feb-2026'],
  ['2026-10-07', 'Reference: REF2026-10-07X'],
]) {
  test(`unmatched or ambiguous source date does not ground ${candidate}: ${source}`, () => {
    const grounding = computeGrounding({ bill_date: candidate, due_date: candidate }, source);
    assert.equal(grounding.bill_date, 'inferred');
    assert.equal(grounding.due_date, 'inferred');
  });
}

test('text and image extraction normalize raw named-month dates without extra AI requests', async () => {
  const { service, calls } = setup();
  for (const result of [await service.extractBillFromText({ text: sourceText }), await service.extractBillFromMedia({ media })]) {
    assert.equal(result.success, true);
    assert.equal(result.bill.bill_date, '2026-10-07');
    assert.equal(result.bill.due_date, '2026-11-07');
    assert.equal(result.grounding.bill_date, 'explicit');
    assert.equal(result.grounding.due_date, 'explicit');
    assert.equal(result.bill.line_items.length, 1);
    assert.equal(result.bill.total_amount, 105);
  }
  assert.equal(calls.length, 2);
});

test('all four Books AI operations log numeric usage and latency at INFO without changing requests', async () => {
  const { service, logs, calls, env } = setup();
  const originalEnv = { ...env };
  await service.extractBillFromText({ text: sourceText });
  await service.extractBillFromMedia({ media });
  await service.mergeAdditionalInfo({ currentBill: envelope().bill, additionalText: 'Preserve source details.' });
  await service.applyEditInstructions({ currentBill: envelope().bill, editInstruction: 'Preserve source details.' });
  const metrics = logs.filter(log => log.record.event === 'ai.bill_request.metrics');
  assert.deepEqual(metrics.map(log => log.record.stage), ['bill_text_extraction', 'bill_media_extraction', 'bill_merge', 'bill_edit']);
  for (const { level, record } of metrics) {
    assert.equal(level, 'info');
    assert.equal(record.outcome, 'response');
    assert.equal(record.model, `${MODEL}-snapshot`);
    assert.ok(Number.isSafeInteger(record.duration_ms) && record.duration_ms >= 0);
    assert.equal(record.input_tokens, 1200);
    assert.equal(record.output_tokens, 350);
    assert.equal(record.total_tokens, 1550);
    assert.equal(record.cached_input_tokens, 1024);
    assert.equal(record.reasoning_tokens, 30);
  }
  assert.equal(metrics[1].record.media_count, 1);
  assert.equal(metrics[1].record.media_bytes, media[0].buffer.length);
  assert.ok(logs.filter(log => log.record.event === 'ai_timing').every(log => log.level === 'info'));
  assert.equal(calls.length, 4);
  for (const [, body] of calls) {
    assert.equal(body.model, MODEL);
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 4096);
    assert.equal(body.truncation, 'disabled');
    assert.equal(body.text.format.schema, billExtractionJsonSchema);
  }
  assert.equal(calls[0][1].input[0].content, BILL_EXTRACTION_INSTRUCTIONS);
  assert.equal(calls[1][1].input[0].content, BILL_MEDIA_EXTRACTION_INSTRUCTIONS);
  assert.equal(calls[1][1].input[1].content[1].detail, 'high');
  assert.deepEqual(env, originalEnv);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE PROVIDER|private-invoice|resp-private|synthetic-private|Example Supplier|INV-42/);
});

test('diagnostics omit malformed token counters and untrusted oversized or multiline model names', async () => {
  for (const model of [PRIVATE, 'gpt-5.6-luna\nprivate', 'g'.repeat(201), { private: PRIVATE }]) {
    const { service, logs } = setup(() => response({ model, usage: {
      input_tokens: PRIVATE, output_tokens: -1, total_tokens: Number.MAX_SAFE_INTEGER + 1,
      input_tokens_details: { cached_tokens: Infinity }, output_tokens_details: { reasoning_tokens: 0.5 },
    } }));
    await service.extractBillFromMedia({ media });
    const metrics = logs.find(log => log.record.event === 'ai.bill_request.metrics').record;
    for (const field of ['model', 'input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'reasoning_tokens']) {
      assert.equal(Object.hasOwn(metrics, field), false);
    }
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE PROVIDER|private-invoice|resp-private/);
  }
});

test('request errors still report safe timing and preserve controlled failure behavior', async () => {
  const { service, logs } = setup(() => { throw Object.assign(new Error(PRIVATE), { response: { status: 429, data: { id: PRIVATE, error: { message: PRIVATE } } } }); });
  const result = await service.extractBillFromText({ text: sourceText });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'AI_RATE_LIMIT');
  const metrics = logs.find(log => log.record.event === 'ai.bill_request.metrics');
  assert.equal(metrics.level, 'info');
  assert.equal(metrics.record.outcome, 'error');
  assert.ok(metrics.record.duration_ms >= 0);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE PROVIDER|Example Supplier|INV-42/);
});

test('truncated provider output remains rejected while its usage is observable', async () => {
  const { service, logs } = setup(() => response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
  const result = await service.extractBillFromMedia({ media });
  assert.equal(result.success, false);
  assert.equal(result.bill, null);
  assert.equal(result.error.reason, 'OUTPUT_TOKEN_LIMIT');
  assert.equal(logs.find(log => log.record.event === 'ai.bill_request.metrics').record.output_tokens, 350);
});
