'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');

const run = promisify(execFile);
const sourceDirectory = path.resolve(__dirname, '../src');

// Exercise the real startup orchestration in an isolated process. Every provider,
// database, HTTP listener and worker is synthetic; dotenv never reads local secrets.
const startupScript = `
  const assert = require('node:assert/strict');
  const { EventEmitter, once } = require('node:events');
  const Module = require('node:module');
  const path = require('node:path');
  const root = process.argv[1];
  const scenario = process.argv[2];
  const events = [];
  const logs = [];
  const config = { enabled: true, aiProvider: '', bossSenders: new Set(), appSecret: 'synthetic-test-secret',
    port: 5000, host: '127.0.0.1' };
  let mongoReady = false;
  let fakeServer;
  const store = { async close() {
    events.push('sql_close');
    if (scenario === 'shutdown_sql_failure') throw new Error('synthetic SQL close failure');
  } };
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level,
    (...args) => logs.push({ level, args })]));
  const fixtures = new Map([
    ['app.js', { createApp() {
      events.push('app_created');
      const ready = Promise.resolve().then(() => {
        events.push('sql_ready');
        if (scenario === 'sql_failure') throw new Error('synthetic SQL initialization failure');
      });
      return { locals: { store, ready }, listen() {
        assert.equal(mongoReady, true, 'HTTP must not listen until MongoDB has connected.');
        events.push('listen_called');
        if (scenario === 'listen_throw') throw new Error('synthetic synchronous HTTP failure');
        fakeServer = new EventEmitter();
        fakeServer.close = (callback) => { events.push('http_close'); callback(); };
        fakeServer.closeAllConnections = () => events.push('http_close_all');
        setImmediate(() => {
          if (scenario === 'listen_error') fakeServer.emit('error', Object.assign(new Error('synthetic occupied port'), { code: 'EADDRINUSE' }));
          else { events.push('http_listening'); fakeServer.emit('listening'); }
        });
        return fakeServer;
      } };
    } }],
    ['config/env.js', { readConfig() { return config; } }],
    ['config/db.js', {
      async connectMongoDB() {
        assert.ok(events.includes('sql_ready'), 'Existing SQL storage must initialize first.');
        events.push('mongo_connect');
        await new Promise(resolve => setImmediate(resolve));
        if (scenario === 'mongo_failure') throw Object.assign(new Error('MongoDB connection failed. Check MONGODB_URI.'), {
          code: 'MONGODB_CONNECTION_FAILED',
        });
        mongoReady = true;
        events.push('mongo_ready');
      },
      async disconnectMongoDB() { events.push('mongo_close'); mongoReady = false; },
    }],
    ['utils/logger.js', { createLogger() { return logger; } }],
    ['services/whatsapp/whatsappService.js', { createWhatsAppService() {
      assert.equal(mongoReady, true, 'Automation factories must wait for MongoDB.');
      events.push('whatsapp_created');
      if (scenario === 'factory_failure') throw new Error('synthetic automation factory failure');
      return {};
    } }],
    ['services/whatsapp/autoReply.js', { createAutoReplyProcessor() { return {}; } }],
    ['worker.js', { createWorker() {
      events.push('worker_created');
      return {
        start() {
          assert.equal(mongoReady, true);
          assert.ok(events.includes('http_listening'), 'Workers must start only after HTTP is listening.');
          events.push('worker_start');
        },
        async stop() { events.push('worker_stop'); },
      };
    } }],
  ].map(([file, fixture]) => [path.join(root, file), fixture]));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'dotenv') return { config() { return {}; } };
    if (request === 'mongoose' || request === 'pg') throw new Error('A startup test attempted a real database import.');
    const filename = Module._resolveFilename(request, parent, isMain);
    if (fixtures.has(filename)) return fixtures.get(filename);
    return originalLoad.apply(this, arguments);
  };
  (async () => {
    assert.equal(process.env.MONGODB_URI, '');
    const initialSignals = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    const { startServer } = require(path.join(root, 'server.js'));
    if (['sql_failure', 'mongo_failure', 'factory_failure', 'listen_throw'].includes(scenario)) {
      await assert.rejects(startServer());
      assert.ok(events.includes('sql_close'), 'Failed startup must close the SQL store.');
      if (scenario !== 'sql_failure') assert.ok(events.includes('mongo_close'), 'Failed startup must also close MongoDB.');
      assert.equal(events.includes('worker_start'), false);
      if (scenario !== 'listen_throw') assert.equal(events.includes('listen_called'), false);
      if (scenario === 'sql_failure') assert.equal(events.includes('mongo_connect'), false);
      if (scenario === 'mongo_failure') assert.equal(events.includes('whatsapp_created'), false);
    } else {
      const server = await startServer();
      if (scenario === 'listen_error') {
        await once(server, 'error');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(process.exitCode, 1);
        process.exitCode = 0;
        assert.equal(events.includes('worker_start'), false);
        assert.equal(logs.some(log => JSON.stringify(log).includes('server_listening')), false);
      } else {
        await once(server, 'listening');
        assert.equal(events.filter(event => event === 'worker_start').length, 1);
        assert.ok(logs.some(log => JSON.stringify(log).includes('Server running on port 5000')));
        await server.shutdown().catch(() => {});
        await server.shutdown().catch(() => {});
        assert.ok(events.includes('http_close'));
        if (scenario === 'shutdown_sql_failure') {
          assert.equal(process.exitCode, 1);
          assert.ok(logs.some(log => JSON.stringify(log).includes('shutdown_cleanup_failed')));
          process.exitCode = 0;
        }
      }
      assert.equal(events.filter(event => event === 'sql_close').length, 1);
      assert.equal(events.filter(event => event === 'mongo_close').length, 1);
      assert.ok(events.includes('worker_stop'));
    }
    for (const [signal, count] of Object.entries(initialSignals)) {
      assert.equal(process.listenerCount(signal), count, 'Startup cleanup must remove its signal handlers.');
    }
    console.log('mongo-startup-test-passed');
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
`;

for (const [scenario, description] of [
  ['success', 'MongoDB connects before HTTP and workers start; shutdown closes both databases once'],
  ['mongo_failure', 'MongoDB startup failure closes SQL and prevents HTTP and automation initialization'],
  ['sql_failure', 'SQL startup failure prevents MongoDB connection and runs database cleanup'],
  ['factory_failure', 'automation factory failure after MongoDB connects closes both databases'],
  ['listen_throw', 'a synchronous HTTP startup failure closes both databases'],
  ['listen_error', 'an asynchronous HTTP listen error closes both databases without starting workers'],
  ['shutdown_sql_failure', 'MongoDB is still closed and signals removed when SQL shutdown fails'],
]) {
  test(description, async () => {
    const result = await run(process.execPath, ['-e', startupScript, sourceDirectory, scenario], {
      env: { ...process.env, NODE_ENV: 'test', MONGODB_URI: '' }, timeout: 10_000,
    });
    assert.match(result.stdout, /mongo-startup-test-passed/);
    assert.doesNotMatch(result.stdout + result.stderr, /attempted a real database import/);
  });
}
