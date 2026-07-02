# 模型目录基准价格与分组折扣/状态策略详细设计

- 状态：冻结候选 / 2026-07-02 / 已按 NEEDS_REVISION 修订，待阶段 2 复评
- 作者：Codex 执行 agent
- 关联需求：`docs/requirements/model-catalog-pricing-policy/requirements.md`

## 0. 已确认需求与约束

- APIPool 展示的折扣价必须和 New API 实际扣费口径对齐；New API 仍是真实 API 网关、路由、额度扣减和调用日志事实源。
- APIPool 负责门户、模型目录、价格展示、API Key 分组映射、运营后台表达、价格同步、漂移检测和验收证据。
- 正常公开价路径必须以 New API `group_ratio` 为事实源；APIPool 不得用未验证的本地倍率展示“已确认折扣价”。
- 普通用户和浏览器侧不得看到 `newapiGroup`、New API 内部地址、admin token、内部表 ID 或后台服务名称。
- 管理能力放在 `/admin`，用户控制台继续只提交公开 `groupSlug` 创建 API Key。
- 本阶段只冻结设计，不改业务代码、不写迁移 SQL、不调整测试。
- 设计必须纳入非阻塞但必须验收的提醒：公开 `/models` 的有效价、折扣、划线价、override 渲染必须有明确设计和验收；admin 页面要展示价格来源、同步状态、override 状态；至少一个 live/equivalent 调用后要通过 New API usage log 或 quota delta 校验展示价公式和实际扣费口径一致。

## 1. 背景与目标

当前 `catalog_model_listing` 同时保存分组、状态、价格、折扣、smoke、排序和说明。它能满足 MVP 展示，但导致同一个模型在多个分组下复制价格，无法稳定区分“模型基准价”“分组折扣价”“划线价”“手工 override”和“New API 实际扣费价”。

本设计目标：

1. 把模型主数据、模型基准价格、分组策略/售卖项三个概念分开。
2. 让同一个 `catalog_model.model_id` 只对应一份当前基准价格。
3. 保留 `catalog_model_listing` 的物理表名和唯一性，降低迁移与代码替换风险，但把它的业务语义收敛为“模型在某个 APIPool 分组下的策略”。
4. New API `/api/pricing` 同步后的基准价、group ratio 和 enabled groups 能落库、展示、校验和漂移告警。
5. 公开 `/models` 只展示可由 New API group ratio 或 live/usage 对账证实的有效价，不泄露内部字段；后台展示完整来源、同步状态、override 状态和漂移证据。

## 2. 非目标

- 不改变 New API 的实际扣费、路由、渠道选路、账号池和 upstream 能力。
- 不把 New API 管理后台搬进 APIPool。
- 不做用户级个性化价格、单 Key 预算、单 Key 速率限制、模型级授权。
- 不重做支付、账本、余额同步和用量同步。
- 不在本设计阶段提交 schema、迁移脚本、实现代码或测试代码。
- 不要求 fixed-price 模型自动拆成 token 输入/输出价；这类模型必须显式标记为固定价或待人工确认。

## 3. 当前系统现状

### 3.1 数据模型

- `src/config/db/schema.sqlite.ts`
  - `catalog_model`：当前只保存 `model_id`、`display_name`、`vendor_id`、`category`、`context_window`，其中 `model_id` 已唯一。
  - `catalog_model_listing`：当前保存 `model_id + group_id + status_id + input/output/image/list price + discount + smoke + featured + sort`，并通过 `uniq_listing_model_group` 保证同一模型和同一分组只有一个 listing。
  - `catalog_group`：保存 `slug/name/userDescription/newapiGroup/allowCreateKey/status/sortOrder`，是 APIPool 分组到 New API group 的映射点。
  - `newapi_key_binding`：保存 `groupId` 和 `newapiGroup` 快照，仅供服务端和排障使用。

### 3.2 服务与公开查询

- `src/features/api-catalog/server/catalog-service.ts`
  - `upsertModelAdminConfig()` 当前把模型主数据、默认 listing、分类、能力放在同一个事务写入。
  - `getModelAdminRows()` 当前读取每个模型的第一个 listing 展示价格与分组。
- `src/features/api-catalog/server/queries.ts`
  - `getPublicListingsUncached()` 以 `catalog_model_listing` 为主表返回公开列表。
  - `ListingRow` 当前包含 `inputMicroUsd/outputMicroUsd/listInputMicroUsd/listOutputMicroUsd/discountRateBps/discountNote`，不包含内部 ID 或 `newapiGroup`。
  - `getGroupsForKeyCreationUncached()` 返回 `{slug,name,userDescription}`，不暴露内部 group。
- `src/app/[locale]/(landing)/models/page.tsx`
  - 当前直接展示 listing 的 `inputMicroUsd/outputMicroUsd`，若存在 `list*` 则显示划线价，`discountNote` 作为文案展示。

### 3.3 New API 对齐现状

- `src/features/newapi-bridge/server/client.ts`
  - `listPricingModels()` 已调用 `GET /api/pricing`。
  - 当前解析 `model_name/vendor_id/quota_type/model_ratio/model_price/completion_ratio/image_ratio/enable_groups/supported_endpoint_types`。
  - 当前只返回模型数组，没有把 envelope 级 `group_ratio`、`usable_group` 等信息作为一等 DTO 返回。
- `src/features/api-catalog/lib/pricing.ts`
  - 当前基准推导公式为：输入价 `model_ratio * 2`，输出价再乘 `completion_ratio`，图片输入价乘 `image_ratio`，图片输出价沿用普通输出价。
  - `quota_type = 1` 返回 fixed-price，不伪造 token split。
- `src/app/api/apipool/admin/catalog/models/search/route.ts`
  - 当前要求 `admin.catalog.write`，通过 server-side API 查询候选，浏览器不直连 New API。
  - 候选会按本地 vendor 和选中 group 的 `newapiGroup` 过滤 `enable_groups`。

### 3.4 API Key 和 live smoke 现状

- `src/features/newapi-bridge/server/portal.ts`
  - `createPortalApiKey()` 只接受 `groupSlug`，服务端解析 `catalog_group.newapiGroup`。
  - 禁用、未允许创建、`newapiGroup` 为空的分组会被拒绝。
  - New API 用户会被补齐到本次 `newapiGroup`。
- `docs/07-runbook.md`
  - 发布前要求 `official.newapiGroup` 与 New API group、`GroupRatio`、channel group、abilities 对齐。
  - `APIPOOL_SMOKE_REQUIRE_LIVE=true npm run smoke:mvp` 当前验证建 Key、调用、用量可见、禁用拒绝。

### 3.5 测试现状

