'use strict';
// Never discover operational scripts or inherit production credentials in tests.
const { readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cwd = path.resolve(__dirname, '..');
const env = { ...process.env, NODE_ENV: 'test' };
env.NODE_OPTIONS = `--require="${path.join(__dirname, 'test-isolation.js').replaceAll('\\', '/')}"`;
for (const name of Object.keys(env)) {
  if (/^(ZOHO_|WHATSAPP_|OPENAI_|AI_|MONGODB_|MONGO_URI|DATABASE_URL|META_|PHONE_NUMBER_ID|AUTHORIZED_|BOOKS_WORKER_|BOSS_)/.test(name)) delete env[name];
}
const files = readdirSync(path.join(cwd, 'test')).filter(name => name.endsWith('.test.js')).map(name => path.join('test', name));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', '--test-timeout=300000', ...files], { cwd, env, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
