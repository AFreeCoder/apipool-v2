# 门户与 New API 路由计费解耦：开发遗留

## 切流前门禁

- [ ] 在目标环境设置 `APIPOOL_SMOKE_REQUIRE_LIVE=true`，完成 Gateway 数据面和充值闭环 live smoke；本次接收只验证了本地构建、测试和静态编排，没有部署，也没有目标环境凭据。
- [ ] 在安装 Caddy 的 CI 或等价 Linux 环境完成真实 `caddy adapt` / `caddy validate`；本机缺少 Caddy，相关本地用例按设计跳过，GitHub Actions 已配置为安装失败即失败。

## 运营期观察

以下均为已接受、需在运营期观察的遗留。PLAN.md 的设计勘误已扩至 E1–E9
并全部收编到对应 Task，本清单不重复登记勘误。

- [ ] Spike S1：截至 2026-07-15，管理员 `GET /api/log/` 从当前实现机返回空响应（Node `UND_ERR_SOCKET`、curl 52），字段形态尚未得到线上 fixture 证实。运行时保留管理员主路径，失败立即回退逐绑定用户 `/api/log/self`，并兼容顶层和 `other.request_id`；取得受信 fixture 后补契约测试。详见 [S1 记录](./s1-admin-usage-log-spike.md)。
- [ ] Spike S2：截至 2026-07-15，`GET /api/pricing` 同样无法取得响应，cache read、5m write、1h write 三维价格不能自动预填；继续要求管理员明确录入并锁定复核，不猜字段、不从 input/output 推导、不用零值代替未知。详见 [S2 记录](./s2-cache-pricing-spike.md)。
- [ ] 风险槽模型以并发近似未决消费，默认上限 10 对 Claude Code/Codex 类高并发客户端可能正常撞 429；按目标用户群和实际 `pending_backfill` 水位调参，不在无证据时直接放宽。
- [ ] 已接受局限 1：上游错误 body 可能残留 New API 品牌；只通过 New API 文案治理和运营巡检处理，不改只读响应体。
- [ ] 已接受局限 2：SQLite 单文件只保证同文件进程组内的原子准入；跨机扩容前必须先迁 PostgreSQL。
- [ ] 已接受局限 3：policy B 下“上游已消费但用户未收到”由运营承担；同主机窗口虽小，仍需通过对账和 waived 量告警观察。
- [ ] 已接受局限 4：对抗性中断流量的白嫖从实时拦截降为离线核查和人工封禁；低量 v1 接受。
- [ ] 已接受局限 5：网关与门户同进程，门户故障可能波及数据面；当前以可平移模块边界和 maintenance/fix-forward 兜底。
- [ ] sweeper 将“已有 request id 的超时 open 行”转为 `pending_backfill` 是设计缝隙的最小闭合；运营期观察误转率、回填延迟与积压。
- [ ] 评审 F8 降级修采用 stale 5 分钟 + keepAlive 穿插续租，拒绝 fencing token；残余竞态由业务唯一索引幂等兜底。若出现同 scope 双 token 或水位乱序，再作为独立 feature 评估 fencing。
- [ ] 评审 R4-F1 降级修对 finalize 终态写入做 3 次退避重试，不持久化意图 marker。残余窗口为“流中断且单条 UPDATE 三连失败”，open 经 sweeper 回填后可能按日志错扣一笔；由对账发现并用 `manual_adjustment` 人工冲正，实际出现后再重开终态意图持久化裁决。
- [ ] 评审 R6-F5 降级裁决：出现非零未映射 usage 维度时仍结算已知桶，因为整笔 `failed_unbilled` 或同样不识新维度的回填损失更大。恢复链路固定为 `unmapped_usage_dimension` 告警 → 对账 `amount_mismatch` → 扩展白名单 → 用带审计的 `manual_adjustment` 补历史差额。
- [ ] reconcile 时间片按 v1 量级固定为 10 分钟/片、50 页/片、12 片/轮；根据 `reconcile_slice_overflow` 频率调参。
- [ ] 评审 R17：常规发布冻结 checkout 只阻止创建新支付会话；冻结前已创建的在途会话若在新镜像启动后、充值 smoke 完成前的秒级窗口抵达，仍会在尚未最终验证的镜像上结算。当前由每小时钱包不变量检查提供可见性，并可用带审计的 `manual_adjustment` 冲正；业务量提升后再设计可重试的结算门控。

十七轮评审完整处置见 [review-log.md](../../plan/portal-newapi-routing-billing-decoupling/review-log.md)。
