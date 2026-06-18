import { eq } from 'drizzle-orm';

import { db } from '@/core/db';
import { account, user } from '@/config/db/schema';
import { getAuthOptions } from '@/core/auth/config';
import { betterAuth } from 'better-auth';

const TEST_USER = {
  email: 'test@apipool.dev',
  password: 'ApipoolTest123!',
  name: 'APIPool Test User',
} as const;

async function findUserByEmail(email: string) {
  const [existingUser] = await db()
    .select()
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  return existingUser;
}

async function ensureEmailVerified(userId: string) {
  await db()
    .update(user)
    .set({ emailVerified: true, locale: 'zh-CN' })
    .where(eq(user.id, userId));
}

async function main() {
  const auth = betterAuth(
    (await getAuthOptions({
      email_auth_enabled: 'true',
      email_verification_enabled: 'false',
    })) as any
  );
  const existingUser = await findUserByEmail(TEST_USER.email);

  if (existingUser) {
    await ensureEmailVerified(existingUser.id);

    const linkedAccounts = await db()
      .select({ providerId: account.providerId })
      .from(account)
      .where(eq(account.userId, existingUser.id));

    console.log('Test user already exists.');
    console.log(`Email: ${TEST_USER.email}`);
    console.log(`Password: ${TEST_USER.password}`);
    console.log(`Email verified: true`);
    console.log(
      `Password account: ${
        linkedAccounts.some((item: any) => item.providerId === 'credential')
          ? 'yes'
          : 'unknown'
      }`
    );
    return;
  }

  const result = await auth.api.signUpEmail({
    body: TEST_USER,
    headers: new Headers({
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }),
  });

  const createdUser = result?.user;
  if (!createdUser?.id) {
    throw new Error('Failed to create test user');
  }

  await ensureEmailVerified(createdUser.id);

  console.log('Test user created.');
  console.log(`Email: ${TEST_USER.email}`);
  console.log(`Password: ${TEST_USER.password}`);
  console.log('Email verified: true');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
