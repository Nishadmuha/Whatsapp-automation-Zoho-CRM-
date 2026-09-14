'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const { createMessageStore } = require('../src/database');
const { createMessagesAdmin, MessagesAdminError } = require('../src/services/admin/messagesAdmin');

const USAGE = [
  'npm run messages -- list [limit: 1-100]',
  'npm run messages -- show MESSAGE_ID',
  'npm run messages -- retry MESSAGE_ID',
  'show includes private message text and lead data; keep its output local and protected.',
  'retry only requeues a safely failed message. It never calls Meta, AI, or Zoho directly.',
  'retry archives a replaceable prior failure reply in the audit and permits a fresh result confirmation.',
  'SENDING/UNKNOWN replies and possible/confirmed CRM writes require manual reconciliation.',
];

function jsonOutput(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
}

async function run(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, createStore = createMessageStore } = {}) {
  let store;
  try {
    const [command, value, ...extra] = argv;
    if (!command || ['help', '--help', '-h'].includes(command)) {
      stdout.write(jsonOutput({ usage: USAGE }));
      return 0;
    }
    if (!['list', 'show', 'retry'].includes(command) || extra.length ||
        (command !== 'list' && !value) || (command === 'list' && value !== undefined && !/^\d{1,3}$/.test(value))) {
      throw new MessagesAdminError('ADMIN_INPUT', 'Use list [limit], show MESSAGE_ID, or retry MESSAGE_ID.');
    }
    const limit = value === undefined ? 20 : Number(value);
    if (command === 'list' && (limit < 1 || limit > 100)) {
      throw new MessagesAdminError('ADMIN_INPUT', 'The list limit must be an integer from 1 to 100.');
    }
    const databaseUrl = env.DATABASE_URL?.trim() || 'file:./data/messages.sqlite';
    if (env.NODE_ENV === 'production' && !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
      throw new MessagesAdminError('ADMIN_CONFIG', 'Production message administration requires a PostgreSQL DATABASE_URL.');
    }
    if (env.NODE_ENV === 'production' && env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
      throw new MessagesAdminError('ADMIN_CONFIG', 'TLS certificate verification must be enabled in production.');
    }
    const senders = (env.ALLOWED_SENDER_PHONES || '').split(',').map((sender) => sender.trim()).filter(Boolean);
    if (senders.some((sender) => !/^\+?[1-9]\d{6,14}$/.test(sender))) {
      throw new MessagesAdminError('ADMIN_CONFIG', 'ALLOWED_SENDER_PHONES must contain international phone numbers.');
    }
    const config = { allowedSenders: new Set(senders.map((sender) => `+${sender.replace(/^\+/, '')}`)) };
    store = createStore({ databaseUrl, logger: { error() {} } });
    await store.init();
    const admin = createMessagesAdmin({ store, config });
    const result = command === 'list' ? await admin.listMessages(limit)
      : command === 'show' ? await admin.showMessage(value) : await admin.retryMessage(value);
    stdout.write(jsonOutput(result));
    return 0;
  } catch (error) {
    const safe = error instanceof MessagesAdminError
      ? { code: error.code, message: error.message }
      : { code: 'ADMIN_DATABASE', message: 'Message administration failed. Check database availability and configuration.' };
    stderr.write(jsonOutput({ error: safe }));
    return 1;
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

if (require.main === module) {
  // No credential-bearing environment contents or dotenv diagnostics are printed.
  const loaded = dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true, debug: false });
  if (loaded.error && loaded.error.code !== 'ENOENT') {
    process.stderr.write(jsonOutput({ error: { code: 'ADMIN_CONFIG', message: 'Unable to read local environment configuration.' } }));
    process.exitCode = 1;
  } else {
    run(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
      process.stderr.write(jsonOutput({ error: { code: 'ADMIN_DATABASE', message: 'Message administration failed.' } }));
      process.exitCode = 1;
    });
  }
}

module.exports = { run, jsonOutput };
