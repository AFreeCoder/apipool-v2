import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
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
  const signalTree = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  };
  signalTree('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) {
    signalTree('SIGKILL');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

test(
  'smoke-gateway 对本地 Next dev + mock New API 跑通 SDK、结算、禁用与余额门禁',
  { skip: process.env.APIPOOL_RUN_GATEWAY_DEV_SMOKE !== 'true' },
  async () => {
    const mock = await startMockNewApi();
    const setup = await setupGatewayIntegrationDb(mock.baseUrl);
    const fixture = await seedGatewayFixture(setup.modules, 'dev-smoke', {
      balanceMicroUsd: 0,
      email: 'smo@apipool.local',
    });
    const distDir = `.next-dev-smoke-${randomUUID()}`;
    const tsconfigPath = join(process.cwd(), 'tsconfig.json');
    const originalTsconfig = await readFile(tsconfigPath, 'utf8');
    let port = 0;
    let child: ChildProcess | undefined;
    let logs = '';
    let ready = false;

    try {
      for (let attempt = 0; attempt < 3 && !ready; attempt += 1) {
        port = await freePort();
        logs = '';
        child = spawn(
          'pnpm',
          ['exec', 'next', 'dev', '--turbopack', '--port', String(port)],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              APIPOOL_NEXT_DIST_DIR: distDir,
              DATABASE_PROVIDER: 'sqlite',
              DATABASE_URL: 'file:.tmp/gateway-integration.db',
              DB_SCHEMA_FILE: './src/config/db/schema.sqlite.ts',
              DB_SINGLETON_ENABLED: 'false',
              APIPOOL_CREDENTIALS_SECRET:
                'gateway-integration-credentials-secret',
              NEWAPI_BASE_URL: mock.baseUrl,
              NEWAPI_INTEGRATION_ENABLED: 'true',
              GATEWAY_JOBS_ENABLED: 'false',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          }
        );
        child.stdout?.on('data', (chunk) => (logs += chunk));
        child.stderr?.on('data', (chunk) => (logs += chunk));
        child.on('error', (error) => (logs += String(error)));

        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && child.exitCode === null) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
            if (response.status === 401) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!ready) {
          await stop(child);
          child = undefined;
          const retryable =
            /EADDRINUSE|address already in use|Unable to acquire lock/i.test(
              logs
            );
          if (!retryable || attempt === 2) break;
        }
      }
      assert.equal(ready, true, logs);
      Object.assign(process.env, {
        NEWAPI_BASE_URL: mock.baseUrl,
        NEWAPI_ADMIN_TOKEN: 'mock-admin-token',
        NEWAPI_ADMIN_USER_ID: '1',
        APIPOOL_SMOKE_PORTAL_USER_ID: fixture.userId,
        APIPOOL_SMOKE_PORTAL_EMAIL: 'smo@apipool.local',
        APIPOOL_SMOKE_GROUP_SLUG: fixture.groupId,
        APIPOOL_SMOKE_MODEL: fixture.modelId,
        APIPOOL_SMOKE_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/v1`,
        APIPOOL_SMOKE_USAGE_ATTEMPTS: '30',
        APIPOOL_SMOKE_USAGE_DELAY_MS: '100',
      });
      const { main } = await import('../../scripts/smoke-gateway');
      await main();
    } finally {
      if (child) await stop(child);
      setup.close();
      await mock.close();
      await writeFile(tsconfigPath, originalTsconfig, 'utf8');
      await rm(join(process.cwd(), distDir), { recursive: true, force: true });
      delete process.env.APIPOOL_SMOKE_PORTAL_EMAIL;
    }
  }
);
