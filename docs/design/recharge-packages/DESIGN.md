# 充值档位与自定义金额详细设计

文档类型：设计（design）
Feature：recharge-packages
日期：2026-07-06
关联需求：`docs/requirements/recharge-packages/requirements.md`

## 1. 总体方案

保持现有支付和到账链路不变：充值页调用 `/api/payment/checkout`，checkout route 创建本地订单和 provider Checkout Session，支付成功后 webhook 进入 `handleCheckoutSuccess()`，再由它写本地 credit 并触发 `applyRechargeForOrder()` 给 New API 加额。

本次改动只优化“金额来源”和“充值页面交互”：

1. 预设档位继续由 `pages.pricing` locale 配置提供，但从 `$5/$10/$50` 改为 `$10/$50/$100/$200/$500/$1000`。
2. 自定义金额不写入 locale pricing，不伪装成普通套餐；前端向 checkout API 提交 `custom_amount_usd`。
3. checkout route 将预设套餐和自定义金额都解析成同一个 server-side `ResolvedTopUpCheckout` 结构，再进入原有创建订单逻辑。
4. 金额校验集中在纯函数模块中，避免 UI、route、测试各写一套规则。

## 2. 文件与责任边界

| 文件                                                        | 类型 | 责任                                                                               |
| ----------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------- |
| `src/features/api-console/lib/top-up-products.ts`           | 新增 | 纯函数：金额限制、预设套餐解析、自定义金额校验、checkout DTO 组装                  |
| `src/app/api/payment/checkout/route.ts`                     | 修改 | 读取请求体，调用 `resolveTopUpCheckout()`，使用解析结果创建订单和 Checkout Session |
| `src/features/api-console/components/top-up-packages.tsx`   | 修改 | 展示六个预设档位和自定义金额输入；提交 `product_id` 或 `custom_amount_usd`         |
| `src/app/[locale]/(landing)/dashboard/billing/page.tsx`     | 修改 | 传入扩展后的自定义金额文案；保持服务端读取 pricing 配置                            |
| `src/config/locale/messages/{en,zh}/pages/pricing.json`     | 修改 | 替换预设充值档位                                                                   |
| `src/config/locale/messages/{en,zh}/dashboard/billing.json` | 修改 | 增加自定义金额输入、范围和错误文案                                                 |
| `tests/api-console/top-up-products.test.ts`                 | 新增 | 覆盖金额解析、预设套餐映射、自定义金额边界                                         |
| `tests/payments/recharge.test.ts`                           | 修改 | 覆盖 `$1000` / 自定义金额在支付成功后 credit 与 ledger 换算一致                    |
| `tests/public-content/recharge-pricing.test.ts`             | 新增 | 静态校验中英文 pricing 档位一致、无 `$5`、`$50` 推荐                               |
| `tests/api-console/top-up-packages-ui.test.ts`              | 新增 | 静态/组件级校验 UI 有自定义金额路径和错误文案，不做真实支付                        |

## 3. 数据与金额模型

### 3.1 内部单位

- `amountUsd`：美元整数，仅用于服务端计算和 ledger 展示语义。
- `amount`：订单金额，单位 cents。`amount = amountUsd * 100`。
- `creditsAmount`：模板 credit 数量，与 cents 保持一致。`creditsAmount = amountUsd * 100`。
- `apipool_ledger_entry.amountUsd`：美元数值。`ledger.amountUsd = amount / 100`。

示例：

| 用户充值 | `order.amount` | `order.creditsAmount` | `ledger.amountUsd` |
| -------- | -------------: | --------------------: | -----------------: |
| `$10`    |         `1000` |                `1000` |               `10` |
| `$50`    |         `5000` |                `5000` |               `50` |
| `$1000`  |       `100000` |              `100000` |             `1000` |

### 3.2 自定义金额限制

`src/features/api-console/lib/top-up-products.ts` 定义：

```ts
export const TOP_UP_CUSTOM_MIN_USD = 10;
export const TOP_UP_CUSTOM_MAX_USD = 1000;
export const TOP_UP_CURRENCY = 'usd';
```

服务端校验：

- `Number.isInteger(amountUsd)`。
- `10 <= amountUsd <= 1000`。
- 只接受 USD，比较时大小写不敏感，写入订单时使用规范化结果 `usd`。

## 4. Checkout 解析设计

新增类型：

