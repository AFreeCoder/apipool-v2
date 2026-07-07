# 充值档位与自定义金额需求

文档类型：需求（requirements）
Feature：recharge-packages
日期：2026-07-06
状态：需求确认稿

## 1. 背景

APIPool_v2 当前充值页提供 `$5 / $10 / $50` 三个一次性充值档位。现有代码并非静态展示：用户点击充值档位后会调用 `/api/payment/checkout` 创建支付订单，支付成功后由 `/api/payment/notify/[provider]` webhook 更新订单、写入本地 credit 记录，并通过 APIPool ledger 调用 New API 额度执行器加同额 quota。

当前档位存在两个问题：

1. `$5` 档位金额过低，手续费和售后成本占比偏高，不适合作为正式上线后的默认充值入口。
2. `$5 / $10 / $50` 只覆盖试用和轻量使用，缺少中高额预充值入口，也不支持用户按实际预算自定义充值。

本需求在不更换现有支付系统、不改变支付入账链路的前提下，优化充值档位和自定义金额能力。

## 2. 已确认产品与技术边界

- 支付系统继续沿用现有 Checkout Session + webhook 链路，不新增独立支付系统。
- 充值页面向用户展示美元余额，不把 `credit` 作为用户必须理解的产品概念。
- 系统内部继续使用整数单位记账：`1 credit = $0.01 = 1 美分`。
- 订单金额继续以 cents 写入 `order.amount`，例如 `$50` 写为 `5000`。
- 本地 credit 数量与 cents 保持一致，例如 `$50 = 5000 credits`。
- New API 额度继续由现有 `handleCheckoutSuccess()` 触发 `applyRechargeForOrder()` 执行，按订单美元金额换算为 New API quota。
- 自定义充值只支持 USD 整数金额，最低 `$10`，最高 `$1000`。
- 内部订单币种以大小写不敏感方式处理，写入订单时保持现有 checkout 路径的规范化结果。
- Stripe webhook 地址仍为 `/api/payment/notify/stripe`；浏览器支付成功回跳 `/api/payment/callback` 不是 Stripe webhook。
- 充值真正到账依赖两组配置同时就绪：支付 provider 配置有效，New API 桥接和 `payment_compliance` 前置开关有效。

## 3. 业务目标

1. 让充值档位覆盖从试用到生产预充值的主要预算区间。
2. 降低低额订单带来的手续费占比和人工售后成本。
3. 允许用户输入符合限制的自定义充值金额。
4. 保持支付成功、credit 入账、APIPool ledger、New API quota 加额之间的现有幂等与补偿能力。
5. 普通用户只看到美元余额和美元充值金额；`credit`、cents 和 quota 作为内部实现单位。

## 4. 功能需求

### 4.1 预设充值档位

充值页应提供六个一次性 USD 充值档位：

| 档位    | 订单金额 cents | credit 数量 | 用户侧展示  |
| ------- | -------------: | ----------: | ----------- |
| `$10`   |         `1000` |      `1000` | `USD $10`   |
| `$50`   |         `5000` |      `5000` | `USD $50`   |
| `$100`  |        `10000` |     `10000` | `USD $100`  |
| `$200`  |        `20000` |     `20000` | `USD $200`  |
| `$500`  |        `50000` |     `50000` | `USD $500`  |
| `$1000` |       `100000` |    `100000` | `USD $1000` |

要求：

- 移除 `$5` 预设档位。
- `$50` 建议作为默认推荐档位。
- 每个档位仍是 `one-time`，不引入订阅。
- `amount` 和 `credits` 必须保持一致，均使用 cents 粒度整数。
- 中英文页面展示档位数量、金额、推荐状态和说明应一致。

### 4.2 自定义充值金额

充值页应提供一个自定义金额入口。

输入规则：

- 币种固定为 USD。
- 只允许整数美元。
- 最低金额为 `$10`。
- 最高金额为 `$1000`。
- 不允许 `$9`、`$10.5`、`0`、负数、非数字、空值或超过 `$1000` 的金额创建 checkout。

服务端规则：

- 前端校验仅用于用户体验，服务端必须重新校验金额。
- 服务端不得信任客户端提交的 cents、credits、product name 或展示文案。
- 预设档位继续来自服务端读取的 locale pricing 配置；自定义金额的可信金额只能来自服务端对 `amountUsd` 的校验和计算。
- 自定义金额的订单应由服务端根据 `amountUsd` 计算：
  - `amount = amountUsd * 100`
  - `creditsAmount = amountUsd * 100`
  - `currency = USD`
  - `paymentType = one-time`
  - `paymentInterval = one-time`
- 自定义金额应复用现有 `/api/payment/checkout` 创建支付订单和 Checkout Session。
- 自定义金额应复用现有 webhook、credit 入账、APIPool ledger 和 New API 额度执行器。

### 4.3 用户展示口径

用户侧文案应统一表达为美元余额：

- 充值按钮、余额卡片、到账记录、错误提示均使用 `USD $N` 或 `$N.00` 语义。
- 不在普通用户界面强调 `credit`。
- `credit` 仅作为内部整数记账单位，用于避免金额小数计算和复用模板账本能力。

