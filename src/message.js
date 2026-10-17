export function normalizeWebhook(body) {
  if (!body || !['messages.upsert', 'MESSAGES_UPSERT'].includes(body.event) || typeof body.instance !== 'string') return null;
  const key = body.data?.key;
  if (!key || key.fromMe !== false || typeof key.id !== 'string' || !key.id || key.id.length > 200 || typeof key.remoteJid !== 'string') return null;
  const match = /^(\d{8,15})@(s\.whatsapp\.net|c\.us)$/.exec(key.remoteJid);
  if (!match || key.remoteJid === 'status@broadcast') return null;
  return { instance: body.instance, messageId: key.id, contact: match[1] };
}

export function buildReply(company) {
  const lines = [company.welcomeText, ''];
  for (const agent of company.agents) lines.push(`👤 ${agent.label}: https://wa.me/${agent.phoneE164}?text=${encodeURIComponent(company.prefilledText)}`);
  lines.push('', company.closingText);
  return lines.join('\n');
}
