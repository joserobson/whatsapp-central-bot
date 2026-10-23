import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDraft, hasChanges, errorMessage } from '../src/admin/public/model.js';

test('formulário identifica campos inválidos, alterações pendentes e conflito', () => {
  const draft = { welcomeText: '<script>alert(1)</script>', closingText: '', prefilledText: 'Oi', agents: [1, 2, 3].map(n => ({ label: `Pessoa ${n}`, phoneE164: `551199999${n}000` })) };
  assert.deepEqual(validateDraft(draft), {});
  assert.ok(validateDraft({ ...draft, agents: [] }).agents);
  assert.ok(validateDraft({ ...draft, agents: Array.from({ length: 11 }, (_, n) => ({ label: `Pessoa ${n}`, phoneE164: `551199999${n}000` })) }).agents);
  assert.ok(validateDraft({ ...draft, messageFormat: 'buttons', agents: Array.from({ length: 4 }, (_, n) => ({ label: `Pessoa ${n}`, phoneE164: `551199999${n}000` })) }).agents);
  assert.equal(hasChanges(draft, structuredClone(draft)), false);
  assert.equal(hasChanges({ ...draft, cooldownHours: 24 }, { cooldownHours: 24, ...draft }), false);
  const changed = structuredClone(draft);
  changed.agents[0].phoneE164 = 'abc';
  changed.welcomeText = '';
  assert.equal(hasChanges(draft, changed), true);
  assert.ok(validateDraft(changed)['phone-0']);
  assert.ok(validateDraft(changed).welcomeText);
  assert.match(errorMessage(412), /recarregue/i);
  assert.match(errorMessage(503), /preservado/i);
  const list = { ...draft, messageFormat: 'list', agents: draft.agents.map(agent => ({ ...agent, label: 'a'.repeat(24) })) };
  assert.deepEqual(validateDraft(list), {});
  list.agents[0].label += 'a';
  assert.ok(validateDraft(list)['label-0']);
  assert.deepEqual(validateDraft({ ...draft, includePrefilledText: false, prefilledText: '' }), {});
  assert.ok(validateDraft({ ...draft, includePrefilledText: true, prefilledText: '' }).prefilledText);
});
