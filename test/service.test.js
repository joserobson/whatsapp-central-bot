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

const companies = ['hba-central', 'hb2a-central', 'salbu-central'].map((instance, index) => ({
  instance, enabled: true, displayName: instance, welcomeText: `Olá ${instance}`,
  closingText: 'Escolha um link.', prefilledText: `Vim pelo anúncio ${instance}`,
  agents: [1, 2, 3].map((n) => ({ label: `Atendente ${n}`, phoneE164: `551199999${index}${n}00` }))
}));
const logger = { info() {}, warn() {}, error() {} };
const payload = (instance, id, jid = '5511988887777@s.whatsapp.net', fromMe = false) => ({
  event: 'messages.upsert', instance, data: { key: { id, remoteJid: jid, fromMe } }
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
    assert.equal((await app.inject({ method: 'POST', url: '/webhooks/evolution', payload: payload('hba-central', '1') })).statusCode, 401);
    assert.equal((await post(payload('hba-central', '1'))).statusCode, 202);
    assert.equal((await post(payload('hba-central', '1'))).statusCode, 200);
    await worker.tick();
    assert.equal(sent.length, 1);
    assert.equal((sent[0].body.text.match(/https:\/\/wa\.me\//g) || []).length, 3);
    assert.match(sent[0].body.text, /Vim%20pelo%20an%C3%BAncio/);
    await post(payload('hba-central', '2'));
    await worker.tick();
    assert.equal(sent.length, 1);
    assert.equal(state.inspect('hba-central', '2').status, 'skipped');
    await post(payload('hb2a-central', '3'));
    await worker.tick();
    assert.equal(sent.length, 2);
    assert.match(sent[1].body.text, /hb2a-central/);
    assert.doesNotMatch(sent[1].body.text, /hba-central/);
    assert.equal((await post(payload('unknown', '4'))).statusCode, 204);
    assert.equal((await post(payload('hba-central', '5', '12345@g.us'))).statusCode, 204);
    assert.equal((await post(payload('hba-central', '6', undefined, true))).statusCode, 204);
    await app.close();
    state.close();
    state = createState(dbPath);
    assert.equal(state.inspect('hba-central', '1').status, 'sent');
    const again = createWorker({ state, config, baseUrl: 'http://evolution', apiKey: 'key', logger, send: async () => { throw new Error('unexpected'); } });
    state.enqueue({ instance: 'hba-central', messageId: '7', contact: '5511988887777' });
    await again.tick();
    assert.equal(state.inspect('hba-central', '7').status, 'skipped');
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
  assert.ok(config.company('hba-central'));
  const state = createState(dbPath);
  try {
    state.enqueue({ instance: 'hba-central', messageId: 'fail', contact: '5511988887777' });
    const worker = createWorker({ state, config, baseUrl: 'http://evolution', apiKey: 'key', logger, send: async () => ({ ok: false, status: 400 }) });
    await worker.tick();
    assert.equal(state.inspect('hba-central', 'fail').status, 'failed');
    assert.equal(state.healthy(), true);
    await writeFile(path, JSON.stringify({ schemaVersion: 1, defaultCooldownHours: 24, companies: [{ ...companies[0], welcomeText: 'Nova saudação' }, ...companies.slice(1)] }));
    await config.reload();
    assert.notEqual(config.version, version);
    assert.equal(config.company('hba-central').welcomeText, 'Nova saudação');
  } finally { state.close(); await rm(dir, { recursive: true, force: true }); }
});

test('envio incerto exige reconciliacao e nao repete apos reinicio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'digiark-'));
  const dbPath = join(dir, 'state.sqlite');
  let state = createState(dbPath);
  const config = { active: { defaultCooldownHours: 24 }, company: () => companies[0] };
  try {
    state.enqueue({ instance: 'hba-central', messageId: 'uncertain', contact: '5511988887777' });
    const worker = createWorker({ state, config, baseUrl: 'http://evolution', apiKey: 'key', logger, send: async () => ({ ok: false, status: 503 }) });
    await worker.tick();
    assert.equal(state.inspect('hba-central', 'uncertain').status, 'ambiguous');
    state.close();
    state = createState(dbPath);
    let calls = 0;
    const restarted = createWorker({ state, config, baseUrl: 'http://evolution', apiKey: 'key', logger, send: async () => { calls++; return { ok: true }; } });
    await restarted.tick();
    assert.equal(calls, 0);
    assert.equal(state.inspect('hba-central', 'uncertain').status, 'ambiguous');
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
  for (const label of ['Ana (teste)', 'Bruno (teste)', 'Carla (teste)']) assert.ok(reply.includes(label));
});
