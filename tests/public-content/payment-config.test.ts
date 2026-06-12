import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('public config whitelist exposes payment provider flags for MVP checkout', async () => {
  const source = await readFile('src/shared/services/settings.ts', 'utf8');
  const whitelistMatch = source.match(
    /export const publicSettingNames = \[([\s\S]*?)\];/
  );

  assert.ok(whitelistMatch, 'publicSettingNames whitelist should exist');

  const whitelist = whitelistMatch[1];
  const required = [
    'select_payment_enabled',
    'default_payment_provider',
    'stripe_enabled',
    'creem_enabled',
    'paypal_enabled',
  ];

  const missing = required.filter((name) => !whitelist.includes(`'${name}'`));
  assert.deepEqual(missing, []);
});
