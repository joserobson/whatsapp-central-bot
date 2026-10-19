import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { normalizeWebhook } from './message.js';
import { registerAdmin } from './admin/routes.js';

function authorized(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ state, config, worker, webhookSecret, logger = false, admin }) {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });
  if (admin?.enabled) registerAdmin(app, config, admin);
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!config.active || !state.healthy()) return reply.code(503).send({ status: 'unavailable' });
    return { status: 'ok', configVersion: config.version };
  });
  app.get('/metrics', async () => worker.snapshot());
  app.post('/webhooks/evolution', async (request, reply) => {
    if (!authorized(request.headers['x-webhook-secret'], webhookSecret)) return reply.code(401).send({ error: 'unauthorized' });
    if (!config.active) return reply.code(503).send({ error: 'configuration_unavailable' });
    const event = normalizeWebhook(request.body);
    if (!event) return reply.code(204).send();
    const company = config.company(event.instance);
    if (!company) return reply.code(204).send();
    if (company.ignoredContacts?.includes(event.contact)) { worker.count(event.instance, 'ignored'); return reply.code(204).send(); }
    worker.count(event.instance, 'received');
    if (!state.enqueue(event)) return reply.code(200).send({ status: 'duplicate' });
    return reply.code(202).send({ status: 'queued' });
  });
  return app;
}
