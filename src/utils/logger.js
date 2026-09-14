'use strict';
const pino = require('pino');
const { normalizeSenderPhone } = require('./phone');

function createLogger(env = process.env, destination) {
  const secrets = Object.entries(env)
    .filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|MONGODB_URI/.test(key) && typeof value === 'string' && value)
    .map(([, value]) => value);
  for (const key of ['AUTHORIZED_BOSS_PHONES', 'BOSS_SENDER_PHONES']) {
    for (const value of (env[key] || '').split(',').map(item => item.trim()).filter(Boolean)) {
      const normalized = normalizeSenderPhone(value);
      secrets.push(value);
      if (normalized) {
        secrets.push(normalized, normalized.slice(1));
        if (normalized.startsWith('+971')) secrets.push('0' + normalized.slice(4));
      }
    }
  }
  function sanitize(value, depth = 0) {
    if (depth > 8) return '[OMITTED]';
    if (value instanceof Error) return { code: 'INTERNAL_ERROR' };
    if (typeof value === 'string') {
      for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, val]) => [key,
        /authorization|cookie|token|secret|api.?key|password|mongo(?:db)?.?uri|message_text|original_message|transcription|extracted_text|rawBody|boss.*phones/i.test(key) ? '[REDACTED]' : sanitize(val, depth + 1)]));
    }
    return value;
  }
  return pino({
    level: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(env.LOG_LEVEL) ? env.LOG_LEVEL : 'info',
    base: { service: 'whatsapp-lead-automation' },
    hooks: { logMethod(args, method) { method.apply(this, args.map((arg) => sanitize(arg))); } },
  }, destination);
}

function maskPhone(phone) {
  return typeof phone === 'string' ? `***${phone.slice(-4)}` : 'unknown';
}

module.exports = { createLogger, maskPhone };
