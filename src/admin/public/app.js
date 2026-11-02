import { hasChanges, validateDraft, errorMessage } from './model.js';

const $ = id => document.getElementById(id);
let csrf;
let original;
let version;
let selected;
let busy = false;
let latest;
let companies = [];
let evolutionInstances = [];
let previewNumber = 0;
const evolutionQrs = new Map();
const status = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
const agentBlocks = () => Array.from($('agents').children);
const draft = () => ({ instance: $('instance').value, messageFormat: $('messageFormat').value, imageUrl: $('imageUrl').value, imageId: $('imageId').value, includePrefilledText: $('includePrefilledText').checked, cooldownHours: Number($('cooldownHours').value), welcomeText: $('welcomeText').value, closingText: $('closingText').value, prefilledText: $('prefilledText').value, agents: agentBlocks().map(block => ({ label: block.querySelector('[data-agent-label]').value, phoneE164: block.querySelector('[data-agent-phone]').value })), evolutionToken: $('useSharedEvolutionKey').checked ? '' : $('evolutionToken').value, useSharedEvolutionKey: $('useSharedEvolutionKey').checked });
const comparable = fields => { const { enabled, hasEvolutionToken, evolutionToken, useSharedEvolutionKey, ...editable } = fields; return editable; };
const dirty = () => {
  if (!original) return false;
  const current = draft();
  return hasChanges(comparable(original), comparable(current)) || Boolean(current.evolutionToken.trim()) || current.useSharedEvolutionKey !== !original.hasEvolutionToken;
};
function showLogin() { $('login').hidden = false; $('workspace').hidden = true; $('logout').hidden = true; }
function showWorkspace() { $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; }
async function api(path, { method = 'GET', payload, etag } = {}) {
  const headers = {};
  if (method !== 'GET') { headers['content-type'] = 'application/json'; if (csrf) headers['x-csrf-token'] = csrf; }
  if (etag) headers['if-match'] = etag;
  const response = await fetch(`/admin/api/${path}`, { method, headers, credentials: 'same-origin', ...(method !== 'GET' ? { body: JSON.stringify(payload ?? {}) } : {}) });
  if (!response.ok) {
    if (response.status === 401) showLogin();
    const detail = await response.json().catch(() => ({}));
    const imageErrors = { image_type_not_supported: 'Selecione uma imagem JPEG ou PNG.', invalid_image: 'Arquivo inválido, corrompido ou com mais de 40 milhões de pixels. Use um JPEG ou PNG válido.', image_too_large: 'A imagem deve ter até 5 MB.', uploaded_image_not_found: 'Imagem enviada não encontrada. Envie o arquivo novamente.' };
    const evolutionErrors = { evolution_unavailable: 'Não foi possível alcançar a Evolution. Verifique a conexão do servidor.', evolution_service_unavailable: 'A Evolution está indisponível. Verifique se o serviço está ativo e licenciado.', evolution_request_failed: 'A Evolution recusou a operação. Confira a instância e a credencial configurada.' };
    const message = path === 'login' && response.status === 401 ? 'Usuário ou senha inválidos.' : errorMessage(response.status);
    throw Object.assign(new Error(imageErrors[detail.error] ?? evolutionErrors[detail.error] ?? message), { status: response.status });
  }
  return { data: response.status === 204 ? null : await response.json(), etag: response.headers.get('etag') };
}
function fill(fields) {
  $('image-file').value = ''; $('upload-status').textContent = '';
  renderEvolutionChoices(fields.instance);
  $('includePrefilledText').checked = fields.includePrefilledText ?? true;
  $('prefilledText').required = $('includePrefilledText').checked && fields.messageFormat !== 'vcard';
  $('prefilled-settings').hidden = fields.messageFormat === 'vcard';
  $('image-settings').hidden = fields.messageFormat !== 'image';
  $('evolutionToken').value = '';
  $('useSharedEvolutionKey').checked = !fields.hasEvolutionToken;
  syncEvolutionTokenControl();
  for (const key of ['instance', 'messageFormat', 'welcomeText', 'closingText', 'prefilledText', 'cooldownHours', 'imageUrl', 'imageId']) $(key).value = fields[key] ?? '';
  renderAgents(fields.agents);
}
function syncEvolutionTokenControl() {
  const useSharedKey = $('useSharedEvolutionKey').checked;
  $('evolutionToken').disabled = useSharedKey;
  $('evolutionToken').placeholder = original?.hasEvolutionToken ? 'Token salvo; informe outro para substituir' : 'Opcional; vazio usa a chave global';
}
function renderAgents(agents) {
  const container = $('agents');
  container.replaceChildren();
  agents.forEach((agent, n) => {
    const block = document.createElement('div'); block.className = 'agent';
    const grid = document.createElement('div'); grid.className = 'agent-grid';
    const nameField = document.createElement('div');
    const nameLabel = document.createElement('label'); nameLabel.htmlFor = `label-${n}`; nameLabel.textContent = `Representante ${n + 1} · nome / botão`;
    const name = document.createElement('input'); name.id = `label-${n}`; name.maxLength = 80; name.required = true; name.dataset.agentLabel = '';
    name.setAttribute('aria-describedby', `error-label-${n}`); name.value = agent.label ?? '';
    const nameError = document.createElement('small'); nameError.id = `error-label-${n}`; nameError.className = 'field-error';
    nameField.append(nameLabel, name, nameError);
    const phoneField = document.createElement('div');
    const phoneLabel = document.createElement('label'); phoneLabel.htmlFor = `phone-${n}`; phoneLabel.textContent = 'WhatsApp com DDI e DDD';
    const phone = document.createElement('input'); phone.id = `phone-${n}`; phone.inputMode = 'tel'; phone.maxLength = 15; phone.placeholder = '55 + DDD + número'; phone.required = true; phone.dataset.agentPhone = '';
    phone.setAttribute('aria-describedby', `error-phone-${n}`); phone.value = agent.phoneE164 ?? '';
    const phoneError = document.createElement('small'); phoneError.id = `error-phone-${n}`; phoneError.className = 'field-error';
    phoneField.append(phoneLabel, phone, phoneError); grid.append(nameField, phoneField); block.append(grid);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary remove-agent'; remove.textContent = 'Remover representante';
    remove.disabled = agents.length <= 1; remove.addEventListener('click', () => { renderAgents(draft().agents.filter((_, index) => index !== n)); $('editor').dispatchEvent(new Event('input', { bubbles: true })); });
    block.append(remove); container.append(block);
  });
  $('agent-count').textContent = `${agents.length} ${agents.length === 1 ? 'contato' : 'contatos'}`;
  $('add-agent').disabled = agents.length >= 10;
}
function validate() {
  const errors = validateDraft(draft());
  const current = draft();
  if (!current.useSharedEvolutionKey && !current.evolutionToken.trim() && !original?.hasEvolutionToken) errors.evolutionToken = 'Informe o token da instância ou escolha usar a chave global.';
  if (original?.hasEvolutionToken && current.instance !== original.instance && !current.useSharedEvolutionKey && !current.evolutionToken.trim()) errors.evolutionToken = 'Informe o token da nova instância ou escolha usar a chave global.';
  $('error-agents').textContent = errors.agents ?? '';
  $('agents').setAttribute('aria-invalid', String(Boolean(errors.agents)));
  const fieldIds = ['instance', 'messageFormat', 'welcomeText', 'closingText', 'prefilledText', 'cooldownHours', 'imageUrl', 'evolutionToken', ...current.agents.flatMap((_, n) => [`label-${n}`, `phone-${n}`])];
  for (const id of fieldIds) {
    $(id).setAttribute('aria-invalid', String(Boolean(errors[id])));
    $(`error-${id}`).textContent = errors[id] ?? '';
  }
  const first = Object.keys(errors)[0];
  if (first) { (first === 'agents' ? $('add-agent') : $(first)).focus(); status('Confira os campos destacados.', true); return false; }
  return true;
}
function renderPreview(data, fields) {
  const container = $('preview');
  container.replaceChildren();
  if (data.format === 'image') {
    const banner = document.createElement('img'); banner.className = 'message-banner';
    banner.alt = 'Imagem da mensagem'; banner.referrerPolicy = 'no-referrer'; banner.src = data.content.imageUrl;
    const caption = document.createElement('div'); caption.textContent = data.text;
    const error = document.createElement('p'); error.hidden = true; error.textContent = 'Não foi possível carregar a imagem. Confira se a URL está acessível.';
    banner.addEventListener('error', () => { banner.hidden = true; error.hidden = false; });
    container.append(banner, error, caption);
    return;
  }
  if (data.format === 'vcard') {
    const greeting = document.createElement('div'); greeting.textContent = data.text;
    const contacts = document.createElement('div'); contacts.className = 'contact-group';
    const heading = document.createElement('strong'); heading.textContent = `${data.content.contact.length} contatos`; contacts.append(heading);
    for (const contact of data.content.contact) {
      const card = document.createElement('div'); card.className = 'contact-card';
      const name = document.createElement('strong'); name.textContent = contact.fullName;
      const phone = document.createElement('div'); phone.textContent = contact.phoneNumber;
      const company = document.createElement('small'); company.textContent = contact.organization;
      card.append(name, phone, company); contacts.append(card);
    }
    const note = document.createElement('p'); note.textContent = 'Enviado depois da saudação, em uma mensagem de contatos agrupados. A aparência real depende do WhatsApp.';
    container.append(greeting, contacts, note);
    return;
  }
  if (data.format === 'list') {
    const body = document.createElement('div');
    body.textContent = [data.content.title, data.content.description, data.content.footerText].filter(Boolean).join('\n\n');
    const menu = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = data.content.buttonText;
    menu.append(summary);
    for (const row of data.content.sections[0].rows) {
      const choice = document.createElement('button');
      choice.type = 'button'; choice.className = 'preview-choice'; choice.textContent = row.title;
      choice.addEventListener('click', () => {
        const index = data.content.sections[0].rows.indexOf(row);
        const agent = fields.agents[index];
        const reply = document.createElement('div');
        reply.textContent = `Simulação da resposta: ${agent.label}\nhttps://wa.me/${agent.phoneE164}${fields.includePrefilledText === false ? '' : `?text=${encodeURIComponent(fields.prefilledText)}`}`;
        container.querySelector('.list-reply')?.remove();
        reply.className = 'list-reply'; container.append(reply);
      });
      menu.append(choice);
    }
    container.append(body, menu);
    return;
  }
  if (data.format !== 'buttons') { container.textContent = data.text; return; }
  const body = document.createElement('div');
  body.textContent = [data.content.title, data.content.description, data.content.footer].filter(Boolean).join('\n\n');
  container.append(body);
  for (const button of data.content.buttons) {
    const link = document.createElement('a');
    link.className = 'preview-link'; link.textContent = button.displayText;
    link.href = button.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    container.append(link);
  }
}
async function preview() {
  if (!validate()) return;
  const number = ++previewNumber;
  const fields = draft();
  const result = await api(`companies/${encodeURIComponent(selected)}/preview`, { method: 'POST', payload: fields });
  if (number === previewNumber) {
    renderPreview(result.data, fields);
    $('preview-state').textContent = hasChanges(fields, draft()) ? 'Prévia desatualizada' : (dirty() ? 'Rascunho' : 'Versão salva');
  }
}
async function load(instance) {
  const result = await api(`companies/${encodeURIComponent(instance)}`);
  selected = instance; original = result.data.fields; version = result.etag;
  $('release-contact').value = ''; $('release-status').textContent = '';
  $('company').value = instance;
  $('preview-company').textContent = $('company').selectedOptions[0].textContent;
  $('company-status').textContent = original.enabled ? 'Ativa: o bot pode responder nesta distribuidora.' : 'Desativada: o bot não responderá nesta distribuidora.';
  $('toggle-company').textContent = original.enabled ? 'Desativar distribuidora' : 'Ativar distribuidora';
  fill(original); $('comparison').hidden = true; latest = null;
  await preview();
}
async function list() {
  const result = await api('companies');
  companies = result.data.companies;
  $('company').replaceChildren(...companies.map(company => {
    const option = document.createElement('option'); option.value = company.instance;
    option.textContent = `${company.displayName}${company.enabled ? '' : ' · desativada'}`; return option;
  }));
  if (selected && original) { $('company').value = selected; showWorkspace(); return; }
  await load(companies[0].instance); showWorkspace();
}
function renderEvolutionChoices(current) {
  const select = $('instance');
  const assignedElsewhere = new Map(companies.filter(company => company.instance !== selected).map(company => [company.instance, company.displayName]));
  const available = evolutionInstances.filter(instance => !assignedElsewhere.has(instance.name));
  if (current && !available.some(instance => instance.name === current)) available.unshift({ name: current, profileName: '', unavailable: true });
  const options = [new Option('Selecione uma instância…', '')];
  for (const instance of available) {
    const label = instance.unavailable ? `${instance.name} (não encontrada na lista da Evolution)` : (instance.profileName && instance.profileName !== instance.name ? `${instance.name} · ${instance.profileName}` : instance.name);
    options.push(new Option(label, instance.name));
  }
  select.replaceChildren(...options);
  select.value = current ?? '';
}
function showTab(tab) {
  const service = tab === 'service';
  $('service-view').hidden = !service; $('evolution-view').hidden = service;
  $('service-tab').classList.toggle('active', service); $('evolution-tab').classList.toggle('active', !service);
  $('service-tab').setAttribute('aria-selected', String(service)); $('evolution-tab').setAttribute('aria-selected', String(!service));
}
const evolutionStateLabel = value => ({ open: 'Conectada', connecting: 'Conectando', close: 'Desconectada', refused: 'Conexão recusada', unknown: 'Estado desconhecido' })[value] ?? `Estado: ${value}`;
async function loadEvolutionInstances() {
  $('evolution-page-status').textContent = 'Carregando instâncias…';
  const result = await api('evolution/instances');
  evolutionInstances = result.data.instances;
  renderEvolutionChoices($('instance').value || original?.instance);
  renderEvolutionInstances(result.data.instances);
  $('evolution-page-status').textContent = `${result.data.instances.length} ${result.data.instances.length === 1 ? 'instância encontrada' : 'instâncias encontradas'}.`;
}
function renderEvolutionInstances(instances) {
  const container = $('evolution-instances'); container.replaceChildren();
  if (!instances.length) { const empty = document.createElement('p'); empty.textContent = 'A Evolution não retornou instâncias.'; container.append(empty); return; }
  const value = (parent, label, content) => {
    const cell = document.createElement('div'); const term = document.createElement('dt'); const description = document.createElement('dd');
    term.textContent = label; description.textContent = content || '—'; cell.append(term, description); parent.append(cell);
  };
  const action = (parent, label, className, handler) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.className = className; button.addEventListener('click', handler); parent.append(button); return button;
  };
  for (const instance of instances) {
    const card = document.createElement('article'); card.className = 'card evolution-card';
    const heading = document.createElement('div'); heading.className = 'evolution-card-heading';
    const name = document.createElement('h3'); name.textContent = instance.name;
    const badge = document.createElement('span'); badge.className = `state-badge state-${instance.state}`; badge.textContent = evolutionStateLabel(instance.state);
    heading.append(name, badge); card.append(heading);
    const data = document.createElement('dl'); data.className = 'instance-data';
    value(data, 'Integração', instance.integration); value(data, 'Número', instance.number); value(data, 'Perfil do WhatsApp', instance.profileName);
    value(data, 'Criada em', instance.createdAt ? new Date(instance.createdAt).toLocaleString() : '');
    value(data, 'Atualizada em', instance.updatedAt ? new Date(instance.updatedAt).toLocaleString() : '');
    value(data, 'Motivo da desconexão', instance.disconnectionReason);
    card.append(data);
    const tokenDetails = document.createElement('details'); tokenDetails.className = 'instance-token';
    const tokenSummary = document.createElement('summary'); tokenSummary.textContent = 'Token da instância';
    const tokenControl = document.createElement('div'); tokenControl.className = 'token-control';
    const tokenInput = document.createElement('input'); tokenInput.type = 'password'; tokenInput.value = instance.token; tokenInput.readOnly = true; tokenInput.autocomplete = 'off'; tokenInput.setAttribute('aria-label', `Token da instância ${instance.name}`);
    const reveal = action(tokenControl, 'Mostrar', 'secondary', () => { const visible = tokenInput.type === 'text'; tokenInput.type = visible ? 'password' : 'text'; reveal.textContent = visible ? 'Mostrar' : 'Ocultar'; });
    action(tokenControl, 'Copiar token', 'secondary', async () => { try { await navigator.clipboard.writeText(instance.token); $('evolution-page-status').textContent = `Token de ${instance.name} copiado.`; } catch { $('evolution-page-status').textContent = 'Não foi possível copiar o token neste navegador.'; } });
    tokenControl.prepend(tokenInput); tokenDetails.append(tokenSummary, tokenControl); card.append(tokenDetails);
    const actions = document.createElement('div'); actions.className = 'actions instance-actions';
    action(actions, 'Conectar / gerar QR', 'secondary', () => void run(() => operateEvolution(instance, 'connect')));
    action(actions, 'Reiniciar', 'secondary', () => void run(() => operateEvolution(instance, 'restart')));
    action(actions, 'Desconectar', 'secondary', () => void run(() => operateEvolution(instance, 'logout')));
    action(actions, 'Excluir', 'secondary danger', () => void run(() => operateEvolution(instance, 'delete')));
    card.append(actions);
    const qr = document.createElement('img'); qr.className = 'instance-qr'; qr.alt = `QR Code para conectar ${instance.name}`; qr.hidden = true;
    const qrHelp = document.createElement('p'); qrHelp.className = 'muted'; qrHelp.textContent = 'Escaneie no WhatsApp. O QR Code expira; gere outro se necessário.'; qrHelp.hidden = true;
    const cardStatus = document.createElement('p'); cardStatus.className = 'instance-card-status'; cardStatus.setAttribute('role', 'status');
    if (evolutionQrs.has(instance.name)) { qr.src = evolutionQrs.get(instance.name); qr.hidden = false; qrHelp.hidden = false; }
    card.append(qr, qrHelp, cardStatus); container.append(card);
  }
}
async function operateEvolution(instance, operation) {
  if (operation === 'restart' && !confirm(`Reiniciar a instância ${instance.name}?`)) return;
  if (operation === 'logout' && !confirm(`Desconectar ${instance.name} do WhatsApp? Será necessário gerar novo QR Code para reconectar.`)) return;
  if (operation === 'delete') {
    if (!confirm(`Excluir ${instance.name} na Evolution? Isso desconecta o WhatsApp e remove a instância.`)) return;
    if (prompt(`Digite exatamente ${instance.name} para confirmar a exclusão:`) !== instance.name) { $('evolution-page-status').textContent = 'Exclusão cancelada.'; return; }
  }
  const path = `evolution/instances/${encodeURIComponent(instance.name)}`;
  if (operation === 'connect') {
    const result = await api(`${path}/connect`, { method: 'POST' });
    if (result.data.qrCode) evolutionQrs.set(instance.name, result.data.qrCode);
    else evolutionQrs.delete(instance.name);
    await loadEvolutionInstances();
    $('evolution-page-status').textContent = result.data.qrCode ? `QR Code gerado para ${instance.name}.` : `${instance.name}: ${evolutionStateLabel(result.data.state)}.`;
    return;
  }
  if (operation === 'restart') await api(`${path}/restart`, { method: 'POST' });
  if (operation === 'logout') await api(`${path}/logout`, { method: 'POST' });
  if (operation === 'delete') { await api(path, { method: 'DELETE' }); evolutionQrs.delete(instance.name); }
  await loadEvolutionInstances();
  $('evolution-page-status').textContent = operation === 'delete' ? `${instance.name} excluída.` : operation === 'logout' ? `${instance.name} desconectada.` : `${instance.name} reiniciada.`;
}
async function run(task) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button, select, #editor input, #editor textarea, #release-contact, #evolution-view input').forEach(element => { element.disabled = true; });
  try { await task(); } catch (error) { status(error.message || errorMessage(503), true); }
  finally { busy = false; document.querySelectorAll('button, select, #editor input, #editor textarea, #release-contact, #evolution-view input').forEach(element => { element.disabled = false; }); syncEvolutionTokenControl(); $('add-agent').disabled = agentBlocks().length >= 10; document.querySelectorAll('.remove-agent').forEach(button => { button.disabled = agentBlocks().length <= 1; }); }
}
$('add-agent').addEventListener('click', () => { const agents = draft().agents; if (agents.length < 10) { agents.push({ label: '', phoneE164: '' }); renderAgents(agents); $('editor').dispatchEvent(new Event('input', { bubbles: true })); } });
$('login-form').addEventListener('submit', event => { event.preventDefault(); void run(async () => {
  const result = await api('login', { method: 'POST', payload: { username: $('username').value, password: $('password').value } });
  csrf = result.data.csrf; $('password').value = ''; await list(); status('Acesso autorizado.');
}); });
$('company').addEventListener('change', () => { const next = $('company').value; $('company').value = selected;
  if (dirty() && !confirm('Descartar as alterações pendentes e trocar de distribuidora?')) return;
  void run(async () => { await load(next); status('Configuração carregada.'); });
});
$('toggle-company').addEventListener('click', () => {
  if (dirty()) { status('Salve ou descarte as alterações pendentes antes de mudar o status da distribuidora.', true); return; }
  const enabled = !original.enabled;
  const action = enabled ? 'ativar' : 'desativar';
  if (!confirm(`Deseja ${action} ${$('company').selectedOptions[0].textContent}?`)) return;
  void run(async () => {
    const result = await api(`companies/${encodeURIComponent(selected)}/status`, { method: 'PUT', payload: { enabled }, etag: version });
    version = result.etag;
    await list(); await load(selected);
    status(`Distribuidora ${enabled ? 'ativada' : 'desativada'}.`);
  });
});
$('editor').addEventListener('input', () => { $('image-settings').hidden = $('messageFormat').value !== 'image'; $('prefilled-settings').hidden = $('messageFormat').value === 'vcard'; $('prefilledText').required = $('includePrefilledText').checked && $('messageFormat').value !== 'vcard'; $('preview-state').textContent = 'Prévia desatualizada'; status(dirty() ? 'Há alterações não salvas.' : ''); });
$('useSharedEvolutionKey').addEventListener('change', () => { if ($('useSharedEvolutionKey').checked) $('evolutionToken').value = ''; syncEvolutionTokenControl(); $('editor').dispatchEvent(new Event('input', { bubbles: true })); });
$('preview-button').addEventListener('click', () => void run(preview));
$('service-tab').addEventListener('click', () => showTab('service'));
$('evolution-tab').addEventListener('click', () => { showTab('evolution'); void run(loadEvolutionInstances); });
$('refresh-evolution').addEventListener('click', () => void run(loadEvolutionInstances));
$('toggle-new-token').addEventListener('click', () => { const input = $('new-instance-token'); const visible = input.type === 'text'; input.type = visible ? 'password' : 'text'; $('toggle-new-token').textContent = visible ? 'Mostrar' : 'Ocultar'; });
$('create-instance-form').addEventListener('submit', event => { event.preventDefault();
  const payload = { name: $('new-instance-name').value, integration: 'WHATSAPP-BAILEYS', number: $('new-instance-number').value, token: $('new-instance-token').value };
  void run(async () => {
    const result = await api('evolution/instances', { method: 'POST', payload });
    if (result.data.qrCode) evolutionQrs.set(result.data.name, result.data.qrCode);
    $('create-instance-form').reset(); $('new-instance-token').type = 'password'; $('toggle-new-token').textContent = 'Mostrar';
    await loadEvolutionInstances(); status('Instância criada na Evolution.');
  });
});
$('upload-image').addEventListener('click', () => void run(async () => {
  const file = $('image-file').files[0];
  if (!file || !['image/jpeg', 'image/png'].includes(file.type)) throw new Error('Selecione uma imagem JPEG ou PNG.');
  if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('A imagem deve ter entre 1 byte e 5 MB.');
  $('upload-status').textContent = 'Validando e preparando a imagem…';
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.')); reader.readAsDataURL(file);
    });
    const result = await api(`companies/${encodeURIComponent(selected)}/image-upload`, { method: 'POST', payload: { data, mimeType: file.type } });
    $('imageId').value = result.data.id; $('imageUrl').value = '';
    $('upload-status').textContent = `Imagem pronta: ${result.data.width} × ${result.data.height} pixels, ${Math.ceil(result.data.size / 1024)} KB. Clique em Salvar alterações para aplicar.`;
    await preview(); status('Imagem no rascunho. Salve para aplicar ao atendimento.');
  } catch (error) { $('upload-status').textContent = error.message; throw error; }
}));
$('clear-image').addEventListener('click', () => void run(async () => {
  $('imageId').value = ''; $('imageUrl').value = ''; $('image-file').value = '';
  $('upload-status').textContent = 'Imagem de exemplo selecionada. Salve para aplicar.';
  await preview(); status('Há alterações não salvas.');
}));
$('editor').addEventListener('submit', event => { event.preventDefault(); if (!validate()) return;
  void run(async () => {
    const fields = draft();
    const result = await api(`companies/${encodeURIComponent(selected)}`, { method: 'PUT', payload: fields, etag: version });
    selected = fields.instance;
    version = result.etag;
    await list();
    selected = fields.instance;
    $('company').value = selected;
    const refreshed = await api(`companies/${encodeURIComponent(selected)}`);
    original = refreshed.data.fields; version = refreshed.etag; fill(original); $('comparison').hidden = true; latest = null;
    await loadEvolutionInstances();
    await preview(); status('Alterações salvas e aplicadas.');
  });
});
$('reload').addEventListener('click', () => void run(async () => {
  if (!dirty()) { await load(selected); status('Versão salva carregada.'); return; }
  latest = await api(`companies/${encodeURIComponent(selected)}`);
  const result = await api(`companies/${encodeURIComponent(selected)}/preview`, { method: 'POST', payload: { ...comparable(latest.data.fields), evolutionToken: '', useSharedEvolutionKey: !latest.data.fields.hasEvolutionToken } });
  $('saved-preview').textContent = result.data.text; $('comparison').hidden = false; $('comparison').open = true;
  status('Rascunho preservado. Compare a versão salva e escolha se deseja usá-la.');
}));
$('discard').addEventListener('click', () => { if (!latest || !confirm('Descartar seu rascunho e usar a versão salva?')) return;
  original = latest.data.fields; version = latest.etag; fill(original); $('comparison').hidden = true; latest = null; void run(preview);
});
$('logout').addEventListener('click', () => { if (dirty() && !confirm('Sair e descartar as alterações pendentes?')) return;
  void run(async () => { await api('logout', { method: 'POST' }); original = null; selected = null; csrf = null; $('editor').reset(); $('preview').textContent = ''; showLogin(); status('Sessão encerrada.'); });
});
$('release-form').addEventListener('submit', event => {
  event.preventDefault();
  const contact = $('release-contact').value;
  if (!confirm('Liberar a próxima resposta para este contato na distribuidora selecionada?')) return;
  void run(async () => {
    $('release-status').textContent = '';
    await api(`companies/${encodeURIComponent(selected)}/cooldown/reset`, { method: 'POST', payload: { contact } });
    $('release-status').textContent = 'Contato liberado. Aguarde uma nova mensagem dele.';
  });
});
$('release-contact').addEventListener('input', () => { $('release-status').textContent = ''; });
window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
void run(async () => {
  try {
    const result = await api('session'); csrf = result.data.csrf; await list();
    try { await loadEvolutionInstances(); }
    catch { evolutionInstances = []; renderEvolutionChoices(original?.instance); $('instance-help').textContent = 'Não foi possível carregar as instâncias da Evolution. Atualize a lista na aba Instâncias Evolution e tente novamente.'; }
  }
  catch (error) { if (error.status === 401) status('Entre para continuar.'); else throw error; }
});