- `tests/api-catalog/catalog-pricing.test.ts` 覆盖 micro-USD、折扣 bps、New API ratio/fixed-price 推导。
- `tests/newapi-bridge/client.test.ts` 覆盖 `/api/pricing` 的模型解析、fixed-price 和 image price。
- `tests/api-catalog/queries.test.ts` 覆盖公开目录筛选、状态过滤、不泄漏 `newapiGroup`。
- `tests/newapi-bridge/create-portal-key.test.ts` 覆盖 `groupSlug -> newapiGroup` 解析和 public response 不泄漏内部 group。
- `tests/db/init-catalog.test.ts` 覆盖 seed、`official.newapiGroup` 修复和保留运营配置。
- `tests/db/catalog-schema-singlesource.test.ts` 当前锁定 catalog 表仍是 sqlite-only，并断言 listing 的图片价格和折扣字段存在。

## 4. 方案概览

### 4.1 核心方案

采用“模型主数据 + 独立模型基准价格 + listing 分组策略”的三层结构：

1. `catalog_model` 继续做模型主数据，`model_id` 保持唯一。
2. 新增 `catalog_model_price` 作为当前模型基准价格表，一模型一条当前基准价，保存 New API 源倍率、推导价、fixed-price 状态、同步状态和漂移状态。
3. 继续使用 `catalog_model_listing` 作为物理表，暂不重命名，避免大范围迁移；业务语义调整为“模型在某个 APIPool 分组下的公开/可调用/折扣/override/smoke 策略”。现有 `input_micro_usd/output_micro_usd/image_*` 字段转为兼容期的“有效展示价缓存”，但公开确认价必须有 New API group ratio 或 live/usage 对账证据。
4. `catalog_group` 继续保存 `newapiGroup` 映射，并新增或关联 group ratio 同步字段，用于从 New API group ratio 计算分组默认有效价；这是正常公开价的事实源。
5. 公开 `/models` 返回计算后的有效展示价和用户可读折扣/划线价，不返回基准表 ID、内部 group ID、`newapiGroup`、原始 New API payload；未验证的本地 listing multiplier / legacy override 不得渲染为已确认折扣。
6. 后台页面显示基准价来源、同步状态、漂移状态、分组倍率、override 状态和有效价预览。

### 4.2 为什么不把基准价格直接放进 `catalog_model`

不采用直接扩展 `catalog_model` 的方案。原因：

- `catalog_model` 是模型事实表，价格同步状态、New API 原始倍率、fixed-price、漂移检测、review 信息会让主表膨胀。
- fixed-price、token price、图片/音频等不同计费模式后续可能需要不同字段和校验逻辑，独立表更容易扩展。
- 基准价格需要单独索引 `sync_status/drift_status/source_synced_at`，独立表更清晰。
- 迁移阶段需要保留旧 listing 展示价缓存；独立价格表可支持双读，不破坏主数据唯一性。

### 4.3 为什么不重命名 `catalog_model_listing`

不在本次重命名物理表为 strategy 表。原因：

- 当前公开查询、admin 子页面、种子、测试和 smoke 都围绕 `catalog_model_listing`。
- 物理重命名会放大 SQLite migration、Drizzle snapshot/journal 和回滚风险。
- 设计上在服务层和类型层逐步引入 `CatalogModelGroupPolicy` 或 `CatalogModelListingPolicy` 命名即可；数据库表名保留，后续有充分理由再做单独 rename。

## 5. 模块 / 文件级改动计划

| 文件 / 模块 | 改动类型 | 改什么 | 为什么 |
|---|---|---|---|
| `src/config/db/schema.sqlite.ts` | 修改 | 新增 `catalogModelPrice`、`catalogPriceSyncRun`，扩展 `catalogModelListing` 的 price policy / override / effective cache 元数据，必要时扩展 `catalogGroup` 的 group ratio 同步字段 | 分离模型基准价和分组策略，支持同步与漂移检测 |
| `src/config/db/migrations_sqlite/*` | 新增 | 新增非破坏性迁移、回填脚本、journal 与 snapshot | 保持旧展示价不跳变，并规避线上 schema 漏落 |
| `scripts/init-catalog` | 修改 | 最小种子补齐 `catalog_model_price` 和 listing 策略字段；保留运营配置 | 新库可启动，旧运营 mapping 不被覆盖 |
| `src/features/api-catalog/lib/pricing.ts` | 修改 | 新增 `deriveBasePriceFromNewApiPricing()`、`resolveEffectiveCatalogPrice()`、`comparePriceDrift()`、`quotaSpendFromEffectivePrice()` | 集中价格公式，测试可覆盖 |
| `src/features/newapi-bridge/server/client.ts` | 修改 | 新增 `getPricingSnapshot()`，保留 `listPricingModels()` 兼容；解析 envelope 级 group ratio / usable group | 同步需要模型价和分组倍率，不只是候选搜索 |
| `src/features/api-catalog/server/pricing-sync.ts` | 新增 | 封装手动同步、回填、漂移检测、sync run 记录 | 避免把同步逻辑塞进页面 action |
| `src/features/api-catalog/server/catalog-service.ts` | 修改 | 模型 admin config 改为读写主数据 + 基准价格 + 默认 listing 策略；保留旧 API wrapper | admin 写入边界清晰 |
| `src/features/api-catalog/server/queries.ts` | 修改 | public query join `catalog_model_price` 和 listing 策略，输出 `PublicCatalogListingDto`；保留旧字段 alias 仅限内部兼容层 | `/models` 展示价从公式来，公开 DTO 白名单更清晰 |
| `src/features/api-catalog/lib/types.ts` | 修改 | 拆分 `PublicCatalogListingDto` 和 `AdminPricingSummaryDto`；public mapper 只输出页面需要字段，admin mapper 才包含基准价、来源、同步状态和 override 状态 | 避免把 admin-only base/source 字段混入公开查询类型 |
| `src/app/[locale]/(landing)/models/page.tsx` | 修改 | 抽出价格渲染组件，展示有效价、划线价、折扣/特价文案；不展示内部 override 状态 | 满足评审提醒的公开展示验收 |
| `src/app/[locale]/(admin)/admin/catalog/models/*` | 修改 | 模型列表/编辑页展示基准价、来源、同步状态、漂移状态、fixed-price 提示 | 管理员能区分模型事实和分组策略 |
| `src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/*` | 修改 | listing 页面改为分组策略编辑：继承 group ratio、listing multiplier、price override、状态、smoke、排序 | 同一模型不同分组的差异在策略层表达 |
| `src/app/api/apipool/admin/catalog/pricing/sync/route.ts` | 新增 | 管理员手动触发 New API pricing 同步 | 首版先人工触发，避免定时任务复杂化 |
| `src/app/api/apipool/admin/catalog/pricing/drift/route.ts` | 新增 | 读取 drift report 和最近 sync run | 运维验收与排障入口 |
| `src/features/newapi-bridge/server/portal.ts` | 小改 | API Key 创建继续只用 `groupSlug`；可增加更明确的 empty mapping 错误审计 | 保持用户边界不变 |
| `tests/*` | 修改/新增 | 见第 10 节 | 确保数据、公式、公开边界、迁移和 live 对账可验证 |

