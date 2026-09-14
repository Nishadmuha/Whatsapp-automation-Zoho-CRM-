'use strict';

require('dotenv').config({ quiet: true });
const { createMessageStore } = require('../src/database');
const { disconnectMongoDB } = require('../src/config/db');

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    process.stderr.write('Set MONGODB_URI in .env to run database initialization.\n');
    process.exitCode = 1;
    return;
  }
  const store = createMessageStore({ mongoUri });
  try {
    await store.init();
    process.stdout.write('MongoDB Atlas indexes and collections initialized successfully.\n');
  } finally {
    await store.close();
    await disconnectMongoDB();
  }
}

main().catch((err) => {
  process.stderr.write('MongoDB initialization failed: ' + (err.message || 'Check MONGODB_URI and connectivity.') + '\n');
  process.exitCode = 1;
});