### 4.4 支付与到账状态

充值成功链路应保持现有状态分离：

1. 用户发起 checkout。
2. 支付 provider 创建 Checkout Session。
3. 支付成功后 webhook 将订单置为 `paid`。
4. `handleCheckoutSuccess()` 写入本地 credit。
5. `handleCheckoutSuccess()` 触发 `applyRechargeForOrder()`。
6. `applyRechargeForOrder()` 创建或复用 `apipool_ledger_entry` 并调用 New API 额度执行器。
7. New API 加额成功后 ledger 变为 `applied`。

异常状态要求：

- 支付成功但 New API 加额失败时，订单仍为已支付，ledger 保持 `pending`、`failed` 或 `reconciliation_required`。
- 用户账单页应继续区分支付状态和到账状态。
- 管理员可继续通过现有重试和对账入口处理未到账订单。
- webhook 重放不得导致重复 credit 入账或重复 New API 加额。

## 5. 非目标

- 不新增其它币种。
- 不做订阅充值。
- 不做优惠券、折扣码、充值赠送或阶梯优惠。
- 不做自动退款或用户自助退款。
- 不改变 New API 的 quota 计费规则。
- 不改变管理员手动调额流程。
- 不把 `credit` 改名或迁移数据库字段。
- 不把充值档位改成后台动态配置；本次仍使用服务端读取的现有 locale pricing 配置作为预设套餐来源。
- 不实现 Stripe Dashboard 预建 Product/Price 依赖；继续使用动态价格创建 checkout。

## 6. 配置与上线前提

线上可用需要同时满足：

- `stripe_enabled=true`。
- `default_payment_provider=stripe`。
- Stripe secret key、publishable key 和 signing secret 有效。
- Stripe Dashboard webhook 配置到 `https://app.apipool.dev/api/payment/notify/stripe`。
- `NEXT_PUBLIC_APP_URL` / `AUTH_URL` 指向稳定 app 域名。
- `NEWAPI_INTEGRATION_ENABLED=true`。
- `NEWAPI_BASE_URL`、`NEWAPI_ADMIN_TOKEN`、`NEWAPI_ADMIN_USER_ID` 和 `NEWAPI_QUOTA_PER_UNIT` 有效。
- New API root 管理员已通过 dashboard session 确认 `payment_compliance`，使兑换码/加额相关能力可用。

若支付配置有效但 New API 桥接未就绪，用户可能完成支付但到账进入 pending 或 failed，需要后台补偿处理。

## 7. 验收标准

### 7.1 功能验收

- 充值页展示 `$10 / $50 / $100 / $200 / $500 / $1000` 六个预设档位。
- 充值页不再展示 `$5` 预设档位。
- `$50` 为推荐档位。
- 点击任一预设档位会创建对应 cents 金额的 checkout。
- 自定义 `$10` 可创建 checkout。
- 自定义 `$1000` 可创建 checkout。
- 自定义 `$9`、`$1001`、`$10.5`、非数字和空值被拒绝。
- 支付成功后订单金额、credit 数量和 ledger `amountUsd` 按单位换算一致：`order.amount = creditsAmount = ledger.amountUsd * 100`。
- 普通用户账单页展示美元金额，不要求理解 credit。

### 7.2 集成验收

- webhook 重放多次只产生一条 credit 入账记录和一条 recharge ledger。
- New API 加额成功后 ledger 状态为 `applied`。
- New API 不可用时，支付成功订单保留为可重试状态。
- 现有后台重试接口可继续按订单号触发未完成加额。
- 非 USD、自定义金额越界或小数金额不会写入订单；币种大小写差异不应影响合法 USD 订单。

### 7.3 UI 验收

- 档位和自定义金额在桌面宽度下布局清晰。
- 档位和自定义金额在移动端不挤压、不截断、不重叠。
- 加载态、错误态和按钮禁用态可见。
- 中英文页面文案完整，不出现 raw i18n key。

## 8. 测试建议

- 单元测试：覆盖充值金额校验、预设档位金额与 credits 映射、自定义金额 cents/credits 计算。
- API 测试：覆盖 `/api/payment/checkout` 对预设档位和自定义金额的成功/失败路径。
- 集成测试：扩展现有 `tests/payments/recharge.test.ts`，覆盖 `$1000` 和自定义金额支付成功后的 ledger 行为。
- UI 测试：覆盖账单页预设档位展示、自定义金额校验错误、合法金额提交 loading 状态。
- i18n 测试：覆盖中英文 pricing 配置金额一致，避免遗漏 `topup_100` 等新增档位。

## 9. 待设计确认

- 自定义金额在 checkout API 中使用独立 `custom_amount_usd` 字段，还是使用 `product_id=topup_custom` 搭配 amount 字段；无论采用哪种传参，客户端提交值都不能成为可信金额事实。
- 自定义金额产品名、订单描述和账单历史展示的最终文案。
- 自定义金额 UI 与预设档位在现有账单页中的布局方式。