## 6. 数据结构 / API / 状态流变化

### 6.1 `catalog_model`

保持模型主数据表，`model_id` 继续唯一。后续实现可只做小幅扩展：

- 可选新增 `description text`、`lifecycle_status text default 'active'`，但不放价格字段。
- `context_window` 暂保留兼容旧页面和种子，不在本设计中删除。
- 分类仍兼容 `category` 主分类字段和 `catalog_model_category` 多分类表。

### 6.2 新表 `catalog_model_price`

一模型一条当前基准价格，`model_id` FK 到 `catalog_model.id` 并唯一。

建议字段：

| 字段 | 类型 | 语义 |
|---|---|---|
| `id` | text pk | 价格记录 ID |
| `model_id` | text unique not null | FK 到 `catalog_model.id` |
| `pricing_mode` | text not null | `token_ratio`、`manual_token`、`fixed_price`、`unknown` |
| `source` | text not null | `newapi_pricing`、`manual`、`migration` |
| `source_model_id` | text | New API `model_name` |
| `source_vendor_id` | text | New API `vendor_id` |
| `source_quota_type` | integer | New API `quota_type` |
| `source_model_ratio` | text | decimal 字符串，避免 SQLite float 精度争议 |
| `source_completion_ratio` | text | decimal 字符串 |
| `source_image_ratio` | text | decimal 字符串，可空 |
| `source_supported_endpoint_types` | text | JSON array |
| `base_input_micro_usd` | integer null | 基准普通输入价，USD / 1M token 的 micro-USD |
| `base_output_micro_usd` | integer null | 基准普通输出价 |
| `base_image_input_micro_usd` | integer null | 基准图片输入价 |
| `base_image_output_micro_usd` | integer null | 基准图片输出价 |
| `fixed_price_micro_usd` | integer null | fixed-price 模型的固定价 |
| `fixed_price_unit` | text null | `request`、`image`、`unknown` 等 |
| `sync_status` | text not null | `never_synced`、`synced`、`sync_failed`、`manual` |
| `drift_status` | text not null | `unknown`、`matched`、`drifted`、`missing_remote`、`fixed_needs_review` |
| `source_fingerprint` | text | 规范化 source payload hash |
| `source_synced_at` | integer timestamp_ms null | 最近同步时间 |
| `reviewed_by` | text null | 人工确认人 |
| `reviewed_at` | integer timestamp_ms null | 人工确认时间 |
| `review_note` | text null | 人工说明 |
| `created_at/updated_at` | timestamp_ms | 通用时间戳 |

索引：

- unique `model_id`
- index `sync_status`
- index `drift_status`
- index `source_model_id`

### 6.3 `catalog_group` 的 group ratio 扩展

`catalog_group.newapi_group` 继续是内部映射。新增字段可直接放 `catalog_group`，因为每个 APIPool 分组只映射一个 New API group：

| 字段 | 类型 | 语义 |
|---|---|---|
| `newapi_group_ratio_decimal` | text null | New API group ratio 的规范化 decimal 字符串，例如 `1`、`0.5` |
| `newapi_group_ratio_bps` | integer null | 由 decimal 规范化得到的 bps，`1 = 10000` |
| `newapi_group_ratio_raw` | text null | 原始 payload 值的 JSON 字符串或原样字符串，用于 report/fingerprint |
| `pricing_sync_status` | text not null default `unknown` | `unknown`、`synced`、`missing_remote_group`、`sync_failed`、`manual` |
| `pricing_synced_at` | integer timestamp_ms null | 最近同步时间 |
| `pricing_review_note` | text null | 运营确认说明 |

解析和规范化规则：

- New API 原始值先写入 sync run report 和 `newapi_group_ratio_raw`，参与 `source_fingerprint`，不得因为规范化后相同而丢掉原始证据。
- 仅接受有限非负 decimal；数字类型先转成十进制字符串，字符串类型 trim 后解析。`NaN`、`Infinity`、负数、空字符串均视为无效，不覆盖旧值，sync run 记录 `missing_remote_group` 或 `sync_failed`。
- 规范化 decimal 字符串去除多余前导 `+` 和尾随 0，但保留数值含义，例如 `1.0000 -> 1`、`0.500 -> 0.5`。
- `newapi_group_ratio_bps = round_half_up(decimal * 10000)`。所有有效价公式、drift compare、usage/quota tolerance 都使用同一 bps 值生成整数 micro-USD，避免 UI、DB 和 smoke 各自舍入。
- fingerprint/report 同时保存 raw、normalized decimal、normalized bps；raw 变了但 bps 未变时记为 info，bps 变化才触发价格 drift。
- 如果 New API 当前版本无法稳定返回 group ratio，后台允许人工填写 decimal/bps，但状态必须是 `manual`，且 live/equivalent 对账未通过前不能作为公开已确认折扣价。

### 6.4 `catalog_model_listing` 作为分组策略表

物理表名保留，业务语义调整为 group policy。已有字段继续使用：

- `model_id + group_id` 唯一：表达同一模型在同一分组下只有一个策略。
- `status_id`：表达该策略是否公开可见、是否可调用。
- `smoke_tested/featured/sort_order/description`：策略级展示与运营属性。
- `input_micro_usd/output_micro_usd/image_*`：兼容期有效展示价缓存。后续服务层命名应改为 `effectiveInputMicroUsd` 等；缓存只能由已匹配的 New API group ratio、已验证 listing multiplier 或已验证 override 写入公开确认价。
- `list_input_micro_usd/list_output_micro_usd`：兼容期划线价缓存。新语义下默认等于基准价乘以 1 或原价策略。
- `discount_rate_bps`：仅在 `price_policy = listing_multiplier` 时使用，表示“该模型在该 New API group 下经过 live/usage 对账证实的最终有效倍率”，不是 APIPool 自造营销折扣。`10000 = 100% = 10 折`，`500 = 5% = 0.5 折`。
- `discount_note`：用户可见文案，但不得成为价格事实源。

新增字段建议：

