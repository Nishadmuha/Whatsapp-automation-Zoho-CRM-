'use strict';
function createWorker({ store, processor, config, logger, processInbox = true, inboxClaimOptions = {}, triggerGate }) {
  let timer;
  let running;
  let stopped = true;
  async function tick() {
    if (stopped || running) return;
    running = (async () => {
      try {
        if (processInbox) {
          const job = await store.claimNext({ ...inboxClaimOptions, leaseMs: config.leaseMs,
            maxAttempts: triggerGate ? 1 : config.maxAttempts,
            ...(triggerGate ? { messageIds: triggerGate.messageIds() } : {}) });
          if (job) await processor.processIncomingWhatsAppMessage(job);
        }
        // Drain bounded replies each tick so confirmations don't wait behind a large inbox.
        for (let i = 0; i < 10 && !stopped; i++) {
          if (!(await processor.processNextReply())) break;
        }
      } catch {
        logger.error({ event: 'worker_tick_failed' });
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
    triggerGate?.close();
    clearInterval(timer);
    await running;
  }
  return { start, stop };
}
module.exports = { createWorker };
