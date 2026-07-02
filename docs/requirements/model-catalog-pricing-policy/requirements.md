# 模型目录基准价格与分组折扣/状态策略需求

日期：2026-07-02

状态：需求评估稿

## 1. 背景与现状问题

APIPool_v2 的产品边界已经明确：门户负责品牌展示、模型目录、文档、登录、支付充值、API Key 管理和统计展示；New API 负责真实 API Key、模型路由、额度扣减和调用日志。`docs/01-product.md` 同时要求价格透明，用户能看到官方价、本站价、折扣和计费单位，并声明真实调用扣费、额度执行、调用日志以 New API 为准。

当前模型目录实现已经具备可用的管理后台和公开查询，但价格语义仍停留在“售卖项价格”层：

- `src/config/db/schema.sqlite.ts` 中 `catalog_model` 只保存 `model_id`、`display_name`、`vendor_id`、`category`、`context_window` 等模型主数据，不保存基准价格、价格来源或同步时间。
- `catalog_model_listing` 同时保存 `model_id`、`group_id`、`status_id`、`input_micro_usd`、`output_micro_usd`、`image_input_micro_usd`、`image_output_micro_usd`、`list_input_micro_usd`、`list_output_micro_usd`、`discount_rate_bps`、`discount_note`、`smoke_tested`、`featured`、`sort_order`。这使 listing 同时承担“分组策略”和“价格事实”。
- `src/features/api-catalog/server/queries.ts` 的公开 `/models` 查询以 `catalog_model_listing` 为主表返回价格；同一个模型在不同分组下重复出现时，价格字段会在多个 listing 中复制。
- `src/features/api-catalog/server/catalog-service.ts` 的 `upsertModelAdminConfig()` 把模型主数据、默认 listing、分类和能力一次性写入；编辑模型时加载第一个 listing 作为默认 listing。这个交互改善了录入效率，但也进一步强化了“模型表单维护一个分组 listing 价格”的现状。
- `docs/requirements/model-catalog-admin/requirements.md` 和 `docs/design/model-catalog-admin/DESIGN.md` 已确认当前优化“不包含多分组售卖策略重构”，并把 New API `/api/pricing` 候选价自动填入 listing 字段；这次需求正是对该遗留语义做后续评估和补全。

现状的直接问题：

1. 基准价格在多个分组 listing 间复制，无法判断哪个价格是模型事实、哪个价格是分组折扣后的有效展示价。
2. `list_*`、`input/output_*`、`discount_rate_bps` 同处 listing，容易把划线价、基准价、折扣价和手工 override 混用。
3. New API `/api/pricing` 已能提供 `model_ratio`、`completion_ratio`、`image_ratio`、`quota_type`、`enable_groups` 等事实，但 APIPool 当前只在候选搜索里使用，没有形成持续同步、差异校验和运营可解释链路。
4. 用户看到的展示价格必须能解释为 New API 实际扣费口径对应的基准价加分组折扣/倍率，而不是 APIPool 自己随意维护的营销价；现有字段结构无法稳定表达这条证明链。

## 2. 已确认产品边界

- New API 继续作为真实 API 网关和扣费事实源；APIPool 不重做网关扣费、路由和渠道选路。
- APIPool 负责门户、模型目录、价格展示、API Key 分组映射、运营后台表达和同步/校验结果展示。
- 展示价必须和 New API 实际扣费口径对齐。任何折扣、划线价、状态或 override 都必须能追溯到 New API 模型价、New API group 倍率/分组策略或明确的运营覆盖记录。
- 浏览器和普通用户界面不得暴露 New API 内部地址、后台入口、`newapiGroup`、内部表 ID、admin token 或其它后台实现痕迹。该边界已在 `docs/04-newapi-contract.md`、`docs/08-user-mvp-requirements.md`、`tests/api-catalog/queries.test.ts` 和 `tests/api-console/api-key-manager.test.ts` 中固化。
- 管理功能归 `/admin`；用户控制台只使用公开 `groupSlug` 创建 API Key，不提交内部 `groupId` 或 `newapiGroup`。

## 3. 目标数据语义

### 3.1 模型主数据

`catalog_model` 的目标语义应是“模型事实”，至少包括：