| 字段 | 类型 | 语义 |
|---|---|---|
| `price_policy` | text not null default `inherit_group` | `inherit_group`、`listing_multiplier`、`price_override`、`legacy_override`、`fixed_price_review` |
| `override_input_micro_usd` | integer null | 手工覆盖普通输入价 |
| `override_output_micro_usd` | integer null | 手工覆盖普通输出价 |
| `override_image_input_micro_usd` | integer null | 手工覆盖图片输入价 |
| `override_image_output_micro_usd` | integer null | 手工覆盖图片输出价 |
| `override_reason` | text null | 必填，解释为什么不能由基准价和倍率计算 |
| `override_status` | text not null default `none` | `none`、`needs_review`、`verified`、`failed` |
| `effective_price_synced_at` | integer timestamp_ms null | 有效展示价缓存更新时间 |
| `effective_price_formula` | text null | JSON，记录基准价、倍率、override 来源的摘要 |
| `price_drift_status` | text not null default `unknown` | `unknown`、`matched`、`drifted`、`missing_group`、`needs_live_check` |

`listing_multiplier` 的约束：

- 正常路径应使用 `inherit_group`，即 `catalog_group.newapi_group_ratio_bps`。
- 只有当 New API 实际扣费对某个模型和 group 的倍率与 group 默认倍率不同，并且已经通过 usage log 或 quota delta 对账，才允许使用 `listing_multiplier` 作为公开确认价。
- 新建或迁移得到的 `listing_multiplier` 默认进入 `price_drift_status = needs_live_check`；未完成 live/usage 对账前，公开 DTO 不得输出折扣 badge、划线价或“已确认折扣”文案。
- 如果历史价格无法解释为 New API group ratio 或已验证 listing multiplier，必须标记为 `legacy_override`，由 admin drift 页面处理，不得静默当成折扣。

### 6.5 新表 `catalog_price_sync_run`

记录每次 `/api/pricing` 同步和漂移检测。

字段建议：

- `id`
- `operator_user_id`
- `status`: `running`、`success`、`failed`、`partial`
- `started_at/finished_at`
- `remote_model_count`
- `matched_model_count`
- `drift_count`
- `fixed_price_count`
- `missing_group_count`
- `source_fingerprint`
- `error_message`
- `report_json`：差异摘要，不含 token、内部 URL 或凭据。

### 6.6 价格公式

所有公式集中放在 `src/features/api-catalog/lib/pricing.ts`。

基准价推导：

```text
base_input_usd_per_1m = model_ratio * 2
base_output_usd_per_1m = model_ratio * 2 * completion_ratio
base_image_input_usd_per_1m = model_ratio * 2 * image_ratio
base_image_output_usd_per_1m = base_output_usd_per_1m
```

其中 `quota_type = 1` 不走 token split，写入 `pricing_mode = fixed_price`。

基准价规范化：

- `source_model_ratio/source_completion_ratio/source_image_ratio` 与 group ratio 使用同一个 decimal parser，不用 JavaScript float 直接参与最终金额计算。
- source ratio 原始值写入 sync run report 和 fingerprint，规范化 decimal 字符串写入 `catalog_model_price.source_*_ratio`。
- `base_*_micro_usd = round_half_up(base_*_usd_per_1m * 1_000_000)`。后续 effective price 只基于整数 micro-USD 和 normalized bps 继续计算。
- `comparePriceDrift()` 同时比较 raw fingerprint、normalized decimal 和最终 integer micro-USD；公开展示和 quota 对账以 integer micro-USD 为准。

有效展示价的前置门禁：

- `catalog_model_price.pricing_mode = token_ratio` 且 `sync_status = synced` 时，基准价来自 New API `/api/pricing`；`manual_token` 必须有 `reviewed_at/reviewed_by` 和说明。
- `catalog_group.pricing_sync_status = synced` 且 `newapi_group_ratio_bps` 存在时，分组倍率来自 New API，是正常公开价事实源。
- `catalog_group.pricing_sync_status = manual` 时，只能在 live/equivalent 对账通过后进入公开确认价；否则 listing 必须保持 `price_drift_status = needs_live_check`。
- public mapper 只有在 listing `price_drift_status = matched` 时才输出可渲染的 confirmed effective price / discount presentation。未匹配的价格只能进入 admin DTO 或兼容期缓存，不得作为已确认折扣展示。

有效展示价：

```text
newapi_group_multiplier = catalog_group.newapi_group_ratio_bps

if listing.price_policy = inherit_group:
  effective = base * newapi_group_multiplier / 10000

if listing.price_policy = listing_multiplier:
  requires listing.price_drift_status = matched
  effective = base * listing.discount_rate_bps / 10000
  effective_price_formula must include sourceGroupRatioBps and verifiedListingMultiplierBps

if listing.price_policy = price_override:
  requires listing.override_status = verified and listing.price_drift_status = matched
  effective = listing.override_*

if listing.price_policy = legacy_override:
  public confirmed price is not emitted
  admin may show existing effective cache as legacy evidence
```

`listing_multiplier` 与 New API group ratio 的关系：

- `inherit_group` 是默认且推荐路径，直接使用 New API group ratio。
- `listing_multiplier` 不是在 New API group ratio 之外再打一个 APIPool 折扣，而是表示“该模型在该 New API group 下经对账确认的最终倍率”。如果它与 `newapi_group_ratio_bps` 不同，必须能用 usage log 或 quota delta 证明 New API 实际扣费也是这个倍率。
- 未验证的 `listing_multiplier` 必须保持 `price_drift_status = needs_live_check`，或者迁移时降级为 `legacy_override`。它可以在 admin 中提示运营处理，但不能进入 public `pricePresentation`。

展示价缓存写入现有 `catalog_model_listing.input_micro_usd/output_micro_usd/image_*`，公开查询读取缓存，同时后台保留公式摘要用于解释。写入公开确认缓存时必须同时写入 `effective_price_formula`，至少包含 `basePriceId`、`pricingMode`、`sourceGroupRatioBps`、`pricePolicy`、`verifiedListingMultiplierBps` 或 `overrideStatus`、`matchedAt`。

划线价：

```text
list_price = base price
```

仅当 `effective < list_price`、listing `price_drift_status = matched`，且差异可由 New API group ratio、live-verified listing multiplier 或 verified override 解释时，公开 `/models` 才显示划线价和折扣文案。`legacy_override`、`needs_live_check`、`drifted`、`missing_group` 一律不显示划线价或折扣 badge。

New API usage 对账公式：

```text
expected_usd =
  input_tokens * effective_input_micro_usd / 1_000_000 / 1_000_000
  + output_tokens * effective_output_micro_usd / 1_000_000 / 1_000_000
```

再用 `NEWAPI_QUOTA_PER_UNIT` 转成 expected quota，与 New API usage log 的 `quota` 或调用前后 quota delta 比较。允许整数取整误差和 New API 侧 rounding tolerance，但 tolerance 必须在测试和 smoke 输出中明示。

### 6.7 New API pricing snapshot DTO

在 `createNewApiClient()` 新增：

