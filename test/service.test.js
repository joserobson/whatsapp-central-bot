import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfigStore, validateConfig } from '../src/config.js';
import { buildReply, buildDelivery, agentRowId } from '../src/message.js';
import { createState } from '../src/state.js';
import { createWorker } from '../src/worker.js';
import { createApp } from '../src/app.js';
import Database from 'better-sqlite3';
import { createImageStore } from '../src/images.js';

const companies = ['distribuidora-alfa', 'distribuidora-beta', 'gama-alimentos'].map((instance, index) => ({
  instance, enabled: true, displayName: instance, welcomeText: `Olá ${instance}`,
  closingText: 'Escolha um link.', prefilledText: `Vim pelo anúncio ${instance}`,
  agents: [1, 2, 3].map((n) => ({ label: `Atendente ${n}`, phoneE164: `551199999${index}${n}00` }))
}));
const logger = { info() {}, warn() {}, error() {} };
const payload = (instance, id, jid = '5511988887777@s.whatsapp.net', fromMe = false) => ({
  event: 'messages.upsert', instance, data: { key: { id, remoteJid: jid, fromMe } }
});

test('worker envia imagem de upload em base64 e não substitui arquivo ausente por exemplo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'upload-worker-'));
  const imageStore = createImageStore(dir);
  const bytes = await readFile(new URL('../src/admin/public/example-banner.jpg', import.meta.url));
  const uploaded = await imageStore.upload({ data: bytes.toString('base64'), mimeType: 'image/jpeg' });
  const state = createState(':memory:');
  const company = { ...companies[0], messageFormat: 'image', imageId: uploaded.id, imageUrl: 'https://example.com/ignored.jpg' };
  const config = { active: { defaultCooldownHours: 24 }, company: () => company };
  const calls = [];
  const worker = createWorker({ state, config, imageStore, logger, baseUrl: 'http://evolution', apiKey: 'test', send: async (_url, options) => { calls.push(JSON.parse(options.body)); return { ok: true }; } });
  try {
    state.enqueue({ instance: company.instance, messageId: 'uploaded', contact: '5511988887777' });
    await worker.tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(Buffer.from(calls[0].media, 'base64'), await imageStore.load(uploaded.id));
    assert.equal(calls[0].mimetype, 'image/jpeg');
    company.imageId = `${'0'.repeat(64)}.jpg`;
    state.enqueue({ instance: company.instance, messageId: 'missing-image', contact: '5511988886666' });
    await worker.tick();
    assert.equal(calls.length, 1);
    assert.equal(state.inspect(company.instance, 'missing-image').status, 'failed');
  } finally { state.close(); await rm(dir, { recursive: true, force: true }); }
});

