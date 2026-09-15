'use strict';
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { after } = require('node:test');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
process.env.NODE_ENV = 'test';
const { createMessageStore } = require('../src/database');

if (typeof after === 'function') {
  try {
    after(async () => {
      await mongoose.disconnect().catch(() => {});
    });
  } catch (_err) {
    // ignore
  }
}

const silent = { info() {}, warn() {}, error() {} };

async function temporaryStore(t) {
  const testDbName = 'test_' + randomBytes(8).toString('hex');
  const store = createMessageStore({
    mongoUri: process.env.MONGODB_URI,
    databaseName: testDbName,
    logger: silent
  });
  await store.init();
  t.after(async () => {
    try {
      if (store.db) {
        await store.db.dropDatabase();
      }
    } catch (_err) {
      // ignore cleanup errors in test teardown
    }
    await store.close();
  });
  let dbUri = process.env.MONGODB_URI;
  try {
    const urlObj = new URL(process.env.MONGODB_URI);
    urlObj.pathname = '/' + testDbName;
    dbUri = urlObj.toString();
  } catch {
    // fallback if not a standard URL
  }
  return { store, databaseUrl: dbUri };
}

function testEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    AUTOMATION_ENABLED: 'false',
    WEBHOOK_VERIFY_TOKEN: randomBytes(32).toString('hex'),
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/test',
    ...overrides,
  };
}

function incoming(overrides = {}) {
  return {
    whatsapp_message_id: 'wamid.test-' + randomBytes(8).toString('hex'),
    sender_phone: '+971551234567',
    message_type: 'text',
    authenticated: true,
    message_text: 'Ahmed from ABC Contracting, 0501234567, needs AC maintenance in Dubai.',
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

function lead(overrides = {}) {
  return {
    name: 'Ahmed',
    phone: '+971501234567',
    email: null,
    company: 'ABC Contracting',
    service: 'AC maintenance',
    location: 'Dubai',
    requirement: 'AC maintenance',
    notes: null,
    ...overrides
  };
}

module.exports = { temporaryStore, testEnv, incoming, lead, silent };
