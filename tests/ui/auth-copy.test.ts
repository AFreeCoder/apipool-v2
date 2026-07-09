import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const AUTH_COMPONENTS = [
  'src/shared/blocks/sign/sign-in.tsx',
  'src/shared/blocks/sign/sign-up.tsx',
  'src/shared/blocks/sign/sign-in-form.tsx',
  'src/shared/blocks/sign/sign-up-form.tsx',
  'src/shared/blocks/sign/verify-email.tsx',
];

test('auth toasts are localized and never echo the auth server verbatim', async () => {
  for (const file of AUTH_COMPONENTS) {
    const source = await readFile(file, 'utf8');

    // 这是每个新用户必经的页面：中文用户不该看到小写英文提示
    assert.doesNotMatch(
      source,
      /toast\.error\('[a-z]/,
      `${file} has a hardcoded English toast`
    );
    // better-auth 的服务端报错恒为英文，直接透传等于绕过 i18n
    assert.doesNotMatch(
      source,
      /toast\.error\(e\?\.(error\?\.)?message/,
      `${file} echoes the auth server message`
    );
  }
});

test('the localized auth copy exists in both locales', async () => {
  const keys = [
    'sign_in_required_fields',
    'sign_up_required_fields',
    'sign_in_failed',
    'sign_up_failed',
    'verify_email_required_field',
    'resend_verification_failed',
  ];

  for (const locale of ['en', 'zh']) {
    const messages = JSON.parse(
      await readFile(`src/config/locale/messages/${locale}/common.json`, 'utf8')
    );
    for (const key of keys) {
      assert.ok(messages.sign?.[key], `${locale} common.sign.${key}`);
    }
  }
});
