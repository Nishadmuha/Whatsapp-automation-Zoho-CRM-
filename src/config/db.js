'use strict';

const mongoose = require('mongoose');

let currentUri;
let pendingConnection;
let pendingDisconnect;
let currentLogger;

function log(level, event, message) {
  // Driver errors can contain credentials or hostnames. Log fixed messages only.
  try { currentLogger?.[level]?.({ event }, message); } catch { /* Connection state is authoritative. */ }
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

mongoose.connection.on('error', () => {
  log('error', 'mongodb_connection_error', 'MongoDB connection error. Check Atlas connectivity and configuration.');
});
mongoose.connection.on('disconnected', () => {
  if (!pendingDisconnect) log('warn', 'mongodb_disconnected', 'MongoDB disconnected.');
});

async function connectMongoDB({ env = process.env, logger } = {}) {
  currentLogger = logger || currentLogger;
  const value = env.MONGODB_URI;
  if (value !== undefined && typeof value !== 'string') {
    throw failure('MONGODB_CONFIGURATION_ERROR', 'Set MONGODB_URI to a valid MongoDB connection string in .env.');
  }
  const uri = (value || '').trim();
  if (!uri) {
    log('warn', 'mongodb_not_configured', 'MongoDB not configured. Set MONGODB_URI in .env to enable Atlas.');
    return null;
  }
  if (!/^mongodb(?:\+srv)?:\/\/\S+$/.test(uri) || /[<>\u0000-\u0020\u007f]/.test(uri)) {
    throw failure('MONGODB_CONFIGURATION_ERROR', 'Set MONGODB_URI to a valid MongoDB connection string in .env.');
  }
  if (pendingDisconnect) await pendingDisconnect;
  if (currentUri && currentUri !== uri) {
    throw failure('MONGODB_CONFIGURATION_ERROR', 'MongoDB is already initialized. Restart the backend to change MONGODB_URI.');
  }
  if (pendingConnection) return pendingConnection;
  if (currentUri) {
    if (mongoose.connection.readyState === 1) return mongoose.connection;
    // Let the existing driver reconnect rather than creating another client.
    throw failure('MONGODB_CONNECTION_FAILED', 'MongoDB is temporarily disconnected. Check Atlas connectivity.');
  }
  currentUri = uri;
  pendingConnection = Promise.resolve().then(async () => {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 30000,
        connectTimeoutMS: 10000,
        maxPoolSize: 10,
        bufferCommands: false,
        autoCreate: false,
        autoIndex: false,
      });
      log('info', 'mongodb_connected', 'MongoDB connected successfully');
      return mongoose.connection;
    } catch {
      await mongoose.disconnect().catch(() => {});
      currentUri = undefined;
      throw failure('MONGODB_CONNECTION_FAILED', 'MongoDB connection failed. Check MONGODB_URI, Atlas network access and database user credentials.');
    }
  }).finally(() => { pendingConnection = undefined; });
  return pendingConnection;
}

function disconnectMongoDB() {
  if (pendingDisconnect) return pendingDisconnect;
  pendingDisconnect = Promise.resolve().then(async () => {
    if (pendingConnection) await pendingConnection.catch(() => {});
    if (!currentUri) return;
    try {
      await mongoose.disconnect();
      currentUri = undefined;
      log('info', 'mongodb_closed', 'MongoDB connection closed.');
    } catch {
      throw failure('MONGODB_DISCONNECT_FAILED', 'MongoDB connection could not be closed cleanly.');
    }
  }).finally(() => { pendingDisconnect = undefined; });
  return pendingDisconnect;
}

module.exports = { connectMongoDB, disconnectMongoDB };
