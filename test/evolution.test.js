import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvolutionClient, evolutionInstancesResponse, evolutionQrResponse, evolutionStateResponse, validateEvolutionCreate } from '../src/evolution.js';

test('cliente Evolution lista, cria, conecta, reinicia, desconecta e exclui instâncias', async () => {
  const requests = [];
  const client = createEvolutionClient({
    baseUrl: 'http://evolution:8080/',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => url.includes('connectionState') ? { instance: { state: 'open' } } : url.includes('/connect/') ? { qrcode: { base64: 'aGVsbG8=' } } : {} };
    }
  });

  await client.instances('global-key');
  const createData = { instanceName: 'Temporary', integration: 'WHATSAPP-BAILEYS', qrcode: true };
  await client.createInstance(createData, 'global-key');
  const state = await client.connectionState('Hba Distribuidora', 'global-key');
  const qr = await client.connect('Hba Distribuidora', 'global-key');
  await client.restart('Hba Distribuidora', 'global-key');
  await client.logout('Hba Distribuidora', 'global-key');
  await client.deleteInstance('Hba Distribuidora', 'global-key');

  assert.deepEqual(requests.map(request => [request.options.method ?? 'GET', request.url]), [
    ['GET', 'http://evolution:8080/instance/fetchInstances'],
    ['POST', 'http://evolution:8080/instance/create'],
    ['GET', 'http://evolution:8080/instance/connectionState/Hba%20Distribuidora'],
    ['GET', 'http://evolution:8080/instance/connect/Hba%20Distribuidora'],
    ['POST', 'http://evolution:8080/instance/restart/Hba%20Distribuidora'],
    ['DELETE', 'http://evolution:8080/instance/logout/Hba%20Distribuidora'],
    ['DELETE', 'http://evolution:8080/instance/delete/Hba%20Distribuidora']
  ]);
  assert.equal(requests.every(request => request.options.headers.apikey === 'global-key'), true);
  assert.equal(requests[1].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[1].options.body), createData);
  assert.equal(evolutionStateResponse(state).state, 'open');
  assert.deepEqual(evolutionQrResponse(qr), { state: 'connecting', qrCode: 'data:image/png;base64,aGVsbG8=' });
});

test('listagem retorna somente os campos de instância escolhidos e token para campo mascarado', () => {
  const result = evolutionInstancesResponse([{
    id: 'instance-id', name: 'Teste-Distri', connectionStatus: 'connecting', integration: 'WHATSAPP-BAILEYS',
    number: '5511999999999', profileName: 'Distri', createdAt: '2026-11-02T10:00:00Z', token: 'instance-secret', hash: 'not-returned',
    disconnectionReasonCode: '401'
  }]);

  assert.deepEqual(result, [{
    id: 'instance-id', name: 'Teste-Distri', state: 'connecting', integration: 'WHATSAPP-BAILEYS',
    number: '5511999999999', profileName: 'Distri', clientName: '', createdAt: '2026-11-02T10:00:00Z',
    updatedAt: '', disconnectedAt: '', disconnectionReason: '401', token: 'instance-secret'
  }]);
});

test('criação de instância aceita apenas campos válidos e nunca cria Business sem seus dados', () => {
  assert.deepEqual(validateEvolutionCreate({ name: 'Nova Distribuidora', integration: 'WHATSAPP-BAILEYS', number: '+5511999999999', token: 'token custom' }), {
    instanceName: 'Nova Distribuidora', integration: 'WHATSAPP-BAILEYS', number: '5511999999999', token: 'token custom', qrcode: true
  });
  assert.equal(validateEvolutionCreate({ name: 'Nova', integration: 'WHATSAPP-BUSINESS' }), null);
  assert.equal(validateEvolutionCreate({ name: 'Nova', integration: 'WHATSAPP-BAILEYS', unexpected: true }), null);
});

test('cliente Evolution sanitiza erros e limita QR Code a imagem base64', async () => {
  const client = createEvolutionClient({
    baseUrl: 'http://evolution:8080',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized', secret: 'must-not-leak' }) })
  });

  await assert.rejects(client.instances('key'), error => {
    assert.equal(error.statusCode, 502);
    assert.equal(error.message, 'evolution_request_failed');
    assert.equal(JSON.stringify(error).includes('must-not-leak'), false);
    return true;
  });
  assert.deepEqual(evolutionQrResponse({ base64: 'javascript:alert(1)' }), { state: 'unknown', qrCode: null });
  assert.equal(evolutionStateResponse({ state: 'x'.repeat(100) }).state.length, 40);
});
