# 充值档位与自定义金额实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将用户充值页从 `$5/$10/$50` 调整为 `$10/$50/$100/$200/$500/$1000`，并新增 `$10-$1000` 整数美元自定义充值，同时复用现有 Stripe checkout、credit、APIPool ledger 和 New API 加额链路。

**Architecture:** 新增纯函数模块集中解析预设档位和自定义金额；checkout route 只接受 helper 产出的可信金额结构；前端只提交 `product_id` 或 `custom_amount_usd`。不改数据库 schema、payment provider 接口或 New API bridge。

**Tech Stack:** Next.js App Router、React client component、next-intl locale JSON、node:test、tsx、Drizzle/libsql 现有订单与充值测试工具。

---

## 文件结构

- 新增 `src/features/api-console/lib/top-up-products.ts`：金额规则、预设套餐解析、自定义金额校验。
- 修改 `src/app/api/payment/checkout/route.ts`：使用 `resolveTopUpCheckout()` 代替散落 pricing item 解析。
- 修改 `src/features/api-console/components/top-up-packages.tsx`：六个档位 + 自定义金额输入。
- 修改 `src/app/[locale]/(landing)/dashboard/billing/page.tsx`：传递扩展 label。
- 修改 `src/config/locale/messages/{en,zh}/pages/pricing.json`：六个预设档位。
- 修改 `src/config/locale/messages/{en,zh}/dashboard/billing.json`：自定义金额文案。
- 新增 `tests/api-console/top-up-products.test.ts`：纯函数单测。
- 新增 `tests/public-content/recharge-pricing.test.ts`：i18n/静态配置测试。
- 新增或扩展 `tests/api-console/top-up-packages-ui.test.ts`：组件源码/交互约束测试。
- 扩展 `tests/payments/recharge.test.ts`：大额和自定义订单入账换算。
- 如 route 可被稳定隔离，新增 `tests/payments/checkout-route.test.ts`；若 Next route 依赖难以 mock，则用纯函数 + route source guard 组合覆盖 route 集成边界。

## 任务

### Task 1: 充值金额解析纯函数

**Files:**

- Create: `src/features/api-console/lib/top-up-products.ts`
- Create: `tests/api-console/top-up-products.test.ts`

- [x] **Step 1: 写失败测试**

测试应覆盖：

```ts
test('resolves preset top-up products from server pricing config', () => {
  const resolved = resolveTopUpCheckout({
    productId: 'topup_50',
    currency: 'USD',
    pricingItems: pricingItemsFixture,
  });

  assert.equal(resolved.productId, 'topup_50');
  assert.equal(resolved.amount, 5000);
  assert.equal(resolved.creditsAmount, 5000);
  assert.equal(resolved.currency, 'usd');
  assert.equal(resolved.isCustomAmount, false);
});

test('resolves custom integer USD amounts into cents and credits', () => {
  const resolved = resolveTopUpCheckout({
    customAmountUsd: 120,
    currency: 'USD',
    pricingItems: pricingItemsFixture,
  });

  assert.equal(resolved.productId, 'topup_custom');
  assert.equal(resolved.amount, 12000);
  assert.equal(resolved.creditsAmount, 12000);
  assert.equal(resolved.currency, 'usd');
  assert.equal(resolved.isCustomAmount, true);
});
```

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/api-console/top-up-products.test.ts
```

Expected: FAIL because `top-up-products.ts` does not exist.

- [x] **Step 3: 实现 helper**

实现常量和函数：

```ts
export const TOP_UP_CUSTOM_MIN_USD = 10;
export const TOP_UP_CUSTOM_MAX_USD = 1000;
export const TOP_UP_CURRENCY = 'usd';

export function normalizeTopUpCurrency(currency?: string) {
  return (currency || TOP_UP_CURRENCY).toLowerCase();
}
```

`resolveTopUpCheckout()` 必须拒绝 `productId` 与 `customAmountUsd` 同传，拒绝自定义金额小数/越界/非 USD，并保证预设金额来自 `pricingItems`。

- [x] **Step 4: 运行测试确认通过**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/api-console/top-up-products.test.ts
```

Expected: PASS.

### Task 2: 预设档位配置与静态校验

**Files:**

- Modify: `src/config/locale/messages/en/pages/pricing.json`
- Modify: `src/config/locale/messages/zh/pages/pricing.json`
- Create: `tests/public-content/recharge-pricing.test.ts`

- [x] **Step 1: 写失败测试**

测试读取中英文 pricing JSON，断言：

- items 长度为 `6`。
- product ids 等于 `topup_10/topup_50/topup_100/topup_200/topup_500/topup_1000`。
- 不存在 `topup_5`。
- 每项 `amount === credits`。
- `$50` 是唯一 `is_featured=true`。

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/public-content/recharge-pricing.test.ts
```

Expected: FAIL because current JSON only has 3 items and still contains `topup_5`.

- [x] **Step 3: 更新中英文 pricing JSON**

按需求写入六档：

```json
{
  "amount": 5000,
  "currency": "USD",
  "price": "USD $50",
  "product_id": "topup_50",
  "product_name": "APIPool Credit USD $50",
  "credits": 5000,
  "valid_days": 0,
  "group": "one-time",
  "is_featured": true
}
```

- [x] **Step 4: 运行测试确认通过**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/public-content/recharge-pricing.test.ts
```

