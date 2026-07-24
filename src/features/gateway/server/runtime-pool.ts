import 'server-only';

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import { newApiUserBinding } from '@/config/db/schema';
import { db } from '@/core/db';
import { gatewayConfig } from '@/features/gateway/lib/config';
import {
  createNewApiClient,
  type NewApiClient,
  type RemoteQuota,
} from '@/features/newapi-bridge/server/client';
import { bindingToUserCredentials } from '@/features/newapi-bridge/server/portal';
import { recordPortalAdminAudit } from '@/shared/models/portal-admin-audit';

type RuntimePoolBinding = Pick<
  typeof newApiUserBinding.$inferSelect,
  'id' | 'newapiUserId' | 'newapiAccessTokenEnc'
>;

type RuntimePoolConfig = Pick<
  ReturnType<typeof gatewayConfig>,
  'runtimePoolTargetUsd' | 'runtimePoolLowWatermarkUsd'
>;

export type RuntimePoolStatus =
  | 'uninitialized'
  | 'ready'
  | 'low'
  | 'depleted'
  | 'error';

export type RuntimePoolMonitorResult = {
  scanned: number;
  uninitialized: number;
  provisioned: number;
  ready: number;
  low: number;
  depleted: number;
  replenished: number;
  failed: number;
  stopped: boolean;
};

const SYSTEM_PROVISIONER = 'system:runtime-pool';
const SYSTEM_MAINTAINER = 'system:runtime-pool-maintenance';

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
}

function requireQuotaValue(quota: RemoteQuota): number {
  const value = quota.quotaRemaining;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('New API 返回了非法运行池额度');
  }
  return value as number;
}

function quotaThresholds(client: NewApiClient, config: RuntimePoolConfig) {
  const targetQuota = client.usdToQuota(config.runtimePoolTargetUsd);
  const lowWatermarkQuota = client.usdToQuota(
    config.runtimePoolLowWatermarkUsd
  );
  if (
    !Number.isSafeInteger(targetQuota) ||
    !Number.isSafeInteger(lowWatermarkQuota) ||
    targetQuota <= 0 ||
    lowWatermarkQuota <= 0 ||
    lowWatermarkQuota >= targetQuota
  ) {
    throw new Error('New API 运行池额度换算结果无效');
  }
  return { targetQuota, lowWatermarkQuota };
}

function classifyQuota(quota: number, lowWatermarkQuota: number) {
  if (quota <= 0) return 'depleted' as const;
  if (quota < lowWatermarkQuota) return 'low' as const;
  return 'ready' as const;
}

export async function ensureRuntimePoolProvisioned(
  binding: RuntimePoolBinding,
  client: NewApiClient,
  deps: {
    config?: RuntimePoolConfig;
    now?: () => Date;
  } = {}
): Promise<{ status: RuntimePoolStatus; quota: number; remoteWrite: boolean }> {
  const config = deps.config ?? gatewayConfig();
  const now = deps.now ?? (() => new Date());
  const { targetQuota, lowWatermarkQuota } = quotaThresholds(client, config);
  const [current] = await db()
    .select()
    .from(newApiUserBinding)
    .where(eq(newApiUserBinding.id, binding.id))
    .limit(1);
  if (!current) throw new Error('New API 用户绑定不存在');
  if (current.runtimePoolProvisionedAt) {
    return {
      status: (current.runtimePoolStatus || 'ready') as RuntimePoolStatus,
      quota: current.runtimePoolLastQuota ?? targetQuota,
      remoteWrite: false,
    };
  }

  try {
    const credentials = bindingToUserCredentials(current);
    const beforeQuota = requireQuotaValue(await client.getQuota(credentials));
    let afterQuota = beforeQuota;
    let remoteWrite = false;
    if (beforeQuota < lowWatermarkQuota) {
      afterQuota = requireQuotaValue(
        await client.overrideUserQuota({
          user: credentials,
          quota: targetQuota,
        })
      );
      remoteWrite = true;
    }
    const checkedAt = now();
    const status = classifyQuota(afterQuota, lowWatermarkQuota);

    await db().transaction(async (tx: any) => {
      const [claimed] = await tx
        .update(newApiUserBinding)
        .set({
          runtimePoolStatus: status,
          runtimePoolProvisionedAt: checkedAt,
          runtimePoolLastQuota: afterQuota,
          runtimePoolCheckedAt: checkedAt,
          runtimePoolLastError: null,
        })
        .where(
          and(
            eq(newApiUserBinding.id, current.id),
            isNull(newApiUserBinding.runtimePoolProvisionedAt)
          )
        )
        .returning({ id: newApiUserBinding.id });
      if (!claimed) return;
      await recordPortalAdminAudit(
        {
          action: 'newapi.runtime_pool.provision',
          operatorUserId: SYSTEM_PROVISIONER,
          targetType: 'newapi_user',
          targetId: current.newapiUserId,
          beforeJson: { quota: beforeQuota },
          afterJson: {
            quota: afterQuota,
            targetQuota,
            lowWatermarkQuota,
            remoteWrite,
          },
          reason: '初始化与门户钱包解耦的 New API 内部运行池',
        },
        tx
      );
    });

    return { status, quota: afterQuota, remoteWrite };
  } catch (error) {
    const checkedAt = now();
    await db()
      .update(newApiUserBinding)
      .set({
        runtimePoolStatus: 'error',
        runtimePoolCheckedAt: checkedAt,
        runtimePoolLastError: safeErrorMessage(error),
      })
      .where(
        and(
          eq(newApiUserBinding.id, current.id),
          isNull(newApiUserBinding.runtimePoolProvisionedAt)
        )
      );
    throw error;
  }
}

