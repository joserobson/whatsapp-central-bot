import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfigStore, validateConfig } from '../src/config.js';
import { buildReply } from '../src/message.js';
import { createState } from '../src/state.js';
import { createWorker } from '../src/worker.js';
import { createApp } from '../src/app.js';

const companies = ['distribuidora-alfa', 'distribuidora-beta', 'gama-alimentos'].map((instance, index) => ({
  instance, enabled: true, displayName: instance, welcomeText: `Olá ${instance}`,
  closingText: 'Escolha um link.', prefilledText: `Vim pelo anúncio ${instance}`,
  agents: [1, 2, 3].map((n) => ({ label: `Atendente ${n}`, phoneE164: `551199999${index}${n}00` }))
}));
const logger = { info() {}, warn() {}, error() {} };
const payload = (instance, id, jid = '5511988887777@s.whatsapp.net', fromMe = false) => ({
  event: 'messages.upsert', instance, data: { key: { id, remoteJid: jid, fromMe } }
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