Expected: PASS.

### Task 3: checkout route 接入金额解析

**Files:**

- Modify: `src/app/api/payment/checkout/route.ts`
- Test: `tests/api-console/top-up-products.test.ts`
- Test: `tests/payments/checkout-route.test.ts` or source guard if route isolation is not practical

- [x] **Step 1: 写失败测试**

优先新增 route 测试，覆盖：

- 自定义 `$120` 创建订单时 `amount=12000`、`creditsAmount=12000`、`productId='topup_custom'`。
- 自定义 `$9/$1001/$10.5` 返回错误且不调用 `createOrder()`。
- `product_id` 与 `custom_amount_usd` 同传返回错误且不创建订单。

若 route 依赖无法低成本 mock，则在 `tests/api-console/top-up-products.test.ts` 加源代码 guard，确认 route 引入并调用 `resolveTopUpCheckout()`，且请求体读取 `custom_amount_usd`。

- [x] **Step 2: 运行测试确认失败**

Run targeted checkout test command. Expected: FAIL because route has not been updated.

- [x] **Step 3: 修改 route**

修改点：

- 从 request body 读取 `custom_amount_usd`。
- 使用 `resolveTopUpCheckout({ productId: product_id, customAmountUsd: custom_amount_usd, currency, pricingItems: pricing.items })`。
- 用 resolved checkout 替代 `pricingItem.amount/currency/credits/valid_days/product_name`。
- 自定义金额跳过 `getPaymentProductId()` 与 `getPromotionCode()`。

- [x] **Step 4: 运行测试确认通过**

Run targeted checkout tests and `tests/api-console/top-up-products.test.ts`. Expected: PASS.

### Task 4: 充值 UI 与 i18n

**Files:**

- Modify: `src/features/api-console/components/top-up-packages.tsx`
- Modify: `src/app/[locale]/(landing)/dashboard/billing/page.tsx`
- Modify: `src/config/locale/messages/en/dashboard/billing.json`
- Modify: `src/config/locale/messages/zh/dashboard/billing.json`
- Create: `tests/api-console/top-up-packages-ui.test.ts`

- [x] **Step 1: 写失败测试**

测试源码约束：

- `TopUpPackages` 请求体包含 `custom_amount_usd`。
- 非法自定义金额不会调用 checkout。
- loading 时禁用所有按钮。
- dashboard billing 中英文 JSON 包含 `customTitle/customDescription/customPlaceholder/customButton/customRange/customInvalid`。

- [x] **Step 2: 运行测试确认失败**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/api-console/top-up-packages-ui.test.ts
```

Expected: FAIL because component and labels have not been updated.

- [x] **Step 3: 修改组件与文案**

UI 要求：

- 预设档位 grid 改为 `sm:grid-cols-2 lg:grid-cols-3`。
- 自定义金额区域放在预设档位下方，与预设卡片同级。
- 前端校验整数、`10 <= amount <= 1000`。
- 合法自定义金额提交 `{ custom_amount_usd: amountUsd, currency: 'USD', locale }`。

- [x] **Step 4: 运行测试确认通过**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/api-console/top-up-packages-ui.test.ts
```

Expected: PASS.

### Task 5: 入账集成测试扩展

**Files:**

- Modify: `tests/payments/recharge.test.ts`

- [x] **Step 1: 写失败测试**

新增测试：

```ts
test('custom top-up order grants matching credits and ledger dollars once', async () => {
  // order.amount=12000, creditsAmount=12000, productId='topup_custom'
  // handleCheckoutSuccess webhook replay 3 times
  // assert one credit row with credits=12000
  // assert one ledger row with amountUsd=120
});
```

另加 `applyRechargeForOrder` 大额测试：`amount=100000` 后 `ledger.amountUsd=1000`。

- [x] **Step 2: 运行测试确认失败或确认覆盖缺失**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/payments/recharge.test.ts
```

Expected: New tests initially fail if assumptions are not yet covered; if production already supports amount math, tests may pass, but they still lock regression behavior.

- [x] **Step 3: 最小实现或保留测试**

如果测试暴露实现问题，按最小范围修复。若已通过，不改生产充值执行器。

- [x] **Step 4: 运行测试确认通过**

Run same command. Expected: PASS.

### Task 6: 阶段 3 收口

- [x] Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test \
  tests/api-console/top-up-products.test.ts \
  tests/public-content/recharge-pricing.test.ts \
  tests/api-console/top-up-packages-ui.test.ts \
  tests/payments/recharge.test.ts
```

- [x] Run:

```bash
pnpm exec tsc --noEmit --pretty false
```

- [x] Run:

```bash
pnpm run lint
```

- [x] Review `git diff` and update this plan checklist.
