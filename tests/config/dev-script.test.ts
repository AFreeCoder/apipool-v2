import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('dev script starts Next.js with the local SQLite database configured', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const devScript = packageJson.scripts?.dev ?? '';

  assert.match(devScript, /tsx scripts\/run-with-env\.ts/);
  assert.match(devScript, /DATABASE_PROVIDER=sqlite/);
  assert.match(devScript, /DATABASE_URL=file:data\/local\.db/);
  assert.match(devScript, /DB_SCHEMA_FILE=\.\/src\/config\/db\/schema\.sqlite\.ts/);
  assert.match(devScript, /DB_MIGRATIONS_OUT=\.\/src\/config\/db\/migrations_sqlite/);
  assert.match(devScript, /DB_SINGLETON_ENABLED=true/);
  assert.match(devScript, / -- next dev --turbopack/);
  assert.match(devScript, /next dev --turbopack/);
});
