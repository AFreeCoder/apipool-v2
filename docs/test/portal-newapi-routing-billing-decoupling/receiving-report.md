# 门户与 New API 路由计费解耦：接收报告

## 结论

截至 2026-07-15，双线成果已按“Codex 为主、Claude 选择性吸收”的方案收编到
`codex/portal-newapi-routing-billing-receiving`。

本地接收结论为：**通过，可进入 push、CI 和目标环境 live smoke；尚不允许直接切流。**
本次未推送、未合并、未部署，也未使用生产凭据。

## 接收基线与范围

- 基线：`origin/main`，提交 `23d513f5f5b41fe075200519a3a19455567bbf64`。
- 收编 4 个已批准的需求、设计、计划及规范提交。
- 收编 Codex 实施线从 Task 1 到 Task 28 的全部任务提交。
- 没有整分支合并旧 Codex 分支；旧基线继承的无关预发布审查、事故和 smoke
  历史未进入接收分支。
- Claude 线不作为整体基线；仅吸收对主线有证据价值的契约、测试与兼容性补强。

## 接收时补强

1. 恢复 `runReconcileSyncOnce` 的计划契约，返回
   `scanned / settledByLog / orphans / truncated`，并为各计数补测试。
2. New API 用量日志保留原始整数 `quota`；回填和对账优先使用原值，仅在缺失时
   回退到美元换算，避免浮点往返造成计费差异。
3. 将内存门禁升级为真实压力测试：在 256 MiB V8 heap 限制下，分别执行
   Content-Length 和 chunked 的 `16 × 25 MiB` 并发请求。
4. 补齐缺失目标组的零写入校验，以及路由退役的条件、审计、幂等和原因校验。
5. 使部署切流测试兼容当前主线的 `newapi-metadata-filter` 健康检查；生产部署逻辑
   未降级，修正的是旧测试 fixture 缺少当前主线服务的问题。

## 验证结果

| 门禁                            | 结果                                 |
| ------------------------------- | ------------------------------------ |
| TypeScript 类型检查             | 通过                                 |
| 接收补强定向测试                | 53 / 53 通过                         |
| Gateway 集成测试                | 31 / 31 通过                         |
| 部署切流测试                    | 14 / 14 通过                         |
| 全量 `pnpm test`                | 775 项；772 通过，0 失败，3 跳过     |
| `pnpm lint`                     | 0 错误，193 个既有告警               |
| `pnpm build`                    | 通过，包含 `/v1/[...path]` 路由      |
| Metadata Filter `go test ./...` | 通过                                 |
| 生产 Compose 静态解析           | 通过                                 |
| `pnpm smoke:mvp`                | 因无 live 环境而跳过，不计为线上通过 |

真实内存压力结果：

- Content-Length：external 增量约 404 MiB，RSS 约 405 MiB。
- chunked：external 增量约 404 MiB，RSS 约 404 MiB。
- 两种模式均低于测试设置的 600 MiB external 上限。

## 跳过项与剩余门禁

全量测试的 3 个跳过项分别是：

1. 本机未安装 Caddy，2 个真实 `adapt / validate` 用例跳过；CI 已强制安装 Caddy，
   安装或校验失败都会阻断。
2. 可选的本地 Next.js dev smoke 跳过。

目标环境 Gateway live smoke、充值闭环 live smoke 尚未执行。管理员 usage log 和
pricing 两项上游 spike 也仍需按
[开发遗留](../../dev/portal-newapi-routing-billing-decoupling/issues.md)持续跟踪。

因此当前裁决是：

- **GO**：推送接收分支、运行 CI、进入目标环境受控验收。
- **NO-GO**：在 Caddy 真实校验和目标环境两类 live smoke 完成前直接切流。
