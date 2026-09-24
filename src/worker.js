'use strict';
function createWorker({ store, processor, config, logger, processInbox = true, inboxClaimOptions = {}, triggerGate, concurrency = 1 }) {
  let timer;
  let running;
  let stopped = true;
  const maxConcurrency = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 1;
  const inFlight = new Set();
  function logFailure() {
    try { logger.error({ event: 'worker_tick_failed' }); } catch { /* Worker errors remain isolated. */ }
  }
  function launch(job) {
    let result;
    try { result = processor.processIncomingWhatsAppMessage(job); }
    catch { logFailure(); result = undefined; }
    const task = Promise.resolve(result).catch(logFailure);
    inFlight.add(task);
    task.finally(() => inFlight.delete(task)).catch(() => {});
  }
  async function tick() {
    if (stopped || running) return;
    running = (async () => {
      try {
        if (processInbox) {
          if (maxConcurrency === 1) {
            const job = await store.claimNext({ ...inboxClaimOptions, leaseMs: config.leaseMs,
              maxAttempts: triggerGate ? 1 : config.maxAttempts,
              ...(triggerGate ? { messageIds: triggerGate.messageIds() } : {}) });
            if (job) await processor.processIncomingWhatsAppMessage(job);
          } else while (!stopped && inFlight.size < maxConcurrency) {
            const job = await store.claimNext({ ...inboxClaimOptions, leaseMs: config.leaseMs,
              maxAttempts: triggerGate ? 1 : config.maxAttempts,
              ...(triggerGate ? { messageIds: triggerGate.messageIds() } : {}) });
            if (!job) break;
            launch(job);
          }
        }
        // Drain bounded replies each tick so confirmations don't wait behind a large inbox.
        for (let i = 0; i < 10 && !stopped; i++) {
          if (!(await processor.processNextReply())) break;
        }
      } catch {
        logFailure();
      }
    })();
    await running;
    running = null;
  }
  function start() {
    if (!stopped || !config.enabled) return;
    stopped = false;
    timer = setInterval(() => { void tick(); }, config.pollMs);
    timer.unref();
    void tick();
  }
  async function stop() {
    stopped = true;
    clearInterval(timer);
    await running;
    await Promise.allSettled([...inFlight]);
  }
  return { start, stop };
}
module.exports = { createWorker };
