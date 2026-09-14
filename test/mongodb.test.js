'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { test } = require('node:test');

const databaseModule = require.resolve('../src/config/db');
const testUri = 'mongodb+srv://test-user:synthetic-mongo-password@cluster.example.invalid/voltronix';
const privateDetail = 'synthetic-private-driver-detail';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function isolatedDatabase({ connect, disconnect } = {}) {
  const connection = new EventEmitter();
  connection.readyState = 0;
  const calls = { connect: [], disconnect: 0, logs: [] };
  const mongoose = {
    connection,
    async connect(...args) {
      calls.connect.push(args);
      connection.readyState = 2;
      try {
        if (connect) await connect(...args);
        connection.readyState = 1;
        connection.emit('connected');
        return mongoose;
      } catch (error) {
        connection.readyState = 0;
        throw error;
      }
    },
    async disconnect() {
      calls.disconnect++;
      connection.readyState = 3;
      if (disconnect) await disconnect();
      connection.readyState = 0;
      connection.emit('disconnected');
    },
    model() { assert.fail('Atlas connection must not create a model.'); },
    Schema() { assert.fail('Atlas connection must not create a schema.'); },
  };
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level,
    (...args) => calls.logs.push({ level, args })]));
  const originalLoad = Module._load;
  delete require.cache[databaseModule];
  let database;
  try {
    Module._load = function (request) {
      if (request === 'mongoose') return mongoose;
      return originalLoad.apply(this, arguments);
    };
    database = require(databaseModule);
  } finally {
    Module._load = originalLoad;
    delete require.cache[databaseModule];
  }
  return { ...database, connection, calls, logger };
}

function assertSanitized(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [testUri, 'synthetic-mongo-password', privateDetail]) {
    assert.equal(text.includes(secret), false, 'MongoDB diagnostics must not expose credentials or driver details.');
  }
}

test('MongoDB is optional until MONGODB_URI is supplied and never connects for blank configuration', async () => {
  const database = isolatedDatabase();
  for (const env of [{}, { MONGODB_URI: '' }, { MONGODB_URI: ' \t\n ' }]) {
    assert.equal(await database.connectMongoDB({ env, logger: database.logger }), null);
  }
  assert.equal(database.calls.connect.length, 0);
  assert.ok(database.calls.logs.some(log => log.level === 'warn'
    && JSON.stringify(log.args).includes('MongoDB not configured. Set MONGODB_URI in .env to enable Atlas.')));
  await database.disconnectMongoDB();
});

test('invalid MongoDB configuration fails safely before invoking the driver', async () => {
  for (const value of ['https://synthetic-mongo-password.example.invalid', '<your MongoDB Atlas connection string>']) {
    const database = isolatedDatabase();
    await assert.rejects(database.connectMongoDB({ env: { MONGODB_URI: value }, logger: database.logger }), error => {
      assert.equal(error.code, 'MONGODB_CONFIGURATION_ERROR');
      assert.equal(error.cause, undefined);
      assertSanitized(error.stack);
      return true;
    });
    assert.equal(database.calls.connect.length, 0);
    assertSanitized(database.calls.logs);
  }
});

test('MongoDB startup waits for the driver, coalesces concurrent requests, and reuses the same connection', async () => {
  const gate = deferred();
  const database = isolatedDatabase({ connect: () => gate.promise });
  const options = { env: { MONGODB_URI: testUri }, logger: database.logger };
  const first = database.connectMongoDB(options);
  const second = database.connectMongoDB(options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(database.calls.connect.length, 1);
  assert.equal(database.calls.logs.some(log => JSON.stringify(log).includes('MongoDB connected successfully')), false);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [database.connection, database.connection]);
  assert.equal(await database.connectMongoDB(options), database.connection);
  assert.equal(database.calls.connect.length, 1);
  const [uri, settings] = database.calls.connect[0];
  assert.equal(uri, testUri);
  assert.ok(settings.serverSelectionTimeoutMS > 0 && settings.serverSelectionTimeoutMS <= 30_000);
  assert.ok(settings.connectTimeoutMS > 0 && settings.connectTimeoutMS <= 10_000);
  assert.equal(settings.autoCreate, false);
  assert.equal(settings.autoIndex, false);
  assert.equal(settings.bufferCommands, false);
  assert.ok(database.calls.logs.some(log => log.level === 'info'
    && JSON.stringify(log.args).includes('MongoDB connected successfully')));
  assertSanitized(database.calls.logs);
  await database.disconnectMongoDB();
});

test('an active MongoDB connection refuses a different URI without opening another connection', async () => {
  const database = isolatedDatabase();
  await database.connectMongoDB({ env: { MONGODB_URI: testUri }, logger: database.logger });
  await assert.rejects(database.connectMongoDB({
    env: { MONGODB_URI: testUri.replace('/voltronix', '/another-database') }, logger: database.logger,
  }), error => {
    assertSanitized(error.stack);
    return true;
  });
  assert.equal(database.calls.connect.length, 1);
  await database.disconnectMongoDB();
});

test('MongoDB driver failures and lifecycle events cannot leak a URI or provider error', async () => {
  let fail = true;
  const database = isolatedDatabase({ connect: () => {
    if (fail) throw Object.assign(new Error(privateDetail + ' ' + testUri), { reason: { uri: testUri } });
  } });
  const options = { env: { MONGODB_URI: testUri }, logger: database.logger };
  await assert.rejects(database.connectMongoDB(options), error => {
    assert.equal(error.code, 'MONGODB_CONNECTION_FAILED');
    assert.equal(error.cause, undefined);
    assert.equal(error.reason, undefined);
    assertSanitized(error.stack);
    return true;
  });
  fail = false;
  assert.equal(await database.connectMongoDB(options), database.connection);
  assert.doesNotThrow(() => database.connection.emit('error', new Error(privateDetail + ' ' + testUri)));
  database.connection.emit('disconnected');
  assert.ok(database.calls.logs.some(log => log.level === 'error'));
  assert.ok(database.calls.logs.some(log => log.level === 'warn'));
  assertSanitized(database.calls.logs);
  await database.disconnectMongoDB();
});

test('MongoDB shutdown waits for a pending connect and deduplicates simultaneous disconnects', async () => {
  const connectGate = deferred();
  const disconnectGate = deferred();
  const database = isolatedDatabase({ connect: () => connectGate.promise, disconnect: () => disconnectGate.promise });
  const connecting = database.connectMongoDB({ env: { MONGODB_URI: testUri }, logger: database.logger });
  const closing = database.disconnectMongoDB();
  const secondClose = database.disconnectMongoDB();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(database.calls.disconnect, 0);
  connectGate.resolve();
  await connecting;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(database.calls.disconnect, 1);
  disconnectGate.resolve();
  await Promise.all([closing, secondClose]);
  assert.equal(database.connection.readyState, 0);
  assert.equal(database.calls.disconnect, 1);
  assertSanitized(database.calls.logs);
});
