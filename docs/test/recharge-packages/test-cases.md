# 充值档位与自定义金额测试案例

文档类型：测试（test）
Feature：recharge-packages
日期：2026-07-06
关联需求：`docs/requirements/recharge-packages/requirements.md`
关联设计：`docs/design/recharge-packages/DESIGN.md`
状态：测试案例确认稿

## 1. 测试目标

验证充值页从 `$5/$10/$50` 调整为 `$10/$50/$100/$200/$500/$1000` 后，预设档位、自定义整数美元金额、checkout 创建、webhook 入账、APIPool ledger 和 New API 加额换算仍保持一致。

核心不变量：

- 充值只支持 USD。
- `order.amount` 使用 cents。
- `creditsAmount` 与 cents 一致。
- `apipool_ledger_entry.amountUsd = order.amount / 100`。
- 普通用户 UI 展示美元余额，不要求理解内部 credit 概念。
- 非法金额不得写入订单，不得调用支付 provider。

## 2. 自动化测试范围

### 2.1 金额解析单元测试

测试文件：`tests/api-console/top-up-products.test.ts`

| ID    | 用例                   | 输入                                         | 预期                                                               |
| ----- | ---------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| UT-01 | 解析 `$50` 预设档位    | `productId=topup_50`, `currency=USD`         | `amount=5000`、`creditsAmount=5000`、`currency=usd`                |
| UT-02 | 解析 `$1000` 预设档位  | `productId=topup_1000`, `currency=usd`       | `amount=100000`、`creditsAmount=100000`                            |
| UT-03 | 解析自定义 `$120`      | `customAmountUsd=120`, `currency=USD`        | `productId=topup_custom`、`amount=12000`、`creditsAmount=12000`    |
| UT-04 | 自定义边界值通过       | `10`、`1000`                                 | 分别解析为 `1000`、`100000` cents                                  |
| UT-05 | 同时提交两个金额来源   | `productId=topup_50`, `customAmountUsd=50`   | 抛出 `choose either product_id or custom_amount_usd`               |
| UT-06 | 自定义非法金额拒绝     | `-10`、`0`、`9`、`1001`、`10.5`、`abc`、空值 | 抛出 `custom_amount_usd` 相关错误                                  |
| UT-07 | 自定义非 USD 拒绝      | `customAmountUsd=100`, `currency=EUR`        | 抛出 `top-up only supports USD`                                    |
| UT-08 | 预设非 USD 拒绝        | `productId=topup_50`, `currency=EUR`         | 抛出 `top-up only supports USD`                                    |
| UT-09 | 预设产品缺失拒绝       | 缺少 `productId/customAmountUsd` 或未知 ID   | 抛出缺少金额来源或 `pricing item not found`                        |
| UT-10 | 忽略客户端伪造金额字段 | 预设请求附带非可信 amount/credits            | 仍按 server-side pricing item 输出真实 `amount` 与 `creditsAmount` |

运行命令：

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/api-console/top-up-products.test.ts
```

### 2.2 预设档位配置测试

测试文件：`tests/public-content/recharge-pricing.test.ts`

| ID     | 用例                  | 预期                                       |
| ------ | --------------------- | ------------------------------------------ |
| CFG-01 | 英文 pricing 档位完整 | 仅包含 `topup_10/50/100/200/500/1000` 六项 |
| CFG-02 | 中文 pricing 档位完整 | 与英文金额、credits 和 product id 一致     |
| CFG-03 | 移除 `$5`             | 中英文均不存在 `topup_5`                   |
| CFG-04 | `$50` 唯一推荐        | 仅 `topup_50.is_featured=true`             |
| CFG-05 | cents 与 credits 一致 | 每个 item 满足 `amount === credits`        |

运行命令：

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/public-content/recharge-pricing.test.ts
```

### 2.3 Checkout API 集成测试

测试文件：`tests/payments/checkout-route.test.ts`

测试策略：`route.ts` 只做请求解析和 locale pricing 读取，核心 checkout 编排在可注入的 `createTopUpCheckoutResponse()` 中测试。测试 mock 用户、配置、订单模型和 Stripe provider，不触碰真实 Stripe。

