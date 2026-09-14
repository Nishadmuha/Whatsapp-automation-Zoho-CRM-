'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) check(filename);
    else if (entry.name.endsWith('.js')) execFileSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
  }
}
for (const directory of ['src', 'test', 'scripts']) check(path.resolve(__dirname, '..', directory));
console.log('JavaScript syntax checks passed.');
