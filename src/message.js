import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

let exampleImage;
const exampleMedia = () => exampleImage ??= readFileSync(new URL('./admin/public/example-banner.jpg', import.meta.url)).toString('base64');

export const agentRowId = agent => `agent_${createHash('sha256').update(`${agent.phoneE164}:${agent.label}`).digest('hex').slice(0, 24)}`;
export const messageRef = messageId => createHash('sha256').update(messageId).digest('hex').slice(0, 12);

export function webhookRejectionReason(body) {
  if (!body || !['messages.upsert', 'MESSAGES_UPSERT'].includes(body.event)) return 'unsupported_event';
  if (typeof body.instance !== 'string') return 'invalid_instance';
  const key = body.data?.key;
  if (!key || typeof key.id !== 'string' || !key.id || key.id.length > 200 || typeof key.remoteJid !== 'string') return 'invalid_message_key';
  if (key.fromMe !== false) return 'outgoing_message';
  if (!/^\d{8,15}@(s\.whatsapp\.net|c\.us)$/.test(key.remoteJid) || key.remoteJid === 'status@broadcast') return 'unsupported_contact_address';
  const message = body.data?.message;
  if (message?.listResponseMessage && (typeof message.listResponseMessage.singleSelectReply?.selectedRowId !== 'string' || !/^agent_[a-f0-9]{24}$/.test(message.listResponseMessage.singleSelectReply.selectedRowId))) return 'invalid_list_selection';
  return 'invalid_payload';
}

export function normalizeWebhook(body) {
  if (!body || !['messages.upsert', 'MESSAGES_UPSERT'].includes(body.event) || typeof body.instance !== 'string') return null;
  const key = body.data?.key;
  if (!key || key.fromMe !== false || typeof key.id !== 'string' || !key.id || key.id.length > 200 || typeof key.remoteJid !== 'string') return null;
  const match = /^(\d{8,15})@(s\.whatsapp\.net|c\.us)$/.exec(key.remoteJid);
  if (!match || key.remoteJid === 'status@broadcast') return null;
  const message = body.data?.message;
  const selection = message?.listResponseMessage?.singleSelectReply?.selectedRowId;
  if (message?.listResponseMessage && (typeof selection !== 'string' || !/^agent_[a-f0-9]{24}$/.test(selection))) return null;
  return { instance: body.instance, messageId: key.id, contact: match[1], ...(selection ? { selectionId: selection } : {}) };
}

export const contactUrl = (company, agent) => `https://wa.me/${agent.phoneE164}${company.includePrefilledText === false ? '' : `?text=${encodeURIComponent(company.prefilledText)}`}`;

export function buildDelivery(company, uploadedImage) {
  if (company.messageFormat === 'image' && company.imageId && !uploadedImage) throw new Error('uploaded_image_unavailable');
  if (company.messageFormat === 'image') return {
    endpoint: 'sendMedia',
    body: { mediatype: 'image', ...(uploadedImage || !company.imageUrl ? { mimetype: 'image/jpeg' } : {}), media: uploadedImage ? uploadedImage.toString('base64') : company.imageUrl || exampleMedia(), fileName: 'banner.jpg', caption: buildReply(company) }
  };
  if (company.messageFormat === 'vcard') return {
    endpoint: 'sendContact',
    body: { contact: company.agents.map(agent => ({ fullName: agent.label, wuid: agent.phoneE164, phoneNumber: `+${agent.phoneE164}`, organization: company.displayName })) }
  };
  if (company.messageFormat === 'list') return {
    endpoint: 'sendList',
    body: {
      title: company.displayName, description: company.welcomeText, footerText: company.closingText,
      buttonText: 'Escolher atendente',
      sections: [{ title: 'Representantes', rows: company.agents.map(agent => ({ title: agent.label, rowId: agentRowId(agent) })) }]
    }
  };
  if (company.messageFormat !== 'buttons') return { endpoint: 'sendText', body: { text: buildReply(company) } };
  return {
    endpoint: 'sendButtons',
    body: {
      title: company.displayName,
      description: company.welcomeText,
      footer: company.closingText,
      buttons: company.agents.map(agent => ({ type: 'url', displayText: agent.label, url: contactUrl(company, agent) }))
    }
  };
}

export function buildDeliveries(company, uploadedImage) {
  if (company.messageFormat !== 'vcard') return [buildDelivery(company, uploadedImage)];
  return [{ endpoint: 'sendText', body: { text: buildReply(company), linkPreview: false } }, buildDelivery(company)];
}

export function buildReply(company) {
  if (company.messageFormat === 'vcard') return [company.welcomeText, company.closingText].filter(text => text.trim()).join('\n\n');
  const lines = [company.welcomeText, ''];
  lines.push(company.agents.map(agent => `☎️ ${contactUrl(company, agent)}`).join('\n\n'));
  if (company.closingText.trim()) lines.push('', company.closingText);
  return lines.join('\n');
}

