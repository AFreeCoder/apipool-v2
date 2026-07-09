import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('database markdown rendering disables raw HTML', async () => {
  const source = await readFile(
    'src/shared/blocks/common/markdown-content.tsx',
    'utf8'
  );

  assert.match(source, /new MarkdownIt\(\{[\s\S]*html:\s*false,/);
  assert.doesNotMatch(source, /html:\s*true/);
});
