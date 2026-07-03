import { headers } from 'next/headers';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';

import { getAuth } from '@/core/auth';
import { db } from '@/core/db';
import { newApiUserBinding, user } from '@/config/db/schema';

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
};

function getUserListConditions({
  email,
  newApiBindingStatus,
  lastSyncErrorCode,
}: UserListFilters) {
  const conditions: SQL[] = [];

  if (email) {
    conditions.push(eq(user.email, email));
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
  email,
  newApiBindingStatus,
  lastSyncErrorCode,
}: {
  page?: number;
  limit?: number;
} & UserListFilters = {}): Promise<User[]> {
  const conditions = getUserListConditions({
    email,
    newApiBindingStatus,
    lastSyncErrorCode,
  });

  const result = await db()
    .select(userListSelect)
    .from(user)
    .leftJoin(
      newApiUserBinding,
      eq(newApiUserBinding.portalUserId, user.id)
    )
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
    .leftJoin(
      newApiUserBinding,
      eq(newApiUserBinding.portalUserId, user.id)
    )
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
  const normalized = String(email || '').trim().toLowerCase();
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
