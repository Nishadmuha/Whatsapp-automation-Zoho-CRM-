'use strict';
function errorHandler(logger) {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const known = {
      'entity.parse.failed': [400, 'Invalid JSON payload'],
      'entity.too.large': [413, 'Payload too large'],
      'encoding.unsupported': [415, 'Unsupported request encoding'],
      'charset.unsupported': [415, 'Unsupported request encoding'],
      'request.aborted': [400, 'Invalid request body'],
      'request.size.invalid': [400, 'Invalid request body'],
    };
    const [status, message] = known[error.type] || [500, 'Internal server error'];
    if (status === 500) logger.error({ event: 'http_failure', request_id: req.requestId });
    return res.status(status).json({ success: false, message });
  };
}
module.exports = { errorHandler };
