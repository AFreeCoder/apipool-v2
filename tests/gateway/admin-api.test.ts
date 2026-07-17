import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;
let client: ReturnType<typeof createClient>;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'gateway-admin-api.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';

  client = createClient({ url: `file:${dbPath}` });
  const migrationsDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  for (const file of (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await client.executeMultiple(
      await readFile(join(migrationsDir, file), 'utf8')
    );
  }

  const schema = await import('@/config/db/schema');
  const { db } = await import('@/core/db');
  const admission = await import('@/features/gateway/server/admission');
  const routes = {
    requests: await import('@/app/api/apipool/admin/gateway/requests/route'),
    wallet: await import('@/app/api/apipool/admin/gateway/wallet/route'),
    adjust: await import('@/app/api/apipool/admin/gateway/wallet/adjust/route'),
    freeze: await import('@/app/api/apipool/admin/gateway/wallet/freeze/route'),
    reconciliation: await import(
      '@/app/api/apipool/admin/gateway/reconciliation/route'
    ),
    resolve: await import(
      '@/app/api/apipool/admin/gateway/reconciliation/resolve/route'
    ),
    metrics: await import('@/app/api/apipool/admin/gateway/metrics/route'),
    audit: await import('@/app/api/apipool/admin/gateway/audit/route'),
  };
  modules = { admission, db, routes, schema };

  await seedUser('admin-user-a', 1_000);
  await seedUser('admin-user-b', 500);
  allowAll();
}

test.before(setupDb);
test.after(() => client.close());

async function seedUser(userId: string, balance: number) {
  await modules
    ?.db?.()
    .insert(modules.schema.user)
    .values({
      id: userId,
      name: userId,
      email: `${userId}@admin-api.test`,
    });
  await modules?.db?.().insert(modules.schema.walletAccount).values({
    userId,
    balanceMicroUsd: balance,
  });
}

function setAuth(route: any, allowed: boolean) {
  route.__setDepsForTest({
    getUserInfo: async () => ({ id: 'op1' }),
    hasPermission: async () => allowed,
  });
}

function allowAll() {
  for (const route of Object.values(modules.routes) as any[]) {
    setAuth(route, true);
  }
}

function request(url: string, body?: unknown) {
  return new Request(
    url,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
  );
}

async function json(response: Response) {
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  return response.json() as Promise<any>;
}

function ledgerValues(input: {
  id: string;
  userId?: string;
  status?: string;
  newapiRequestId?: string | null;
  reconcileStatus?: string;
  nextBackfillAt?: Date | null;
}) {
  const status = input.status ?? 'settled';
  return {
    id: input.id,
    newapiRequestId:
      input.newapiRequestId === undefined
        ? `newapi-${input.id}`
        : input.newapiRequestId,
    userId: input.userId ?? 'admin-user-a',
    portalKeyId: `key-${input.id}`,
    portalGroupId: 'group-admin',
    portalModelId: 'model-admin',
    newapiGroup: 'official',
    newapiModelId: 'model-admin',
    credentialId: 'credential-admin',
    routeVersion: 1,
    priceVersionId: 'price-admin',
    endpoint: 'chat_completions',
    status,
    chargedMicroUsd: status === 'settled' ? 10 : null,
    reconcileStatus: input.reconcileStatus ?? 'matched',
    nextBackfillAt: input.nextBackfillAt,
  };
}

test('无权限时每个管理路由均返回 respErr', async () => {
  const cases: Array<[any, () => Promise<Response>]> = [
    [
      modules.routes.requests,
      () => modules.routes.requests.GET(request('http://local/api')),
    ],
    [
      modules.routes.wallet,
      () => modules.routes.wallet.GET(request('http://local/api')),
    ],
    [
      modules.routes.adjust,
      () => modules.routes.adjust.POST(request('http://local/api', {})),
    ],
    [
      modules.routes.freeze,
      () => modules.routes.freeze.POST(request('http://local/api', {})),
    ],
    [
      modules.routes.reconciliation,
      () => modules.routes.reconciliation.GET(request('http://local/api')),
    ],
    [
      modules.routes.resolve,
      () => modules.routes.resolve.POST(request('http://local/api', {})),
    ],
    [
      modules.routes.metrics,
      () => modules.routes.metrics.GET(request('http://local/api')),
    ],
    [
      modules.routes.audit,
      () => modules.routes.audit.GET(request('http://local/api')),
    ],
  ];
  for (const [route, invoke] of cases) {
    setAuth(route, false);
    const body = await json(await invoke());
    assert.equal(body.code, -1);
    assert.match(body.message, /permission/i);
    setAuth(route, true);
  }
});

