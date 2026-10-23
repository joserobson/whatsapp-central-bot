import { buildDeliveries, agentRowId, contactUrl, messageRef } from './message.js';

export function createWorker({ state, config, baseUrl, apiKey, imageStore, logger = console, send = fetch, now = Date.now }) {
  let running = false;
  const counters = new Map();
  function count(instance, field) {
    const item = counters.get(instance) ?? { received: 0, sent: 0, failed: 0, ignored: 0 };
    item[field]++;
    counters.set(instance, item);
  }
  async function tick() {
    if (running || !config.active) return;
    running = true;
    try {
      const event = state.claim(now(), instance => ((config.company(instance)?.cooldownHours ?? config.active.defaultCooldownHours) * 3_600_000));
      if (!event) return;
      if (event.skipped) { count(event.instance, 'ignored'); logger.info({ event: 'cooldown_active', instance: event.instance, messageRef: messageRef(event.message_id) }); return; }
      const company = config.company(event.instance);
      if (!company) {
        state.ambiguous(event, now());
        logger.warn({ event: 'instance_unknown', instance: event.instance, messageRef: messageRef(event.message_id) });
        return;
      }
      try {
        const agent = event.selection_id && company.messageFormat === 'list' && company.agents.find(item => agentRowId(item) === event.selection_id);
        if (event.selection_id && !agent && !event.delivery_plan) {
          state.discard(event, now());
          logger.warn({ event: 'reply_skipped', reason: 'invalid_list_selection', instance: event.instance, messageRef: messageRef(event.message_id) });
          return;
        }
        const uploadedImage = !event.delivery_plan && company.messageFormat === 'image' && company.imageId ? await imageStore?.load(company.imageId) : undefined;
        const deliveries = event.delivery_plan ? JSON.parse(event.delivery_plan) : agent ? [{ endpoint: 'sendText', body: { text: `${agent.label}\n☎️ ${contactUrl(company, agent)}` } }] : buildDeliveries(company, uploadedImage);
        const multipart = Boolean(event.delivery_plan) || deliveries.length > 1;
        if (multipart && !event.delivery_plan) state.plan(event, deliveries);
        for (let step = event.delivery_step ?? 0; step < deliveries.length; step++) {
          const delivery = deliveries[step];
          logger.info({ event: 'reply_attempt', instance: event.instance, messageRef: messageRef(event.message_id), attempt: event.attempts, step: step + 1, endpoint: delivery.endpoint });
          const response = await send(`${baseUrl.replace(/\/$/, '')}/message/${delivery.endpoint}/${encodeURIComponent(event.instance)}`, {
            method: 'POST',
            headers: { apikey: company.evolutionToken || apiKey, 'content-type': 'application/json' },
            body: JSON.stringify({ number: event.contact, ...delivery.body }),
            signal: AbortSignal.timeout(10_000)
          });
          if (!response.ok) {
            // 5xx/timeouts can represent an accepted send. Stop automatic retries.
            if (response.status >= 500) { state.ambiguous(event, now()); logger.error({ event: 'reply_failed', instance: event.instance, messageRef: messageRef(event.message_id), reason: 'delivery_uncertain', httpStatus: response.status, attempt: event.attempts, step: step + 1 }); return; }
            throw Object.assign(new Error('evolution_http_error'), { httpStatus: response.status });
          }
          if (multipart) state.advance(event, step + 1, now());
        }
        state.sent(event, now());
        count(event.instance, 'sent');
        logger.info({ event: 'reply_sent', instance: event.instance, messageRef: messageRef(event.message_id) });
      } catch (error) {
        if (error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError) {
          state.ambiguous(event, now());
          logger.error({ event: 'reply_failed', instance: event.instance, messageRef: messageRef(event.message_id), reason: 'delivery_uncertain', attempt: event.attempts, ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}) });
        } else {
          const reason = error.httpStatus ? `http_${error.httpStatus}` : 'delivery_error';
          state.failed(event, reason, now());
          count(event.instance, 'failed');
          const retryScheduled = event.attempts < 3;
          logger.error({ event: 'reply_failed', instance: event.instance, messageRef: messageRef(event.message_id), reason, attempt: event.attempts, retryScheduled, ...(retryScheduled ? { retryInMs: Math.min(60_000, 2 ** event.attempts * 1000) } : {}), ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}) });
        }
      }
    } finally { running = false; }
  }
  return { tick, count, snapshot() { return Object.fromEntries(counters); } };
}
