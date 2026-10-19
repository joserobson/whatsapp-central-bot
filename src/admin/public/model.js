export const hasChanges = (original, draft) => JSON.stringify(original) !== JSON.stringify(draft);
export function validateDraft(draft) {
  const errors = {};
  for (const [key, limit] of Object.entries({ welcomeText: 1000, closingText: 500, prefilledText: 500 })) {
    if ((key !== 'closingText' && !draft[key].trim()) || draft[key].length > limit) errors[key] = `Preencha com até ${limit} caracteres.`;
  }
  draft.agents.forEach((agent, n) => {
    if (!agent.label.trim() || agent.label.length > 80) errors[`label-${n}`] = 'Informe um nome com até 80 caracteres.';
    if (!/^\d{8,15}$/.test(agent.phoneE164)) errors[`phone-${n}`] = 'Informe DDI, DDD e número, somente dígitos.';
  });
  return errors;
}
export function errorMessage(status) {
  return ({ 401: 'Sua sessão expirou. Entre novamente; o rascunho permanece nesta página.', 403: 'Acesso recusado. Entre novamente para renovar a sessão.', 412: 'A configuração mudou. Seu rascunho foi preservado; recarregue a versão atual para comparar.', 422: 'Confira os campos: textos, três representantes e telefones válidos sem duplicidade não autorizada.', 429: 'Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.' })[status] ?? 'Não foi possível concluir. Seu rascunho foi preservado; tente novamente.';
}