- 供应商/厂商归属。
- New API 侧模型 ID。
- 用户可见模型名称。
- 分类、能力、说明、上下文窗口等非分组事实。
- 模型级启停或归档状态，仅表达该模型事实是否还应被维护；具体对外上架状态仍在分组策略层表达。

### 3.2 模型基准价格

模型基准价格应按“模型 ID + 价格口径”只维护一次，不随分组复制。可在后续设计中选择放入 `catalog_model` 或独立模型价格表，但需求语义必须满足：

- 保存普通输入 token、普通输出 token、图片输入 token、图片输出 token等基准价，单位沿用当前 micro-USD / 1M token。
- 保存价格来源：New API `/api/pricing`、人工录入、迁移回填、固定价格模型、其它运营来源。
- 保存源数据同步时间、源数据版本或摘要、同步状态、最后一次差异校验结果。
- 对 `quota_type = 0` 的 New API ratio 模型，基准价应从 New API 模型倍率推导；当前代码已按 `model_ratio * 2` 推导输入价，输出价再乘 `completion_ratio`，图片输入价使用 `image_ratio`，图片输出价沿用普通输出价。
- 对 `quota_type = 1` 的固定价格模型，不得强行拆成输入/输出 token 价；必须明确展示为“固定价格/待人工确认/不适用 token split”之一。

### 3.3 分组策略/上架策略

分组策略层表达“某个模型在某个 APIPool 分组下如何售卖和展示”，不再默认复制基准价。它至少包括：

- `model_id + group_id` 唯一关系。
- 与 New API group 的映射来源：通过 `catalog_group.newapi_group` 解析，普通用户只看到 `groupSlug`。
- 分组折扣/倍率或折扣说明，用于从模型基准价计算有效展示价。
- 上架状态：可见性、是否可调用、是否允许新建 Key、是否已下线、是否即将上线。
- smoke 状态、排序、推荐标记、分组说明、运营备注。
- 必要时的价格 override：只用于 New API 实际扣费和标准公式不一致、固定价格模型、短期人工确认等场景；override 必须保存来源、原因、操作人、时间和校验状态，不能成为无解释的营销价。

### 3.4 有效展示价

公开 `/models` 的有效展示价必须能按以下顺序解释：

1. 取模型基准价。
2. 套用当前 APIPool 分组对应的 New API group 倍率或经校验的分组折扣策略。
3. 如存在有效 override，则展示 override 结果，并同时保留基准价、折扣/倍率、override 原因和校验状态供后台查看。
4. 用户侧展示“输入价/输出价/图片价/折扣说明/状态”，但不展示 New API 内部字段。

展示价不得只由 `discount_note` 或运营文案决定；文案必须从可计算价格或有效 override 派生。

### 3.5 New API 对齐

New API `/api/pricing` 是 APIPool 模型基准价和分组倍率校验的主要事实源。APIPool 需要维护“最后同步值”和“当前展示值”的差异状态：

- 同步成功：记录同步时间和来源摘要。
- 同步失败：保留上次可用价格，后台显示同步失败，不影响普通用户看到已发布目录。
- 价格漂移：后台必须提示哪些模型/分组的展示价与 New API 推导价不一致。
- 固定价格或无法拆分的模型：后台必须标记需要人工确认，不能把空值伪装成 0 价。

## 4. 功能需求

### 4.1 后台模型管理

- 管理员在 `/admin/catalog/models` 维护模型主数据和模型基准价格。
- 新增/编辑模型时，选择供应商后可通过 server-side API 查询 New API `/api/pricing` 候选模型；浏览器不得直接访问 New API。
- 选中候选后自动填入模型 ID、显示名称和可推导的基准价格。
- 模型详情页应展示价格来源、最近同步时间、最近校验状态、固定价格/缺失价格提示。
- 管理员可人工修正基准价，但必须记录来源为人工、操作人、时间和原因。
- 现有分类/能力多选能力保留，`catalog_model_category` 和 `catalog_model_capability` 继续表达模型事实维度。

### 4.2 分组策略管理

