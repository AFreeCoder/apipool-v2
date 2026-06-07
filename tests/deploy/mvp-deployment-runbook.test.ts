import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runbookPath = 'docs/05-mvp-deployment-runbook.md';

test('MVP deployment runbook locks New API operator surface protections', async () => {
  const runbook = await readFile(runbookPath, 'utf8');

  assert.match(runbook, /newapi\.apipool\.dev/);
  assert.match(runbook, /operator login/i);
  assert.match(runbook, /Basic Auth/);
  assert.match(runbook, /IP allowlist/);
  assert.match(runbook, /noindex/i);
  assert.match(runbook, /NEWAPI_BASE_URL/);
  assert.match(runbook, /internal service URL/i);
});

test('MVP deployment runbook preserves live smoke order and rollback order', async () => {
  const runbook = await readFile(runbookPath, 'utf8');
  const deploymentOrder = [
    'New API health check',
    'bridge smoke',
    'portal build',
    'create Key smoke',
    'API call smoke',
    'disabled key rejection smoke',
  ];
  const rollbackOrder = [
    'APIPOOL_KEY_CREATION_ENABLED=false',
    'roll back the portal',
    'do not delete existing New API keys',
    'do not delete ledger entries',
  ];

  let cursor = -1;
  for (const phrase of deploymentOrder) {
    const next = runbook.indexOf(phrase);
    assert.ok(next > cursor, `${phrase} should appear in deployment order`);
    cursor = next;
  }

  cursor = -1;
  for (const phrase of rollbackOrder) {
    const next = runbook.indexOf(phrase);
    assert.ok(next > cursor, `${phrase} should appear in rollback order`);
    cursor = next;
  }
});
