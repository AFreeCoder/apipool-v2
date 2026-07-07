import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseCustomTopUpAmountInput } from '@/features/api-console/lib/top-up-products';

const componentPath = 'src/features/api-console/components/top-up-packages.tsx';
const billingLocales = [
  'src/config/locale/messages/en/dashboard/billing.json',
  'src/config/locale/messages/zh/dashboard/billing.json',
];

test('top-up packages component submits custom_amount_usd only for custom checkouts', async () => {
  const source = await readFile(componentPath, 'utf8');

  assert.match(source, /custom_amount_usd/);
  assert.match(source, /product_id: productId/);
  assert.match(source, /customAmount/);
  assert.match(source, /TOP_UP_CUSTOM_MIN_USD/);
  assert.match(source, /TOP_UP_CUSTOM_MAX_USD/);
  assert.match(source, /parseCustomTopUpAmountInput\(customAmount\)/);
  assert.match(source, /setError\(labels\.customInvalid\)/);
});

test('top-up packages component validator accepts only whole USD amounts from 10 to 1000', () => {
  assert.equal(parseCustomTopUpAmountInput('-10'), undefined);
  assert.equal(parseCustomTopUpAmountInput('0'), undefined);
  assert.equal(parseCustomTopUpAmountInput('9'), undefined);
  assert.equal(parseCustomTopUpAmountInput('10'), 10);
  assert.equal(parseCustomTopUpAmountInput('1000'), 1000);
  assert.equal(parseCustomTopUpAmountInput('1001'), undefined);
  assert.equal(parseCustomTopUpAmountInput('10.5'), undefined);
  assert.equal(parseCustomTopUpAmountInput('abc'), undefined);
});

test('top-up packages component keeps all checkout buttons disabled while loading', async () => {
  const source = await readFile(componentPath, 'utf8');

  assert.match(source, /disabled=\{loadingId !== ''\}/);
  assert.match(source, /sm:grid-cols-2 lg:grid-cols-3/);
  assert.match(source, /checkoutCustom/);
});

test('billing locale files include custom top-up labels', async () => {
  const required = [
    'customTitle',
    'customDescription',
    'customPlaceholder',
    'customButton',
    'customRange',
    'customInvalid',
  ];

  for (const file of billingLocales) {
    const json = JSON.parse(await readFile(file, 'utf8'));
    for (const key of required) {
      assert.equal(typeof json.topUp[key], 'string', `${file} missing ${key}`);
      assert.notEqual(json.topUp[key].trim(), '', `${file} empty ${key}`);
    }
  }
});
