# 06 支付与加额账本设计

## 1. 总览

充值美元余额、按量扣费。支付沿用模板现成链路承担（Stripe + Creem 双接，先批先用），门户记账，New API 执行额度。一笔充值的生命周期：

```
用户选套餐 → POST /api/payment/checkout → 跳转支付页 → 支付成功
  → webhook /api/payment/notify/[provider]
    → 订单置 paid（模板 handleCheckoutSuccess）
    → 本地 credit 入账（模板 grantCreditsForUser）
    → 【新增】加额执行器：给 New API 加同额 quota
  → 控制台余额 +N
```

## 2. 充值套餐

一次性 credits 商品（非订阅）：`$5 / $10 / $50`，1 credit = $0.01（与模板 credit 整数粒度对齐）。套餐配置走模板 pricing 配置，控制台充值 tab 展示。

## 3. 加额执行器（New API 侧）

**首选：兑换码模式**（天然幂等、易对账）：

```
1. webhook 确认订单 paid、本地 credit 入账
2. 写 apipoolLedgerEntry（source='recharge'，status='pending'，关联 order_no）
3. 管理员上下文 POST /api/redemption/ 生成一次性兑换码（金额 = 订单美元 × QUOTA_PER_UNIT；名称限长 20 字符，存 order_no 的短哈希，对账以兑换码值关联 ledger）
4. 用户上下文 POST /api/user/topup { key: 兑换码 } 完成兑换
5. ledger 置 applied，记录兑换码 ID 作为 changeId
```

一码只能兑一次：步骤 4 重复执行会被 New API 拒绝，不会重复加额。

**降级方案**（兑换码接口不可用时）：管理员 `PUT /api/user/` 读改写 quota。存在并发竞态，必须按 newapiUserId 串行化（进程内队列或 DB 行锁），并在前后各读一次 quota 写入审计。

## 4. 幂等与去重

| 环节            | 机制                                                                 |
| --------------- | -------------------------------------------------------------------- |
| webhook 重放    | 模板订单状态机：订单已 paid 则跳过入账                               |
| credit 重复入账 | `credit` 表按 `order_no` 查重（模板现成行为，需测试确认）            |
| 加额重复执行    | `apipoolLedgerEntry.order_no` 唯一索引：插入冲突说明已处理，直接短路 |
| 兑换重复提交    | 兑换码一码一兑，New API 侧拒绝                                       |

## 5. 失败补偿

- **加额失败（New API 宕机/超时）**：ledger 保持 `pending`/`failed`，用户余额展示带"到账处理中"态；admin 后台提供按 ledger 行重试的入口；恢复后重试从第 3 步继续（若兑换码已生成则只重试兑换）。
- **远端成功但本地标记失败**：以兑换码 ID 反查——对账任务发现 New API 已兑换但 ledger 非 applied 时，补置 applied。
- **用户在 pending 期间发起调用**：允许失败（余额未到账即额度不足），文案提示充值到账中。

## 6. 对账

最小对账查询（admin 后台/脚本均可）：

```
orders(status=paid) ⟷ apipoolLedgerEntry(source=recharge) ⟷ New API 兑换记录
```

三方按 order_no / 兑换码名称关联，输出三类差异：已支付未入账、已入账未加额、已加额未标记。MVP 阶段人工触发即可，迭代 3 做成定时 watchdog。

## 7. 退款（MVP 仅预留）

MVP 不做自助退款。人工退款流程：admin 生成负向 ledger 行 → 手动在 New API 扣减 quota → 支付渠道后台操作退款。三步均落审计。

## 8. 守护测试要求（M2 交付）

- webhook 重放 3 次只入账/加额 1 次（单测 + 集成测试）。
- New API 不可用时支付完成 → ledger pending → 恢复后重试成功，金额不重不漏。
- ledger 金额与订单金额换算一致（美元 ↔ credit ↔ quota 三种单位换算集中在一个模块，杜绝散落换算）。
