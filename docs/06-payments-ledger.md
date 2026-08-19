# 06 支付与钱包账本

## 1. 当前边界

门户本地钱包是用户余额的唯一事实源：

- `wallet_account` 保存当前余额与冻结状态；
- `wallet_ledger` 保存充值、人工调额、请求扣费和冲正的追加式流水；
- `request_ledger` 保存请求状态、用量、金额及结算时锁定的价格版本；
- New API quota、旧 `apipool_ledger_entry` 和模板 `credit` 不参与门户余额计算。

## 2. 充值链路

```text
用户选择一次性充值金额
  → 创建支付订单
  → 支付渠道确认成功
  → 同一数据库事务内：订单置 paid + 写 wallet_ledger(recharge)
  → 原子增加 wallet_account.balance_micro_usd
  → 控制台读取本地钱包余额与流水
```

金额统一使用整数 micro-USD，`1 USD = 1,000,000 micro-USD`。浏览器提交的金额不能直接作为入账依据，服务端只接受已配置套餐或服务端校验后的自定义金额。

当前一次性充值规则：

- 预设档位为 `$10 / $50 / $100 / $200 / $500 / $1000`，其中 `$50` 为推荐档；
- 自定义充值只支持 USD 整数，范围 `$10–$1000`；
- 前端校验只改善体验，服务端必须重新校验金额、币种和范围；
- 预设金额以服务端配置为事实源，自定义金额由服务端根据 `custom_amount_usd` 计算；客户端提交的 cents、余额单位、商品名或展示文案均不可信；
- 所有充值均为 one-time，不引入订阅、优惠券、赠送或阶梯优惠。

## 3. 幂等与不变量

- webhook 重放：已支付订单直接短路；同一 `order_no` 最多存在一条充值流水。
- 人工调额：调用方必须提供幂等键，同一幂等键重复提交返回既有结果。
- 请求扣费：一条 `request_ledger` 最多对应一条钱包扣费流水；冲正引用原扣费流水。
- 钱包守恒：`wallet_account.balance_micro_usd` 必须等于该用户全部 `wallet_ledger.signed_amount_micro_usd` 之和。
- 所有金额写入前检查安全整数范围，禁止浮点美元直接进入账本。

## 4. 人工调额

管理后台只保留“APIPool 调额”入口。该入口调用本地钱包调额服务并写审计，不创建 New API 兑换码、不修改 New API 用户 quota。网关运营页不提供第二套余额修改表单；网关内部调额接口仅允许对既有请求扣费做幂等冲正。

## 5. 结算与失败处理

- 支付订单与钱包充值在同一事务提交，不存在“门户已到账、New API 未加额”的跨系统中间态。
- 请求在准入时锁定路由和价格快照；结算根据真实 usage 生成本地扣费流水。
- 上游失败且未形成可计费用量时记 `failed_unbilled`，不扣钱包。
- 终态写入遇到数据库忙时做有界重试；重试耗尽时账本保持 `open`，后台 sweeper 最终将其
  收束为 `failed_unbilled` 并释放风险槽。New API 日志只补充观测，不据此回填结算或重复扣费。
- 钱包透支超过风险阈值时可冻结；补款和人工解冻后恢复。

## 6. 对账

运营对账围绕三条本地链路：

```text
支付：order(paid) ↔ wallet_ledger(recharge)
调用：request_ledger(settled) ↔ wallet_ledger(request_charge)
余额：wallet_account.balance ↔ SUM(wallet_ledger.signed_amount)
```

New API 请求日志可用于核对上游用量和价格元数据，但不能覆盖本地钱包余额或生成第二套用户账本。

## 7. 守护测试

- webhook 重放多次仍只有一条充值流水，且旧 `credit`、`apipool_ledger_entry` 均不新增；
- 钱包余额始终等于追加式流水之和；
- 人工调额重复提交保持幂等；
- 自动路由或价格版本变化后，历史请求仍按原价格版本结算；
- New API 不可用时不会阻止已确认支付写入本地钱包。