test('网关钱包接口拒绝任意调额，仅保留请求扣费冲正', async () => {
  const rejected = await json(
    await modules.routes.adjust.POST(
      request('http://local/api', {
        userId: 'admin-user-b',
        signedAmountMicroUsd: -25,
        reason: 'manual debit',
        operationId: 'operation_manual_001',
      })
    )
  );
  assert.equal(rejected.code, -1);
  assert.match(rejected.message, /APIPool 调额/);
  await modules.db().insert(modules.schema.walletLedger).values({
    id: 'charge-to-reverse',
    userId: 'admin-user-b',
    entryType: 'request_charge',
    signedAmountMicroUsd: -200,
    balanceAfterMicroUsd: 275,
    requestLedgerId: 'request-for-reverse',
  });
  await modules
    .db()
    .update(modules.schema.walletAccount)
    .set({ balanceMicroUsd: 275 })
    .where(eq(modules.schema.walletAccount.userId, 'admin-user-b'));
  const reversed = await json(
    await modules.routes.adjust.POST(
      request('http://local/api', {
        reverseWalletLedgerId: 'charge-to-reverse',
        signedAmountMicroUsd: 999_999,
      })
    )
  );
  assert.equal(reversed.code, 0);
  const [account] = await modules
    .db()
    .select()
    .from(modules.schema.walletAccount)
    .where(eq(modules.schema.walletAccount.userId, 'admin-user-b'));
  assert.equal(account.balanceMicroUsd, 475);
  const [reverse] = await modules
    .db()
    .select()
    .from(modules.schema.walletLedger)
    .where(
      eq(
        modules.schema.walletLedger.idempotencyKey,
        'reverse:charge-to-reverse'
      )
    );
  assert.equal(reverse.signedAmountMicroUsd, 200);
});

test('freeze/unfreeze 要求 reason，成功操作均有审计', async () => {
  const missing = await json(
    await modules.routes.freeze.POST(
      request('http://local/api', {
        userId: 'admin-user-a',
        action: 'freeze',
      })
    )
  );
  assert.equal(missing.code, -1);
  assert.match(missing.message, /reason/);
  assert.equal(
    (
      await json(
        await modules.routes.freeze.POST(
          request('http://local/api', {
            userId: 'admin-user-a',
            action: 'freeze',
            reason: 'risk review',
          })
        )
      )
    ).code,
    0
  );
  assert.equal(
    (
      await json(
        await modules.routes.freeze.POST(
          request('http://local/api', {
            userId: 'admin-user-a',
            action: 'unfreeze',
            reason: 'review done',
          })
        )
      )
    ).code,
    0
  );
  const audits = await modules
    .db()
    .select()
    .from(modules.schema.portalAdminAuditLog);
  assert.ok(audits.some((row: any) => row.action === 'wallet.freeze'));
  assert.ok(audits.some((row: any) => row.action === 'wallet.unfreeze'));
});

test('requests 支持门户 ID 与 New API request ID 精确检索', async () => {
  await modules
    .db()
    .insert(modules.schema.requestLedger)
    .values(
      ledgerValues({
        id: 'preq_admin_lookup',
        newapiRequestId: 'newapi-admin-lookup',
      })
    );
  const byPortal = await json(
    await modules.routes.requests.GET(
      request('http://local/api?id=preq_admin_lookup')
    )
  );
  const byNewApi = await json(
    await modules.routes.requests.GET(
      request('http://local/api?newapiRequestId=newapi-admin-lookup')
    )
  );
  assert.equal(byPortal.data.request.id, 'preq_admin_lookup');
  assert.equal(byNewApi.data.request.id, 'preq_admin_lookup');
});

