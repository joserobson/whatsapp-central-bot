const safeInstancePath = instance => encodeURIComponent(instance);

export function createEvolutionClient({ baseUrl, fetchImpl = fetch, timeoutMs = 8000 }) {
  const request = async (path, key) => {
    let response;
    try {
      response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
        headers: { apikey: key, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw Object.assign(new Error('evolution_unavailable'), { statusCode: 503 });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const statusCode = response.status === 401 || response.status === 403 ? 502 : response.status === 404 ? 404 : response.status === 503 ? 503 : 502;
      throw Object.assign(new Error(response.status === 503 ? 'evolution_service_unavailable' : 'evolution_request_failed'), { statusCode });
    }
    return data;
  };
  return {
    connectionState: (instance, key) => request(`/instance/connectionState/${safeInstancePath(instance)}`, key),
    connect: (instance, key) => request(`/instance/connect/${safeInstancePath(instance)}`, key)
  };
}

export function evolutionStateResponse(data) {
  const state = typeof data?.instance?.state === 'string' ? data.instance.state : typeof data?.state === 'string' ? data.state : 'unknown';
  return { state: state.slice(0, 40) };
}

export function evolutionQrResponse(data) {
  const candidates = [data?.base64, data?.qrcode?.base64, data?.qrcode, data?.qrCode?.base64, data?.qrCode];
  const value = candidates.find(item => typeof item === 'string' && item.length <= 1_000_000 && /^(?:data:image\/(?:png|jpeg);base64,)?[A-Za-z0-9+/]+={0,2}$/.test(item));
  const state = evolutionStateResponse(data).state;
  return { state: state === 'unknown' && value ? 'connecting' : state, qrCode: value ? (value.startsWith('data:') ? value : `data:image/png;base64,${value}`) : null };
}
