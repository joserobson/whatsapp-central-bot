import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvolutionClient, evolutionQrResponse, evolutionStateResponse } from '../src/evolution.js';

test('cliente Evolution consulta estado e solicita QR Code com autenticação e instância codificada', async () => {
  const requests = [];
  const client = createEvolutionClient({
    baseUrl: 'http://evolution:8080/',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => url.includes('connectionState') ? { instance: { state: 'open' } } : { qrcode: { base64: 'aGVsbG8=' } } };
    }
  });

  const state = await client.connectionState('Hba Distribuidora', 'company-key');
  const qr = await client.connect('Hba Distribuidora', 'company-key');

  assert.deepEqual(requests.map(request => request.url), [
    'http://evolution:8080/instance/connectionState/Hba%20Distribuidora',
    'http://evolution:8080/instance/connect/Hba%20Distribuidora'
  ]);
  assert.deepEqual(requests.map(request => request.options.headers.apikey), ['company-key', 'company-key']);
  assert.equal(evolutionStateResponse(state).state, 'open');
  assert.deepEqual(evolutionQrResponse(qr), { state: 'connecting', qrCode: 'data:image/png;base64,aGVsbG8=' });
});

test('cliente Evolution não repassa detalhes ou corpos de erro da API', async () => {
  const client = createEvolutionClient({
    baseUrl: 'http://evolution:8080',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized', secret: 'must-not-leak' }) })
  });

  await assert.rejects(client.connectionState('fidelidade-mensagens', 'key'), error => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.message, 'evolution_request_failed');
    assert.equal(JSON.stringify(error).includes('must-not-leak'), false);
    return true;
  });
});

test('cliente Evolution limita resposta de QR Code a base64 de imagem', () => {
  assert.deepEqual(evolutionQrResponse({ base64: 'javascript:alert(1)' }), { state: 'unknown', qrCode: null });
  assert.equal(evolutionStateResponse({ state: 'x'.repeat(100) }).state.length, 40);
});
