import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('生产镜像包含运行池维护工具，远端写入必须显式 --apply', async () => {
  const [dockerfile, script, jobs] = await Promise.all([
    readFile('Dockerfile', 'utf8'),
    readFile('scripts/maintain-newapi-runtime-pool.ts', 'utf8'),
    readFile('src/features/gateway/server/jobs.ts', 'utf8'),
  ]);

  assert.match(dockerfile, /maintain-newapi-runtime-pool\.ts/);
  assert.match(dockerfile, /runtime-pool-maintenance\.cjs/);
  assert.match(script, /args\.has\(['"]--apply['"]\)/);
  assert.match(script, /apply \? ['"]apply['"] : ['"]check['"]/);
  assert.match(script, /process\.exitCode = 2/);
  assert.match(script, /!apply/);
  assert.match(jobs, /runtime_pool_monitor/);
  assert.match(jobs, /bootstrap:\s*true/);
  assert.doesNotMatch(jobs, /apply:\s*true/);
});
