import test from 'node:test';
import assert from 'node:assert/strict';

import { Config } from '../lib/index.js';

/** Config is a Standard Schema; `validate` is the surface Cordis calls. */
const validate = (value) => Config['~standard'].validate(value);

test('rejects a missing botToken', () => {
  const result = validate({});
  assert.ok(Array.isArray(result.issues));
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.issues[0].path, ['botToken']);
});

test('rejects a non-object config', () => {
  for (const value of [null, 'token', 42, ['token']]) {
    const result = validate(value);
    assert.ok(Array.isArray(result.issues), `expected issues for ${JSON.stringify(value)}`);
  }
});

test('rejects allowlists that are not string arrays', () => {
  const result = validate({ botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', allowedChatIds: [8637406466] });
  assert.ok(Array.isArray(result.issues));
  assert.deepEqual(result.issues[0].path, ['allowedChatIds']);
});

test('rejects an unusable poll timeout', () => {
  const result = validate({ botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', pollTimeoutSeconds: 0 });
  assert.ok(Array.isArray(result.issues));
  assert.deepEqual(result.issues[0].path, ['pollTimeoutSeconds']);
});

test('fills every default and freezes the result', () => {
  const result = validate({ botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
  assert.equal(result.value.apiBase, 'https://api.telegram.org');
  assert.deepEqual(result.value.allowedChatIds, []);
  assert.deepEqual(result.value.allowedUserIds, []);
  assert.equal(result.value.allowAllChats, false);
  assert.equal(result.value.provider, 'deepseek-official');
  assert.equal(result.value.model, 'deepseek-flash');
  assert.equal(result.value.reasoningEffort, '');
  assert.equal(result.value.cwd, '');
  assert.equal(result.value.pollTimeoutSeconds, 30);
  assert.equal(result.value.maxMessageChars, 4000);
  assert.ok(Object.isFrozen(result.value));
});

test('keeps explicit values and copies caller arrays', () => {
  const allowedChatIds = ['8637406466'];
  const result = validate({
    botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
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

test('treats a non-true allowAllChats as false', () => {
  const result = validate({ botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', allowAllChats: 'yes' });
  assert.ok(Array.isArray(result.issues));
  assert.deepEqual(result.issues[0].path, ['allowAllChats']);
});