- 管理员在 `/admin/catalog/groups` 维护门户分组、用户可见说明、`newapiGroup`、是否允许创建 Key、排序和状态。
- 管理员在模型的分组策略页面维护该模型在不同分组下的上架状态、可见性、smoke 状态、排序、推荐、折扣倍率/折扣说明和可选价格 override。
- 分组策略默认从模型基准价计算有效展示价；只有明确填写 override 时才覆盖。
- 如果分组允许创建 Key，则 `newapiGroup` 必须非空，并且需要通过运维校验确认 New API 侧存在同名或映射后的 group、`GroupRatio` 和渠道 group 配置。
- 分组状态、模型上架状态和 `catalog_status.is_callable/is_public_visible` 语义必须继续区分：公开展示不等于可调用，可调用不等于允许新建 Key。

### 4.3 New API `/api/pricing` 同步

- APIPool server-only 客户端继续调用 `GET /api/pricing`，并解析模型定价列表、供应商、可用分组、分组倍率、支持端点等信息。
- 同步逻辑需要支持手动触发和后续自动化触发；首版可先做后台手动同步，但必须留下同步时间和结果。
- 对 `quota_type = 0`，同步应按当前已测试公式推导基准 token 价。
- 对 `quota_type = 1`，同步应标记固定价格，要求人工确认展示单位和价格表达。
- 同步时应记录模型是否在目标 New API group 的 `enable_groups` 中；若 APIPool 分组映射的 New API group 不在该模型可用组内，后台必须提示。
- 同步失败不得清空现有发布价格；应保留旧值并显示失败原因摘要。

### 4.4 公开 `/models` 展示

- `/models` 继续支持供应商、分组、分类、能力、状态筛选。
- 每条展示记录仍然以“模型 + 分组策略”为一个可售/可见项；同一个模型 ID 可在不同分组下出现。
- 展示价格来自有效展示价，不直接暴露基准价存储字段或 New API 内部字段。
- 折扣说明必须与有效展示价一致；如果无法解释折扣，则不展示折扣营销文案。
- 已下线或不可公开状态默认不进入公开列表；即将上线可展示但不得暗示可调用。
- 页面和 DTO 不得出现 `newapiGroup`、内部 `groupId`、New API 后台名称或内部服务 URL。

### 4.5 API Key 分组创建

- 用户创建 API Key 继续只提交 `groupSlug`；`src/features/newapi-bridge/server/portal.ts` 当前已在服务端解析 `groupSlug -> catalog_group.id/newapiGroup`。
- 服务端必须拒绝不存在、禁用、`allowCreateKey=false` 或 `newapiGroup` 为空的分组。
- 创建或复用 New API 用户时，必须确保 New API 用户 group 与本次 `newapiGroup` 对齐；否则 New API 会拒绝该分组调用。
- Key 创建不应依赖公开 `/models` 返回内部字段；本地绑定可以保存 `groupId` 和 `newapiGroup` 快照用于排障，但公共响应不得返回。
- 模型级授权限制仍非本需求目标；当前 user-mvp 已约定 Key 绑定用户和分组，不做单 Key 模型级授权。

### 4.6 运维校验

- `docs/07-runbook.md` 中的发布门禁需要继续要求：`official` 分组 `newapiGroup` 与 New API 真实 group 对齐，New API 侧 `GroupRatio`、channel group 和 abilities 生效。
- 发布前必须能校验至少一个可调用、已 smoke 的模型，其展示价和 New API 推导价一致或有明确 override。
- 价格同步、价格漂移、分组映射缺失、group 不可用、fixed-price 待人工确认等状态需要进入后台可见检查清单。
- `npm run catalog:init` 或等价初始化流程必须能种出最小可用目录，且不会覆盖运营已配置的生产 `newapiGroup`。

## 5. 非目标

- 不改变 New API 的实际扣费、路由、渠道选路或账号池能力。
- 不把 New API 管理后台能力搬进 APIPool 门户。
- 不向普通用户暴露 New API、`newapiGroup`、内部 ID 或后台服务名称。
- 不在本需求中实现 schema、迁移脚本、测试或 UI 代码。
- 不做用户级/客户级个性化价格、单 Key 预算、单 Key 速率限制或模型级授权。
- 不重做支付、账本、余额同步和用量同步。
- 不要求固定价格模型在本阶段自动拆出 token 单价。
- 不做通用多网关抽象；当前事实源仍是 New API。

## 6. 迁移与兼容要求

