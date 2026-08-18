import 'server-only';

import { hostname } from 'node:os';
import { and, eq, isNull, lt, or } from 'drizzle-orm';

import { gatewayJobLock } from '@/config/db/schema';
import { db } from '@/core/db';
import { gatewayConfig } from '@/features/gateway/lib/config';

const LOCK_ID = 'singleton';
const DEFAULT_STALE_MS = 5 * 60_000;
const KEEPALIVE_THROTTLE_MS = 10_000;
const TICK_MS = 5_000;
const RECONCILE_EVERY_MS = 5 * 60_000;
const INVARIANT_EVERY_MS = 60 * 60_000;

export async function acquireJobLock(
  holderId: string,
  staleMs = DEFAULT_STALE_MS
): Promise<boolean> {
  const now = Date.now();
  const [row] = await db()
    .update(gatewayJobLock)
    .set({
      holderId,
      heartbeatAt: new Date(now),
      acquiredAt: new Date(now),
    })
    .where(
      and(
        eq(gatewayJobLock.id, LOCK_ID),
        or(
          isNull(gatewayJobLock.holderId),
          eq(gatewayJobLock.holderId, holderId),
          lt(gatewayJobLock.heartbeatAt, new Date(now - staleMs))
        )
      )
    )
    .returning();
  return Boolean(row);
}

export async function heartbeatJobLock(holderId: string): Promise<boolean> {
  const [row] = await db()
    .update(gatewayJobLock)
    .set({ heartbeatAt: new Date() })
    .where(
      and(eq(gatewayJobLock.id, LOCK_ID), eq(gatewayJobLock.holderId, holderId))
    )
    .returning();
  return Boolean(row);
}

export function createKeepAliveController(
  holderId: string,
  deps: {
    heartbeat?: (holderId: string) => Promise<boolean>;
    now?: () => number;
    throttleMs?: number;
  } = {}
) {
  const heartbeat = deps.heartbeat ?? heartbeatJobLock;
  const now = deps.now ?? Date.now;
  const throttleMs = deps.throttleMs ?? KEEPALIVE_THROTTLE_MS;
  let ownsLock = false;
  let lastBeatAt = 0;

  const setHasLock = (value: boolean, beatAt = now()) => {
    ownsLock = value;
    if (value) lastBeatAt = beatAt;
  };

  const renewNow = async () => {
    ownsLock = await heartbeat(holderId);
    if (ownsLock) lastBeatAt = now();
    return ownsLock;
  };

  const keepAlive = async () => {
    if (!ownsLock) return false;
    const current = now();
    if (current - lastBeatAt < throttleMs) return true;
    lastBeatAt = current;
    ownsLock = await heartbeat(holderId);
    return ownsLock;
  };

  return {
    hasLock: () => ownsLock,
    keepAlive,
    renewNow,
    setHasLock,
  };
}

let started = false;

// Task 20/21 的模块在后续提交创建；目录上下文动态加载让本 Task 可独立编译。
async function loadGatewayWorker(name: 'backfill' | 'reconcile') {
  return import(`./${name}`) as Promise<Record<string, any>>;
}

export function startGatewayJobs(): void {
  if (started || !gatewayConfig().jobsEnabled) return;
  started = true;
  const holderId = `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const lock = createKeepAliveController(holderId);
  let lastReconcileAt = 0;
  let lastInvariantAt = 0;
  let lastRuntimePoolAt = 0;

  const runWorker = async (
    context: string,
    load: () => Promise<(deps?: any) => Promise<unknown>>,
    deps?: Record<string, unknown>
  ) => {
    if (!(await lock.renewNow())) return;
    try {
      const worker = await load();
      await worker({ keepAlive: lock.keepAlive, ...deps });
    } catch (error) {
      console.error(`[jobs] ${context}`, error);
    }
  };

  const tick = async () => {
    try {
      const hasLock = lock.hasLock()
        ? await lock.renewNow()
        : await acquireJobLock(holderId);
      lock.setHasLock(hasLock);
      if (!hasLock) return;

      await runWorker('credential_worker', async () => {
        const { runCredentialWorkerOnce } = await import('./credentials');
        return runCredentialWorkerOnce;
      });
      if (!lock.hasLock()) return;

      await runWorker('image_task_worker', async () => {
        const { runImageTaskWorkerOnce } = await import('./image-tasks');
        return runImageTaskWorkerOnce;
      });
      if (!lock.hasLock()) return;

      await runWorker('usage_worker', async () => {
        const module = await loadGatewayWorker('backfill');
        return module.runUsageWorkerOnce;
      });
      if (!lock.hasLock()) return;

      const now = Date.now();
      if (now - lastReconcileAt >= RECONCILE_EVERY_MS) {
        lastReconcileAt = now;
        await runWorker('reconcile_worker', async () => {
          const module = await loadGatewayWorker('reconcile');
          return module.runReconcileSyncOnce;
        });
      }
      if (!lock.hasLock()) return;

      if (now - lastInvariantAt >= INVARIANT_EVERY_MS) {
        lastInvariantAt = now;
        await runWorker('wallet_invariant', async () => {
          const module = await loadGatewayWorker('reconcile');
          return module.runWalletInvariantCheckOnce;
        });
      }
      if (!lock.hasLock()) return;

      if (now - lastRuntimePoolAt >= INVARIANT_EVERY_MS) {
        lastRuntimePoolAt = now;
        await runWorker(
          'runtime_pool_monitor',
          async () => {
            const module = await import('./runtime-pool');
            return module.runRuntimePoolMonitorOnce;
          },
          { bootstrap: true }
        );
      }
    } catch (error) {
      console.error('[jobs] tick failed', error);
      lock.setHasLock(false);
    } finally {
      setTimeout(tick, TICK_MS).unref?.();
    }
  };

  setTimeout(tick, TICK_MS).unref?.();
}
