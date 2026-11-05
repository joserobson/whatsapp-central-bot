const safeInstancePath = instance => encodeURIComponent(instance);
export const EVOLUTION_WEBHOOK_URL = 'http://whatsapp-central-bot:3000/webhooks/evolution';
export const EVOLUTION_WEBHOOK_EVENTS = ['MESSAGES_UPSERT'];
export const evolutionWebhookConfig = webhookSecret => ({
  webhook: {
    enabled: true,
    url: EVOLUTION_WEBHOOK_URL,
    byEvents: false,
    base64: false,
    events: [...EVOLUTION_WEBHOOK_EVENTS],
    ...(typeof webhookSecret === 'string' && webhookSecret ? { headers: { 'x-webhook-secret': webhookSecret } } : {})
  }
});

const flatEvolutionWebhookConfig = config => ({
  enabled: config.webhook.enabled,
  url: config.webhook.url,
  webhookByEvents: config.webhook.byEvents,
  webhookBase64: config.webhook.base64,
  events: config.webhook.events,
  ...(config.webhook.headers ? { headers: config.webhook.headers } : {})
});

export function createEvolutionClient({ baseUrl, fetchImpl = fetch, timeoutMs = 8000 }) {
  const request = async (path, key, { method = 'GET', body, timeoutMs: requestTimeout = timeoutMs } = {}) => {
    let response;
    try {
      response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { apikey: key, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(requestTimeout)
      });
    } catch {
      throw Object.assign(new Error('evolution_unavailable'), { statusCode: 503 });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const statusCode = response.status === 401 || response.status === 403 ? 502 : response.status === 404 ? 404 : response.status === 503 ? 503 : 502;
      throw Object.assign(new Error(response.status === 503 ? 'evolution_service_unavailable' : 'evolution_request_failed'), { statusCode, upstreamStatus: response.status });
    }
    return data;
  };
  return {
    instances: key => request('/instance/fetchInstances', key),
    createInstance: (data, key) => request('/instance/create', key, { method: 'POST', body: data, timeoutMs: 30_000 }),
    setWebhook: async (instance, key, webhookSecret) => {
      const path = `/webhook/set/${safeInstancePath(instance)}`;
      const config = evolutionWebhookConfig(webhookSecret);
      try { return await request(path, key, { method: 'POST', body: config, timeoutMs: 30_000 }); }
      catch (error) {
        if (error.upstreamStatus !== 400) throw error;
        return request(path, key, { method: 'POST', body: flatEvolutionWebhookConfig(config), timeoutMs: 30_000 });
      }
    },
    connectionState: (instance, key) => request(`/instance/connectionState/${safeInstancePath(instance)}`, key),
    connect: (instance, key) => request(`/instance/connect/${safeInstancePath(instance)}`, key, { timeoutMs: 30_000 }),
    restart: (instance, key) => request(`/instance/restart/${safeInstancePath(instance)}`, key, { method: 'POST', timeoutMs: 30_000 }),
    logout: (instance, key) => request(`/instance/logout/${safeInstancePath(instance)}`, key, { method: 'DELETE', timeoutMs: 30_000 }),
    deleteInstance: (instance, key) => request(`/instance/delete/${safeInstancePath(instance)}`, key, { method: 'DELETE', timeoutMs: 30_000 })
  };
}

export function evolutionStateResponse(data) {
  const rawState = data?.instance?.state ?? data?.state ?? data?.connectionStatus ?? data?.status;
  const state = typeof rawState === 'string' ? rawState : 'unknown';
  return { state: state.slice(0, 40) };
}

export function evolutionQrResponse(data) {
  const candidates = [data?.base64, data?.qrcode?.base64, data?.qrcode, data?.qrCode?.base64, data?.qrCode];
  const value = candidates.find(item => typeof item === 'string' && item.length <= 1_000_000 && /^(?:data:image\/(?:png|jpeg);base64,)?[A-Za-z0-9+/]+={0,2}$/.test(item));
  const state = evolutionStateResponse(data).state;
  return { state: state === 'unknown' && value ? 'connecting' : state, qrCode: value ? (value.startsWith('data:') ? value : `data:image/png;base64,${value}`) : null };
}

export function evolutionInstancesResponse(data) {
  const rows = Array.isArray(data) ? data : Array.isArray(data?.instances) ? data.instances : Array.isArray(data?.data) ? data.data : [];
  return rows.map(row => {
    const instance = row?.instance && typeof row.instance === 'object' ? row.instance : row;
    const string = value => typeof value === 'string' ? value.slice(0, 300) : '';
    return {
      id: string(instance?.instanceId ?? instance?.id),
      name: string(instance?.instanceName ?? instance?.name),
      state: evolutionStateResponse({ state: instance?.state ?? instance?.connectionStatus ?? row?.connectionStatus ?? instance?.status }).state,
      integration: string(instance?.integration),
      number: string(instance?.number ?? instance?.ownerJid),
      profileName: string(instance?.profileName),
      clientName: string(instance?.clientName),
      createdAt: string(instance?.createdAt ?? instance?.created_at),
      updatedAt: string(instance?.updatedAt ?? instance?.updated_at),
      disconnectedAt: string(instance?.disconnectionAt),
      disconnectionReason: string(instance?.disconnectionReasonCode),
      token: typeof instance?.token === 'string' && instance.token.length <= 500 ? instance.token : ''
    };
  }).filter(instance => instance.name);
}

export function validateEvolutionCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name', 'integration', 'number', 'token'].includes(key))) return null;
  const { name, integration, number = '', token = '' } = body;
  if (typeof name !== 'string' || name.length > 100 || name.trim() !== name || !/^[a-zA-Z0-9_-](?:[a-zA-Z0-9 _-]{0,98}[a-zA-Z0-9_-])?$/.test(name)) return null;
  if (integration !== 'WHATSAPP-BAILEYS') return null;
  if (typeof number !== 'string' || number.length > 20 || (number && !/^\+?\d{8,20}$/.test(number))) return null;
  if (typeof token !== 'string' || token.length > 500 || token.trim() !== token || /[\u0000-\u001f\u007f]/.test(token)) return null;
  return { instanceName: name, integration, ...(number ? { number: number.replace(/^\+/, '') } : {}), ...(token ? { token } : {}), qrcode: true };
}
