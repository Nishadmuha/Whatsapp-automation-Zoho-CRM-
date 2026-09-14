'use strict';

// Durable inbox IDs prevent replay across processes. This additional, short-lived
// admission list permits automation only for fresh receipts in this server run.
function createIncomingTriggerGate({ now = Date.now, maxAgeMs = 300000, logger } = {}) {
  const startedAt = Math.floor(now() / 1000) * 1000;
  const entries = new Map();
  let stopped = false;
  function log(id, reason) {
    try {
      logger?.info?.({ event: 'whatsapp_trigger_ignored', message_id: id, reason },
        '[WEBHOOK] Ignored inactive or expired message trigger');
    } catch { /* Logging cannot authorize processing. */ }
  }
  function reason(timestamp) {
    if (stopped) return 'stopped';
    if (typeof timestamp !== 'string' || !/^\d{1,11}$/.test(timestamp)) return 'invalid';
    const time = Number(timestamp) * 1000;
    const current = now();
    if (time <= 0) return 'invalid';
    if (time > Math.floor(current / 1000) * 1000) return 'future';
    if (time < startedAt || current - time >= maxAgeMs) return 'historical';
    return null;
  }
  function prune() {
    for (const [id, entry] of entries) {
      if (now() - entry.time >= maxAgeMs) {
        if (!entry.done) log(id, 'expired');
        entries.delete(id);
      }
    }
  }
  function allows(id) {
    prune();
    return !stopped && entries.has(id) && !entries.get(id).done;
  }
  return {
    reason,
    admit(id, timestamp) {
      prune();
      if (reason(timestamp) || entries.has(id)) return false;
      entries.set(id, { time: Number(timestamp) * 1000, started: false, done: false });
      return true;
    },
    allows,
    beginProcessing(id) {
      if (!allows(id) || entries.get(id).started) return false;
      entries.get(id).started = true;
      return true;
    },
    messageIds() {
      prune();
      return stopped ? [] : [...entries].filter(([, entry]) => !entry.done).slice(0, 1000).map(([id]) => id);
    },
    finish(id) {
      if (entries.has(id)) entries.get(id).done = true;
    },
    close() { stopped = true; entries.clear(); },
  };
}

module.exports = { createIncomingTriggerGate };
