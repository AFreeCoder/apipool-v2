# New API 用户名与账本同步需求

> 状态：需求评估与完善
> 日期：2026-07-03
> 范围：门户用户与 New API 用户绑定、余额事实源、ledger 补偿、usage 展示缓存、API Key 生命周期同步

## 1. 背景 / 现状摘要

APIPool_v2 的产品边界已经固定为“门户站 + New API 独立统一网关”：

- 门户负责注册登录、支付充值、管理员调额、API Key 管理、账单和用量展示。
- New API 负责真实 API Key、模型路由、渠道接入、余额扣减和调用日志。
- 普通用户只应感知 APIPool 门户、控制台和公开 API Base URL，不应看到 New API 后台名称、内部 ID、内部 group、token 或 admin token。

当前实现已经具备基础桥接能力：

- `ensurePortalUserBinding()` 会为门户用户创建或绑定 New API 用户，并保存 New API 用户 ID、用户 access token 和本地绑定状态。
- `createPortalApiKey()` 会先确保用户绑定和 group 对齐，再以该 New API 用户上下文创建远端 token。
- `disablePortalApiKey()`、`deletePortalApiKey()` 会把禁用/删除同步到 New API，并在失败时保留可诊断状态。
- `adjustPortalQuota()` 会先确保门户用户已有 New API binding，再写门户 ledger，随后调用 New API 调额；成功后把 ledger 置为 `applied`，失败后保留 `failed` 或 `reconciliation_required`。
- `getPortalUsage()` 会从 New API 拉取 quota、usage summary 和 usage logs，写入 `usage_snapshot` / `usage_log_snapshot` 后展示；同步失败时回退到 `stale` 或 `failed` 状态。

主要差距：

- 当前 New API username 仍由 `deriveNewapiUsername(portalUserId)` 生成 `pu_<hash>`，不满足运营人员按用户名在 New API 侧直接排障、调额、对账的目标。
- 注册新用户后的 auth hook 目前只发本地 credits 和角色，不保证注册完成后立即创建或绑定同用户名的 New API 用户。
- 邮箱变更后的 New API username 同步尚未形成明确需求和审计闭环。
- 余额、ledger、usage snapshot 的事实源边界需要在需求层明确收敛，避免后续实现继续把门户本地 credit 或 snapshot 当成真实 API 余额。

## 2. 需求评估结论

本轮最终决策如下：

1. New API username 必须与门户用户的运营可识别用户名保持一致。首选规范为门户规范化邮箱：`trim + lower-case`。
2. 技术名 `pu_<hash>` 不再作为目标用户名策略。它只能作为历史兼容对象被识别、迁移或补偿，不能作为新用户或新绑定的目标形态。
3. APIPool 用户余额事实源 = New API quota。
4. 门户 ledger = 充值、管理员调额事实源和失败补偿 / 重试入口。所有由门户发起的余额变更都必须同步到 New API。
5. 门户 usage snapshot = 展示缓存。dashboard / billing / usage 刷新，或获取最新请求日志时，应从 New API 同步 quota、usage summary 和 logs 后再展示。snapshot 不参与真实扣费和真实余额判定。
6. API Key 的创建、禁用、删除等生命周期操作必须同步 New API。门户只保存必要绑定、展示字段和可审计状态，不暴露 New API 内部 ID、内部 token 或 admin token。
7. 注册新用户后，应在 New API 侧创建或绑定同用户名用户。失败不能无声吞掉，必须有本地状态、审计记录和重试入口。
8. New API 故障、超时、返回异常或同步失败时，门户必须留下可审计状态，并提供运营补偿入口。

## 3. 范围内

- 新用户注册后创建或绑定 New API 用户，目标 username 为规范化邮箱。
- 既有门户用户在首次桥接、登录后补偿、管理员手动修复或迁移任务中，将 New API username 收敛到规范化邮箱。
- 门户用户邮箱变更后，同步更新 New API username，并写入审计记录。
- New API username 同步失败后的状态表达、审计、重试和人工处理入口。
- 余额事实源收敛：用户余额展示、账单刷新、管理员排障应以 New API quota 为准。
- 门户 ledger 继续承载充值、调额、幂等、对账和补偿入口，但不能被解释为真实可用余额。
- usage snapshot / usage log snapshot 继续作为 dashboard 展示缓存，并在读取路径同步 New API 后刷新。
- API Key 创建、禁用、删除与 New API 生命周期一致；失败时保留 pending / failed / reconciliation 状态。
- 浏览器响应、用户可见 DTO、日志摘要和错误文案的敏感信息去敏。

