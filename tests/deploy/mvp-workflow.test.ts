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

test('MVP workflow stays no-secret; production live smoke runs on VPS scripts', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const dockerfile = await readFile('Dockerfile', 'utf8');
  const liveSmoke = await readFile('deploy/live-smoke.sh', 'utf8');
  const setupSmokeUsers = await readFile('deploy/setup-smoke-users.sh', 'utf8');
  const forbiddenSecrets = [
    'DATABASE_URL',
    'NEWAPI_BASE_URL',
    'NEWAPI_ADMIN_TOKEN',
    'APIPOOL_SMOKE_PORTAL_USER_ID',
    'APIPOOL_SMOKE_OPERATOR_USER_ID',
  ];

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /environment:\s*production/);
  assert.doesNotMatch(workflow, /live-mvp-smoke:/);
  for (const secret of forbiddenSecrets) {
    assert.doesNotMatch(workflow, new RegExp(`secrets\\.${secret}`));
  }

  assert.match(liveSmoke, /APIPOOL_SMOKE_REQUIRE_LIVE=true/);
  assert.match(liveSmoke, /APIPOOL_SMOKE_PRICE_RECONCILIATION/);
  assert.match(liveSmoke, /APIPOOL_SMOKE_GROUP_SLUG/);
  assert.match(liveSmoke, /smoke-mvp\.cjs/);
  assert.match(setupSmokeUsers, /pre-smoke-users/);
  assert.match(setupSmokeUsers, /role_operator/);
  assert.match(dockerfile, /scripts\/smoke-mvp-runner\.ts/);
  assert.match(dockerfile, /smoke-mvp\.cjs/);
});