### 6.1 旧 listing 价格回填基准价

迁移必须保持线上展示价不跳变，并给运营可审计的回填结果。建议需求口径如下：

1. 按 `catalog_model.model_id` 聚合旧 listing。
2. 优先使用 `official` 分组的 listing 作为基准价来源。
3. 如果该 listing 有 `list_input_micro_usd/list_output_micro_usd`，优先把 list price 作为模型基准价，把当前 `input/output` 视为该分组有效价或折扣价。
4. 如果没有 list price，则使用 `official` listing 的当前 `input/output/image_*` 作为基准价。
5. 如果没有 `official` listing，但所有 listing 的价格完全一致，则用该一致价格作为基准价。
6. 如果多个 listing 价格不一致且无法从 list price 或折扣推导，选择 smoke-tested、callable、排序最靠前的 listing 作为临时基准价，其它分组写成 override 或标记为待运营确认。
7. 禁止对不一致价格做平均值、最低价或最高价的静默推导。

### 6.2 价格不一致处理

- 回填脚本必须生成差异报告：模型、分组、旧输入价、旧输出价、旧图片价、推导基准价、推导折扣/倍率、是否需要人工确认。
- 对可计算为统一倍率的分组，写入分组折扣/倍率。
- 对不能解释的分组价格，保留为 override，并标记 `needs_review` 或等价状态。
- 公开展示在迁移窗口内必须保持与旧 listing 展示价一致；后台则提示该价格来自迁移 override 或待确认。
- New API 同步后如发现推导基准价与迁移基准价不一致，不能自动覆盖生产展示价；应进入差异确认。

### 6.3 兼容与回滚

- 后续实现应支持一段双读或兼容读窗口：旧 listing 价格字段仍可支撑展示，直到基准价和策略层数据完整。
- 新字段上线前必须先备份生产数据库；失败时可回滚应用版本而不删除现有 listing。
- `newApiKeyBinding.groupId/newapiGroup` 快照语义不变，历史 Key 不需要因为价格语义重构而重建。
- `catalog_group.newapiGroup` 生产值不得被种子或迁移覆盖；已有测试已覆盖 operator-provided official mapping 需要被保留。

### 6.4 schema 与 journal 防漏要求

后续实现不得只改 TypeScript schema。涉及数据库结构时必须同时更新并验证：

- `src/config/db/schema.sqlite.ts`。
- `src/config/db/migrations_sqlite/*.sql`。
- `src/config/db/migrations_sqlite/meta/_journal.json` 和对应 snapshot。
- `src/config/db/schema.ts` barrel export。
- `scripts/init-catalog` 或相关种子逻辑。
- `tests/db/catalog-schema-singlesource.test.ts` 和 `tests/db/init-catalog.test.ts`。

当前迁移目录已有 `0007_model_catalog_admin_prices.sql`，`_journal.json` 记录到 0007，但 meta snapshot 文件只到 `0005_snapshot.json`；后续设计/实现阶段必须显式复核 Drizzle journal 与 snapshot 生成策略，避免生产迁移或本地测试只覆盖一半。

## 7. 安全、权限、可观测性与运营要求

- New API 调用必须保持 server-only；浏览器不接收 New API base URL、admin token、用户 access token 或内部 group。
- `/api/apipool/admin/catalog/models/search` 和后续同步接口必须要求 `admin.catalog.write` 或更细权限；只读差异报表可用 `admin.catalog.read`。
- 价格人工修改、override、同步覆盖、分组折扣修改必须记录操作人、时间、旧值、新值、原因和来源。
- 公开 DTO 和用户侧 API 必须继续使用白名单输出，避免内部 ID 和 `newapiGroup` 泄漏。
- 同步任务不得在日志中记录 admin token、access token、内部服务 URL 或完整敏感响应。
- 后台需要可见这些状态：最后同步时间、同步失败原因、New API group 不匹配、价格漂移、fixed-price 待确认、override 待复核、已 smoke/未 smoke。
- 发布前 smoke 失败时，应能区分价格/分组配置问题、New API 健康问题、渠道不可用问题和门户代码问题。

## 8. 验收标准与测试建议

### 8.1 需求验收