test('imagem envia banner e legenda em uma mensagem, com exemplo local ou URL HTTPS', async () => {
  const bytes = await readFile(new URL('../src/admin/public/example-banner.jpg', import.meta.url));
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff');
  for (const imageUrl of ['', 'https://example.com/banner.jpg']) {
    const state = createState(':memory:');
    const company = { ...companies[0], messageFormat: 'image', imageUrl, includePrefilledText: false };
    const config = { active: { defaultCooldownHours: 24 }, company: () => company };
    const calls = [];
    const worker = createWorker({ state, config, logger, baseUrl: 'http://evolution', apiKey: 'test', send: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true }; } });
    try {
      assert.doesNotThrow(() => validateConfig({ schemaVersion: 1, defaultCooldownHours: 24, companies: [company] }));
      state.enqueue({ instance: company.instance, messageId: 'banner', contact: '5511988887777' });
      await worker.tick(); await worker.tick();
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/message\/sendMedia\//);
      assert.equal(calls[0].body.mediatype, 'image');
      assert.equal(calls[0].body.caption, buildReply(company));
      assert.equal((calls[0].body.caption.match(/https:\/\/wa.me\//g) ?? []).length, 3);
      assert.doesNotMatch(calls[0].body.caption, /\?text=/);
      if (imageUrl) assert.equal(calls[0].body.media, imageUrl);
      else {
        assert.deepEqual(Buffer.from(calls[0].body.media, 'base64'), bytes);
        assert.equal(calls[0].body.mimetype, 'image/jpeg');
      }
      assert.equal(state.inspect(company.instance, 'banner').status, 'sent');
    } finally { state.close(); }
  }
  for (const imageUrl of ['http://example.com/banner.jpg', 'file:///test.jpg', 'https://user:password@example.com/test.jpg', null, 123]) {
    assert.throws(() => validateConfig({ schemaVersion: 1, defaultCooldownHours: 24, companies: [{ ...companies[0], messageFormat: 'image', imageUrl }] }));
  }
});

test('vCard envia saudação e três contatos e retoma só a etapa pendente após reinício', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vcard-flow-'));
  const path = join(dir, 'state.sqlite');
  let state = createState(path);
  const company = { ...companies[0], messageFormat: 'vcard', prefilledText: '' };
  const config = { active: { defaultCooldownHours: 24 }, company: () => company };
  const calls = [];
  let time = Date.now();
  const event = { instance: company.instance, contact: '5511988887777', messageId: 'cards' };
  const makeWorker = () => createWorker({ state, config, logger, baseUrl: 'http://evolution', apiKey: 'test', now: () => time,
    send: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: calls.length !== 2, status: calls.length === 2 ? 429 : 200 }; } });
  try {
    assert.doesNotThrow(() => validateConfig({ schemaVersion: 1, defaultCooldownHours: 24, companies: [company] }));
    state.enqueue(event); time = Date.now(); await makeWorker().tick();
    assert.match(calls[0].url, /sendText/);
    assert.equal(calls[0].body.text, `${company.welcomeText}\n\n${company.closingText}`);
    assert.equal(calls[0].body.linkPreview, false);
    assert.match(calls[1].url, /sendContact/);
    assert.deepEqual(calls[1].body.contact, company.agents.map(agent => ({ fullName: agent.label, wuid: agent.phoneE164, phoneNumber: `+${agent.phoneE164}`, organization: company.displayName })));
    assert.equal(state.inspect(event.instance, event.messageId).delivery_step, 1);
    state.close(); state = createState(path);
    company.messageFormat = 'text'; // A pending vCard keeps the original contacts and order.
    time += 5000; await makeWorker().tick();
    assert.equal(calls.length, 3);
    assert.match(calls[2].url, /sendContact/);
    assert.deepEqual(calls[2].body, calls[1].body);
    assert.equal(state.inspect(event.instance, event.messageId).status, 'sent');
    assert.equal(state.enqueue(event), false);
    state.enqueue({ ...event, messageId: 'cooldown' }); await makeWorker().tick();
    assert.equal(calls.length, 3);
  } finally { state.close(); await rm(dir, { recursive: true, force: true }); }
});

test('vCard com entrega incerta não repete saudação nem contatos', async () => {
  for (const uncertainStep of [0, 1]) {
    const state = createState(':memory:');
    const company = { ...companies[0], messageFormat: 'vcard' };
    const config = { active: { defaultCooldownHours: 24 }, company: () => company };
    let calls = 0;
    const worker = createWorker({ state, config, logger, baseUrl: 'http://evolution', apiKey: 'test', send: async () => {
      if (calls++ === uncertainStep) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      return { ok: true };
    } });
    try {
      state.enqueue({ instance: company.instance, contact: '5511988887777', messageId: 'uncertain-vcard' });
      await worker.tick(); await worker.tick();
      assert.equal(calls, uncertainStep + 1);
      assert.equal(state.inspect(company.instance, 'uncertain-vcard').status, 'ambiguous');
    } finally { state.close(); }
  }
});

