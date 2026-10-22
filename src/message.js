export function normalizeWebhook(body) {
  if (!body || !['messages.upsert', 'MESSAGES_UPSERT'].includes(body.event) || typeof body.instance !== 'string') return null;
  const key = body.data?.key;
  if (!key || key.fromMe !== false || typeof key.id !== 'string' || !key.id || key.id.length > 200 || typeof key.remoteJid !== 'string') return null;
  const match = /^(\d{8,15})@(s\.whatsapp\.net|c\.us)$/.exec(key.remoteJid);
  if (!match || key.remoteJid === 'status@broadcast') return null;
  return { instance: body.instance, messageId: key.id, contact: match[1] };
}

export const contactUrl = (company, agent) => `https://wa.me/${agent.phoneE164}?text=${encodeURIComponent(company.prefilledText)}`;

export function buildDelivery(company) {
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

export function buildReply(company) {
  const lines = [company.welcomeText, ''];
  for (const agent of company.agents) {
    lines.push(`☎️ ${contactUrl(company, agent)}`);
  }
  if (company.closingText.trim()) lines.push('', company.closingText);
  return lines.join('\n');
}

