import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyApiKeyMutationResult,
  buildCreateKeyRequest,
  buildGroupSelectOptions,
} from '@/features/api-console/lib/key-request';

test('buildCreateKeyRequest sends a public group slug without model or internal fields', () => {
  const body = buildCreateKeyRequest('  Smoke key  ', ' official ');

  assert.deepEqual(body, {
    name: 'Smoke key',
    groupSlug: 'official',
  });
  assert.equal(Object.hasOwn(body, 'allowedModels'), false);
  assert.equal(Object.hasOwn(body, 'id'), false);
  assert.equal(Object.hasOwn(body, 'groupId'), false);
  assert.equal(Object.hasOwn(body, 'newapiGroup'), false);
});

test('buildCreateKeyRequest applies the stable default key name', () => {
  assert.deepEqual(buildCreateKeyRequest('   ', 'official'), {
    name: 'Default APIPool key',
    groupSlug: 'official',
  });
});

test('buildGroupSelectOptions uses slug as option value and omits internal group fields', () => {
  const options = buildGroupSelectOptions([
    {
      slug: 'official',
      name: 'Official',
      userDescription: 'Stable public route',
      id: 'catalog_group_internal_official',
      newapiGroup: 'ng-official',
    } as any,
  ]);

  assert.deepEqual(options, [
    {
      value: 'official',
      label: 'Official',
      description: 'Stable public route',
    },
  ]);
  assert.equal(
    JSON.stringify(options).includes('catalog_group_internal'),
    false
  );
  assert.equal(JSON.stringify(options).includes('ng-official'), false);
});

test('applyApiKeyMutationResult removes a key when the mutation returns deleted', () => {
  const keys = [
    {
      id: 'key_active',
      displayName: 'Active key',
      keyMasked: 'sk-...active',
      status: 'active',
      createdAt: '2026-06-27T00:00:00.000Z',
    },
    {
      id: 'key_deleted',
      displayName: 'Deleted key',
      keyMasked: 'sk-...deleted',
      status: 'disabled',
      createdAt: '2026-06-27T00:00:00.000Z',
    },
  ] as const;

  const next = applyApiKeyMutationResult(keys, {
    id: 'key_deleted',
    displayName: 'Deleted key',
    keyMasked: 'sk-...deleted',
    status: 'deleted',
    createdAt: '2026-06-27T00:00:00.000Z',
    deletedAt: '2026-06-27T00:01:00.000Z',
  });

  assert.deepEqual(
    next.map((key) => key.id),
    ['key_active']
  );
});

test('API key manager does not ship Chinese fallback copy into the English console', async () => {
  const source = await readFile(
    join(
      process.cwd(),
      'src/features/api-console/components/api-key-manager.tsx'
    ),
    'utf8'
  );

  assert.doesNotMatch(source, /分组|选择分组|可调模型范围|暂无可调模型/);
});

test('API key manager renders high-priority visual treatment for errors', async () => {
  const source = await readFile(
    join(
      process.cwd(),
      'src/features/api-console/components/api-key-manager.tsx'
    ),
    'utf8'
  );

  assert.match(
    source,
    /role=\{notice\.tone === 'error' \? 'alert' : 'status'\}/
  );
  assert.match(
    source,
    /aria-live=\{notice\.tone === 'error' \? 'assertive' : 'polite'\}/
  );
  assert.match(
    source,
    /border-destructive\/30 bg-destructive\/10 text-destructive/
  );
  assert.doesNotMatch(
    source,
    /<p className="text-muted-foreground mt-3 text-sm">\{[^}]+message[^}]*\}<\/p>/
  );
});