## 4. 范围外

- 不重做 New API 的网关、路由、渠道、扣费和日志系统。
- 不把门户建设成 New API 管理后台替代品。
- 不做门户模型、价格、分组与 New API 的全自动同步。
- 不迁移 APIPool v1 或外部老 APIPool 用户资产。本文所说历史 `pu_<hash>` 迁移，仅指 APIPool_v2 当前数据库中已经存在的 `newapi_user_binding` 技术用户名绑定。
- 不做团队 / 组织账户、子账户、成员权限或企业账单。
- 不做 API Key 级 budget、rate limit、模型级权限或复杂成本控制。
- 不要求普通用户进入 New API 后台。
- 不向浏览器暴露 New API 用户 ID、Key ID、access token、admin token、内部域名、内部 group 或 `newapiGroup`。

## 5. 详细需求

### 5.1 用户名规范

- New API username 使用门户规范化邮箱：`email.trim().toLowerCase()`。
- 创建或绑定 New API 用户时，`username` 和 `display_name` 默认均使用规范化邮箱，除非后续设计明确引入单独展示名。
- 门户必须在服务端执行规范化，不能依赖浏览器传入的邮箱字符串。
- 若门户用户没有可用邮箱，必须进入可诊断状态，不得用随机技术名静默替代。该状态应可由管理员补邮箱或手动绑定后恢复。
- 新建绑定不得再生成 `pu_<hash>` 作为目标 username。
- 历史 `pu_<hash>` 绑定需要被识别为待迁移状态。这里的迁移范围只包含 APIPool_v2 当前数据库中已有的 `newapi_user_binding` 技术用户名，不包含 APIPool v1 或外部老资产迁移。

### 5.2 注册后 New API 用户创建 / 绑定

- 用户通过邮箱、Google 或 GitHub 注册成功后，门户应尝试创建或绑定同规范化邮箱的 New API 用户。
- 该动作失败时，不得只打印日志后结束。必须至少记录：
  - 门户用户 ID。
  - 目标规范化邮箱。
  - 同步动作类型。
  - 本文第 5.4 节定义的绑定同步状态。
  - 错误摘要。
  - 下一次可重试依据。
- 注册后的 New API 绑定失败不应导致门户用户账号消失，但会影响余额、Key 创建和用量展示。用户侧需要看到可理解的服务暂不可用或同步中状态；管理员侧需要看到补偿入口。
- 若 New API 中已存在同 username 用户，门户不得默认直接绑定。只有满足以下任一可证明条件时，才允许自动绑定：
  - 本地已存在同一门户用户的绑定记录，且远端 user id 与本地保存的 `newapiUserId` 一致。
  - 门户持有该远端用户此前由门户生成并加密保存的密码或 access token，且能用该凭据成功登录 / 取 token，证明该远端用户属于当前门户用户。
  - 远端用户带有可验证的门户侧 remark / metadata / reference，能与当前门户用户 ID 或历史绑定审计对应。
- 若同 username 远端用户存在，但门户无法证明归属，必须进入冲突状态，不得尝试用新生成的密码登录并覆盖本地绑定，不得把该远端账号绑定给当前门户用户。
- 冲突状态需要管理员人工确认。人工确认至少应查看：门户用户邮箱、远端 username、远端 user id、远端 remark / group / quota 摘要、历史审计、是否已有其它门户用户绑定同一远端 user id。确认后可选择绑定、改邮箱、要求用户补充信息或标记为不可自动处理。

### 5.3 邮箱变更同步

- 邮箱变更属于本轮范围内。
- 当门户用户邮箱变更时，必须计算新的规范化邮箱，并同步更新 New API username。
- 邮箱变更同步必须写审计，记录旧邮箱、新邮箱、旧 New API username、新 New API username、操作者、时间、结果和错误摘要。
- 邮箱变更同步失败时，本地必须落入第 5.4 节定义的可验收状态，不得让运营误以为两边已经一致。
- 在邮箱变更同步完成前，API Key、余额展示和调额策略需采用保守规则：
  - 不得创建新的错误用户名绑定。
  - 不得向浏览器暴露远端 ID 或凭据来解释失败。
  - 管理员应能重试或人工确认绑定。

### 5.4 最小可验收绑定状态模型

当前 `newapi_user_binding.status` 只有 `pending`、`active`、`disabled` 等基础状态说明，不足以测试本轮 username 同步和冲突处理。设计阶段必须把下列逻辑状态映射到可查询字段、管理员界面和测试断言；具体字段名可在设计阶段确定，但语义不可丢失。

