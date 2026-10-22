import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigStore } from '../src/config.js';
import { buildReply } from '../src/message.js';

export const company = { instance: 'alfa', displayName: 'Alfa', enabled: true, welcomeText: 'Olá', closingText: '', prefilledText: 'Oi & café', agents: [1, 2, 3].map(n => ({ label: `Pessoa ${n}`, phoneE164: `551199999${n}000` })) };
const logger = { info() {}, error() {} };

test('bootstrap, edição isolada, conflito concorrente e persistência após reinício', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admin-config-'));
  const seed = join(dir, 'seed.json');
  const path = join(dir, 'data', 'config.json');
  const raw = { schemaVersion: 1, defaultCooldownHours: 24, companies: [company, { ...company, instance: 'beta' }] };
  try {
    await writeFile(seed, JSON.stringify(raw));
    const store = createConfigStore(path, logger, { seedPath: seed });
    await store.reload();
    assert.ok(store.active);
    const version = store.version;
    const edit = { welcomeText: 'Novo', closingText: '', prefilledText: 'Novo contato', agents: company.agents };
    const results = await Promise.allSettled([store.update('alfa', edit, version), store.update('beta', edit, version)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.statusCode, 412);
    assert.equal(store.company('beta').welcomeText, 'Olá');
    assert.equal(store.company('alfa').enabled, true);
    await assert.rejects(store.update('alfa', { ...edit, enabled: false }, store.version), { statusCode: 400 });
    await assert.rejects(store.update('alfa', { ...edit, agents: [] }, store.version), { statusCode: 422 });
    await writeFile(seed, '{invalid seed');
    const restarted = createConfigStore(path, logger, { seedPath: seed });
    await restarted.reload();
    assert.equal(restarted.company('alfa').welcomeText, 'Novo');
    await writeFile(path, '{broken');
    await restarted.reload();
    assert.equal(restarted.company('alfa').welcomeText, 'Novo');
    await assert.rejects(restarted.update('alfa', edit, restarted.version), { statusCode: 503 });
    const broken = createConfigStore(path, logger, { seedPath: seed });
    await broken.reload();
    assert.equal(broken.active, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('falha de publicação mantém arquivo e versão anterior', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admin-fail-'));
  const path = join(dir, 'config.json');
  try {
    await writeFile(path, JSON.stringify({ schemaVersion: 1, defaultCooldownHours: 24, companies: [company] }));
    const before = await readFile(path, 'utf8');
    const store = createConfigStore(path, logger, { io: { open, rename: async () => { throw new Error('disk failure'); } } });
    await store.reload();
    const version = store.version;
    await assert.rejects(store.update('alfa', { welcomeText: 'Novo', closingText: '', prefilledText: 'Oi', agents: company.agents }, version), { statusCode: 503 });
    assert.equal(store.version, version);
    assert.equal(await readFile(path, 'utf8'), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('template segue referência sem labels, com links codificados e encerramento opcional', () => {
  const text = buildReply(company);
  assert.equal(text, `Olá\n\n${company.agents.map(a => `☎️ https://wa.me/${a.phoneE164}?text=Oi%20%26%20caf%C3%A9`).join('\n\n')}`);
  assert.equal(buildReply({ ...company, closingText: 'Até logo' }), `${text}\n\nAté logo`);
});

for (const step of ['open', 'write', 'sync']) test(`falha de ${step} não publica configuração incompleta`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admin-io-'));
  const path = join(dir, 'config.json');
  const fail = async () => { throw new Error('filesystem unavailable'); };
  try {
    await writeFile(path, JSON.stringify({ schemaVersion: 1, defaultCooldownHours: 24, companies: [company] }));
    const before = await readFile(path, 'utf8');
    const io = { rename, open: step === 'open' ? fail : async (...args) => {
      const file = await open(...args);
      return { writeFile: step === 'write' ? fail : (...values) => file.writeFile(...values), sync: step === 'sync' ? fail : () => file.sync(), close: () => file.close() };
    } };
    const store = createConfigStore(path, logger, { io });
    await store.reload();
    const version = store.version;
    await assert.rejects(store.update('alfa', { welcomeText: 'Novo', closingText: '', prefilledText: 'Oi', agents: company.agents }, version), { statusCode: 503 });
    assert.equal(store.version, version);
    assert.equal(await readFile(path, 'utf8'), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reload coordenado não reativa versão anterior; campos e números inválidos são rejeitados', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admin-reload-'));
  const path = join(dir, 'config.json');
  try {
    await writeFile(path, JSON.stringify({ schemaVersion: 1, defaultCooldownHours: 24, companies: [company] }));
    const store = createConfigStore(path, logger);
    await store.reload();
    const fields = { welcomeText: 'Atualizado', closingText: '', prefilledText: 'Oi', agents: company.agents };
    await Promise.all([store.reload(), store.update('alfa', fields, store.version), store.reload()]);
    assert.equal(store.company('alfa').welcomeText, 'Atualizado');
    for (const changes of [{ welcomeText: ' ' }, { welcomeText: 'a'.repeat(1001) }, { closingText: 'a'.repeat(501) }, { agents: company.agents.map(a => ({ ...a, phoneE164: '12345678' })) }, { agents: company.agents.map(a => ({ ...a, phoneE164: company.agents[0].phoneE164 })) }]) {
      await assert.rejects(store.update('alfa', { ...fields, ...changes }, store.version), { statusCode: 422 });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('troca de instância persiste, rejeita duplicidade e preserva outras distribuidoras', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admin-instance-'));
  const path = join(dir, 'config.json');
  try {
    await writeFile(path, JSON.stringify({ schemaVersion: 1, defaultCooldownHours: 24, companies: [company, { ...company, instance: 'beta' }] }));
    const store = createConfigStore(path, logger);
    await store.reload();
    const fields = { instance: 'nova-evolution', welcomeText: company.welcomeText, closingText: '', prefilledText: company.prefilledText, agents: company.agents };
    for (const instance of ['beta', '', 'com espaço', '../invalid']) await assert.rejects(store.update('alfa', { ...fields, instance }, store.version), { statusCode: 422 });
    await store.update('alfa', fields, store.version);
    assert.equal(store.company('alfa'), undefined);
    assert.equal(store.company('nova-evolution').displayName, company.displayName);
    assert.equal(store.company('beta').instance, 'beta');
    const restarted = createConfigStore(path, logger);
    await restarted.reload();
    assert.equal(restarted.company('nova-evolution').instance, 'nova-evolution');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
