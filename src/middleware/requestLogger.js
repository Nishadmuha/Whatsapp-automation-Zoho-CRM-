'use strict';
const { randomUUID } = require('node:crypto');

function requestLogger(logger) {
  return (req, res, next) => {
    const started = Date.now();
    req.requestId = randomUUID();
    res.set('X-Request-ID', req.requestId);
    res.once('finish', () => logger.info({
      event: 'http_request', request_id: req.requestId,
      method: req.method, route: req.route?.path || 'unmatched',
      status: res.statusCode, duration_ms: Date.now() - started,
    }));
    // Never log URLs/query strings: Meta puts the verification token in its query.
    next();
  };
}
module.exports = { requestLogger };