| 逻辑状态 | 触发条件 | 用户侧可观察点 | 管理员侧可观察点 |
| --- | --- | --- | --- |
| `unbound` | 门户用户尚无 New API binding，或历史数据缺失 | 余额 / Key / 用量显示同步中或服务暂不可用，不暴露内部原因 | 用户详情显示未绑定，可触发创建 / 绑定 |
| `provisioning` | 正在创建或绑定 New API 用户，或注册后异步任务尚未完成 | 展示处理中，不允许误报余额和 Key 可用 | 显示目标 username、触发来源、开始时间 |
| `active` | New API user id、username、凭据均确认有效，且 username 与规范化邮箱一致 | 余额、Key、用量可正常使用 | 显示已绑定、远端摘要、最近同步时间 |
| `username_sync_pending` | 门户邮箱已变更，目标 username 已计算，但 New API username 尚未确认更新 | 展示同步中；可继续查看已有缓存但不得创建错误新绑定 | 显示旧 username、新 username、待同步原因，可重试 |
| `username_sync_failed` | username 更新失败、New API 不支持更新、超时或返回异常 | 展示服务暂不可用或资料同步失败，不暴露远端细节 | 显示错误摘要、最后尝试时间、重试入口和人工处理入口 |
| `conflict_requires_review` | New API 已存在同 username 用户，但门户无法证明该远端账号归属当前门户用户 | 展示账号同步需处理，不提供内部 ID / token | 显示冲突证据、候选远端用户摘要、人工确认操作 |
| `disabled` | 绑定被管理员停用、用户关闭或安全策略要求停用 | 余额、Key 创建和敏感操作不可用 | 显示停用原因、操作者、恢复入口 |

最低验收要求：

- 注册后绑定失败、邮箱变更同步失败、同名远端用户冲突，都必须能在管理员侧按状态筛选出来。
- 用户侧状态文案只能表达“同步中 / 服务暂不可用 / 账号同步需处理”等产品语义，不暴露 New API user id、token、admin token、内部 group 或内部域名。
- 每次状态变化必须有审计或可关联的操作记录。
- 重试同一状态的动作必须具备幂等键或可对账 reference。

### 5.5 余额与 ledger

- New API quota 是用户真实可用余额的唯一事实源。
- 门户 ledger 是充值、管理员调额、幂等、对账和失败补偿的事实源。
- 所有门户发起的余额变更都必须先形成 ledger 记录，再同步 New API。
- ledger 状态至少表达：
  - `pending`：已形成事实，等待同步或确认。
  - `applied`：New API 已确认生效。
  - `failed`：同步失败，可补偿或人工处理。
  - `reconciliation_required`：远端可能已生效但本地确认失败，需要对账。
- 用户侧余额展示必须来自 New API quota 或最新同步后的缓存，并清楚表达同步失败、到账处理中或数据可能延迟。
- `pending` ledger 不得被当作真实可用余额。
- 管理员调额、支付充值、失败重试必须使用幂等键，避免重复加额或重复扣减。

### 5.6 usage snapshot

- `usage_snapshot` 和 `usage_log_snapshot` 只是展示缓存。
- dashboard / billing / usage 刷新时，应从 New API 同步 quota、usage summary 和 usage logs，再更新 snapshot。
- 获取最新请求日志时，应从 New API 同步 logs 后展示；同步失败时可以展示旧缓存，但必须标记 `stale` 或 `failed`。
- snapshot 不参与真实扣费、余额判断、可调用性判断或调额对账。
- 同步需要避免重复累计同一条 New API 调用日志。

### 5.7 API Key 生命周期

- 创建 API Key 前必须存在有效 New API 用户绑定；如果绑定缺失，应先创建或绑定同规范化邮箱的 New API 用户。
- 创建 Key 必须调用 New API 成功，并在本地保存必要绑定后才展示为可用。
- 完整 Key 只展示一次；后续列表只展示掩码 Key。
- 禁用 Key 必须同步 New API。远端未确认禁用时，本地不得静默显示成功。
- 删除 Key 必须同步 New API。远端未确认删除时，本地不得静默显示成功。
- 远端成功但本地绑定失败时，应保留 `remote_created_binding_failed` 或等价状态，供管理员补偿清理。
- 门户 DTO 只返回用户需要的展示字段，例如本地 Key ID、掩码 Key、名称、状态、门户分组 slug / 名称、创建时间、更新时间，不返回 New API 内部 ID 或内部 group。

## 6. 失败与补偿策略

