import test from 'node:test';
import assert from 'node:assert/strict';

import { Config } from '../lib/index.js';

/** Config is a Standard Schema; `validate` is the surface Cordis calls. */
const validate = (value) => Config['~standard'].validate(value);

/** Every accepted config needs a token and an existing working directory. */
const base = { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', cwd: '/tmp' };

test('rejects a missing botToken', () => {
  const result = validate({});
  assert.ok(Array.isArray(result.issues));
  assert.ok(result.issues.some((issue) => issue.path[0] === 'botToken'));
});

test('rejects a non-object config', () => {
  for (const value of [null, 'token', 42, ['token']]) {
    const result = validate(value);
    assert.ok(Array.isArray(result.issues), `expected issues for ${JSON.stringify(value)}`);
  }
});

test('rejects allowlists that are not string arrays', () => {
  const result = validate({ ...base, allowedChatIds: [8637406466] });
  assert.ok(Array.isArray(result.issues));
  assert.deepEqual(result.issues[0].path, ['allowedChatIds']);
});

test('rejects an unusable poll timeout', () => {
  const result = validate({ ...base, pollTimeoutSeconds: 0 });
  assert.ok(Array.isArray(result.issues));
  assert.deepEqual(result.issues[0].path, ['pollTimeoutSeconds']);
});

test('fills every default and freezes the result', () => {
  const result = validate(base);
  assert.equal(result.value.apiBase, 'https://api.telegram.org');
  assert.deepEqual(result.value.allowedChatIds, []);
  assert.deepEqual(result.value.allowedUserIds, []);
  assert.equal(result.value.allowAllChats, false);
  assert.equal(result.value.provider, '');
  assert.equal(result.value.model, '');
  assert.equal(result.value.reasoningEffort, '');
  assert.equal(result.value.cwd, '/tmp');
  assert.equal(result.value.pollTimeoutSeconds, 30);
  assert.equal(result.value.maxMessageChars, 4000);
  assert.ok(Object.isFrozen(result.value));
});

test('requires cwd instead of falling back to the host process directory', () => {
  const result = validate({ botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
  assert.ok(Array.isArray(result.issues));
  assert.deepEqual(result.issues.map((issue) => issue.path), [['cwd']]);
});

test('leaves the model unset so the profile default applies', () => {
  const result = validate(base);
  assert.equal(result.value.provider, '');
  assert.equal(result.value.model, '');
});

test('keeps explicit values and copies caller arrays', () => {
  const allowedChatIds = ['8637406466'];
  const result = validate({
    ...base,
    allowedChatIds,
    provider: 'newapi',
    model: 'DeepSeek-V4.1-Flash',
    pollTimeoutSeconds: 20,
  });
  assert.deepEqual(result.value.allowedChatIds, ['8637406466']);
  assert.notEqual(result.value.allowedChatIds, allowedChatIds);
  assert.equal(result.value.provider, 'newapi');
  assert.equal(result.value.model, 'DeepSeek-V4.1-Flash');
  assert.equal(result.value.pollTimeoutSeconds, 20);
});

test('rejects a half-configured model override', () => {
  const providerOnly = validate({ ...base, provider: 'newapi' });
  assert.ok(Array.isArray(providerOnly.issues));
  assert.deepEqual(providerOnly.issues[0].path, ['provider']);

  const modelOnly = validate({ ...base, model: 'DeepSeek-V4.1-Flash' });
  assert.ok(Array.isArray(modelOnly.issues));
  assert.deepEqual(modelOnly.issues[0].path, ['provider']);
});

test('rejects reasoningEffort without an explicit model', () => {
  const result = validate({ ...base, reasoningEffort: 'high' });
  assert.ok(Array.isArray(result.issues));
  assert.deepEqual(result.issues[0].path, ['reasoningEffort']);
});

test('treats a non-true allowAllChats as false', () => {
  const result = validate({ ...base, allowAllChats: 'yes' });
  assert.ok(Array.isArray(result.issues));
  assert.deepEqual(result.issues[0].path, ['allowAllChats']);
});
