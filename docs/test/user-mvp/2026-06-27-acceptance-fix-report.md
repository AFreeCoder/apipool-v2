# User MVP 验收问题修复报告

> 日期：2026-06-27
> 修复分支：`codex/user-mvp-acceptance-fixes`
> 原始测试报告：`docs/test/user-mvp/2026-06-27-acceptance-report.md`
> 范围：基于 `main` 新建 worktree 后，逐项修复原验收报告问题。
> 发布动作：未执行 `gstack:ship`、`land-and-deploy` 或 `canary`。

## 一、修复队列

| 问题编号 | 严重级别 | 判断结果 | 处理状态 |
| --- | --- | --- | --- |
| 1. 后台调额重复提交缺服务端幂等 | High | 真实 bug | Fixed |
| 2. `smoke:mvp` 发布门禁可能假阳性 | High | 真实 bug | Fixed |
| 3. `/models` 可展示 disabled 维度 listing | Medium | 真实 bug | Fixed |
| 4. API Key 页可为无 callable 模型的分组创建 Key | Medium | 真实 bug，符合验收预期 | Fixed |
| 5. `/api/apipool/billing` 返回 ledger 宽 DTO | Medium | 真实 bug | Fixed |
| 6. API Key 同名校验非原子 | Medium | 真实 bug | Fixed |
| 7. 本地 binding update 失败可能透出内部错误 | Low | 真实 bug | Fixed |
| 8. 英文 Billing 页到账状态硬编码中文 | Low | 真实 bug | Fixed |
| 9. 偶发 hydration warning 与错误提示视觉弱化 | Low | hydration 不可复现；视觉优化可延后 | Deferred |

## 二、逐项处理记录

### 1. High：后台调额重复提交缺服务端幂等

- 原始问题描述：管理员人工增减额度时，重复提交可能重复加款或扣款。
- 复现结果：确认真实。原实现每次请求生成新的 `portal-adjustment:${user}:${uuid}`，账本层没有业务幂等约束。
- 根因：调额业务没有从 UI、API 到数据库建立同一业务请求的 idempotency key。
- 修复内容：前端调额表单生成并复用 idempotency key；API route 接收该 key；`adjustPortalQuota` 按 key 复用 ledger；SQLite schema 和迁移新增 `apipool_ledger_entry.idempotency_key` 唯一索引。
- 新增或更新的测试：`tests/api-console/admin-permission.test.ts`、`tests/newapi-bridge/billing-ledger.test.ts`。
- 验证命令和结果：`pnpm test` 通过，239/239 pass；本地 New API live smoke 10/10 pass。
- 最终状态：Fixed。

### 2. High：`smoke:mvp` 发布门禁可能假阳性

- 原始问题描述：缺少 live env 时 `smoke:mvp` 退出 0，且未验证 DB-backed catalog 和真实 New API 闭环。
- 复现结果：确认真实。
- 根因：脚本仍使用旧 fixture/可选 live 逻辑，没有和 user-mvp 的 DB catalog、key 创建、用量同步闭环绑定。
- 修复内容：smoke 改为读取 DB 中 public/callable/smokeTested catalog；检查 New API health；创建真实 API key；执行人工配额；调用 launch model；同步用量；禁用 key 并验证 401；`APIPOOL_SMOKE_REQUIRE_LIVE=true` 时缺 live 变量必须失败。
- 新增或更新的测试：`tests/smoke/mvp-smoke-script.test.ts`。
- 验证命令和结果：`APIPOOL_SMOKE_REQUIRE_LIVE=true ... pnpm exec tsx scripts/smoke-mvp.ts` 通过，10/10 pass；New API 本地 Docker 版本为 `v1.0.0-rc.10`。
- 最终状态：Fixed。

### 3. Medium：`/models` 可展示 disabled group/vendor/category/capability 下的 listing

- 原始问题描述：公共模型广场可能展示运营已禁用维度下的 listing。
- 复现结果：确认真实。
- 根因：public 查询只过滤 `catalogStatus.isPublicVisible`，没有统一要求 vendor/group/category/capability active。
- 修复内容：public、filter、callable、smoke 候选查询统一排除 disabled 维度；能力过滤只匹配 active capability；多能力模型查询避免重复 listing。
- 新增或更新的测试：`tests/api-catalog/queries.test.ts`。
- 验证命令和结果：`NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/api-catalog/queries.test.ts` 通过，9/9 pass；浏览器 QA `/models` 仅显示 1 条 `GPT-4o mini` 且无 console error。
- 最终状态：Fixed。

