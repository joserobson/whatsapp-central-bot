import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { normalizeWebhook, webhookRejectionReason, agentRowId, messageRef } from './message.js';
import { registerAdmin } from './admin/routes.js';

function authorized(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ state, config, worker, webhookSecret, logger = false, admin }) {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });
  if (admin?.enabled) registerAdmin(app, config, { ...admin, state });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!config.active || !state.healthy()) return reply.code(503).send({ status: 'unavailable' });
    return { status: 'ok', configVersion: config.version };
  });
  app.get('/metrics', async () => worker.snapshot());
  app.post('/webhooks/evolution', async (request, reply) => {
    const log = (level, fields) => app.log[level]({ requestId: request.id, ...fields });
    if (!authorized(request.headers['x-webhook-secret'], webhookSecret)) {
      log('warn', { event: 'webhook_rejected', reason: 'unauthorized' });
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!config.active) {
      log('error', { event: 'webhook_rejected', reason: 'configuration_unavailable' });
      return reply.code(503).send({ error: 'configuration_unavailable' });
    }
    const event = normalizeWebhook(request.body);
    if (!event) {
      log('info', { event: 'webhook_ignored', reason: webhookRejectionReason(request.body) });
      return reply.code(204).send();
    }
    const company = config.company(event.instance);
    if (!company) {
      log('warn', { event: 'webhook_ignored', reason: 'unknown_instance', instance: event.instance });
      return reply.code(204).send();
    }
    if (event.selectionId && (company.messageFormat !== 'list' || !company.agents.some(agent => agentRowId(agent) === event.selectionId))) {
      log('info', { event: 'webhook_ignored', reason: 'invalid_list_selection', instance: event.instance });
      return reply.code(204).send();
    }
    if (company.ignoredContacts?.includes(event.contact)) {
      worker.count(event.instance, 'ignored');
      log('info', { event: 'webhook_ignored', reason: 'ignored_contact', instance: event.instance });
      return reply.code(204).send();
    }
    worker.count(event.instance, 'received');
    if (!state.enqueue(event)) {
      log('info', { event: 'webhook_duplicate', instance: event.instance, messageRef: messageRef(event.messageId) });
      return reply.code(200).send({ status: 'duplicate' });
    }
    log('info', { event: 'webhook_queued', instance: event.instance, messageRef: messageRef(event.messageId), selection: Boolean(event.selectionId) });
    return reply.code(202).send({ status: 'queued' });
  });
  return app;
}