```ts
async getPricingSnapshot(): Promise<{
  models: RemotePricingModel[];
  vendors: Record<string, string>;
  groupRatios: Record<string, {
    raw: unknown;
    decimal: string;
    bps: number;
    sourceKey: 'group_ratio' | 'groupRatio' | 'group_ratios';
  }>;
  usableGroups: string[];
  sourceFingerprint: string;
}>
```

兼容保留：

```ts
async listPricingModels(): Promise<RemotePricingModel[]> {
  return (await getPricingSnapshot()).models;
}
```

解析策略：

- `data`：兼容裸数组、`{items}`。
- `vendors`：兼容 object 或 array。
- group ratio：兼容 `group_ratio`、`groupRatio`、`group_ratios`，值可为数字或数字字符串；client DTO 不直接暴露 float，而是返回 raw、规范化 decimal 和 normalized bps。
- usable group：兼容 `usable_group`、`usable_groups`、`groups`。
- per-model enabled groups：继续解析 `enable_groups`。
- 所有未知字段只进入 fingerprint，不直接透出给浏览器。

规范化实现要求：

- `getPricingSnapshot()` 负责把 New API 原始 group ratio 统一转换为 `{raw, decimal, bps}`；服务层和测试不再重复解析 float。
- bps 采用 `round_half_up(decimal * 10000)`，与 `catalog_group.newapi_group_ratio_bps` 落库规则一致。
- `sourceFingerprint` 基于规范化后的排序结构加原始 raw 值生成，保证同一 payload 顺序变化不产生误报，原始值变化仍可追踪。
- quota 对账使用已落库的 effective micro-USD；effective micro-USD 由同一 bps 计算得到，因此 parser、DB、公开展示和 smoke 的舍入口径一致。

### 6.8 DTO 边界

公开查询和后台查询拆分 DTO，禁止在一个 `ListingRow` 上堆叠 public 与 admin-only 字段。

`PublicCatalogListingDto` 只允许包含页面渲染必需字段：

- `modelId`
- `displayName`
- `vendorName`
- `categorySlugs`
- `capabilities`
- `groupSlug`
- `groupName`
- `status`
- `description`
- `smokeTested`
- `featured`
- `sortOrder`
- `effectiveInputMicroUsd/effectiveOutputMicroUsd/effectiveImageInputMicroUsd/effectiveImageOutputMicroUsd`
- `pricePresentation`：仅包含可公开的 `showPrice`、`showStrikethrough`、`discountLabel`、`note`、`verificationState`

`PublicCatalogListingDto` 禁止包含：

- `newapiGroup`
- 内部 `groupId/listingId/basePriceId`
- New API raw payload
- `source_model_ratio/source_completion_ratio/source_image_ratio`
- `sync_status/drift_status/override_status` 的原始枚举
- 未验证 legacy cache

`AdminPricingSummaryDto` 可包含：

- `basePrice`：基准输入/输出/图片价、`pricing_mode`、来源、同步时间、review 信息
- `groupPricing`：`newapiGroup`、raw/decimal/bps、sync status、最后同步时间
- `listingPolicy`：`price_policy`、`discount_rate_bps`、override 字段、override status、price drift status、effective formula
- `driftEvidence`：最近 sync run、usage/quota 对账摘要、冲突报告引用

public mapper 只能从已计算的 pricing summary 中挑字段生成白名单 DTO；不得把 admin DTO 直接 JSON 序列化后在页面侧过滤。

### 6.9 API 设计

新增后台 API 均走 server-only New API client，要求 RBAC：

| 方法与路径 | 权限 | 作用 |
|---|---|---|
| `POST /api/apipool/admin/catalog/pricing/sync` | `admin.catalog.write` | 手动同步 `/api/pricing`，更新 `catalog_model_price`、group ratio、sync run、drift status |
| `GET /api/apipool/admin/catalog/pricing/drift` | `admin.catalog.read` | 返回最近 drift report，用于后台只读展示 |
| `POST /api/apipool/admin/catalog/models/[id]/pricing/refresh` | `admin.catalog.write` | 针对单个模型从最近 snapshot 或 New API 刷新基准价格 |
| `POST /api/apipool/admin/catalog/models/[id]/pricing/manual` | `admin.catalog.write` | 人工设置基准价，必须提交原因 |
| `POST /api/apipool/admin/catalog/models/[id]/listings/[listingId]/price-override` | `admin.catalog.write` | 设置 listing override，必须提交原因和审核状态 |

返回给浏览器的 admin DTO 可以包含 `newapiGroup`，因为这是 `/admin` 运维后台；公开 `/models` 和用户控制台 DTO 继续禁止。

### 6.10 状态流

状态必须按列拆分，不允许把一种列的值写进另一种列。`reviewed_at/reviewed_by/review_note` 是人工确认字段，不是通用状态值；需要表达“已审核”时使用合法 status 加 review 字段。

`catalog_model_price.pricing_mode`

| 合法值 | 语义 | 允许转换 |
|---|---|---|
| `unknown` | 尚无可解释计费模式 | 初始值；同步成功后转 `token_ratio` 或 `fixed_price`；人工录入后转 `manual_token` |
| `token_ratio` | New API ratio 可推导 token 价 | `/api/pricing` 正常 token 模型同步；远端变 fixed 时转 `fixed_price` 并将 `drift_status` 置为 `fixed_needs_review` |
| `manual_token` | 人工维护 token 基准价 | admin 人工录入并填写 reason；后续 New API 匹配后可转 `token_ratio` |
| `fixed_price` | New API fixed-price 模型 | `quota_type = 1` 同步进入；人工确认只写 `reviewed_at/reviewed_by`，不写 `reviewed` 状态 |

`catalog_model_price.sync_status`

| 合法值 | 语义 | 允许转换 |
|---|---|---|
| `never_synced` | 从未成功同步 | 初始值；同步成功转 `synced`；失败转 `sync_failed`；人工录入转 `manual` |
| `synced` | 最近一次 New API 同步成功 | 后续成功保持；失败转 `sync_failed`；人工覆盖转 `manual` |
| `sync_failed` | 最近一次同步失败，旧值保留 | 下次成功转 `synced`；人工覆盖转 `manual` |
| `manual` | 当前基准价由人工维护 | New API 匹配且管理员确认后转 `synced`；同步差异只改 `drift_status`，不自动覆盖人工价 |

`catalog_model_price.drift_status`

| 合法值 | 语义 | 允许转换 |
|---|---|---|
| `unknown` | 尚未比较或无远端证据 | 初始值；同步比较后转其他状态 |
| `matched` | 当前基准价与 New API 规范化结果一致 | 远端 ratio/bps/价格变化后转 `drifted`；远端缺失转 `missing_remote` |
| `drifted` | 当前基准价与 New API 结果不一致 | 管理员接受远端或人工处理后转 `matched` |
| `missing_remote` | 本地模型在远端 pricing 中缺失 | 远端恢复后转 `matched` 或 `drifted` |
| `fixed_needs_review` | fixed-price 模型需要人工确认展示单位或是否公开 | 人工确认后仍保持 `pricing_mode = fixed_price`，并按证据转 `matched` 或继续阻断 public token 展示 |

