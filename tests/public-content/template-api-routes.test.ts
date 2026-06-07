import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const disabledTemplateApiRoutes = [
  {
    file: 'src/app/api/email/send-email/route.ts',
    riskyPatterns: /getEmailService|sendEmail|VerificationCode/,
  },
  {
    file: 'src/app/api/storage/upload-image/route.ts',
    riskyPatterns: /getStorageService|uploadFile|exists\(/,
  },
  {
    file: 'src/app/api/proxy/file/route.ts',
    riskyPatterns: /fetch\(url\)|response\.body/,
  },
];

test('non-MVP template API routes are disabled instead of exposing side effects', async () => {
  const helper = await readFile(
    'src/features/apipool-ui/lib/template-api.ts',
    'utf8'
  );
  assert.match(helper, /TEMPLATE_API_DISABLED_MESSAGE/);
  assert.match(helper, /withNoStore/);

  for (const item of disabledTemplateApiRoutes) {
    const source = await readFile(item.file, 'utf8');

    assert.match(source, /disabledTemplateApiResponse/, item.file);
    assert.doesNotMatch(source, item.riskyPatterns, item.file);
  }
});
