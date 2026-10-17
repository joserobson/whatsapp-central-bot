import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

const nonempty = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const digits = value => typeof value === 'string' && /^\d{8,15}$/.test(value);

export function validateConfig(raw) {
  if (!raw || raw.schemaVersion !== 1 || !Number.isInteger(raw.defaultCooldownHours) || raw.defaultCooldownHours < 1 || raw.defaultCooldownHours > 720 || !Array.isArray(raw.companies) || raw.companies.length === 0) throw new Error('estrutura de configuracao invalida');
  const instances = new Set();
  for (const company of raw.companies) {
    if (!company || !nonempty(company.instance, 100) || !/^[a-zA-Z0-9_-]+$/.test(company.instance) || instances.has(company.instance)) throw new Error('instancia invalida ou repetida');
    instances.add(company.instance);
    if (typeof company.enabled !== 'boolean' || !nonempty(company.displayName, 100) || !nonempty(company.welcomeText, 1000) || !nonempty(company.closingText, 500) || !nonempty(company.prefilledText, 500)) throw new Error('campos de empresa invalidos');
    if (company.allowDuplicateAgentPhones !== undefined && typeof company.allowDuplicateAgentPhones !== 'boolean') throw new Error('permissao de telefone repetido invalida');
    if (!Array.isArray(company.agents) || (company.enabled && company.agents.length !== 3)) throw new Error('empresa habilitada deve ter tres atendentes');
    const phones = new Set();
    for (const agent of company.agents) {
      const phone = agent && digits(agent.phoneE164) ? parsePhoneNumberFromString(`+${agent.phoneE164}`) : null;
      if (!nonempty(agent?.label, 80) || !phone?.isValid() || (phones.has(agent.phoneE164) && !company.allowDuplicateAgentPhones)) throw new Error('atendente ou telefone invalido');
      phones.add(agent.phoneE164);
    }
    if (company.cooldownHours !== undefined && (!Number.isInteger(company.cooldownHours) || company.cooldownHours < 1 || company.cooldownHours > 720)) throw new Error('cooldown invalido');
    if (company.ignoredContacts !== undefined && (!Array.isArray(company.ignoredContacts) || company.ignoredContacts.some(phone => !digits(phone)))) throw new Error('contatos ignorados invalidos');
  }
  return raw;
}

export function createConfigStore(path, logger = console) {
  let active;
  let fingerprint;
  let checkedFingerprint;
  async function reload() {
    try {
      const info = await stat(path);
      const current = `${info.mtimeMs}:${info.size}`;
      if (active && current === checkedFingerprint) return;
      checkedFingerprint = current;
      const bytes = await readFile(path);
      const candidate = validateConfig(JSON.parse(bytes.toString('utf8')));
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
      active = candidate;
      fingerprint = hash;
      logger.info({ event: 'config_reloaded', version: hash });
    } catch (error) {
      logger.error({ event: 'config_invalid', reason: error.code ?? (error instanceof SyntaxError ? 'invalid_json' : error.message) });
    }
  }
  return { reload, get active() { return active; }, get version() { return fingerprint; }, company(instance) { return active?.companies.find(item => item.instance === instance && item.enabled); } };
}
