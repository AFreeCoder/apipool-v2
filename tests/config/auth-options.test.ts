import assert from 'node:assert/strict';
import test from 'node:test';

import { getAuthOptions } from '@/core/auth/config';

test('auth options enable link email verification only when Resend is configured', async () => {
  const enabled = (await getAuthOptions({
    email_auth_enabled: 'true',
    email_verification_enabled: 'true',
    resend_api_key: 're_test_key',
    resend_sender_email: 'APIPool <no-reply@example.com>',
  })) as any;

  assert.equal(enabled.emailAndPassword.enabled, true);
  assert.equal(enabled.emailAndPassword.requireEmailVerification, true);
  assert.equal(enabled.emailAndPassword.autoSignIn, false);
  assert.equal(enabled.emailVerification.autoSignInAfterVerification, true);
  assert.equal(
    typeof enabled.emailVerification.sendVerificationEmail,
    'function'
  );

  const missingResend = (await getAuthOptions({
    email_auth_enabled: 'true',
    email_verification_enabled: 'true',
  })) as any;

  assert.equal(missingResend.emailAndPassword.requireEmailVerification, false);
  assert.equal(missingResend.emailAndPassword.autoSignIn, true);
  assert.equal(Object.hasOwn(missingResend, 'emailVerification'), false);
});
