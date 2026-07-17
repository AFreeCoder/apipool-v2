import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runbookPath = 'docs/07-runbook.md';

test('MVP deployment runbook locks New API operator surface protections', async () => {
  const runbook = await readFile(runbookPath, 'utf8');

  assert.match(runbook, /newapi\.apipool\.dev/);
  assert.match(runbook, /运营登录/);
  assert.match(runbook, /Basic Auth/);
  assert.match(runbook, /IP 白名单/);
  assert.match(runbook, /noindex/i);
  assert.match(runbook, /NEWAPI_BASE_URL/);
  assert.match(runbook, /内部服务地址/);
});

test('MVP deployment runbook preserves live smoke order and rollback order', async () => {
  const runbook = await readFile(runbookPath, 'utf8');
  const deploymentOrder = [
    'New API 健康检查',
    'bridge 冒烟',
    '门户构建',
    '充值冒烟',
    '建 Key 冒烟',
    '调用冒烟',
    '禁用拒绝冒烟',
    'webhook 重放检查',
  ];
  const rollbackOrder = [
    'APIPOOL_KEY_CREATION_ENABLED=false',
    '暂停支付',
    '回滚到上一个稳定部署',
    '不删除已有门户 Key',
    '审计日志',
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
