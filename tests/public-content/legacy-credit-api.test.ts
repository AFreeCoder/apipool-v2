import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const legacyCreditApiFiles = [
  'src/app/api/user/get-user-info/route.ts',
  'src/app/api/user/get-user-credits/route.ts',
];

test('browser user APIs do not expose legacy ShipAny credits as APIPool quota', async () => {
  const violations: string[] = [];

  for (const file of legacyCreditApiFiles) {
    const source = await readFile(file, 'utf8');
    if (/getRemainingCredits|@\/shared\/models\/credit/.test(source)) {
      violations.push(file);
    }
  }

  assert.deepEqual(violations, []);
});

test('legacy credits API directs users to APIPool billing instead of returning quota data', async () => {
  const source = await readFile(
    'src/app/api/user/get-user-credits/route.ts',
    'utf8'
  );

  assert.match(source, /APIPool billing/i);
  assert.doesNotMatch(source, /remainingCredits/);
});