`catalog_model_listing.price_policy`

| 合法值 | 语义 | 允许转换 |
|---|---|---|
| `inherit_group` | 默认公开价路径，使用 New API group ratio | 初始推荐值；可转 `listing_multiplier`、`price_override`、`fixed_price_review` |
| `listing_multiplier` | 已对账的模型+分组最终倍率例外 | 新建或迁移时必须同时把 `price_drift_status` 置为 `needs_live_check`；live/usage matched 后才可公开；可退回 `inherit_group` |
| `price_override` | 手工覆盖具体价格 | 必须有 override 字段、reason 和 `override_status`；verified 且 price matched 后才可公开 |
| `legacy_override` | 迁移遗留价格，尚不能解释为 New API group ratio 或已验证 override | 只能在 admin 显示证据；处理后转 `inherit_group`、`listing_multiplier` 或 `price_override` |
| `fixed_price_review` | fixed-price 模型的 listing 展示待确认 | 人工确认展示单位和对账后转可公开状态，否则不输出 token 价 |

`catalog_model_listing.override_status`

| 合法值 | 语义 | 允许转换 |
|---|---|---|
| `none` | 无手工 override | `price_policy = price_override` 时转 `needs_review` |
| `needs_review` | 已提交 override，等待确认或 live 对账 | 审核通过并有证据后转 `verified`；失败转 `failed` |
| `verified` | override 有人工确认和必要对账证据 | 远端/usage 证据冲突时转 `failed` 或 `needs_review` |
| `failed` | override 未通过或与扣费口径冲突 | 修正后转 `needs_review`；移除 override 后转 `none` |

`catalog_model_listing.price_drift_status`

| 合法值 | 语义 | 允许转换 |
|---|---|---|
| `unknown` | 尚未做公式或 live 对账 | sync/drift 任务后转 `matched`、`needs_live_check`、`missing_group` 或 `drifted` |
| `matched` | listing 有效价与 New API group ratio 或 live/usage 对账一致 | group ratio、base price、override 变化后转 `needs_live_check` 或 `drifted` |
| `drifted` | listing 有效价与可解释公式或 live 证据不一致 | 重新同步、调整策略或 live matched 后转 `matched` |
| `missing_group` | listing 分组没有可用 New API group ratio 或远端 group 缺失 | group ratio 同步恢复后转 `needs_live_check` 或 `matched` |
| `needs_live_check` | 需要 live/equivalent 对账才能公开确认为折扣价 | usage log / quota delta matched 后转 `matched`；失败转 `drifted` |

公开确认价门禁：

- `inherit_group`：要求 `catalog_group.pricing_sync_status = synced`、`newapi_group_ratio_bps` 存在、listing `price_drift_status = matched`。
- `listing_multiplier`：要求 listing `price_drift_status = matched`，且 `effective_price_formula` 包含 live/usage 对账证据引用。
- `price_override`：要求 `override_status = verified` 且 `price_drift_status = matched`。
- `legacy_override`、`fixed_price_review`、`needs_live_check`、`drifted`、`missing_group` 不得输出公开折扣/划线价。

公开展示规则：

- `catalog_status.is_public_visible = true` 且 vendor/group/category/status/capability 均 active 才进入 `/models`。
- `catalog_status.is_callable = true` 才可被 callable/smoke 查询使用。
- `allowCreateKey` 仍只控制 Key 创建分组，不代表模型可调用。

## 7. 兼容性与迁移风险

### 7.1 回填策略

迁移实现必须非破坏性，并且不能把历史 listing 价格误认成已通过 New API 对账的折扣价。旧展示价“不跳变”只适用于兼容读阶段；进入新价格策略公开确认路径前，必须完成 group ratio 同步或 live/usage 对账。

回填顺序：

1. 为每个 `catalog_model` 创建 `catalog_model_price`。
2. 优先选 `official` listing 作为基准来源。
3. 如果 official listing 有 `list_input_micro_usd/list_output_micro_usd`，用 list price 回填基准价。
4. 如果没有 list price，用 official 当前有效价回填基准价。
5. 没有 official 时，如果所有 listing 价格一致，用一致价回填基准价。
6. 若多个 listing 价格不一致且无法推导倍率，选 smoke-tested + callable + sort 最靠前的 listing 作为临时基准，其他 listing 标为 `legacy_override`，`price_drift_status = needs_live_check`，并在 admin 中要求处理。
7. 不做平均价、最低价、最高价这类静默推导。

回填后的策略归类：

- 能由 New API group ratio 解释的 listing：`price_policy = inherit_group`，同步任务可将 `price_drift_status` 置为 `matched`。
- 与 group ratio 不一致但运营声称有远端特殊倍率的 listing：只能设为 `listing_multiplier + needs_live_check`；live/usage 对账通过后才允许 `matched`。
- 只有历史展示缓存、无法解释为 New API 事实源的 listing：设为 `legacy_override + needs_live_check`，public 不显示已确认折扣或划线价。
- 手工价：设为 `price_override + override_status = needs_review`，必须审核和对账后才能公开。

### 7.2 兼容读

分两阶段：

- 阶段 A：`queries.ts` 仍读取 listing 的现有 `input_micro_usd/output_micro_usd` 作为旧页面兼容价，但 admin 已能看到基准价、group ratio、公式状态和 `needs_live_check`。此阶段不得新增“已确认折扣”文案或新 badge，也不得作为新价格策略的发布完成标准。
- 阶段 B：所有模型都有 `catalog_model_price`，且公开 listing 的 `price_drift_status` 已 resolved 为 `matched` 后，服务层统一通过 `resolveEffectiveCatalogPrice()` 计算并写回 effective cache；公开查询仍读 cache，避免页面热路径每次动态算复杂公式。
- 阶段 C：新 public DTO 切到 `PublicCatalogListingDto` 白名单。未 matched 的 listing 可以继续留在 admin，但 public mapper 不输出 confirmed price presentation。

发布门禁：新策略切到公开 `/models` 前，目标公开 listing 必须完成阶段 B/C；如果某 listing 仍是 `needs_live_check/legacy_override/drifted/missing_group`，只能继续走旧兼容页、隐藏价格 presentation，或临时从公开列表下架，不能作为已确认折扣价上线。

### 7.3 冲突报告

迁移或同步发现冲突时，不自动覆盖公开展示价：