```ts
export type ResolvedTopUpCheckout = {
  productId: string;
  productName: string;
  description: string;
  amount: number;
  currency: string;
  priceLabel: string;
  interval: PaymentInterval;
  type: PaymentType;
  creditsAmount: number;
  creditsValidDays: number;
  planName: string;
  paymentProductId: string;
  allowedProviders?: string[];
  isCustomAmount: boolean;
};
```

新增函数：

```ts
export function resolveTopUpCheckout(input: {
  productId?: string;
  customAmountUsd?: unknown;
  currency?: string;
  pricingItems: PricingItem[];
}): ResolvedTopUpCheckout;
```

分支规则：

1. 若 `productId` 和 `customAmountUsd` 同时存在，直接拒绝，避免调用方同时声明两个金额来源。
2. 若 `customAmountUsd` 非空，走自定义金额分支。
3. 否则要求 `productId` 非空，按现有 pricing item 解析。
4. 自定义金额分支不读取客户端的 cents、credits、productName 或 description。
5. 自定义金额分支生成：
   - `productId = 'topup_custom'`
   - `productName = 'APIPool Credit USD $<amountUsd>'`
   - `description = 'Custom APIPool credit top-up'`
   - `amount = amountUsd * 100`
   - `creditsAmount = amountUsd * 100`
   - `interval = one-time`
   - `type = one-time`
   - `creditsValidDays = 0`
   - `isCustomAmount = true`
6. 预设分支保持现有 server-side pricing item 作为金额事实源。

错误策略：

- 同时传入 `product_id` 和 `custom_amount_usd`：`choose either product_id or custom_amount_usd`。
- 没有 `product_id` 且没有 `custom_amount_usd`：`product_id or custom_amount_usd is required`。
- 自定义金额非整数：`custom_amount_usd must be an integer USD amount`。
- 自定义金额越界：`custom_amount_usd must be between 10 and 1000`。
- 非 USD 自定义金额：`custom top-up only supports USD`。
- 预设 product 不存在：沿用 `pricing item not found`。

## 5. API 改造

`src/app/api/payment/checkout/route.ts` 保留现有外部路径和响应格式。

请求体新增可选字段：

```json
{
  "custom_amount_usd": 120,
  "currency": "USD",
  "locale": "zh"
}
```

预设档位请求保持兼容：

```json
{
  "product_id": "topup_50",
  "currency": "USD",
  "locale": "zh"
}
```

route 变化：

1. 读取 `product_id`、`custom_amount_usd`、`currency`、`locale`、`payment_provider`、`metadata`。
2. 读取 `pages.pricing` 配置。
3. 调用 `resolveTopUpCheckout()` 得到可信 checkout item。
4. payment provider 选择、allowed provider 校验、promotion code、订单创建、provider createPayment 和错误处理继续使用现有流程。
5. 自定义金额不走 `getPaymentProductId()`，始终使用动态 price data。
6. 自定义金额不使用 Stripe promotion code 映射。
7. 同时收到 `product_id` 和 `custom_amount_usd` 时，在创建订单前返回错误，不写入 `order`。

## 6. UI 设计

`TopUpPackages` 继续负责充值卡片和发起 checkout。组件扩展 props：

```ts
labels: {
  popular: string;
  add: string;
  checkoutError: string;
  customTitle: string;
  customDescription: string;
  customPlaceholder: string;
  customButton: string;
  customRange: string;
  customInvalid: string;
}
```

交互：

- 预设档位使用 6 张卡片，桌面 `lg:grid-cols-3`，移动端单列。
- `$50` 卡片使用推荐样式。
- 自定义金额作为同级独立区域放在预设卡片下方，不嵌套卡片。
- 输入框只接受普通文本/number 体验，不依赖浏览器校验作为唯一约束。
- 用户输入非法金额时，前端显示本地错误，不发起 checkout。
- 用户输入合法金额后，点击按钮发起 POST `/api/payment/checkout`，body 为 `{ custom_amount_usd, currency: 'USD', locale }`。
- loading 期间禁用所有充值按钮，避免重复提交。

## 7. i18n 与文案

`pages/pricing.json` 中预设档位：

- `topup_10`：入门 / Starter
- `topup_50`：开发 / Builder，`is_featured=true`
- `topup_100`：团队 / Team
- `topup_200`：增长 / Growth
- `topup_500`：生产 / Production
- `topup_1000`：规模 / Scale

`dashboard/billing.json` 新增自定义金额文案。用户侧不出现 `credit` 解释，继续使用余额/充值金额。