export async function runRuntimePoolMonitorOnce(
  deps: {
    client?: NewApiClient;
    config?: RuntimePoolConfig;
    keepAlive?: () => Promise<boolean>;
    apply?: boolean;
    bootstrap?: boolean;
    operatorUserId?: string;
    now?: () => Date;
  } = {}
): Promise<RuntimePoolMonitorResult> {
  const client = deps.client ?? createNewApiClient();
  const config = deps.config ?? gatewayConfig();
  const keepAlive = deps.keepAlive ?? (async () => true);
  const apply = deps.apply === true;
  const bootstrap = deps.bootstrap === true;
  const operatorUserId = deps.operatorUserId ?? SYSTEM_MAINTAINER;
  const now = deps.now ?? (() => new Date());
  const { targetQuota, lowWatermarkQuota } = quotaThresholds(client, config);
  const result: RuntimePoolMonitorResult = {
    scanned: 0,
    uninitialized: 0,
    provisioned: 0,
    ready: 0,
    low: 0,
    depleted: 0,
    replenished: 0,
    failed: 0,
    stopped: false,
  };

  const bindings = await db()
    .select()
    .from(newApiUserBinding)
    .where(
      and(
        inArray(newApiUserBinding.status, [
          'active',
          'username_sync_pending',
          'username_sync_failed',
        ]),
        isNotNull(newApiUserBinding.newapiAccessTokenEnc)
      )
    );

  for (const binding of bindings) {
    if (!(await keepAlive())) {
      result.stopped = true;
      break;
    }
    result.scanned += 1;
    try {
      if (!binding.runtimePoolProvisionedAt) {
        result.uninitialized += 1;
        if (!bootstrap) continue;
        const provisioned = await ensureRuntimePoolProvisioned(
          binding,
          client,
          {
            config,
            now,
          }
        );
        result.provisioned += 1;
        if (provisioned.status === 'ready') result.ready += 1;
        else if (provisioned.status === 'low') result.low += 1;
        else if (provisioned.status === 'depleted') result.depleted += 1;
        else result.failed += 1;
        continue;
      }
      const credentials = bindingToUserCredentials(binding);
      const beforeQuota = requireQuotaValue(await client.getQuota(credentials));
      const observedStatus = classifyQuota(beforeQuota, lowWatermarkQuota);
      result[observedStatus] += 1;
      let afterQuota = beforeQuota;
      let status: Exclude<RuntimePoolStatus, 'uninitialized' | 'error'> =
        observedStatus;

      if (apply && observedStatus !== 'ready') {
        afterQuota = requireQuotaValue(
          await client.overrideUserQuota({
            user: credentials,
            quota: targetQuota,
          })
        );
        status = classifyQuota(afterQuota, lowWatermarkQuota);
        result.replenished += 1;
      }

      const checkedAt = now();
      await db().transaction(async (tx: any) => {
        await tx
          .update(newApiUserBinding)
          .set({
            runtimePoolStatus: status,
            runtimePoolLastQuota: afterQuota,
            runtimePoolCheckedAt: checkedAt,
            runtimePoolLastError: null,
          })
          .where(eq(newApiUserBinding.id, binding.id));
        if (!apply || observedStatus === 'ready') return;
        await recordPortalAdminAudit(
          {
            action: 'newapi.runtime_pool.replenish',
            operatorUserId,
            targetType: 'newapi_user',
            targetId: binding.newapiUserId,
            beforeJson: { quota: beforeQuota, status: observedStatus },
            afterJson: {
              quota: afterQuota,
              status,
              targetQuota,
              lowWatermarkQuota,
            },
            reason: '人工补充 New API 内部运行池',
          },
          tx
        );
      });

      if (observedStatus !== 'ready') {
        console.warn(
          `[runtime-pool] ${binding.id} 水位 ${observedStatus}，quota=${beforeQuota}`
        );
      }
    } catch (error) {
      result.failed += 1;
      const message = safeErrorMessage(error);
      await db()
        .update(newApiUserBinding)
        .set({
          runtimePoolStatus: 'error',
          runtimePoolCheckedAt: now(),
          runtimePoolLastError: message,
        })
        .where(eq(newApiUserBinding.id, binding.id));
      console.warn(`[runtime-pool] ${binding.id} 检查失败：${message}`);
    }
  }

  return result;
}