- 写入 `catalog_price_sync_run.report_json`。
- listing 标记 `legacy_override`、`needs_live_check` 或 `price_drift_status = drifted`，不得标为 `matched`。
- admin drift 页面列出：模型、分组、旧有效价、基准价、group ratio、建议公式、差异、处理建议。
- 如果冲突来自 `listing_multiplier`，报告必须列出 New API group ratio、listing multiplier、最近 live/usage 对账状态；未对账时 public 只能按 `inherit_group` 公式展示或隐藏折扣 presentation。

### 7.4 回滚方案

- 不删除旧 listing price 字段。
- 回滚应用版本后，旧 `/models` 仍可按 listing 价格展示。
- 新表和新字段可保留不用，不影响旧代码读写。
- 若同步逻辑异常，运营可停用 sync API，继续保留最近有效展示价。

### 7.5 Drizzle journal / snapshot 风险

历史上已经出现 SQL 已进镜像但 SQLite migration journal 未登记导致线上字段未落库的问题。后续实现必须作为发布门禁：

- `src/config/db/migrations_sqlite/*.sql` 与 `src/config/db/migrations_sqlite/meta/_journal.json` 同步。
- 补齐对应 snapshot；当前 meta 目录只到 `0005_snapshot.json`，而 journal 已记录 `0007_model_catalog_admin_prices`，实现阶段必须先澄清并修复生成策略。
- 扩展 `tests/db/catalog-schema-singlesource.test.ts` 检查新表、新字段、journal entry 和 snapshot 一致性。
- 生产发布前用只读 SQL 验证目标字段真实存在。

## 8. 安全、性能、可维护性

### 8.1 安全与权限

- 所有 New API pricing 同步和候选搜索继续 server-only。
- `GET /api/pricing` 请求携带 admin token 与 `New-Api-User`，但响应 DTO、日志、sync run report 不记录 token 或内部 URL。
- public `/models`、dashboard、API Key 创建页面不输出 `newapiGroup`、内部 ID、raw source payload。
- admin 写价格、override、manual base price 时必须要求 `admin.catalog.write`，并记录操作人和原因。
- fixed-price、listing multiplier、legacy override 和 price override 未验证时，公开页面不得渲染成看似已验证的折扣价、划线价或折扣 badge。

### 8.2 性能

- `/models` 热路径继续读本地 SQLite/libsql，不实时请求 New API。
- 有效价预计算写入 listing cache，公开查询只 join 本地表。
- 同步任务批量运行，记录 `catalog_price_sync_run`，避免页面加载触发远端同步。
- `getPublicListings` 的 cache tag `catalog` 保留；同步/价格变更后调用 `revalidateCatalog()`。

### 8.3 可维护性与可观测性

- 价格公式集中在 `pricing.ts`，禁止页面、route、service 各自重复实现。
- sync run report 足够定位：远端模型缺失、group 缺失、ratio 漂移、fixed-price 待确认、override 未验证。
- admin 页面用 `AdminPricingSummaryDto` 展示模型列表、详情页和 listing 策略页，避免字段解释分叉；public 页面只能使用 `PublicCatalogListingDto`。
- live/equivalent smoke 输出应记录：模型、groupSlug、effective price、tokens、New API quota/log cost、差异。

## 9. 依赖与前置假设

- New API `/api/pricing` 在目标部署版本可用，且可通过 admin token 调用。
- New API group ratio 字段在目标版本中可解析；如果字段形态不同，先扩展 parser 和 fixture。
- New API usage log 至少能提供 `prompt_tokens`、`completion_tokens`、`quota`、`model_name`；否则用调用前后 user quota delta 做对账。
- 当前首发数据库仍是 SQLite/libsql，catalog 表继续 sqlite-only。
- 运营愿意在 fixed-price 和 override 场景提供人工确认原因。

## 10. 测试与验证计划

### 10.1 功能 × 验证矩阵

| 功能点 | 验收标准 | 单元测试 | 功能测试 | UI 交互测试 | 失效路径验证 |
|---|---|---|---|---|---|
| 基准价格独立表 | 同一 `catalog_model` 只有一条当前基准价，模型主数据不复制价格 | `catalog-pricing.test.ts` 覆盖 base price DTO、fixed-price、manual source | `catalog-service.test.ts` 创建模型后写入/读取 `catalog_model_price` | N/A | 缺基准价时 admin 显示 `never_synced`，public 不崩 |
| 分组策略有效价 | 正常公开价使用 New API group ratio；同一模型不同分组可因远端 group ratio 不同而有不同有效价 | `resolveEffectiveCatalogPrice()` 输入 base + New API group ratio + policy 输出 effective；未 matched 的 `listing_multiplier` 不返回 public presentation | `queries.test.ts` 插入两个 group listing，验证有效价不同且无重复；未验证 multiplier 进入 `needs_live_check` | `/admin/catalog/models/[id]/listings` 显示 group ratio、listing multiplier、live check 状态和有效价预览 | group ratio 缺失、override 未审核、fixed-price、listing multiplier 未 live matched 均不公开为已确认折扣 |
| New API pricing 同步 | `/api/pricing` 同步后写入 base price、group ratio raw/decimal/bps、enabled groups、drift 状态 | `client.test.ts` 覆盖 `getPricingSnapshot()` envelope 解析；`pricing.test.ts` 覆盖 decimal 到 bps round_half_up 和 effective micro-USD | route 测试模拟 New API payload 后执行 sync，验证表数据、raw report、fingerprint 和 sync run | admin 同步按钮有 loading/success/error | 远端 401/timeout/success=false 不清空旧价格；无效 group ratio 不覆盖旧值，写 sync_failed/missing_remote_group |
| fixed-price 模型 | 不伪造 token split，后台标记待人工确认 | `deriveBasePriceFromNewApiPricing()` quota_type=1 返回 fixed | 同步后 fixed 模型 `pricing_mode=fixed_price` | admin 显示 fixed-price 待确认提示 | public 不显示 `$0.00/token` |
| 公开 `/models` 展示 | 展示已 matched 的有效价、可解释划线价、折扣文案，不泄漏内部字段 | price presentation helper 覆盖 New API group ratio 折扣、无折扣、verified override、unverified multiplier | `queries.test.ts` JSON 不含 `newapiGroup`、内部 ID、raw source、admin status；`PublicCatalogListingDto` 白名单快照 | 页面/组件测试验证有效价、划线价、override 文案不会错位 | `needs_live_check/legacy_override/override failed` 时不显示营销折扣或划线价 |
| admin 价格来源与状态 | 模型页和策略页显示 source、sync、drift、override 状态 | DTO mapper 测试 | admin page source grep/route fixture 测试 | 页面测试覆盖 badges、空态、错误态 | sync_failed、missing_remote_group、needs_review 有可读提示 |
| API Key 分组创建 | 用户仍只提交 `groupSlug`，服务端解析 `newapiGroup`，响应不泄漏 | `buildCreateKeyRequest` 不含内部字段 | `create-portal-key.test.ts` 保持 group mapping 和 rejection | API Key page 不显示 `newapiGroup` | empty mapping/disabled group 在远端调用前失败 |
| 迁移回填 | 旧展示价兼容缓存不跳变，但未解释价格不得公开为已确认折扣；冲突进入 report，不静默覆盖 | 回填函数 fixture 覆盖 official/list price/一致价/冲突、unverified multiplier、legacy override | migration test 在旧 fixture DB 上运行并比对 cache、policy、drift status | N/A | 冲突 listing 标为 `legacy_override + needs_live_check`，public mapper 不输出 discount presentation |
| live/equivalent 对账 | 至少一个调用用 usage log 或 quota delta 证明公式与实际扣费一致，才能把需要验证的 multiplier/override 标为 matched | `quotaSpendFromEffectivePrice()` token 到 quota 的 rounding 测试，使用 normalized bps 生成 effective micro-USD | smoke 脚本 mock equivalent 验证差异阈值；真实/等价环境通过后写 matched 证据 | N/A | usage log 延迟时重试；无法取 log 时用 quota delta；delta 超阈值保持 `needs_live_check` 或转 `drifted` |