| ID     | 用例                          | 输入                                          | 预期                                                                           |
| ------ | ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| API-01 | route 委托到 checkout handler | 读取 `route.ts`                               | route 调用 `createTopUpCheckoutResponse()`，不再强制要求 `product_id`          |
| API-02 | 自定义 `$120` 创建 checkout   | `custom_amount_usd=120`, `currency=USD`       | 创建 1 条订单，`amount=12000`、`creditsAmount=12000`、`productId=topup_custom` |
| API-03 | 自定义金额使用动态价格        | API-02                                        | provider order price 为 `{ amount: 12000, currency: 'usd' }`                   |
| API-04 | 自定义 metadata 保留          | API-02 附带 `metadata.source`                 | provider metadata 包含 `order_no/user_id/source`                               |
| API-05 | 预设 `topup_50` 创建 checkout | `product_id=topup_50`, 伪造 amount/credits    | 仍按服务端配置写 `amount=5000`、`creditsAmount=5000`                           |
| API-06 | 自定义 `$0` / 负数拒绝        | `custom_amount_usd=0`、`-10`                  | 返回错误，不调用 `createOrder()`，不调用 provider `createPayment()`            |
| API-07 | 自定义 `$9` 拒绝              | `custom_amount_usd=9`                         | 返回错误，不调用 `createOrder()`，不调用 provider `createPayment()`            |
| API-08 | 自定义 `$1001` 拒绝           | `custom_amount_usd=1001`                      | 返回错误，不写订单，不创建 payment                                             |
| API-09 | 自定义小数拒绝                | `custom_amount_usd=10.5`                      | 返回错误，不写订单，不创建 payment                                             |
| API-10 | 非 USD 拒绝                   | `custom_amount_usd=10`, `currency=EUR`        | 返回错误，不写订单，不创建 payment                                             |
| API-11 | 双金额来源拒绝                | `product_id=topup_50`, `custom_amount_usd=50` | 返回错误，不写订单，不创建 payment                                             |

运行命令：

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/payments/checkout-route.test.ts
```

### 2.4 UI 组件与 i18n 测试

测试文件：`tests/api-console/top-up-packages-ui.test.ts`

| ID     | 用例                       | 预期                                                                                                  |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| UIA-01 | 组件包含自定义充值请求字段 | `TopUpPackages` 发送 `custom_amount_usd`，预设请求仍发送 `product_id`                                 |
| UIA-02 | 自定义金额前端校验         | `-10/0/9/1001/10.5/abc` 返回非法，`10/1000` 返回合法整数                                              |
| UIA-03 | loading 禁用所有按钮       | 预设按钮和自定义按钮均受 `loadingId !== ''` 控制                                                      |
| UIA-04 | 响应式网格约束             | 档位网格使用 `sm:grid-cols-2 lg:grid-cols-3`                                                          |
| UIA-05 | 中英文文案完整             | `customTitle/customDescription/customPlaceholder/customButton/customRange/customInvalid` 均存在且非空 |

运行命令：

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/api-console/top-up-packages-ui.test.ts
```

### 2.5 支付成功与入账集成测试

测试文件：`tests/payments/recharge.test.ts`

| ID     | 用例                          | 预期                                                                       |
| ------ | ----------------------------- | -------------------------------------------------------------------------- |
| PAY-01 | 充值幂等入账                  | webhook/重试重放只产生一次 New API 加额                                    |
| PAY-02 | audit 失败不影响已成功加额    | 远端已加额后 audit 写失败，ledger 仍保持 `applied`                         |
| PAY-03 | 并发 pending ledger claim     | 并发重试只有一个执行远端加额                                               |
| PAY-04 | 远端已成功但本地 applied 失败 | ledger 进入 `reconciliation_required`，避免重复远端加额                    |
| PAY-05 | New API 临时不可用可重试      | 首次 pending，恢复后 applied 且不重复加额                                  |
| PAY-06 | New API 终态错误标记 failed   | forbidden/unauthorized 类错误进入人工处理路径                              |
| PAY-07 | 非 USD 或 0 金额跳过          | 不写 ledger                                                                |
| PAY-08 | webhook 重放只写一次 credit   | 多次 `handleCheckoutSuccess()` 只产生一条 credit 和一条 ledger             |
| PAY-09 | 自定义 `$1000` 单位一致       | credit 为 `100000`，ledger `amountUsd=1000`，New API 调用 `amountUsd=1000` |
| PAY-10 | paid webhook replay 自愈      | 已 paid 订单缺 ledger 时可补建 pending ledger                              |
| PAY-11 | 未赢得 paid 乐观锁不入账      | stale paid transition 不写 credit、不写 ledger                             |

运行命令：

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/payments/recharge.test.ts
```

## 3. 组合回归命令

目标回归：

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test \
  tests/api-console/top-up-products.test.ts \
  tests/public-content/recharge-pricing.test.ts \
  tests/api-console/top-up-packages-ui.test.ts \
  tests/payments/checkout-route.test.ts \
  tests/payments/recharge.test.ts
```

类型检查：

```bash
pnpm exec tsc --noEmit --pretty false
```

Lint：

```bash
pnpm run lint
```

## 4. 手工 UI 验收案例

这些案例需要真实浏览器和登录态。测试时应同时检查页面截图、console error、network request body 和响应。