### 4. Medium：API Key 页可为无 callable 模型的分组创建 Key

- 原始问题描述：无 callable listing 的分组仍可出现在 Key 创建下拉并创建 Active key。
- 复现结果：确认真实。代码评审复核发现 `getGroupsForKeyCreation` 仍只看 group active 与 `allowCreateKey`。
- 根因：Key 创建分组筛选条件没有与 callable listing 条件对齐。
- 修复内容：`getGroupsForKeyCreationUncached` 改为从 callable listing 反推可创建分组，并要求 group、vendor、category、capability、status 均 active。
- 新增或更新的测试：`tests/api-catalog/queries.test.ts` 增加无 callable 分组不返回的断言。
- 验证命令和结果：先加测试得到失败，再修复后定向测试 9/9 pass；全量 `pnpm test` 239/239 pass。
- 最终状态：Fixed。

### 5. Medium：`/api/apipool/billing` 返回 ledger 宽 DTO

- 原始问题描述：用户侧 billing API 返回内部 ledger 字段。
- 复现结果：确认真实。
- 根因：route 直接返回 ledger service 的宽投影，没有账单页专用 DTO。
- 修复内容：billing API 改为窄 DTO，只返回用户账单页需要的字段；不暴露 New API、operator、rollback 等内部语义。
- 新增或更新的测试：`tests/api-console/billing.test.ts`。
- 验证命令和结果：`pnpm test` 通过，239/239 pass。
- 最终状态：Fixed。

### 6. Medium：API Key 同名校验非原子

- 原始问题描述：同一用户并发创建同名 key 时，应用层先查后写存在竞态窗口。
- 复现结果：确认真实。
- 根因：缺数据库级唯一约束。
- 修复内容：SQLite schema 和迁移增加同用户、同 display name、未删除 key 的部分唯一索引；创建流程捕获约束错误并返回安全文案。迁移前会为历史重复 active key 自动追加短 id 后缀，避免旧库迁移失败。
- 新增或更新的测试：`tests/newapi-bridge/portal.test.ts`。
- 验证命令和结果：`pnpm test` 通过；临时 SQLite 旧库重复 key 场景应用 `0005` 迁移成功。
- 最终状态：Fixed。

### 7. Low：本地 binding update 失败可能透出 SQL/constraint 错误

- 原始问题描述：远端 key 创建成功但本地 binding update 失败时，可能向用户暴露 SQL/constraint 细节。
- 复现结果：确认真实。
- 根因：本地持久化失败重新抛出原始错误，public error mapper 覆盖不足。
- 修复内容：本地 binding 失败包装为安全 `NewApiBridgeError`；public error mapper 补充内部错误关键词脱敏。
- 新增或更新的测试：`tests/api-console/public-errors.test.ts`、`tests/newapi-bridge/portal.test.ts`。
- 验证命令和结果：`pnpm test` 通过，239/239 pass。
- 最终状态：Fixed。

### 8. Low：英文 Billing 页到账状态硬编码中文

- 原始问题描述：英文账单页可能展示 `已到账`、`到账处理中`、`到账失败` 等中文文案。
- 复现结果：确认真实。
- 根因：到账状态映射写在页面代码中，未按英文 locale 输出。
- 修复内容：英文页面状态改为 `Applied`、`Processing`、`Failed` 等英文用户可读文案。
- 新增或更新的测试：`tests/api-console/billing.test.ts`。
- 验证命令和结果：`pnpm test` 通过，239/239 pass。
- 最终状态：Fixed。

### 9. Low：偶发 hydration warning 与错误提示视觉弱化

- 原始问题描述：浏览器 QA 曾观察到一次 hydration warning；duplicate error 视觉优先级偏弱。
- 复现结果：本轮未能稳定复现 hydration warning；浏览器 QA 多次访问相关页面无 console error。
- 根因：hydration warning 暂无稳定证据；错误提示样式属于低优先级视觉增强。
- 修复内容：本轮未改视觉样式，避免把低优先级优化混入验收 bug 修复。
- 新增或更新的测试：无。
- 验证命令和结果：gstack browse 访问 `/models`、`/dashboard/billing`、`/admin/apipool-adjustments`，均无 console error。
- 最终状态：Deferred。