test('mensagem no link é opcional e mantém comportamento legado', () => {
  const company = { ...companies[0], includePrefilledText: false, prefilledText: '' };
  assert.doesNotThrow(() => validateConfig({ schemaVersion: 1, defaultCooldownHours: 24, companies: [company] }));
  assert.doesNotMatch(buildReply(company), /\?text=/);
  assert.deepEqual(buildDelivery({ ...company, messageFormat: 'buttons' }).body.buttons.map(button => button.url), company.agents.map(agent => `https://wa.me/${agent.phoneE164}`));
  assert.match(buildReply(companies[0]), /\?text=/);
  assert.match(buildReply({ ...company, includePrefilledText: true, prefilledText: 'Olá & café' }), /\?text=Ol%C3%A1%20%26%20caf%C3%A9/);
  for (const value of [true, 'false', 0, null]) {
    assert.throws(() => validateConfig({ schemaVersion: 1, defaultCooldownHours: 24, companies: [{ ...company, includePrefilledText: value }] }));
  }
});

test('migração da fila legada preserva eventos e cooldown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'list-migrate-'));
  const path = join(dir, 'state.sqlite');
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE events (instance TEXT NOT NULL, message_id TEXT NOT NULL, contact TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error TEXT, PRIMARY KEY(instance,message_id));
    CREATE TABLE cooldowns (instance TEXT NOT NULL, contact TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY(instance,contact));
    INSERT INTO events VALUES ('alfa','legacy','5511988887777','pending',0,0,0,0,NULL);
    INSERT INTO cooldowns VALUES ('alfa','5511988887777',1000);`);
  legacy.close();
  const state = createState(path);
  try {
    assert.equal(state.inspect('alfa', 'legacy').selection_id, null);
    assert.equal(state.inspect('alfa', 'legacy').delivery_step, 0);
    assert.equal(state.inspect('alfa', 'legacy').delivery_plan, null);
    assert.equal(state.claim(1001, () => 3600000).skipped, true);
    assert.equal(state.enqueue({ instance: 'alfa', messageId: 'legacy', contact: '5511988887777' }), false);
  } finally { state.close(); await rm(dir, { recursive: true, force: true }); }
});

test('lista envia menu e responde escolha durante cooldown, com persistência e deduplicação', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'list-flow-'));
  const dbPath = join(dir, 'state.sqlite');
  let state = createState(dbPath);
  const company = { ...companies[0], messageFormat: 'list' };
  const config = { active: { defaultCooldownHours: 24 }, company: instance => instance === company.instance ? company : undefined };
  const sends = [];
  const makeWorker = () => createWorker({ state, config, logger, baseUrl: 'http://evolution', apiKey: 'test', send: async (url, options) => { sends.push({ url, body: JSON.parse(options.body) }); return { ok: true }; } });
  let worker = makeWorker();
  let app = createApp({ state, config, worker, webhookSecret: 'secret' });
  const post = body => app.inject({ method: 'POST', url: '/webhooks/evolution', headers: { 'x-webhook-secret': 'secret' }, payload: body });
  const selection = (id, rowId) => ({ ...payload(company.instance, id), data: { ...payload(company.instance, id).data, message: { listResponseMessage: { singleSelectReply: { selectedRowId: rowId } } } } });
  try {
    assert.equal((await post(payload(company.instance, 'menu'))).statusCode, 202);
    await worker.tick();
    assert.match(sends[0].url, /sendList/);
    assert.equal(sends[0].body.buttonText, 'Escolher atendente');
    assert.deepEqual(sends[0].body.sections[0].rows.map(row => row.title), company.agents.map(agent => agent.label));
    company.includePrefilledText = false;
    const selected = selection('choice', sends[0].body.sections[0].rows[1].rowId);
    assert.equal((await post(selection('invalid', 'agent_' + '0'.repeat(24)))).statusCode, 204);
    assert.equal((await post(selection('malformed', 'bad'))).statusCode, 204);
    company.ignoredContacts = ['5511988887777'];
    assert.equal((await post(selected)).statusCode, 204);
    delete company.ignoredContacts;
    assert.equal((await post(selected)).statusCode, 202);
    assert.equal((await post(selected)).statusCode, 200);
    await app.close(); state.close();
    state = createState(dbPath); worker = makeWorker();
    app = createApp({ state, config, worker, webhookSecret: 'secret' });
    await worker.tick();
    assert.equal(sends.length, 2);
    assert.match(sends[1].url, /sendText/);
    assert.ok(sends[1].body.text.includes(company.agents[1].phoneE164));
    assert.doesNotMatch(sends[1].body.text, /\?text=/);
    assert.ok(!sends[1].body.text.includes(company.agents[0].phoneE164));
    assert.equal((await post(selected)).statusCode, 200);
    await post(payload(company.instance, 'cooldown')); await worker.tick();
    assert.equal(sends.length, 2);
    assert.equal(state.inspect(company.instance, 'cooldown').status, 'skipped');
    await post(selection('stale', agentRowId(company.agents[0])));
    company.messageFormat = 'text';
    await worker.tick();
    assert.equal(state.inspect(company.instance, 'stale').status, 'skipped');
    assert.equal(sends.length, 2);
  } finally { await app.close(); state.close(); await rm(dir, { recursive: true, force: true }); }
});

test('botões enviam três URLs e timeout não gera fallback ou reenvio', async () => {
  for (const uncertain of [false, true]) {
    const company = { ...companies[0], messageFormat: 'buttons' };
    const state = createState(':memory:');
    const requests = [];
    const config = { active: { defaultCooldownHours: 24 }, company: () => company };
    const worker = createWorker({ state, config, baseUrl: 'http://evolution/', apiKey: 'key', logger,
      send: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        if (uncertain) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
        return { ok: true };
      } });
    try {
      state.enqueue({ instance: company.instance, messageId: 'buttons', contact: '5511988887777' });
      await worker.tick();
      await worker.tick();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, `http://evolution/message/sendButtons/${company.instance}`);
      assert.equal(requests[0].body.number, '5511988887777');
      assert.equal(requests[0].body.description, company.welcomeText);
      assert.deepEqual(requests[0].body.buttons, company.agents.map(agent => ({ type: 'url', displayText: agent.label, url: `https://wa.me/${agent.phoneE164}?text=${encodeURIComponent(company.prefilledText)}` })));
      assert.equal(state.inspect(company.instance, 'buttons').status, uncertain ? 'ambiguous' : 'sent');
    } finally { state.close(); }
  }
});