| ID     | 页面/视口                    | 操作                             | 预期                                                                         |
| ------ | ---------------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| MAN-01 | `/en/dashboard/billing` 桌面 | 打开账单页                       | 展示 6 个预设档位，无 `$5`，`$50` 有推荐标记                                 |
| MAN-02 | `/zh/dashboard/billing` 桌面 | 打开账单页                       | 中文文案完整，无 raw i18n key                                                |
| MAN-03 | 移动端 375x812               | 打开账单页                       | 档位与自定义金额区域不重叠、不截断，按钮文字完整                             |
| MAN-04 | 自定义金额输入               | 输入 `9` 并点击自定义充值        | 展示非法金额错误，不发起 `/api/payment/checkout` 请求                        |
| MAN-05 | 自定义金额输入               | 输入 `10.5` 并点击自定义充值     | 展示非法金额错误，不发起 checkout 请求                                       |
| MAN-06 | 自定义金额输入               | 输入 `10` 并点击自定义充值       | 发起 checkout，请求体包含 `custom_amount_usd: 10` 和 `currency: USD`         |
| MAN-07 | 自定义金额输入               | 输入 `1000` 并点击自定义充值     | 发起 checkout，请求体包含 `custom_amount_usd: 1000`                          |
| MAN-08 | 预设档位                     | 点击 `$50`                       | 发起 checkout，请求体包含 `product_id: topup_50`，不包含 `custom_amount_usd` |
| MAN-09 | loading 状态                 | checkout 请求 pending 时观察按钮 | 所有充值按钮禁用，当前按钮显示 loading                                       |
| MAN-10 | API 错误状态                 | 模拟 checkout 返回错误           | 页面展示错误文案，loading 结束后按钮恢复可点击                               |

## 5. 支付沙箱验收案例

这些案例需要 Stripe 测试密钥、Stripe webhook 测试环境和 New API 测试桥接配置，不应在生产真实扣款环境直接执行。

| ID     | 操作                           | 预期                                                                  |
| ------ | ------------------------------ | --------------------------------------------------------------------- |
| STR-01 | Stripe 测试卡支付 `$10` 预设   | 订单变 `paid`，credit `1000`，ledger `amountUsd=10`                   |
| STR-02 | Stripe 测试卡支付自定义 `$120` | 订单变 `paid`，credit `12000`，ledger `amountUsd=120`                 |
| STR-03 | Stripe webhook 重放            | 不产生重复 credit，不产生重复 New API 加额                            |
| STR-04 | New API 临时关闭后支付成功     | 订单 paid，ledger pending/failed，可通过后台重试恢复                  |
| STR-05 | 后台重试未到账订单             | ledger 从 pending/failed 进入 applied，New API 用户余额增加对应美元值 |

## 6. 上线前配置检查

| ID     | 检查项                                                          | 通过标准                                            |
| ------ | --------------------------------------------------------------- | --------------------------------------------------- |
| OPS-01 | `stripe_enabled`                                                | `true`                                              |
| OPS-02 | `default_payment_provider`                                      | `stripe`                                            |
| OPS-03 | Stripe secret、publishable key、signing secret                  | 均配置且来自同一环境                                |
| OPS-04 | Stripe webhook URL                                              | `https://app.apipool.dev/api/payment/notify/stripe` |
| OPS-05 | `NEXT_PUBLIC_APP_URL` / `AUTH_URL`                              | 指向稳定 app 域名                                   |
| OPS-06 | `NEWAPI_INTEGRATION_ENABLED`                                    | `true`                                              |
| OPS-07 | `NEWAPI_BASE_URL`、`NEWAPI_ADMIN_TOKEN`、`NEWAPI_ADMIN_USER_ID` | 均有效                                              |
| OPS-08 | `NEWAPI_QUOTA_PER_UNIT`                                         | 与当前 New API quota 换算规则一致                   |
| OPS-09 | New API root `payment_compliance`                               | 已通过 dashboard session 确认                       |

## 7. 已执行验证记录

2026-07-06 已执行：

- `NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/api-console/top-up-products.test.ts tests/public-content/recharge-pricing.test.ts tests/api-console/top-up-packages-ui.test.ts tests/payments/checkout-route.test.ts tests/payments/recharge.test.ts`：34 项通过。
- `pnpm exec tsc --noEmit --pretty false`：通过。
- `pnpm run lint`：退出码 0；保留仓库既有 warning。

## 8. 剩余风险

- 当前自动化 UI 覆盖没有引入 jsdom、React Testing Library 或 Playwright；真实浏览器交互仍需按第 4 节执行。
- Stripe 与 New API 沙箱验收依赖外部配置，不应仅凭本地 mock 测试视为生产支付已验收。
- `lint` 仍输出仓库既有 warning，本次未扩大处理范围。
