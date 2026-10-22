import { readFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

const nonempty = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const digits = value => typeof value === 'string' && /^\d{8,15}$/.test(value);

export function validateConfig(raw) {
  if (!raw || raw.schemaVersion !== 1 || !Number.isInteger(raw.defaultCooldownHours) || raw.defaultCooldownHours < 1 || raw.defaultCooldownHours > 720 || !Array.isArray(raw.companies) || raw.companies.length === 0) throw new Error('estrutura de configuracao invalida');
  const instances = new Set();
  for (const company of raw.companies) {
    if (!company || !nonempty(company.instance, 100) || !/^[a-zA-Z0-9_-]+$/.test(company.instance) || instances.has(company.instance)) throw new Error('instancia invalida ou repetida');
    instances.add(company.instance);
    if (company.messageFormat !== undefined && !['text', 'buttons'].includes(company.messageFormat)) throw new Error('formato de mensagem invalido');
    if (typeof company.enabled !== 'boolean' || !nonempty(company.displayName, 100) || !nonempty(company.welcomeText, 1000) || typeof company.closingText !== 'string' || company.closingText.length > 500 || !nonempty(company.prefilledText, 500)) throw new Error('campos de empresa invalidos');
    if (company.allowDuplicateAgentPhones !== undefined && typeof company.allowDuplicateAgentPhones !== 'boolean') throw new Error('permissao de telefone repetido invalida');
    if (!Array.isArray(company.agents) || (company.enabled && company.agents.length !== 3)) throw new Error('empresa habilitada deve ter tres atendentes');
    const phones = new Set();
    for (const agent of company.agents) {
      const phone = agent && digits(agent.phoneE164) ? parsePhoneNumberFromString(`+${agent.phoneE164}`) : null;
      if (!nonempty(agent?.label, 80) || !phone?.isValid() || (phones.has(agent.phoneE164) && !company.allowDuplicateAgentPhones)) throw new Error('atendente ou telefone invalido');
      phones.add(agent.phoneE164);
      if (company.messageFormat === 'buttons' && agent.label.length > 20) throw new Error('nome do botao deve ter ate 20 caracteres');
    }
    if (company.cooldownHours !== undefined && (!Number.isInteger(company.cooldownHours) || company.cooldownHours < 1 || company.cooldownHours > 720)) throw new Error('cooldown invalido');
    if (company.ignoredContacts !== undefined && (!Array.isArray(company.ignoredContacts) || company.ignoredContacts.some(phone => !digits(phone)))) throw new Error('contatos ignorados invalidos');
  }
  return raw;
}

export function configError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function editedCompany(company, fields) {
  const required = ['welcomeText', 'closingText', 'prefilledText', 'agents'];
  const allowed = [...required, 'cooldownHours', 'instance', 'messageFormat'];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || required.some(key => !Object.hasOwn(fields, key)) || Object.keys(fields).some(key => !allowed.includes(key))) throw configError(400, 'invalid_fields');
  if (!Array.isArray(fields.agents) || fields.agents.length !== 3) throw configError(422, 'three_agents_required');
  if (fields.agents.some(agent => !agent || Object.keys(agent).length !== 2 || Object.keys(agent).some(key => !['label', 'phoneE164'].includes(key)))) throw configError(400, 'invalid_agent_fields');
  const candidate = { ...company, ...structuredClone(fields) };
  try { validateConfig({ schemaVersion: 1, defaultCooldownHours: 24, companies: [candidate] }); }
  catch { throw configError(422, 'invalid_company'); }
  return candidate;
}

export function createConfigStore(path, logger = console, { seedPath, io = { open, rename } } = {}) {
  let active;
  let fingerprint;
  let valid = false;
  let pending = Promise.resolve();
  const serial = task => {
    const result = pending.then(task);
    pending = result.catch(() => {});
    return result;
  };
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  async function publish(bytes) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await io.open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await io.rename(temporary, path);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async function load() {
    try {
      let bytes;
      try { bytes = await readFile(path); }
      catch (error) {
        if (error.code !== 'ENOENT' || !seedPath || active) throw error;
        bytes = await readFile(seedPath);
        validateConfig(JSON.parse(bytes.toString('utf8')));
        await publish(bytes);
      }
      const candidate = validateConfig(JSON.parse(bytes.toString('utf8')));
      const version = hash(bytes);
      valid = true;
      if (version === fingerprint) return;
      active = candidate;
      fingerprint = version;
      logger.info({ event: 'config_reloaded', version });
    } catch (error) {
      valid = false;
      logger.error({ event: 'config_invalid', reason: error.code ?? (error instanceof SyntaxError ? 'invalid_json' : error.message) });
    }
  }
  return {
    reload: () => serial(load),
    update: (instance, fields, expectedVersion) => serial(async () => {
      await load();
      if (!valid || !active) throw configError(503, 'configuration_unavailable');
      if (!expectedVersion) throw configError(428, 'version_required');
      if (expectedVersion !== fingerprint) throw configError(412, 'configuration_changed');
      const index = active.companies.findIndex(item => item.instance === instance);
      if (index < 0) throw configError(404, 'company_not_found');
      const candidate = structuredClone(active);
      candidate.companies[index] = editedCompany(candidate.companies[index], fields);
      try { validateConfig(candidate); }
      catch { throw configError(422, 'invalid_configuration_or_duplicate_instance'); }
      const bytes = JSON.stringify(candidate, null, 2) + '\n';
      try { await publish(bytes); } catch { throw configError(503, 'configuration_write_failed'); }
      active = candidate;
      fingerprint = hash(bytes);
      logger.info({ event: 'config_saved', instance, version: fingerprint });
      return fingerprint;
    }),
    get active() { return active; }, get version() { return fingerprint; },
    company(instance) { return active?.companies.find(item => item.instance === instance && item.enabled); }
  };
}
