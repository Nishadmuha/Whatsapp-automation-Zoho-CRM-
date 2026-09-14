'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { run } = require('../scripts/whatsapp-cli');
const { createWhatsAppService } = require('../src/services/whatsapp/whatsappService');

function environment(extra = {}) {
  return { WHATSAPP_ACCESS_TOKEN: 'mock-private-whatsapp-key', WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
    META_GRAPH_API_VERSION: 'v25.0', WHATSAPP_TEST_TO: '+971501234567', ...extra };
}

function harness({ env = environment(), outcome = { status: 200, data: { messages: [{ id: 'mock-accepted-message' }] } }, prompt } = {}) {
  const calls = [];
  const output = { stdout: '', stderr: '' };
  let factories = 0;
  const options = {
    env, stdin: { isTTY: false }, prompt,
    stdout: { write(value) { output.stdout += value; } },
    stderr: { write(value) { output.stderr += value; } },
    createService(args) {
      factories++;
      return createWhatsAppService({ ...args, http: { async post(...values) {
        calls.push(values);
        return typeof outcome === 'function' ? outcome(...values) : outcome;
      } } });
    },
  };
  return { calls, output, options, env, factories: () => factories };
}

test('WhatsApp CLI defaults to a validated dry run with masked recipient and no service/network call', async () => {
  const h = harness();
  assert.equal(await run([], h.options), 0);
  assert.equal(JSON.parse(h.output.stdout).status, 'DRY_RUN');
  assert.equal(JSON.parse(h.output.stdout).deliveryState, 'NOT_ATTEMPTED');
  assert.equal(JSON.parse(h.output.stdout).recipient, '***4567');
  assert.equal(h.factories(), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.output.stderr, '');
  for (const privateValue of [h.env.WHATSAPP_ACCESS_TOKEN, h.env.WHATSAPP_TEST_TO]) {
    assert.equal(h.output.stdout.includes(privateValue), false);
  }
});

test('WhatsApp CLI checks missing/invalid send configuration before prompting', async () => {
  for (const overrides of [{ WHATSAPP_ACCESS_TOKEN: '' }, { WHATSAPP_PHONE_NUMBER_ID: '' }, { WHATSAPP_PHONE_NUMBER_ID: 'invalid' }, { META_GRAPH_API_VERSION: '' }]) {
    let prompts = 0;
    const h = harness({ env: environment({ ...overrides, WHATSAPP_TEST_TO: undefined }), prompt: async () => { prompts++; return '+971501234567'; } });
    assert.equal(await run(['--send'], h.options), 1);
    assert.equal(JSON.parse(h.output.stderr).code, 'ERR_WHATSAPP_CONFIG');
    assert.equal(JSON.parse(h.output.stderr).deliveryState, 'NOT_ATTEMPTED');
    assert.equal(prompts, 0);
    assert.equal(h.calls.length, 0);
  }
});

test('WhatsApp CLI explicit template send uses the service once with dynamic arguments', async () => {
  const h = harness();
  assert.equal(await run(['--send', '--template', 'appointment_reminder', '--language', 'ar', '--to', '+971551234567'], h.options), 0);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0][1], { messaging_product: 'whatsapp', to: '+971551234567', type: 'template',
    template: { name: 'appointment_reminder', language: { code: 'ar' } } });
  assert.equal(JSON.parse(h.output.stdout).status, 'SENT');
  assert.match(JSON.parse(h.output.stdout).message, /accepted.*delivery is not confirmed/);
  assert.equal(h.output.stdout.includes('mock-accepted-message'), false);
  assert.equal(h.output.stdout.includes('+971551234567'), false);
});

test('WhatsApp CLI allows private prompted recipient and text input without echoing payload into result logs', async () => {
  const answers = ['+971551234567', 'Private customer message'];
  const prompts = [];
  const h = harness({ env: environment({ WHATSAPP_TEST_TO: undefined }), prompt: async (label) => {
    prompts.push(label);
    return answers[prompts.length - 1];
  } });
  assert.equal(await run(['--send', '--mode', 'text'], h.options), 0);
  assert.equal(prompts.length, 2);
  assert.deepEqual(h.calls[0][1], { messaging_product: 'whatsapp', to: answers[0], type: 'text', text: { body: answers[1] } });
  assert.equal(h.output.stdout.includes(answers[0]), false);
  assert.equal(h.output.stdout.includes(answers[1]), false);
});

test('WhatsApp CLI uses private text environment and legacy Graph version without AI/Zoho configuration', async () => {
  const h = harness({ env: environment({ META_GRAPH_API_VERSION: '', WHATSAPP_API_VERSION: 'v25.0', WHATSAPP_TEST_TEXT: 'Private test text' }) });
  assert.equal(await run(['--send', '--mode', 'text'], h.options), 0);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0][0], /^https:\/\/graph\.facebook\.com\/v25\.0\//);
  assert.equal(h.calls[0][1].text.body, 'Private test text');
  assert.equal(h.output.stdout.includes('Private test text'), false);
});

test('WhatsApp CLI missing or blank noninteractive private input fails without hanging or sending', async () => {
  for (const [extra, argv] of [
    [{ WHATSAPP_TEST_TO: undefined }, ['--send']],
    [{ WHATSAPP_TEST_TO: '' }, ['--send']],
    [{ WHATSAPP_TEST_TO: ' ' }, ['--send']],
    [{ WHATSAPP_TEST_TEXT: '' }, ['--send', '--mode', 'text']],
    [{ WHATSAPP_TEST_TEXT: ' ' }, ['--send', '--mode', 'text']],
  ]) {
    const h = harness({ env: environment(extra) });
    assert.equal(await run(argv, h.options), 1);
    assert.equal(JSON.parse(h.output.stderr).code, 'WHATSAPP_CLI_PROMPT');
    assert.equal(JSON.parse(h.output.stderr).attempted, false);
    assert.equal(h.calls.length, 0);
  }
});