- New API 未配置、停机、超时、401、403、429、非 2xx、`success=false` 或响应形状不符，均不得静默成功。
- GET 类同步可以安全重试；写操作在 New API 不支持远端幂等键的前提下，必须先查远端状态或依赖门户幂等键，避免重复写。
- 用户绑定失败：
  - 本地保留第 5.4 节定义的绑定同步状态和目标 username。
  - 写入审计。
  - 管理员可重试创建 / 绑定 / 更新 username。
- 邮箱变更同步失败：
  - 本地保留旧 username 与目标 username。
  - 标记为 `username_sync_failed` 或等价可验收状态。
  - 管理员可重试或人工确认。
- 同名远端用户冲突：
  - 标记为 `conflict_requires_review` 或等价可验收状态。
  - 不得自动绑定、不得覆盖远端凭据、不得向用户展示远端 ID。
  - 管理员必须根据归属证据人工裁决。
- 余额同步失败：
  - ledger 保留 `pending` / `failed` / `reconciliation_required`。
  - 用户侧展示到账处理中或失败提示。
  - 管理员从 ledger 行发起重试或对账。
- Key 生命周期同步失败：
  - 本地保留失败状态。
  - 用户侧不展示为成功完成。
  - 管理员可清理本地失败记录或重试远端操作。
- usage 同步失败：
  - 有旧缓存时展示 stale，并附用户可理解的同步失败提示。
  - 无旧缓存时展示 failed / empty 的明确状态。

## 7. 审计要求

所有 New API 写操作必须写审计，包括但不限于：

- 用户创建 / 绑定。
- New API username 更新。
- 用户 group 更新。
- API Key 创建、禁用、删除。
- 充值加额、管理员调额、扣减、失败重试。
- 需要人工对账的补偿动作。

审计字段至少包含：

- 操作者 ID；系统自动动作可标记为 system。
- 门户用户 ID。
- 动作类型。
- 目标类型。
- 本地目标 ID。
- 远端目标引用。远端 ID 可以进入 server-only 审计，但不得进入用户可见响应。
- 幂等键或业务 reference。
- 状态。
- 脱敏后的请求 / 响应摘要。
- 错误摘要。
- 创建时间。

审计中不得保存明文 access token、admin token、完整 API Key、密码、兑换码明文或其它凭据。需要关联兑换码时，只保存可对账的安全 reference 或脱敏值。

## 8. 数据一致性原则

- 身份一致性优先：门户用户与 New API 用户应能通过规范化邮箱直接对应。
- 真实余额只看 New API quota；门户本地 credit、ledger 和 snapshot 不得作为真实 API 可用余额。
- 账务事实看门户 ledger；所有充值和调额必须有 ledger 行、幂等键和审计。
- 展示缓存可延迟，但必须标状态。缓存数据不能冒充实时事实。
- 写操作必须可重放或可对账；无法确认远端状态时进入补偿队列，不猜测成功。
- 本地状态必须保守：远端未确认时不显示成功，远端成功本地失败时保留人工补偿证据。
- 用户可见数据最小化：只返回完成用户操作所需字段，隐藏 New API 内部实现细节。

## 9. 验收标准

### 9.1 用户名与绑定

- 新注册用户 `User@Example.COM ` 在 New API 中创建或绑定的 username 为 `user@example.com`。
- 新建绑定不再使用 `pu_<hash>` 作为 New API username。
- New API 已存在同 username 用户且门户能证明归属时，门户能绑定到该用户，并保存本地绑定状态。
- New API 已存在同 username 用户但门户无法证明归属时，门户进入冲突状态，不自动绑定；管理员能看到冲突证据和人工确认入口。
- 注册后 New API 创建 / 绑定失败时，用户不会看到内部错误细节；管理员可看到第 5.4 节定义的失败状态、目标 username 和重试入口。
- 邮箱变更后，New API username 更新为新的规范化邮箱，并写入审计。
- 邮箱变更同步失败时，本地可见 `username_sync_pending` / `username_sync_failed` 或等价状态，管理员可重试。

### 9.2 余额与账本

- 用户控制台余额来自 New API quota 或最近一次 New API 同步结果。
- 支付成功但 New API 加额未完成时，ledger 为 pending / failed，用户看到到账处理中或失败提示。
- 管理员调额成功后，New API quota 改变，ledger 为 applied，审计中有对应记录。
- 管理员调额失败时，ledger 不标记 applied，保留可重试或对账状态。
- 重放同一支付回调或同一调额幂等键不会重复改变 New API quota。

### 9.3 usage 展示

