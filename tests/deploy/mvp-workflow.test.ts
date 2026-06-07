import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = '.github/workflows/mvp-verify.yaml';

test('MVP workflow gates typecheck, tests, lint, build, and local smoke', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const requiredCommands = [
    'pnpm exec tsc --noEmit --pretty false',
    'pnpm test',
    'pnpm lint',
    'pnpm build',
    'pnpm smoke:mvp',
  ];

  assert.match(workflow, /name:\s*APIPool MVP Verify/);
  for (const command of requiredCommands) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(workflow, /APIPOOL_SMOKE_REQUIRE_LIVE:\s*['"]false['"]/);
});

test('MVP workflow has an explicit manual live smoke gate with required secrets', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const requiredSecrets = [
    'DATABASE_URL',
    'NEWAPI_BASE_URL',
    'NEWAPI_ADMIN_TOKEN',
    'APIPOOL_SMOKE_PORTAL_USER_ID',
    'APIPOOL_SMOKE_OPERATOR_USER_ID',
  ];

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /live-mvp-smoke:/);
  assert.match(workflow, /APIPOOL_SMOKE_REQUIRE_LIVE:\s*['"]true['"]/);
  for (const secret of requiredSecrets) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`));
  }
});
