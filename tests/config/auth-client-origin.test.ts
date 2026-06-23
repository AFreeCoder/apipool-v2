import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('browser auth client uses the current origin for auth mutations', async () => {
  const source = await readFile('src/core/auth/client.ts', 'utf8');

  assert.match(source, /getAuthClientBaseURL/);
  assert.match(source, /window\.location\.origin/);
  assert.doesNotMatch(source, /baseURL:\s*envConfigs\.auth_url/);
});