test('formato desconhecido e nome longo de botão são rejeitados, texto legado continua válido', () => {
  const raw = company => ({ schemaVersion: 1, defaultCooldownHours: 24, companies: [company] });
  assert.doesNotThrow(() => validateConfig(raw(companies[0])));
  assert.throws(() => validateConfig(raw({ ...companies[0], messageFormat: 'invalid' })));
  const company = { ...companies[0], agents: companies[0].agents.map(agent => ({ ...agent, label: 'a'.repeat(21) })) };
  assert.doesNotThrow(() => validateConfig(raw(company)));
  assert.throws(() => validateConfig(raw({ ...company, messageFormat: 'buttons' })));
});

test('intervalo reduzido e liberação permitem novas mensagens sem reenviar histórico', async () => {
  const state = createState(':memory:');
  let time = 10_000_000;
  const company = { ...companies[0], cooldownHours: 24 };
  const config = { active: { defaultCooldownHours: 24 }, company: () => company };
  let sends = 0;
  const worker = createWorker({ state, config, logger, baseUrl: 'http://evolution', apiKey: 'key', now: () => time, send: async () => { sends++; return { ok: true }; } });
  const event = id => ({ instance: company.instance, messageId: id, contact: '5511988887777' });
  // Enqueue uses wall time; keep the worker clock aligned with it.
  time = Date.now();
  try {
    state.enqueue(event('first')); time = Date.now(); await worker.tick();
    assert.equal(sends, 1);
    time += 3_600_000;
    state.enqueue(event('blocked')); await worker.tick();
    assert.equal(sends, 1);
    company.cooldownHours = 1;
    state.enqueue(event('reduced')); await worker.tick();
    assert.equal(sends, 2);
    state.enqueue(event('still-blocked')); await worker.tick();
    assert.equal(sends, 2);
    assert.equal(state.clearCooldown(company.instance, event('').contact), 1);
    await worker.tick();
    assert.equal(sends, 2);
    assert.equal(state.enqueue(event('first')), false);
    state.enqueue(event('released')); await worker.tick();
    assert.equal(sends, 3);
    assert.equal(state.inspect(company.instance, 'blocked').status, 'skipped');
    assert.equal(state.inspect(company.instance, 'still-blocked').status, 'skipped');
  } finally { state.close(); }
});

