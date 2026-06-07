import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const SERVER_BRIDGE_FILES = [
  'src/features/newapi-bridge/server/client.ts',
  'src/features/newapi-bridge/server/portal.ts',
];

test('New API bridge server modules declare a server-only boundary', async () => {
  const missing: string[] = [];

  for (const file of SERVER_BRIDGE_FILES) {
    const content = await readFile(join(process.cwd(), file), 'utf8');
    if (!content.startsWith("import 'server-only';")) {
      missing.push(file);
    }
  }

  assert.deepEqual(missing, []);
});
