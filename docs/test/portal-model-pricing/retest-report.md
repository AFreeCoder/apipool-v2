# 门户模型定价与调用计费修复复测报告

- 日期：2026-07-21
- 修复基线：分支 `codex/portal-model-pricing-implementation` 当前工作树
- 原始验收：[`report.md`](report.md)
- 代码评审：[`code-review.md`](code-review.md)
- 闭环清单：[`issues.md`](issues.md)

## 结论

本轮代码级回归和合成本地浏览器回归通过，原评审中的后台保存、内部运行池缺失、计费边界、对账竞态、公共价格、用量/账单页面及请求契约问题已修复。

当前仍**不具备发布结论**：内部运行池实现已按既定阶段二需求完成，但本轮没有目标 New API 环境凭据，尚未真实验证该部署版本的 `POST /api/user/manage` override 契约，以及“全新用户仅本地入账后首次调用”的完整闭环；同时尚未重新执行真实提供商的图片、长上下文和 web search 调用。不能用官方源码核对、mock 契约测试、合成数据库或本地页面检查替代这些证据。

## 自动化验证

| 验证项                                                                    | 结果                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm lint`                                                               | 通过，0 error；193 条既有 warning                |
| `pnpm exec tsc --noEmit`                                                  | 通过                                             |
| `pnpm test`                                                               | 通过，812 tests：811 passed、1 skipped、0 failed |
| `NODE_OPTIONS='--max-old-space-size=4096' pnpm exec next build --webpack` | 通过，编译、类型检查和页面生成完成               |

定向回归覆盖：内部运行池首次绝对值供应与重复幂等、存量绑定 bootstrap、低水位只监控不自动补充、显式人工补充和审计、供应失败不创建运行 Key；以及 0 价 tier、Embedding 输入单价、per_call 公开 SKU、长 URL/b64 图片计数、New API 图片 usage 字段别名、usage 小数防御、Images `stream:true`、multipart 缺图、成本参照快照、default/non-default per_call 对账及 settlement/waive 竞态。

生产镜像使用与 Dockerfile 相同的 esbuild 参数成功生成 `runtime-pool-maintenance.cjs`，`--help` 启动检查通过；Next.js webpack 生产构建完成编译、类型检查、静态页面生成和 build trace 收集。

## 内部运行池专项结论

- 运行 Key 激活前先读取绑定用户的 New API quota；低于阈值时通过管理员 `POST /api/user/manage` 以 `add_quota + override` 覆盖到目标值，随后用用户上下文回读精确确认。
- `runtimePoolProvisionedAt` 作为一次性标记；远端响应不确定时重复写同一绝对目标不会叠加，标记与脱敏审计在本地同一事务提交。
- 迁移前已有活跃绑定由首轮后台任务一次性供应；之后每小时任务只更新 `ready/low/depleted/error` 水位并告警，不自动补充。
- 生产检查命令默认不改远端；只有显式 `--apply` 才补充低水位或耗尽绑定，并记录 `newapi.runtime_pool.replenish`。门户钱包、充值、退款和 APIPool 调额链路均未接入该远端写操作。
- 端点形状已按 New API 官方 `v1.0.0-rc.20` 路由、控制器和计费源码核对，mock 测试确认管理员/用户双认证上下文；目标部署版本真实调用仍是发布门禁。

## 本地浏览器回归

使用一次性 SQLite 数据库和合成用户/管理员启动本地开发服务，完成以下检查：

- 模型编辑与 listing 编辑均可保存，服务端数据持久化，页面重定向和提示正常。
- 公共模型目录立即反映编辑结果；按次模型展示 default/low SKU 单次价格。
- 仅输入价的 Embedding 模型正常展示输入单价，输出列为 `—`。
- Checkout 关闭时，控制台首页和账单页不展示充值入口，余额提醒隐藏，充值历史空状态不再提示用户充值。
- 中文文档页不再出现“切换到中文”提示；余额不足、Embeddings、Images、按次计费与示例模型说明可见。

浏览器环境仅用于 UI/Server Action 回归，没有提交真实凭据、支付信息或生产数据。检查结束后已停止开发服务并删除一次性数据库。

## 尚未完成的发布证据

1. 在目标 New API 版本用全新门户用户完成“仅本地钱包入账 → 创建 Key → 内部池自动供应 → 首次真实调用”，核对 override 请求、回读水位和脱敏审计；不得手工修改远端用户数据后冒充通过。
2. 重新执行真实图片生成/编辑，确认图片 usage 不再产生 `token_mismatch`，长 URL 返回可正确按张结算。
3. 用真实 chat/responses web search 响应确认 `server_tool_use` 形态和计次字段。
4. 执行 272K 长上下文真实验证，并记录脱敏的请求、账本和 New API 日志关联证据。

完成以上项目后，才能把本报告的结论升级为“可发布”。
