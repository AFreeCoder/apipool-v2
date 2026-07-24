import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const componentPath = 'src/features/api-console/components/api-key-manager.tsx';

test('deleting an API key requires an explicit confirmation step', async () => {
  const source = await readFile(componentPath, 'utf8');

  // 垃圾桶按钮不可直接调 deleteKey：删除会吊销远端 token 且完整 key 无法找回，
  // 与相邻的「禁用」按钮仅隔一个图标位，误触即断生产流量。
  assert.doesNotMatch(
    source,
    /onClick=\{\(\) => deleteKey\(key\.id\)\}/,
    'the trash button must open a confirmation instead of deleting immediately'
  );
  assert.match(source, /requestDeleteKey|setPendingDelete/);
  assert.match(source, /<Dialog/);
});

test('the delete confirmation copy exists in both locales', async () => {
  for (const locale of ['en', 'zh']) {
    const messages = JSON.parse(
      await readFile(
        `src/config/locale/messages/${locale}/dashboard/apiKeys.json`,
        'utf8'
      )
    );
    const confirm = messages.table?.confirmDelete;
    assert.ok(confirm, `${locale} must define table.confirmDelete`);
    for (const key of ['title', 'description', 'confirm', 'cancel']) {
      assert.ok(confirm[key], `${locale} table.confirmDelete.${key} missing`);
    }
  }
});