- dashboard / usage 刷新会触发 New API quota、summary、logs 同步。
- 同步成功后 snapshot 更新，展示最新余额和用量。
- New API 同步失败且有旧缓存时，页面展示 stale 状态。
- New API 同步失败且无缓存时，页面展示 failed 或等价状态。
- usage snapshot 不参与真实扣费或余额判断。

### 9.4 API Key

- 创建 Key 时，门户先确保 New API 用户绑定和 group 对齐，再创建 New API token。
- 创建成功后只返回一次完整 Key；列表和后续状态只展示掩码 Key。
- 禁用 Key 后，New API 侧 token 不可继续调用；门户状态同步为 disabled。
- 删除 Key 后，New API 侧 token 被删除或撤销；门户不再把它展示为可用。
- 远端失败或本地绑定失败时，门户保留可诊断失败状态和审计。

### 9.5 敏感信息

- 用户可见响应中不包含 `newapiUserId`、`newapiKeyId`、New API access token、admin token、内部域名、内部 group、`newapiGroup`、密码或完整远端响应体。
- 错误文案不透出 New API admin token、access token、SQL 约束细节或内部服务地址。
- 审计和日志中的请求 / 响应体对凭据字段脱敏。

## 10. 设计阶段阻塞检查 / 必须验证

以下事项会直接影响本轮设计能否成立，不能归入“不阻塞”：

- 必须验证目标 New API 版本是否支持通过 API 或受控管理路径修改 username，并记录实测端点、请求体、响应、失败形态和权限要求。
- 如果 New API 不支持直接修改 username，设计必须给出可测试 fallback，例如：
  - 新建目标 username 用户后迁移本地 binding 和后续 Key 创建路径；
  - 通过受控 SQL / 管理脚本更新 username，并提供回滚和审计；
  - 暂停自动邮箱变更同步，进入 `username_sync_failed` / 人工确认状态，但必须说明如何恢复一致。
- fallback 必须有自动化或人工可重复验收方式，至少覆盖：成功更新、目标 username 已存在冲突、远端更新成功但本地确认失败、重试幂等。
- 设计不得在未确认 username 更新能力前承诺邮箱变更自动同步上线。

## 11. 待确认但不阻塞事项

- 当两个门户用户因邮箱变更、大小写归一或历史数据导致同一规范化邮箱冲突时，管理员如何裁决归属。
- APIPool_v2 当前数据库中历史 `pu_<hash>` binding 迁移采用一次性脚本、登录后懒迁移、管理员批处理，还是混合策略。
- OAuth provider 未返回邮箱、邮箱未验证、邮箱为空时，注册是否阻断，还是进入待补邮箱状态。
- 邮箱变更是否需要二次验证后再同步 New API username。
- 管理员界面的具体补偿入口放在用户详情、ledger 详情、New API 绑定详情，还是统一异常队列。
- 是否需要周期性 watchdog 扫描未完成绑定、username 不一致、pending ledger、stale usage snapshot 和 Key 同步失败。

## 12. 主要实现影响点

- `src/features/newapi-bridge/server/portal.ts`
  - `deriveNewapiUsername()` 需要从 `pu_<hash>` 目标策略改为规范化邮箱策略。
  - `ensurePortalUserBinding()` 需要处理既有绑定的 username 不一致、邮箱变更和迁移状态。
  - 同名 New API 用户存在时，不能仅按 username 搜索结果直接绑定；需要归属证明、冲突状态和人工确认路径。
  - `recordAudit()` 的调用点需要覆盖 username 更新、注册后绑定失败和补偿动作。
  - `getPortalUsage()` 的读取路径已符合“同步 New API 后展示”的方向，但需求上要保持 snapshot 只做展示缓存。
  - `adjustPortalQuota()` 当前顺序是先确保 New API binding，再写 ledger，再调额；后续要继续强化补偿入口和事实源表达。
- `src/features/newapi-bridge/server/client.ts`
  - `provisionUser()` 当前按 username 创建 / 搜索 New API 用户，可复用为规范化邮箱 username。
  - 必须在设计阶段验证 New API 版本是否支持 username 更新；若不支持，需要给出可测试 fallback。
- `src/core/auth/config.ts`
  - 注册后 hook 当前只发本地 credits 和角色，需要纳入 New API 用户创建 / 绑定的可审计流程。
  - 当前 catch 后只打日志的模式不满足“不无声失败”的需求。
- `tests/newapi-bridge/*`
  - 现有测试已覆盖 Key 生命周期、DTO 去敏、ledger 状态和 usage 同步基础路径。
  - 后续需补充规范化邮箱 username、注册后绑定、邮箱变更同步、历史 `pu_<hash>` 迁移和敏感信息不外泄的测试。