test('webhook, cooldown, deduplicacao, isolamento e reinicio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'digiark-'));
  const path = join(dir, 'config.json');
  const dbPath = join(dir, 'state.sqlite');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, defaultCooldownHours: 24, companies }));
  const config = createConfigStore(path, logger);
  await config.reload();
  let state = createState(dbPath);
  const sent = [];
  const worker = createWorker({ state, config, baseUrl: 'http://evolution', apiKey: 'key', logger,
    send: async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return { ok: true }; } });
  const app = createApp({ state, config, worker, webhookSecret: 'secret' });
  const post = body => app.inject({ method: 'POST', url: '/webhooks/evolution', headers: { 'x-webhook-secret': 'secret' }, payload: body });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/webhooks/evolution', payload: payload('distribuidora-alfa', '1') })).statusCode, 401);
    assert.equal((await post(payload('distribuidora-alfa', '1'))).statusCode, 202);
    assert.equal((await post(payload('distribuidora-alfa', '1'))).statusCode, 200);
    await worker.tick();
    assert.equal(sent.length, 1);
    assert.equal((sent[0].body.text.match(/https:\/\/wa\.me\//g) || []).length, 3);
    assert.match(sent[0].body.text, /Vim%20pelo%20an%C3%BAncio/);
    await post(payload('distribuidora-alfa', '2'));
    await worker.tick();
    assert.equal(sent.length, 1);
    assert.equal(state.inspect('distribuidora-alfa', '2').status, 'skipped');
    await post(payload('distribuidora-beta', '3'));
    await worker.tick();
    assert.equal(sent.length, 2);
    assert.match(sent[1].body.text, /distribuidora-beta/);
    assert.doesNotMatch(sent[1].body.text, /distribuidora-alfa/);
    assert.equal((await post(payload('unknown', '4'))).statusCode, 204);
    assert.equal((await post(payload('distribuidora-alfa', '5', '12345@g.us'))).statusCode, 204);
    assert.equal((await post(payload('distribuidora-alfa', '6', undefined, true))).statusCode, 204);
    await app.close();
    state.close();
    state = createState(dbPath);
    assert.equal(state.inspect('distribuidora-alfa', '1').status, 'sent');
    const again = createWorker({ state, config, baseUrl: 'http://evolution', apiKey: 'key', logger, send: async () => { throw new Error('unexpected'); } });
    state.enqueue({ instance: 'distribuidora-alfa', messageId: '7', contact: '5511988887777' });
    await again.tick();
    assert.equal(state.inspect('distribuidora-alfa', '7').status, 'skipped');
  } finally { await app.close(); state.close(); await rm(dir, { recursive: true, force: true }); }
});

