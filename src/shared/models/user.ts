import { headers } from 'next/headers';
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { newApiUserBinding, role, user, userRole } from '@/config/db/schema';
import { getAuth } from '@/core/auth';
import { db } from '@/core/db';

import { Permission, Role } from '../services/rbac';
import { getRemainingCredits } from './credit';

export interface UserCredits {
  remainingCredits: number;
  expiresAt: Date | null;
}

export type UserNewApiBindingSummary = {
  status: string | null;
  targetNewapiUsername: string | null;
  newapiUsername: string | null;
  lastSyncErrorCode: string | null;
  lastSyncAttemptedAt: Date | null;
  lastSyncedAt: Date | null;
};

export type User = typeof user.$inferSelect & {
  isAdmin?: boolean;
  credits?: UserCredits;
  roles?: Role[];
  permissions?: Permission[];
  newApiBinding?: UserNewApiBindingSummary | null;
};
export type NewUser = typeof user.$inferInsert;
export type UpdateUser = Partial<Omit<NewUser, 'id' | 'createdAt' | 'email'>>;

type UserListFilters = {
  email?: string;
  newApiBindingStatus?: string;
  lastSyncErrorCode?: string;
  /** 账本里有未结清的行（远端结局未知，已挡住该用户的后续调额）。 */
  unresolvedLedger?: boolean;
};

function getUserListConditions({
  email,
  newApiBindingStatus,
  lastSyncErrorCode,
  unresolvedLedger,
}: UserListFilters) {
  const conditions: SQL[] = [];

  if (unresolvedLedger) {
    // 对账告警要能落到具体的人：结清入口在用户详情页的账本行上。
    conditions.push(
      sql`exists (select 1 from apipool_ledger_entry le
                 where le.portal_user_id = ${user.id}
                   and le.status in ('pending', 'processing', 'reconciliation_required'))`
    );
  }

  if (email) {
    // Admin email search must be case-insensitive and substring-based:
    // `eq(user.email, 'User@Example.com')` returns nothing for a stored
    // `user@example.com`, and typing part of an address should still match.
    const keyword = email.trim().toLowerCase();
    if (keyword) {
      conditions.push(like(sql`lower(${user.email})`, `%${keyword}%`));
    }
  }
  if (newApiBindingStatus) {
    conditions.push(eq(newApiUserBinding.status, newApiBindingStatus));
  }
  if (lastSyncErrorCode) {
    conditions.push(eq(newApiUserBinding.lastSyncErrorCode, lastSyncErrorCode));
  }

  return conditions;
}

const userListSelect = {
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: user.emailVerified,
  image: user.image,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  utmSource: user.utmSource,
  ip: user.ip,
  locale: user.locale,
  newApiBinding: {
    status: newApiUserBinding.status,
    targetNewapiUsername: newApiUserBinding.targetNewapiUsername,
    newapiUsername: newApiUserBinding.newapiUsername,
    lastSyncErrorCode: newApiUserBinding.lastSyncErrorCode,
    lastSyncAttemptedAt: newApiUserBinding.lastSyncAttemptedAt,
    lastSyncedAt: newApiUserBinding.lastSyncedAt,
  },
};

export async function updateUser(userId: string, updatedUser: UpdateUser) {
  const [result] = await db()
    .update(user)
    .set(updatedUser)
    .where(eq(user.id, userId))
    .returning();

  return result;
}

export async function findUserById(userId: string) {
  const [result] = await db().select().from(user).where(eq(user.id, userId));

  return result;
}

export async function getUsers({
  page = 1,
  limit = 30,
  ...filters
}: {
  page?: number;
  limit?: number;
} & UserListFilters = {}): Promise<User[]> {
  // 透传整个 filters：逐字段解构时新增的筛选很容易被遗漏，
  // 而 getUsersCount 传的是整个对象——两者会静默地不一致。
  const conditions = getUserListConditions(filters);

  const result = await db()
    .select(userListSelect)
    .from(user)
    .leftJoin(newApiUserBinding, eq(newApiUserBinding.portalUserId, user.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(user.createdAt))
    .limit(limit)
    .offset((page - 1) * limit);

  return result;
}

export async function getUsersCount(filters: UserListFilters = {}) {
  const conditions = getUserListConditions(filters);

  const [result] = await db()
    .select({ count: count() })
    .from(user)
    .leftJoin(newApiUserBinding, eq(newApiUserBinding.portalUserId, user.id))
    .where(conditions.length ? and(...conditions) : undefined);
  return result?.count || 0;
}

export async function getUserByUserIds(userIds: string[]) {
  const result = await db()
    .select()
    .from(user)
    .where(inArray(user.id, userIds));

  return result;
}

/**
 * Case-insensitive exact-email lookup for flows that need a unique hit
 * (e.g. quota adjustment). Deliberately NOT substring-based: matching the
 * wrong user here changes the wrong person's balance. Limited to 2 rows so
 * callers can detect (and reject) an ambiguous match.
 */
export async function findUsersByExactEmail(email: string) {
  const keyword = email.trim().toLowerCase();
  if (!keyword) return [];

  return await db()
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(sql`lower(${user.email})`, keyword))
    .limit(2);
}

/**
 * Batch-load active (non-expired) roles for many users in a single query,
 * returning a userId -> roles map. Replaces the per-row `getUserRoles`
 * fan-out on the admin user list (30 rows = 30 queries).
 */
export async function getUserRolesForUserIds(
  userIds: string[]
): Promise<Map<string, Role[]>> {
  const rolesByUser = new Map<string, Role[]>();
  if (userIds.length === 0) return rolesByUser;

  const now = new Date();
  const rows = await db()
    .select({
      userId: userRole.userId,
      id: role.id,
      name: role.name,
      title: role.title,
      description: role.description,
      status: role.status,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
      sort: role.sort,
    })
    .from(userRole)
    .innerJoin(role, eq(userRole.roleId, role.id))
    .where(
      and(
        inArray(userRole.userId, userIds),
        eq(role.status, 'active'),
        or(isNull(userRole.expiresAt), gt(userRole.expiresAt, now))
      )
    );

  for (const row of rows) {
    const { userId, ...roleRow } = row;
    const list = rolesByUser.get(userId);
    if (list) {
      list.push(roleRow as Role);
    } else {
      rolesByUser.set(userId, [roleRow as Role]);
    }
  }

  return rolesByUser;
}

export async function getUserInfo() {
  const signUser = await getSignUser();

  return signUser;
}

export async function getUserCredits(userId: string) {
  const remainingCredits = await getRemainingCredits(userId);

  return { remainingCredits };
}

export async function getSignUser() {
  const auth = await getAuth();
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  return session?.user;
}

export async function isEmailVerified(email: string): Promise<boolean> {
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;

  const [row] = await db()
    .select({ emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, normalized))
    .limit(1);

  return !!row?.emailVerified;
}

export async function appendUserToResult(result: any) {
  if (!result || !result.length) {
    return result;
  }

  const userIds = result.map((item: any) => item.userId);
  const users = await getUserByUserIds(userIds);
  result = result.map((item: any) => {
    const user = users.find((user: any) => user.id === item.userId);
    return { ...item, user };
  });

  return result;
}
