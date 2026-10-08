'use strict';

// Parallel bill validation and contact pages share a small per-organization
// budget. This leaves capacity for writes and avoids multiplying concurrency
// as several bill workers run. It never retries or reorders a workflow's writes.
function limitOrganizationRequests(transport) {
  const organizations = new Map();
  const maximum = 5;
  async function run(options, request) {
    const organizationId = options?.params?.organization_id;
    // OAuth refresh is not an organization API call and must remain available
    // while other requests hold slots.
    if (!organizationId) return request();
    const key = String(organizationId);
    let state = organizations.get(key);
    if (!state) {
      state = { active: 0, waiting: [] };
      organizations.set(key, state);
    }
    if (state.active >= maximum) await new Promise(resolve => state.waiting.push(resolve));
    else state.active++;
    try {
      return await request();
    } finally {
      // Hand the occupied slot directly to the next waiter so a new request
      // cannot jump ahead or take that same slot before the waiter resumes.
      if (state.waiting.length) state.waiting.shift()();
      else if (--state.active === 0) organizations.delete(key);
    }
  }
  return {
    get: (url, options) => run(options, () => transport.get(url, options)),
    post: (url, body, options) => run(options, () => transport.post(url, body, options)),
    put: (url, body, options) => run(options, () => transport.put(url, body, options)),
  };
}

module.exports = { limitOrganizationRequests };
