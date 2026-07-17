# 门户与 New API 路由计费解耦：开发遗留

## 上线前门禁

- [ ] 首次开放 checkout 前，在隔离环境完成备份恢复演练并保存真实、可读、非空的证据文件；`go-live.sh open-checkout` 必须通过 `--evidence <路径>` 校验后才能开收款。
- [ ] 按 runbook §6.2 查询生产门户库中的有效旧 credit 余额，必须返回零行；测试余额需登记后清理，归属不明或可能是真实余额时停止开放 checkout。
- [ ] 在目标环境设置 `APIPOOL_SMOKE_REQUIRE_LIVE=true`，完成 Gateway 数据面和充值闭环 live smoke；本次接收只验证了本地构建、测试和静态编排，没有部署，也没有目标环境凭据。
- [ ] 在安装 Caddy 的 CI 或等价 Linux 环境完成真实 `caddy adapt` / `caddy validate`；本机缺少 Caddy，相关本地用例按设计跳过，GitHub Actions 已配置为安装失败即失败。

## 本次接收已闭环裁决

- [x] 2026-07-16 现场裁决：线上无真实用户和真实流量，不做渐进切流。删除钱包写入、钱包展示和 API 路由模式三个开关；充值固定写钱包账本并停写 credit，Dashboard/API 固定读取钱包与请求账本，Caddy 固定 `api2 /v1 → portal`、`newapi /v1 → 404`。仅保留 `APIPOOL_CHECKOUT_ENABLED` 作为收款开放门禁。
- [x] Task 11 终态充值语义：`applyApipoolRecharge` 在首次结算和 PAID 重放下都照常执行；回归测试同时校验钱包流水与远端推送凭证按 `order_no` 幂等。
- [x] runtime credential worker 的 invalid→pending 与失败 catch 更新都增加 `status IN ('pending','invalid')` 条件，管理员并发禁用后不得把凭证复活为 pending/active；已补“创建 token 期间禁用”的竞态测试。
- [x] Task 25 公开目录 callable 叠加不增加运行时门控。明确接受“代码部署后、路由/价格发布前”短暂显示不可调用；运营顺序固定为“部署 → 立即发布路由/价格 → 上线验证”，验证完成前保持 checkout=false。详见 [runbook §6.1](../../07-runbook.md#61-上线顺序)。
- [x] 告警关键字检索式已改为代码中真实存在的日志词，并按终态、凭证、回填、资金/路由四类补充处置入口。详见 [runbook §6.5](../../07-runbook.md#65-观察-72h告警与旧-token-收尾)。

## 运营期观察

以下均为已接受、需在运营期观察的遗留。PLAN.md 的设计勘误已扩至 E1–E9
并全部收编到对应 Task，本清单不重复登记勘误。

- [ ] Spike S1：截至 2026-07-15，管理员 `GET /api/log/` 从当前实现机返回空响应（Node `UND_ERR_SOCKET`、curl 52），字段形态尚未得到线上 fixture 证实。运行时保留管理员主路径，失败立即回退逐绑定用户 `/api/log/self`，并兼容顶层和 `other.request_id`；取得受信 fixture 后补契约测试。详见 [S1 记录](./s1-admin-usage-log-spike.md)。
- [x] Spike S2：2026-07-16 已从生产 `GET /api/pricing` 取得脱敏价格事实，并对照生产提交结算源码复核倍率公式。`gpt-5.5` 改为 input/cached input/output 三维；5m/1h write 不适用。原失败现场保留在 [S2 记录](./s2-cache-pricing-spike.md)，后续调整见 [OpenAI 计价维度调整记录](./openai-pricing-adjustment.md)。
- [ ] OpenAI 长上下文阶梯：官方 GPT-5.5/GPT-5.6 对超长输入存在额外倍率，当前生产 `/api/pricing` 未返回 `billing_mode/billing_expr`。本阶段按 New API 当前实际倍率结算；若 New API 开启阶梯计费，必须扩展价格快照和账本测试后再同步门户规则。
- [ ] GPT-5.6 cache write：官方为单一 write 价格，当前生产 `/api/pricing` 未返回 `create_cache_ratio`。该系列正式发布前必须取得字段或真实 usage/log 证据，并验证 Chat/Responses 的 `cache_write_tokens` 结算；不得沿用 `gpt-5.5` 三维快照直接发布。
- [ ] 风险槽模型以并发近似未决消费，默认上限 10 对 Claude Code/Codex 类高并发客户端可能正常撞 429；按目标用户群和实际 `pending_backfill` 水位调参，不在无证据时直接放宽。
- [ ] 已接受局限 1：上游错误 body 可能残留 New API 品牌；只通过 New API 文案治理和运营巡检处理，不改只读响应体。
- [ ] 已接受局限 2：SQLite 单文件只保证同文件进程组内的原子准入；跨机扩容前必须先迁 PostgreSQL。
- [ ] 已接受局限 3：policy B 下“上游已消费但用户未收到”由运营承担；同主机窗口虽小，仍需通过对账和 waived 量告警观察。
- [ ] 已接受局限 4：对抗性中断流量的白嫖从实时拦截降为离线核查和人工封禁；低量 v1 接受。
- [ ] 已接受局限 5：网关与门户同进程，门户故障可能波及数据面；当前以可平移模块边界、checkout 冻结和稳定镜像回滚兜底。
- [ ] sweeper 将“已有 request id 的超时 open 行”转为 `pending_backfill` 是设计缝隙的最小闭合；运营期观察误转率、回填延迟与积压。
- [ ] 评审 F8 降级修采用 stale 5 分钟 + keepAlive 穿插续租，拒绝 fencing token；残余竞态由业务唯一索引幂等兜底。若出现同 scope 双 token 或水位乱序，再作为独立 feature 评估 fencing。
- [ ] 评审 R4-F1 降级修对 finalize 终态写入做 3 次退避重试，不持久化意图 marker。残余窗口为“流中断且单条 UPDATE 三连失败”，open 经 sweeper 回填后可能按日志错扣一笔；由对账发现并用 `manual_adjustment` 人工冲正，实际出现后再重开终态意图持久化裁决。
- [ ] 评审 R6-F5 降级裁决：出现非零未映射 usage 维度时仍结算已知桶，因为整笔 `failed_unbilled` 或同样不识新维度的回填损失更大。恢复链路固定为 `unmapped_usage_dimension` 告警 → 对账 `amount_mismatch` → 扩展白名单 → 用带审计的 `manual_adjustment` 补历史差额。
- [ ] reconcile 时间片按 v1 量级固定为 10 分钟/片、50 页/片、12 片/轮；根据 `reconcile_slice_overflow` 频率调参。
- [ ] 评审 R17：常规发布冻结 checkout 只阻止创建新支付会话；冻结前已创建的在途会话若在新镜像开始接收请求后、当前 `IMAGE_TAG` 的 recharge smoke marker 写入且 checkout 重开前抵达，仍会在尚未最终验证的镜像上结算。该秒级窗口的起点是新容器接流，终点是 smoke 成功并恢复 checkout；当前由每小时钱包不变量检查提供可见性，并可用带审计的 `manual_adjustment` 冲正。业务量提升后再设计可重试的结算门控。

十七轮评审完整处置见 [review-log.md](../../plan/portal-newapi-routing-billing-decoupling/review-log.md)。