## 三、代码评审结果

- 发现的问题：
  - High：catalog 查询加入 capability join 后，多能力模型会重复返回 listing。
  - High：Key 创建分组仍未按 callable listing 过滤。
  - Medium：`_journal.json` 引用了新增迁移，但迁移 SQL 和 snapshot 仍是 untracked，提交时必须纳入。
  - Medium：新增唯一索引可能在旧库已有同名未删除 key 时迁移失败。
  - Low：缺少 public/callable/smoke 查询不重复的回归断言。
- 已采纳修复：
  - catalog 查询改用 active capability model id 集合过滤，避免 join 扩行后重复 listing。
  - `getGroupsForKeyCreationUncached` 改为只返回有 callable listing 的分组。
  - `getSmokeTestedCallableModelIdsByGroupUncached` 使用 distinct。
  - 迁移 SQL 在创建 display name 唯一索引前清理历史重复 active key。
  - 测试新增不重复断言和无 callable 分组不返回断言。
- 未采纳原因：无。所有有效评审意见均已处理。

## 四、最终验证

| 验证项 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| diff whitespace | `git diff --check` | 通过 | 无 whitespace error |
| lint | `pnpm lint` | 通过 | 0 errors，196 warnings，为仓库既有 warning |
| typecheck | `pnpm exec tsc --noEmit` | 通过 | 无错误输出 |
| unit tests | `pnpm test` | 通过 | 239/239 pass |
| integration tests | `pnpm test` 中 catalog、api-console、newapi-bridge、billing/ledger、smoke 行为测试 | 通过 | 覆盖本轮服务层和 API 形状 |
| migration check | 临时 SQLite 旧库重复 key 场景应用 `0005` | 通过 | 重复 active key 被重命名，唯一索引创建成功 |
| build | `pnpm build` | 通过 | Next 16/Turbopack production build 成功 |
| live smoke | `APIPOOL_SMOKE_REQUIRE_LIVE=true ... pnpm exec tsx scripts/smoke-mvp.ts` | 通过 | 本地 New API Docker，10/10 pass |
| browser/UI QA | gstack browse 访问 `/models`、`/dashboard/billing`、`/admin/apipool-adjustments` | 通过 | `/models` 仅 1 条 `GPT-4o mini`，受保护页跳 sign-in，均无 console error |

## 五、剩余风险

- 未修复项：
  - Issue 9 中错误提示视觉增强未处理。
  - hydration warning 本轮不可复现，暂未定位到稳定根因。
- 延后项：
  - OAuth Google/GitHub live 登录。
  - Resend 真实邮件投递。
  - 真实支付 provider 与 webhook 回调。
  - 发布后 CDN/缓存/队列/canary。
  - CSRF/Origin 安全专项。
- 需要产品或技术决策的问题：
  - 是否把 duplicate/error 提示样式提升为本轮必修 UI 质量项。
  - 是否在进入发布阶段前补真实支付 sandbox/live webhook 验收。
  - 是否把管理后台目录 CRUD 做一次完整写入式浏览器 QA。

## 六、变更落点

- 主要实现：`scripts/smoke-mvp.ts`、`src/features/api-catalog/server/queries.ts`、`src/features/newapi-bridge/server/portal.ts`、`src/app/api/apipool/billing/route.ts`、`src/app/api/apipool/admin/adjust-quota/route.ts`。
- 数据迁移：`src/config/db/migrations_sqlite/0005_elite_prowler.sql`、`src/config/db/migrations_sqlite/meta/0005_snapshot.json`、`src/config/db/migrations_sqlite/meta/_journal.json`、`src/config/db/schema.sqlite.ts`。
- 回归测试：`tests/api-catalog/queries.test.ts`、`tests/newapi-bridge/portal.test.ts`、`tests/newapi-bridge/billing-ledger.test.ts`、`tests/api-console/billing.test.ts`、`tests/api-console/public-errors.test.ts`、`tests/smoke/mvp-smoke-script.test.ts`。
