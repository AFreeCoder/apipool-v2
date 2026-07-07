import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const expectedProductIds = [
  'topup_10',
  'topup_50',
  'topup_100',
  'topup_200',
  'topup_500',
  'topup_1000',
];

async function loadPricingItems(locale: 'en' | 'zh') {
  const json = JSON.parse(
    await readFile(
      `src/config/locale/messages/${locale}/pages/pricing.json`,
      'utf8'
    )
  );
  return json.page.sections.pricing.items as Array<{
    amount: number;
    credits: number;
    currency: string;
    is_featured: boolean;
    price: string;
    product_id: string;
    product_name: string;
  }>;
}

for (const locale of ['en', 'zh'] as const) {
  test(`${locale} pricing exposes the APIPool top-up ladder`, async () => {
    const items = await loadPricingItems(locale);

    assert.deepEqual(
      items.map((item) => item.product_id),
      expectedProductIds
    );
    assert.equal(items.length, 6);
    assert.equal(
      items.some((item) => item.product_id === 'topup_5'),
      false
    );

    for (const item of items) {
      assert.equal(item.currency, 'USD');
      assert.equal(item.amount, item.credits);
      assert.match(item.price, /^USD \$/);
      assert.match(item.product_name, /^APIPool Credit USD \$/);
    }
  });
}

test('$50 is the only featured top-up package in every locale', async () => {
  for (const locale of ['en', 'zh'] as const) {
    const featured = (await loadPricingItems(locale)).filter(
      (item) => item.is_featured
    );
    assert.deepEqual(
      featured.map((item) => item.product_id),
      ['topup_50']
    );
  }
});

test('en and zh pricing keep the same top-up amounts and credits', async () => {
  const enItems = await loadPricingItems('en');
  const zhItems = await loadPricingItems('zh');

  for (const productId of expectedProductIds) {
    const enItem = enItems.find((item) => item.product_id === productId);
    const zhItem = zhItems.find((item) => item.product_id === productId);

    assert.ok(enItem, `en missing ${productId}`);
    assert.ok(zhItem, `zh missing ${productId}`);
    assert.equal(zhItem.amount, enItem.amount);
    assert.equal(zhItem.credits, enItem.credits);
    assert.equal(zhItem.currency, enItem.currency);
  }
});