test('reconciliation 分列并将 explained 仅写 reconcile_status', async () => {
  await modules
    .db()
    .insert(modules.schema.requestLedger)
    .values([
      ledgerValues({
        id: 'reconcile-mismatch',
        reconcileStatus: 'token_mismatch',
      }),
      ledgerValues({
        id: 'reconcile-waived',
        status: 'failed_unbilled',
        reconcileStatus: 'waived_by_failure',
      }),
      ledgerValues({
        id: 'reconcile-stuck',
        status: 'pending_backfill',
        reconcileStatus: 'pending',
        nextBackfillAt: null,
      }),
    ]);
  await modules.db().insert(modules.schema.reconcileOrphanObservation).values({
    id: 'reconcile-orphan',
    newapiRequestId: 'newapi-orphan-admin',
    tokenName: 'rk_admin_orphan',
  });
  const listed = await json(
    await modules.routes.reconciliation.GET(request('http://local/api'))
  );
  assert.ok(
    listed.data.mismatches.some((row: any) => row.id === 'reconcile-mismatch')
  );
  assert.ok(listed.data.waived.some((row: any) => row.source === 'ledger'));
  assert.ok(listed.data.waived.some((row: any) => row.source === 'orphan'));
  assert.ok(listed.data.stuck.some((row: any) => row.id === 'reconcile-stuck'));
  assert.ok(Array.isArray(listed.data.invariant.broken));

  const resolved = await json(
    await modules.routes.resolve.POST(
      request('http://local/api', {
        ledgerId: 'reconcile-mismatch',
        resolution: 'explained',
        note: 'verified upstream rounding',
      })
    )
  );
  assert.equal(resolved.code, 0);
  const [row] = await modules
    .db()
    .select()
    .from(modules.schema.requestLedger)
    .where(eq(modules.schema.requestLedger.id, 'reconcile-mismatch'));
  assert.equal(row.reconcileStatus, 'explained');
  assert.equal(row.status, 'settled');
  assert.equal(row.resolvedAt, null);
});

test('manual_closed 原子转 failed_unbilled 并立即释放风险槽；孤儿可闭环', async () => {
  const userId = 'admin-user-a';
  const before = await modules.admission.admitRequest(
    {
      id: 'preq_before_manual_close',
      userId,
      portalKeyId: 'key-admin',
      portalGroupId: 'group-admin',
      portalModelId: 'model-admin',
      newapiGroup: 'official',
      newapiModelId: 'model-admin',
      credentialId: 'credential-admin',
      routeVersion: 1,
      priceVersionId: 'price-admin',
      endpoint: 'chat_completions',
      isStream: false,
    },
    1
  );
  assert.equal(before, false);
  const result = await json(
    await modules.routes.resolve.POST(
      request('http://local/api', {
        ledgerId: 'reconcile-stuck',
        resolution: 'manual_closed',
        note: 'policy B close',
      })
    )
  );
  assert.equal(result.code, 0);
  const [closed] = await modules
    .db()
    .select()
    .from(modules.schema.requestLedger)
    .where(eq(modules.schema.requestLedger.id, 'reconcile-stuck'));
  assert.equal(closed.status, 'failed_unbilled');
  assert.ok(closed.resolvedAt instanceof Date);
  assert.equal(
    await modules.admission.admitRequest(
      {
        id: 'preq_after_manual_close',
        userId,
        portalKeyId: 'key-admin',
        portalGroupId: 'group-admin',
        portalModelId: 'model-admin',
        newapiGroup: 'official',
        newapiModelId: 'model-admin',
        credentialId: 'credential-admin',
        routeVersion: 1,
        priceVersionId: 'price-admin',
        endpoint: 'chat_completions',
        isStream: false,
      },
      1
    ),
    true
  );

  const orphan = await json(
    await modules.routes.resolve.POST(
      request('http://local/api', {
        orphanId: 'reconcile-orphan',
        resolution: 'orphan_acknowledged',
        note: 'acknowledged',
      })
    )
  );
  assert.equal(orphan.code, 0);
  const [observation] = await modules
    .db()
    .select()
    .from(modules.schema.reconcileOrphanObservation)
    .where(
      eq(modules.schema.reconcileOrphanObservation.id, 'reconcile-orphan')
    );
  assert.ok(observation.resolvedAt instanceof Date);
});

test('RBAC 常量与初始化种子保持双写一致', async () => {
  const { PERMISSIONS } = await import('@/core/rbac/permission-codes');
  const { defaultPermissions } = await import('../../scripts/init-rbac');
  const expected = [
    'admin.apipool.routing.read',
    'admin.apipool.routing.write',
    'admin.apipool.wallet.read',
    'admin.apipool.wallet.adjust',
    'admin.apipool.wallet.freeze',
    'admin.apipool.reconciliation.read',
    'admin.apipool.reconciliation.resolve',
  ];
  assert.deepEqual(
    [
      PERMISSIONS.APIPOOL_ROUTING_READ,
      PERMISSIONS.APIPOOL_ROUTING_WRITE,
      PERMISSIONS.APIPOOL_WALLET_READ,
      PERMISSIONS.APIPOOL_WALLET_ADJUST,
      PERMISSIONS.APIPOOL_WALLET_FREEZE,
      PERMISSIONS.APIPOOL_RECONCILIATION_READ,
      PERMISSIONS.APIPOOL_RECONCILIATION_RESOLVE,
    ],
    expected
  );
  const codes = new Set(
    defaultPermissions.map((permission: any) => permission.code)
  );
  assert.ok(expected.every((code) => codes.has(code)));
});