### 10.2 测试文件建议

- `tests/api-catalog/catalog-pricing.test.ts`
  - 新增 base price 推导、group ratio raw/decimal/bps 规范化、effective price、drift compare、usage cost formula。
  - 覆盖 `listing_multiplier` 未 live matched 时不能输出 public confirmed presentation。
- `tests/newapi-bridge/client.test.ts`
  - 新增 `getPricingSnapshot()`，覆盖 `group_ratio`、`usable_group`、vendors array/object、success=false、无效 decimal、round_half_up。
- `tests/api-catalog/catalog-service.test.ts`
  - 新增模型基准价和 listing 策略的组合读写。
- `tests/api-catalog/queries.test.ts`
  - 新增 `PublicCatalogListingDto` 的有效价、折扣/划线价、override 文案字段；继续断言无 `newapiGroup`、内部 ID、raw source、admin status。
  - 新增 `AdminPricingSummaryDto` mapper 测试，确保 base/source/sync/override 只出现在 admin DTO。
- `tests/api-catalog/catalog-admin-pages.test.ts`
  - 新增 admin 页面展示 source/sync/drift/override 状态。
- `tests/db/init-catalog.test.ts`
  - 新增 seed 后 `catalog_model_price` 存在，且 operator-provided `newapiGroup` 不被覆盖。
- `tests/db/catalog-schema-singlesource.test.ts`
  - 新增 sqlite-only、新表导出、journal/snapshot 防漏断言。
- `tests/smoke/mvp-smoke-script.test.ts`
  - 增加 live/equivalent price reconciliation：usage log quota 或 user quota delta 与公式一致。

### 10.3 live/equivalent 验收

发布或等价环境至少跑一次：

1. 选择一个 `available + smoke_tested + price_drift_status=matched` 的 listing；优先选择 `price_policy = inherit_group` 且 `catalog_group.pricing_sync_status = synced`、`newapi_group_ratio_bps` 存在的分组。
2. 创建该分组 API Key。
3. 发起一次真实或等价 New API 调用。
4. 读取 New API usage log 的 `prompt_tokens/completion_tokens/quota`；若 log 延迟，则读取调用前后用户 quota delta。
5. 用 APIPool 有效展示价公式计算 expected quota。
6. 输出 expected、actual、delta、tolerance。
7. delta 超阈值则 smoke fail，后台 drift 标记为 `needs_live_check` 或 `drifted`；涉及 `listing_multiplier` 或 `price_override` 时不得写入 `matched`。

## 11. 未决问题与风险

### 11.1 未决问题

1. New API 目标部署版本的 `group_ratio`、`usable_group` 字段精确形态仍需 live fixture 确认；设计已要求 parser 兼容多种形态，但实现前应抓一次真实 payload。
2. fixed-price 模型的 public UI 单位需要产品确认：按次、按图、按请求还是“联系确认”。本设计只要求不伪造 token split。
3. override 审批强度暂定为 `admin.catalog.write + reason + status`；是否需要 super_admin 或二人复核，留给运营流程拍板。

### 11.2 风险

- New API 实际扣费公式可能和当前前端 pricing 公式存在版本差异。缓解：live/equivalent usage log 或 quota delta 对账作为发布门禁。
- New API group ratio 原始值、规范化 decimal 和 bps 如果由不同模块各自舍入，会产生细小但难排查的价格漂移。缓解：client 统一返回 raw/decimal/bps，DB 和公式只用同一 normalized bps。
- 运营误把本地 `listing_multiplier` 当营销折扣使用，会冲突 New API 扣费事实源。缓解：未 live matched 的 multiplier 只能是 `needs_live_check`，public mapper 不输出折扣 presentation。
- SQLite migration journal/snapshot 漏落会导致线上字段不存在。缓解：新增 schema 单源测试和生产只读 SQL 验证。
- 公开页面如果直接展示 override 文案，可能让用户以为营销价已验证。缓解：public DTO 只输出已验证或可解释的 `pricePresentation`。
- 缓存未失效会导致 `/models` 展示旧价。缓解：价格写入和同步成功后统一调用 `revalidateCatalog()`。
- fixed-price 和图片/音频计费模式复杂度较高。缓解：首版标记为待确认，不进入伪 token 价。

## 12. 冻结结论

本设计冻结以下关键决策，供实现计划和只读评审使用：

1. 基准价格采用独立 `catalog_model_price` 表，不放入 `catalog_model`。
2. `catalog_model.model_id` 继续唯一，模型主数据只表达模型事实。
3. `catalog_model_listing` 保留物理表名，业务语义调整为分组策略/售卖项；现有 price 字段作为兼容期有效展示价缓存。
4. 展示价统一由 `pricing.ts` 的公式生成：基准价 + New API group ratio；`listing_multiplier` 只是经过 live/usage 对账证实的模型+分组最终倍率例外，未 matched 前不得公开成已确认折扣价。
5. New API `/api/pricing` 同步必须解析模型倍率、fixed-price、图片价格、enabled groups、group ratio，并写入 sync run 和 drift 状态。
6. 公开 `/models` 必须使用 `PublicCatalogListingDto` 白名单，并明确设计、验收有效价、划线价、折扣/override 渲染；admin 必须用 `AdminPricingSummaryDto` 展示价格来源、同步状态和 override 状态。
7. 至少一个 live/equivalent 调用必须通过 New API usage log 或 quota delta 证明展示价公式与实际扣费一致。