- 管理员能看到模型基准价格和分组策略是两个不同概念。
- 同一个模型 ID 在多个分组出现时，基准价格只维护一次。
- 分组策略能独立表达折扣/倍率、状态、可见性、smoke、排序和 override。
- `/models` 展示价能从“基准价 + 分组折扣/倍率/override”解释，并与 New API 扣费口径一致。
- New API `/api/pricing` 同步能记录来源、同步时间、固定价格模型和分组可用性。
- API Key 创建继续只使用 `groupSlug`，服务端解析到 `newapiGroup`，公共响应不泄漏内部字段。
- 旧 listing 迁移后，公开展示价不出现无解释跳变。
- 价格不一致不会被静默平均或覆盖，必须进入差异报告或人工确认。

### 8.2 测试建议

- 扩展 `tests/api-catalog/catalog-pricing.test.ts`：覆盖基准价、分组倍率、override 和有效展示价计算。
- 扩展 `tests/newapi-bridge/client.test.ts`：覆盖 `/api/pricing` 的 group ratio/usable group 解析、fixed-price 标记和异常响应。
- 扩展 `tests/api-catalog/model-candidate-search.test.ts`：覆盖候选模型按本地 vendor 和映射后的 New API group 过滤。
- 扩展 `tests/api-catalog/catalog-service.test.ts`：覆盖模型基准价与分组策略分别写入、迁移回填和价格不一致标记。
- 扩展 `tests/api-catalog/queries.test.ts`：覆盖公开 listing 的有效展示价、状态过滤、内部字段不泄漏。
- 扩展 `tests/newapi-bridge/create-portal-key.test.ts` 和 `tests/api-console/api-key-manager.test.ts`：确认 Key 创建 payload 和响应仍不包含内部 group 字段。
- 扩展 `tests/db/init-catalog.test.ts` 和 schema 单源测试：确认迁移、种子、journal 和生产 operator-provided mapping 不被覆盖。
- 发布前继续执行 `APIPOOL_SMOKE_REQUIRE_LIVE=true npm run smoke:mvp`，并增加价格/分组对齐检查项。

## 9. 未决问题

1. 物理数据模型在设计阶段需要拍板：模型基准价格直接放 `catalog_model`，还是新建独立价格表以支持多价格单位、固定价格和历史版本。
2. New API `/api/pricing` 当前部署版本中 group ratio、usable group 和 enabled groups 的精确响应形态需要再次用真实实例确认，并据此决定同步 DTO。
3. 分组折扣/倍率是完全自动跟随 New API group ratio，还是由 APIPool 后台保存“运营确认后的倍率”并做漂移告警，需要设计阶段确认。
4. 固定价格模型、图片生成、音频等非标准 token split 模型的用户侧展示单位和后台校验规则需要单独设计。
5. override 的审批强度需要产品/运营确认：是否只允许超级管理员修改，是否需要二人复核，是否允许限时 override 自动过期。

## 10. 已核对的现状文件

- `docs/01-product.md`
- `docs/04-newapi-contract.md`
- `docs/07-runbook.md`
- `docs/08-user-mvp-requirements.md`
- `docs/requirements/model-catalog-admin/requirements.md`
- `docs/design/model-catalog-admin/DESIGN.md`
- `src/config/db/schema.sqlite.ts`
- `src/features/api-catalog/server/catalog-service.ts`
- `src/features/api-catalog/server/queries.ts`
- `src/features/api-catalog/lib/pricing.ts`
- `src/features/api-catalog/server/model-candidate-search.ts`
- `src/features/newapi-bridge/server/client.ts`
- `src/features/newapi-bridge/server/portal.ts`
- `src/app/api/apipool/admin/catalog/models/search/route.ts`
- `tests/api-catalog/catalog-pricing.test.ts`
- `tests/api-catalog/catalog-service.test.ts`
- `tests/api-catalog/model-candidate-search.test.ts`
- `tests/api-catalog/queries.test.ts`
- `tests/db/init-catalog.test.ts`
- `tests/db/catalog-schema-singlesource.test.ts`
- `tests/newapi-bridge/client.test.ts`
- `tests/newapi-bridge/create-portal-key.test.ts`
- `tests/newapi-bridge/portal.test.ts`
- `tests/api-console/api-key-manager.test.ts`
