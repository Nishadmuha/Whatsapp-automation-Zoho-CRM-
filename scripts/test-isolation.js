'use strict';
// Preloaded only by the test runner, also in its child processes.
require('dotenv').config = () => ({ parsed: {} });
const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options?.host : typeof args[1] === 'string' ? args[1] : undefined;
  if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('External network access is disabled in tests. Inject a mock transport.');
  return original.apply(this, args);
};
