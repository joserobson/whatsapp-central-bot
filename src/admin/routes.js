import { readFile } from 'node:fs/promises';
import { equal, token, validHash, verifyPassword } from './auth.js';
import { configError, editedCompany } from '../config.js';
import { buildReply } from '../message.js';

export function registerAdmin(app, config, options) {
  const { username, passwordHash, origin, now = Date.now, secure = true } = options;
  if (!username || username.length > 100 || !validHash(passwordHash) || !origin) throw new Error('Configuracao administrativa invalida');
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.origin !== origin || !['http:', 'https:'].includes(parsedOrigin.protocol) || (secure && parsedOrigin.protocol !== 'https:')) throw new Error('ADMIN_ORIGIN invalida');
  if (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(parsedOrigin.hostname)) throw new Error('HTTP administrativo permitido apenas em loopback');
  const sessions = new Map();
  const attempts = new Map();
  const cookieName = 'admin_session';
  const cookie = (value, age) => `${cookieName}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const cleanup = () => {
    for (const [key, value] of sessions) if (value.expires <= now()) sessions.delete(key);
    for (const [key, value] of attempts) if (value.expires <= now()) attempts.delete(key);
  };
  const timer = setInterval(cleanup, 60_000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); sessions.clear(); attempts.clear(); });
  app.register(async admin => {
    admin.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
      reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if (!request.url.startsWith('/admin/api/')) return;
      const mutating = !['GET', 'HEAD'].includes(request.method);
      if (mutating && (request.headers.origin !== origin || !request.headers['content-type']?.startsWith('application/json'))) return reply.code(403).send({ error: 'invalid_origin_or_content_type' });
      if (request.url === '/admin/api/login' && request.method === 'POST') return;
      const match = /(?:^|;\s*)admin_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '');
      const session = match && sessions.get(match[1]);
      if (!session || session.expires <= now()) {
        if (match) sessions.delete(match[1]);
        return reply.code(401).send({ error: 'unauthorized' });
      }
      request.adminSession = { ...session, id: match[1] };
      if (mutating && !equal(request.headers['x-csrf-token'], session.csrf)) return reply.code(403).send({ error: 'invalid_csrf' });
    });
    admin.setErrorHandler((error, _request, reply) => {
      const status = error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503;
      reply.code(status).send({ error: status === 503 ? 'configuration_unavailable' : (error.code ? 'invalid_request' : error.message) });
    });
    const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'application/javascript; charset=utf-8'], '/model.js': ['model.js', 'application/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
    for (const [path, [file, type]] of Object.entries(assets)) {
      admin.get(path, async (_request, reply) => reply.type(type).send(await readFile(new URL(`./public/${file}`, import.meta.url))));
    }
    admin.post('/api/login', async (request, reply) => {
      cleanup();
      const key = request.ip;
      if (!attempts.has(key) && attempts.size >= 10000) return reply.code(429).send({ error: 'try_later' });
      const entry = attempts.get(key) ?? { count: 0, expires: now() + 900_000 };
      if (entry.count >= 5) return reply.header('retry-after', Math.ceil((entry.expires - now()) / 1000)).code(429).send({ error: 'try_later' });
      // Count before the async password check so parallel requests cannot bypass the limit.
      entry.count++;
      attempts.set(key, entry);
      const passwordOK = await verifyPassword(request.body?.password, passwordHash);
      if (!passwordOK || !equal(request.body?.username, username)) return reply.code(401).send({ error: 'invalid_credentials' });
      if (sessions.size >= 100) return reply.code(503).send({ error: 'try_later' });
      const id = token();
      const csrf = token();
      sessions.set(id, { csrf, expires: now() + 8 * 3_600_000 });
      attempts.delete(key);
      return reply.header('set-cookie', cookie(id, 8 * 3600)).send({ csrf });
    });
    admin.get('/api/session', async request => ({ csrf: request.adminSession.csrf }));
    admin.post('/api/logout', async (request, reply) => {
      sessions.delete(request.adminSession.id);
      return reply.header('set-cookie', cookie('', 0)).code(204).send();
    });
    admin.get('/api/companies', async () => {
      if (!config.active) throw configError(503, 'configuration_unavailable');
      return { companies: config.active.companies.map(({ instance, displayName, enabled }) => ({ instance, displayName, enabled })) };
    });
    const getCompany = instance => {
      if (!config.active) throw configError(503, 'configuration_unavailable');
      const company = config.active.companies.find(item => item.instance === instance);
      if (!company) throw configError(404, 'company_not_found');
      return company;
    };
    admin.get('/api/companies/:instance', async (request, reply) => {
      const company = getCompany(request.params.instance);
      const { welcomeText, closingText, prefilledText, agents } = company;
      return reply.header('etag', `"${config.version}"`).send({ fields: { welcomeText, closingText, prefilledText, agents } });
    });
    admin.post('/api/companies/:instance/preview', async request => ({ text: buildReply(editedCompany(getCompany(request.params.instance), request.body)) }));
    admin.put('/api/companies/:instance', async (request, reply) => {
      const expected = request.headers['if-match'];
      if (!expected) throw configError(428, 'version_required');
      const version = await config.update(request.params.instance, request.body, /^"([a-f0-9]{64})"$/.exec(expected)?.[1] ?? 'invalid');
      return reply.header('etag', `"${version}"`).send({ status: 'saved' });
    });
  }, { prefix: '/admin' });
}
