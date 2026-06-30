import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

test('catalog permissions are exposed as RBAC constants', async () => {
  const permission = await readFile(
    join(process.cwd(), 'src/core/rbac/permission.ts'),
    'utf8'
  );

  assert.match(permission, /CATALOG_READ:\s*'admin\.catalog\.read'/);
  assert.match(permission, /CATALOG_WRITE:\s*'admin\.catalog\.write'/);
});

test('RBAC seed grants catalog permissions to admin roles', async () => {
  const rbac = await readFile(
    join(process.cwd(), 'scripts/init-rbac.ts'),
    'utf8'
  );

  assert.match(rbac, /code:\s*'admin\.catalog\.read'/);
  assert.match(rbac, /code:\s*'admin\.catalog\.write'/);
  assert.match(rbac, /'admin\.catalog\.\*'/);
  assert.match(rbac, /permissions:\s*\['\*'\]/);
});