## 8. 测试设计

### 8.1 单元测试

新增 `tests/api-console/top-up-products.test.ts`：

- 预设 `topup_50` 解析为 `amount=5000`、`creditsAmount=5000`、`currency='usd'`。
- 预设 `topup_1000` 解析为 `amount=100000`、`creditsAmount=100000`。
- 自定义 `10` 解析为 `amount=1000`、`creditsAmount=1000`、`productId='topup_custom'`。
- 自定义 `1000` 解析成功。
- 自定义 `9`、`1001`、`10.5`、`abc`、空值失败。
- 自定义 `EUR` 失败。

### 8.2 集成测试

新增 `tests/payments/checkout-route.test.ts` 或扩展现有支付 route 测试：

- mock 用户、config、payment service 和订单模型，验证预设 `topup_10`、`topup_50`、`topup_1000` 可创建 checkout。
- 对每个成功预设断言订单写入 `amount === creditsAmount`，且等于对应美元金额乘以 `100`。
- 验证自定义 `$10`、`$120`、`$1000` 可创建 checkout，订单 `productId='topup_custom'`、`amount=creditsAmount=amountUsd*100`、`currency='usd'`。
- 验证自定义 `$9`、`$1001`、`$10.5`、`abc`、空值、非 USD 均返回错误。
- 验证非法自定义金额不会调用 `createOrder()`，不会调用 provider `createPayment()`。
- 验证 `product_id` 和 `custom_amount_usd` 同时传入时返回错误，且不创建订单。
- 验证预设档位仍不信任客户端 amount/credits 字段，即使请求体带入这些字段也按 server-side pricing item 创建订单。

扩展 `tests/payments/recharge.test.ts`：

- `applyRechargeForOrder()` 对 `amount=100000` 写 `ledger.amountUsd=1000`。
- `handleCheckoutSuccess()` 对自定义订单 `productId='topup_custom'`、`amount=12000`、`creditsAmount=12000` 只写一次 credit，ledger `amountUsd=120`。

### 8.3 UI / 静态与组件交互测试

新增或扩展 public-content 测试：

- 中英文 `pages/pricing.json` 均只有 6 个充值项。
- 不存在 `topup_5`。
- 新增 `topup_100/topup_200/topup_500/topup_1000`。
- `$50` 为唯一推荐。
- 每个 item 的 `amount === credits`。

新增组件静态测试：

- `TopUpPackages` 包含自定义金额状态、`custom_amount_usd` 请求字段和前端范围校验。
- `dashboard/billing.json` 中英文包含所有新增 label。

新增组件交互测试：

- 输入 `$9` 后点击自定义充值按钮，显示错误文案，不调用 `fetch()`。
- 输入 `$10` 后点击自定义充值按钮，调用 `fetch('/api/payment/checkout')`，body 包含 `custom_amount_usd: 10`。
- 自定义金额提交期间，预设档位按钮和自定义按钮均禁用。
- checkout 返回错误时展示 `checkoutError`，并恢复可提交状态。
- 点击预设 `topup_50` 时仍发送 `product_id: 'topup_50'`，不发送 `custom_amount_usd`。

### 8.4 手工 UI 验收

开发完成后启动本地服务并用浏览器检查：

- `/zh/dashboard/billing` 桌面和移动端布局。
- 六个档位不重叠、不截断。
- 自定义 `$9` 显示错误，不发起 checkout。
- 自定义 `$10` 可进入 loading；若本地无 Stripe 配置，显示 checkout 错误但 UI 状态正确。

## 9. 风险与处理

| 风险                                   | 处理                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| 自定义金额绕过服务端校验               | 所有 cents/credits/productName 均由 `resolveTopUpCheckout()` 计算 |
| `ledger.amountUsd` 与 cents 混淆       | 单元测试和充值集成测试固定 `amount / 100` 关系                    |
| UI 上 credit 概念外泄                  | 文案只写余额/金额，不解释 credit                                  |
| Stripe webhook 已支付但 New API 未到账 | 保持现有 pending/failed/retry/reconciliation 机制                 |
| 新增 6 档导致移动端拥挤                | 使用响应式 grid + 独立自定义金额区域，并做浏览器验收              |

## 10. 不变项

- 不改数据库 schema。
- 不改 New API bridge 配置。
- 不改 `applyRechargeForOrder()` 的幂等模型。
- 不改 payment provider 接口。
- 不改后台手动调额。
- 不新增后台动态套餐管理。