test('blank private recipient configuration uses the interactive prompt and leaves the default dry run intact', async () => {
  let prompts = 0;
  const h = harness({ env: environment({ WHATSAPP_TEST_TO: ' ' }), prompt: async () => { prompts++; return '+971501234567'; } });
  assert.equal(await run([], h.options), 0);
  assert.equal(prompts, 1);
  assert.equal(JSON.parse(h.output.stdout).status, 'DRY_RUN');
  assert.equal(h.calls.length, 0);
});

test('blank private text configuration uses the prompt while explicitly empty CLI input remains invalid', async () => {
  for (const configuredText of ['', ' ']) {
    let prompts = 0;
    const h = harness({ env: environment({ WHATSAPP_TEST_TEXT: configuredText }), prompt: async () => { prompts++; return 'Private prompted text'; } });
    assert.equal(await run(['--mode', 'text'], h.options), 0);
    assert.equal(prompts, 1);
    assert.equal(h.calls.length, 0);
    assert.equal(h.output.stdout.includes('Private prompted text'), false);
  }
  for (const argv of [['--to', ''], ['--text', '']]) {
    let prompts = 0;
    const h = harness({ prompt: async () => { prompts++; return '+971501234567'; } });
    assert.equal(await run(argv, h.options), 1);
    assert.equal(prompts, 0);
    assert.equal(h.calls.length, 0);
  }
});

test('WhatsApp CLI invalid options and send inputs cannot make a request', async () => {
  for (const argv of [
    ['--send', '--dry-run'], ['--send', '--send'], ['--unknown', 'private-value'], ['--to'],
    ['--send', '--mode', 'invalid'], ['--send', '--mode', 'template', '--text', 'private-text'],
    ['--send', '--mode', 'text', '--template', 'hello_world'], ['--send', '--to', 'invalid-number'],
    ['--send', '--template', 'bad template'], ['--send', '--language', 'en_US\n'],
    ['--send', '--text', ''], ['--send', '--text', 'x'.repeat(4097)],
  ]) {
    const h = harness();
    assert.equal(await run(argv, h.options), 1);
    assert.equal(JSON.parse(h.output.stderr).deliveryState, 'NOT_ATTEMPTED');
    assert.equal(h.calls.length, 0);
    for (const privateValue of ['private-value', 'private-text', h.env.WHATSAPP_ACCESS_TOKEN, h.env.WHATSAPP_TEST_TO]) {
      assert.equal(h.output.stderr.includes(privateValue), false);
    }
  }
});

test('WhatsApp CLI exposes only safe rejection metadata and does not retry', async () => {
  const env = environment();
  const h = harness({ env, outcome: () => {
    throw { response: { status: 503, data: { error: { message: env.WHATSAPP_ACCESS_TOKEN, code: 131000, error_subcode: 1 } } },
      config: { headers: { Authorization: env.WHATSAPP_ACCESS_TOKEN } } };
  } });
  assert.equal(await run(['--send'], h.options), 1);
  const output = JSON.parse(h.output.stderr);
  assert.equal(output.deliveryState, 'ATTEMPTED_FAILED');
  assert.equal(output.attempted, true);
  assert.equal(output.httpStatus, 503);
  assert.equal(output.metaCode, 131000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.output.stderr.includes(env.WHATSAPP_ACCESS_TOKEN), false);
  assert.equal(h.output.stderr.includes(env.WHATSAPP_TEST_TO), false);
});

test('WhatsApp CLI timeout reports UNKNOWN and prompts reconciliation without retry', async () => {
  const h = harness({ outcome: () => { throw { code: 'ECONNABORTED' }; } });
  assert.equal(await run(['--send'], h.options), 1);
  const output = JSON.parse(h.output.stderr);
  assert.equal(output.deliveryState, 'UNKNOWN');
  assert.match(output.message, /Check Meta before any manual resend/);
  assert.equal(h.calls.length, 1);
});

test('WhatsApp CLI does not echo arbitrary exception fields', async () => {
  const h = harness();
  h.options.createService = () => ({ async sendTemplateMessage() {
    throw { code: h.env.WHATSAPP_ACCESS_TOKEN, message: h.env.WHATSAPP_TEST_TO, httpStatus: h.env.WHATSAPP_ACCESS_TOKEN,
      metaCode: h.env.WHATSAPP_TEST_TO, deliveryState: h.env.WHATSAPP_ACCESS_TOKEN };
  } });
  assert.equal(await run(['--send'], h.options), 1);
  assert.equal(JSON.parse(h.output.stderr).deliveryState, 'UNKNOWN');
  assert.equal(h.output.stderr.includes(h.env.WHATSAPP_ACCESS_TOKEN), false);
  assert.equal(h.output.stderr.includes(h.env.WHATSAPP_TEST_TO), false);
});

test('WhatsApp CLI help is available without configuration or private input', async () => {
  const h = harness({ env: {} });
  assert.equal(await run(['--help'], h.options), 0);
  assert.ok(JSON.parse(h.output.stdout).usage.length);
  assert.equal(h.calls.length, 0);
});
