'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLogger } = require('../src/utils/logger');
const { outputRedactor } = require('../src/routes/leads');

// Synthetic values only; these tests neither read .env nor connect to MongoDB.
const uri = 'mongodb+srv://synthetic-user:synthetic-password@cluster.example.test/voltronix?retryWrites=true&w=majority';

test('logger redacts configured MongoDB URI from structured values, messages, and errors', () => {
  let output = '';
  const logger = createLogger({ LOG_LEVEL: 'info', MONGODB_URI: uri }, { write(chunk) { output += chunk; } });
  logger.info({ event: 'mongo_redaction_test', values: [uri, { detail: 'Connection ' + uri }] }, 'Connecting to ' + uri);
  logger.error('Connection failed for ' + uri);
  logger.error({ error: new Error('Authentication failed for ' + uri) });

  const records = output.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records[0].values, ['[REDACTED]', { detail: 'Connection [REDACTED]' }]);
  assert.equal(records[0].msg, 'Connecting to [REDACTED]');
  assert.equal(records[1].msg, 'Connection failed for [REDACTED]');
  assert.deepEqual(records[2].error, { code: 'INTERNAL_ERROR' });
  for (const secret of [uri, 'synthetic-user', 'synthetic-password']) assert.equal(output.includes(secret), false);
});

test('logger treats MongoDB URI object keys as sensitive even when no URI is configured', () => {
  let output = '';
  const logger = createLogger({ LOG_LEVEL: 'info' }, { write(chunk) { output += chunk; } });
  logger.info({ event: 'mongo_key_test', MONGODB_URI: uri, nested: { mongodbUri: uri, mongoUri: uri } });

  const record = JSON.parse(output);
  assert.equal(record.MONGODB_URI, '[REDACTED]');
  assert.deepEqual(record.nested, { mongodbUri: '[REDACTED]', mongoUri: '[REDACTED]' });
  assert.equal(output.includes('synthetic-password'), false);
});

test('shared lead and chat output redactor removes MongoDB URI recursively without changing source data', () => {
  const redact = outputRedactor({}, { MONGODB_URI: '  ' + uri + '  ' });
  const source = {
    original_message: 'Customer copied ' + uri,
    active_session: { lead: { notes: uri, company_name: 'Synthetic company', phone: null } },
    messages: [{ text: 'Discuss ' + uri }, { text: 'AC maintenance in Dubai' }],
  };
  const before = structuredClone(source);
  const result = redact(source);

  assert.deepEqual(result, {
    original_message: 'Customer copied [REDACTED]',
    active_session: { lead: { notes: '[REDACTED]', company_name: 'Synthetic company', phone: null } },
    messages: [{ text: 'Discuss [REDACTED]' }, { text: 'AC maintenance in Dubai' }],
  });
  assert.deepEqual(source, before);
  assert.equal(JSON.stringify(result).includes('synthetic-password'), false);
});

test('blank MongoDB configuration preserves ordinary lead and chat fields', () => {
  const source = { company_name: 'Synthetic company', notes: 'Customer needs a quote', messages: [{ text: 'Hello' }], phone: null };
  for (const env of [{}, { MONGODB_URI: '' }, { MONGODB_URI: '  ' }]) {
    assert.deepEqual(outputRedactor({}, env)(source), source);
  }
});
