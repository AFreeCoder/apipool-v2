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

**核心原则**：只有能**证明**远端未发生任何副作用时，才允许自动重试。「本地没记下码值」不是这样的证明。

- **`POST /api/redemption/` 返回之前失败（绑定失败、New API 宕机、创建兑换码超时）**：创建兑换码**不发放额度**，最坏只在远端留下一张未兑换的孤儿码，用户余额不受影响。ledger 保持 `pending`/`failed` 可自动重试；用户余额展示带"到账处理中"态；admin 后台提供按 ledger 行重试的入口。
- **`POST /api/redemption/` 返回之后的任何失败**（响应损坏、兑换请求超时、确认查询失败、进程被杀）：**禁止自动重试**——「一码一兑」的幂等只对同一张码有效，重试会生成第二张码，兑换成功即双倍到账。该行一律转 `reconciliation_required` 等人工核对。
- **两个持久化证据**（缺一不可）：
  - `ledger.remoteAttemptAt`：在**任何远端副作用之前**写入。为 null 才证明"远端从未被尝试"。
  - `ledger.newapiChangeId`：在**发出兑换请求之前**写入。额度发放（topup）严格晚于它，故**额度已发放 ⇒ 码值必已落库**。
- **不变量**：ledger 行只要带有 `newapiChangeId` **或** `remoteAttemptAt`，任何自动路径（webhook 重放、支付回跳、admin retry、processing 超时重夺）都不得再次调用加额。
- **processing 卡死**：进程在 claim 后崩溃会把行留在 `processing`。超过 5 分钟且 `remoteAttemptAt` 与 `newapiChangeId` **均为 null** 的行才可安全重夺重试（证明崩溃发生在任何远端调用之前）；否则升级为 `reconciliation_required`。
- **远端成功但本地标记失败**：以兑换码 ID（`newapiChangeId`）反查；若连码值都没落库（响应损坏 / 崩溃在落库前），按兑换码名反查——名称是 `reference` 的确定性短哈希 `r + sha256(reference)[0:18]`，可随时由 order_no 重算。
- **已知残留**：创建兑换码超时且远端实际已创建时，重试会留下一张**未兑换的孤儿码**（面值等于充值额，码值已丢失，仅在 New API 管理后台可见）。它不影响用户余额，需 New API 管理员才能兑换。New API 无兑换码检索接口，门户侧无法自动清理；上线后按名称人工巡检。
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
