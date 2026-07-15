import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  seedGatewayFixture,
  setupGatewayIntegrationDb,
  startMockNewApi,
} from '../gateway/helpers/mock-newapi';

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test(
  'smoke-gateway 对本地 Next dev + mock New API 跑通 SDK、结算、禁用与余额门禁',
  { skip: process.env.APIPOOL_RUN_GATEWAY_DEV_SMOKE !== 'true' },
  async () => {
    const mock = await startMockNewApi();
    const setup = await setupGatewayIntegrationDb(mock.baseUrl);
    const fixture = await seedGatewayFixture(setup.modules, 'dev-smoke', {
      balanceMicroUsd: 0,
    });
    const port = await freePort();
    const child = spawn(
      'pnpm',
      ['exec', 'next', 'dev', '--turbopack', '--port', String(port)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_PROVIDER: 'sqlite',
          DATABASE_URL: 'file:.tmp/gateway-integration.db',
          DB_SCHEMA_FILE: './src/config/db/schema.sqlite.ts',
          DB_SINGLETON_ENABLED: 'false',
          APIPOOL_CREDENTIALS_SECRET:
            'gateway-integration-credentials-secret',
          NEWAPI_BASE_URL: mock.baseUrl,
          NEWAPI_INTEGRATION_ENABLED: 'true',
          GATEWAY_JOBS_ENABLED: 'false',
          WALLET_LEDGER_WRITE_ENABLED: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let logs = '';
    child.stdout?.on('data', (chunk) => (logs += chunk));
    child.stderr?.on('data', (chunk) => (logs += chunk));

    try {
      const deadline = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
          if (response.status === 401) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.equal(ready, true, logs);
      Object.assign(process.env, {
        NEWAPI_BASE_URL: mock.baseUrl,
        NEWAPI_ADMIN_TOKEN: 'mock-admin-token',
        NEWAPI_ADMIN_USER_ID: '1',
        APIPOOL_SMOKE_PORTAL_USER_ID: fixture.userId,
        APIPOOL_SMOKE_GROUP_SLUG: fixture.groupId,
        APIPOOL_SMOKE_MODEL: fixture.modelId,
        APIPOOL_SMOKE_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/v1`,
        WALLET_LEDGER_WRITE_ENABLED: 'true',
        APIPOOL_SMOKE_USAGE_ATTEMPTS: '30',
        APIPOOL_SMOKE_USAGE_DELAY_MS: '100',
      });
      const { main } = await import('../../scripts/smoke-gateway');
      await main();
    } finally {
      await stop(child);
      setup.close();
      await mock.close();
    }
  }
);
