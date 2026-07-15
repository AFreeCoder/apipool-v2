import 'server-only';

import { db } from '@/core/db';
import { portalAdminAuditLog } from '@/config/db/schema';
import { getUuid } from '@/shared/lib/hash';

function serialize(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function recordPortalAdminAudit(
  input: {
    action: string;
    operatorUserId: string;
    targetType: string;
    targetId?: string;
    beforeJson?: unknown;
    afterJson?: unknown;
    reason?: string;
  },
  writer: any = db()
): Promise<void> {
  await writer.insert(portalAdminAuditLog).values({
    id: getUuid(),
    action: input.action,
    operatorUserId: input.operatorUserId,
    targetType: input.targetType,
    targetId: input.targetId,
    beforeJson: serialize(input.beforeJson),
    afterJson: serialize(input.afterJson),
    reason: input.reason,
  });
}