test('reload invalido preserva configuracao e falha de envio nao cria cooldown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'digiark-'));
  const path = join(dir, 'config.json');
  const dbPath = join(dir, 'state.sqlite');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, defaultCooldownHours: 24, companies }));
  const config = createConfigStore(path, logger);
  await config.reload();
  const version = config.version;
  await writeFile(path, '{ broken');
  await config.reload();
  assert.equal(config.version, version);
  assert.ok(config.company('distribuidora-alfa'));
  const state = createState(dbPath);
  try {
    state.enqueue({ instance: 'distribuidora-alfa', messageId: 'fail', contact: '5511988887777' });
    const worker = createWorker({ state, config, baseUrl: 'http://evolution', apiKey: 'key', logger, send: async () => ({ ok: false, status: 400 }) });
    await worker.tick();
    assert.equal(state.inspect('distribuidora-alfa', 'fail').status, 'failed');
    assert.equal(state.healthy(), true);
    await writeFile(path, JSON.stringify({ schemaVersion: 1, defaultCooldownHours: 24, companies: [{ ...companies[0], welcomeText: 'Nova saudação' }, ...companies.slice(1)] }));
    await config.reload();
    assert.notEqual(config.version, version);
    assert.equal(config.company('distribuidora-alfa').welcomeText, 'Nova saudação');
  } finally { state.close(); await rm(dir, { recursive: true, force: true }); }
});

test('envio incerto exige reconciliacao e nao repete apos reinicio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'digiark-'));
  const dbPath = join(dir, 'state.sqlite');
  let state = createState(dbPath);
  const config = { active: { defaultCooldownHours: 24 }, company: () => companies[0] };
  try {
    state.enqueue({ instance: 'distribuidora-alfa', messageId: 'uncertain', contact: '5511988887777' });
    const worker = createWorker({ state, config, baseUrl: 'http://evolution', apiKey: 'key', logger, send: async () => ({ ok: false, status: 503 }) });
    await worker.tick();
    assert.equal(state.inspect('distribuidora-alfa', 'uncertain').status, 'ambiguous');
    state.close();
    state = createState(dbPath);
    let calls = 0;
    const restarted = createWorker({ state, config, baseUrl: 'http://evolution', apiKey: 'key', logger, send: async () => { calls++; return { ok: true }; } });
    await restarted.tick();
    assert.equal(calls, 0);
    assert.equal(state.inspect('distribuidora-alfa', 'uncertain').status, 'ambiguous');
  } finally { state.close(); await rm(dir, { recursive: true, force: true }); }
});

test('tres nomes podem compartilhar telefone somente com permissao explicita', () => {
  const company = structuredClone(companies[0]);
  company.agents = ['Ana (teste)', 'Bruno (teste)', 'Carla (teste)'].map(label => ({ label, phoneE164: '553588071390' }));
  const config = { schemaVersion: 1, defaultCooldownHours: 24, companies: [company] };
  assert.throws(() => validateConfig(config));
  company.allowDuplicateAgentPhones = true;
  assert.doesNotThrow(() => validateConfig(config));
  const reply = buildReply(company);
  assert.equal((reply.match(/https:\/\/wa\.me\/553588071390\?/g) ?? []).length, 3);
  for (const label of ['Ana (teste)', 'Bruno (teste)', 'Carla (teste)']) assert.ok(!reply.includes(label));
});

test('edição administrativa altera próximo envio elegível sem apagar cooldown ou deduplicação', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panel-worker-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, defaultCooldownHours: 24, companies }));
  const config = createConfigStore(path, logger);
  await config.reload();
  const state = createState(join(dir, 'state.sqlite'));
  const sent = [];
  const worker = createWorker({ state, config, logger, baseUrl: 'http://evolution', apiKey: 'test', send: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true }; } });
  const event = { instance: companies[0].instance, messageId: 'first', contact: '5511988887777' };
  try {
    state.enqueue(event); await worker.tick();
    const { agents, prefilledText } = companies[0];
    await config.update(event.instance, { welcomeText: 'Saudação nova', closingText: '', agents, prefilledText }, config.version);
    assert.equal(state.enqueue(event), false);
    state.enqueue({ ...event, messageId: 'cooldown' }); await worker.tick();
    assert.equal(sent.length, 1);
    state.enqueue({ ...event, contact: '5511988886666', messageId: 'new-contact' }); await worker.tick();
    assert.equal(sent.length, 2);
    assert.ok(sent[1].text.startsWith('Saudação nova\n\n☎️'));
  } finally { state.close(); await rm(dir, { recursive: true, force: true }); }
});
