# 评审记录 — portal-model-pricing

## 第 1 轮（2026-07-18，评审人：用户）

对 DESIGN v1（commit 0e44131）§13 五个开放问题的反馈与裁决。正文已按裁决修订，本文只留过程。

| 项 | 用户反馈 | 裁决 | 正文落点 |
|---|---|---|---|
| O1 定价独立性 | 未想好，摆出三个顾虑：全手填工作量其实不大且无兼容问题；newapi 已维护一份价格不用可惜，但其价格也不完全准、同样要人工维护；担心 newapi 字段与门户最终 schema 不完全匹配、兼容引来新问题 | 采纳推荐项：**手填定价 + newapi 降级为只读成本守卫**（倒挂/变动告警 + 表单预填辅助，永不写入门户价格）。决策关键事实：newapi 价格实质是门户的采购成本价（门户 Key 经 newapi 转发、按其倍率扣门户 quota），彻底断开会失去卖价倒挂的自动预警；降级为只读对比后，映射不了的字段不参与对比，兼容顾虑自然消解 | §9 重写 |
| O2 策略收敛 | （解释 4 态现状后）"只需要一种策略：基准价乘以折扣"——比原两态提案更简 | 删除全部 `pricePolicy` 策略态与 `override*` 列；唯一公式 `有效价 = 手填基准价 × 折扣`；分组倍率退出卖价链、转为成本守卫输入；分组差异价需求用各 listing 折扣表达 | §8 重写、§6.1 |
| O3 账本形态 | 确认"5 列存 token 用量"现状后，倾向图片模型 token 也入列，按次计费独立出来 | token 用量每 meter 一列（账本补 4 列），按次独立 `sku_key`/`unit_count` 列，JSON 仅存异常回退标记 | §6.3 重写 |
| O4 促销切换 | 可接受人工改价；提出后期可写定时任务监控各大模型官网价格 | 维持人工改价发新版本；官网价监控记远期 defer（成本守卫架构可挂第二参照源） | §8、§12 |
| O5 SKU 白名单 | 同意代码常量起步；确认"按 token 还是按次"应在模型元数据可配置 | 维持设计：`billing_scheme` 在 `catalog_model_price`；SKU 参数白名单代码常量，出现第二种参数结构再迁元数据 | §6.1、§5.2 |

裁决后新增的已知局限：`cache_write` 成本侧无 newapi 参照，倒挂监控对该 meter 是盲区（§12 已记）。

## 第 2 轮（2026-07-18/19，评审人：用户；材料：codex 双线对比 + codex 反评审）

过程：用户令 codex 与 claude 各自独立编写定价方案（codex 案 = 绿地 6 实体双轨，位于 `~/.codex/worktrees/ca24/APIPool_v2/docs/design/model-pricing-billing-v2/`，未提交）。对比结论以本方案为唯一底座；codex 对该结论反评审提出 7 项意见，经代码验证与用户裁决收敛如下。正文已按裁决修订，本文只留过程。

| 项 | 讨论要点 | 裁决 | 正文落点 |
|---|---|---|---|
| O6 底座选择 | codex 案 6 实体的三大理由（保护存量财务/双轨可回退/区间与变体表达力）被逐一消解：存量是 Stripe 沙盒可迁可清、单轨表单微调更好、未上线允许破坏性重建；且与 O2（折扣挂 listing）/O3（账本列式）直接冲突 | 本方案为唯一实施底座；codex 案不合入主线，价值以修订输入 + 24 题对抗评审题库吸收，其 worktree 保留至吸收完成 | 头部状态 |
| O7 迁移 | codex 要求"迁不动就清不得由脚本自动决定"（正当纠偏） | 破坏性重建；清理/迁移清单实施时列出经人工确认；清空为显式批准的独立操作；停写窗口 + 备份 + 回滚 | §11 |
| O8 变体拦截 | codex 主张拦截 service_tier/fast/geo 并响应复核；经查上游成本按 newapi quota 计、不分 tier，无直接资损 | 完全不做；直连官方 API 时重开 | §2、§12 |
| O9 长上下文 | 初始建议"限流防倒挂、阶梯 defer"；用户升级为：listing 级（分组 × 模型）开关，开 = 计价与官方完全一致、差异只有折扣 → 首版实现整请求切档。事实核对：GPT-5.4/5.5/5.6 的 1.05M 型号官方均列长档价（非仅 5.6）；首发 Claude 系当前无溢价、Haiku 200K 窗口 | 首版实现：`*_long` 平行 meter + 归一化判档 + listing 开关（关 = 保守估算拦截，漏拦按普通档 + 标记）；开关编译进价格版本 | §5.4、§6、§7.1 |
| O10 计价完备性 | codex 主张运行期禁止任何替代价结算；我方曾以"回退恰好产出官方正确价"顶回；用户以**争议/退款成本**维度终裁：一开始就把每个模型计价彻底搞清楚 | 完备集发布硬门（能力声明驱动，告警层取消）+ 删除运行期回退；未知计量项零计费 + 账本标记 + 强告警（兜底保留：零成本且上游追加字段有先例）；原"回退恰好正确"的语义前移到发布配置 | §7.4 重写、§7.1 |
| O11 gpt-image-2 计费形态 | 用户裁决门户按次售卖（官方 token 计费事实不变，售价形态是产品决策）；newapi 侧同步配按次，default 档成本可比性恢复 | per_call 首发启用：SKU 准入 fail-closed（缺省/auto → default，未知组合拒绝）、数量按响应实际、token 照记不计费；multipart 提取升级为计费关键路径 | §5.2、§7.2、§7.6、§9、§10 |
| 反评审补充 | codex 指出现状 `isCatalogRouteReady` 有 priceDriftStatus='matched'/groupPricingSyncStatus='synced'/groupRatioBps>0 三个 newapi 硬门（已代码验证）——不删则 O1 手填价发布后所有模型不可调用 | 采纳为实施阻断级修订：callable 新条件集 = 售卖状态 + 路由分组映射 + 发布门禁通过 | §9 |

codex 反评审中被驳回的部分：per_call 运行面 fail-closed 的"feature gate 禁用"分支（O11 后 per_call 转为首发启用，其 fail-closed 语义以准入拒绝形式实现）；"任何 input fallback 均不可"的论证与其自身 research §4.1 矛盾（该矛盾经 O10 用不同理由达成同方向结论，不影响终态）。

第 2 轮验证过的代码事实：`parseBufferMax = 33_554_432`（32 MiB 响应解析缓冲上限，config.ts）；请求侧 `service_tier` 零拦截（billing.ts 仅 usage 白名单）；`isCatalogRouteReady` 三硬门（queries.ts）。

后续：按 codex 案 review-log 技术题对本方案跑对抗评审 → 终审 GO → §11 移入 `docs/plan/portal-model-pricing/`。

## 第 3 轮（2026-07-20，对抗评审：codex 案 25+5 题对本方案的适用性验证）

题源：codex 案 review-log 三组审查 25 条 + 5 条上线门槛（此前口径"24 题"系点数错误）。初筛：已消解/已吸收 12、机制不存在不适用 8、真题 7 + 轻确认 2。真题逐条取证（main 代码 + newapi 上游）后裁定：

| 题 | 取证 | 裁定 | 落点 |
|---|---|---|---|
| R1 GPT-5.6 `cache_write` 字段可得性 | 适配器读 `input_tokens_details.cache_write_tokens`，端点不返回则写入量混入 input 低收 20%；官方 Responses 参考页未列该字段 | **成立**：加上线门槛——模型 × 端点逐组合真实非零 smoke；取不到则暂缓或显式按"无独立写入价"定价 | §12 新行 |
| R9 缓存写聚合等式校验 | billing.ts messages 分支确认无校验；"5m 明细在、1h 字段缺失"时 1h 归 0 漏计 | **成立**：聚合与细分同存时校验相等，不等按细分结算 + 标记 + 告警 | §7.1 |
| R10 server tools / iterations 防御 | 三层实锤：handler 请求侧不拦截 `tools`；`server_tool_use` 在 MAPPED_KEYS 白名单但无桶映射（次数静默忽略）；`unmappedNonZero` 只过滤**顶层数值**字段，对象/数组（iterations）逃逸 | **成立且加重**：请求侧拦截 server-side tools（client function calling 放行）+ 检测升级覆盖结构化未知项与白名单内无映射字段 | §7.1 新段、§11 步骤 8 |
| R16 异常运营闭环 | 现状告警 = console.error；方案已升级账本标记 + reconcile 统计 | 已覆盖；内测期告警 + 人工足够，不加熔断 | 无 |
| R21 归一化回填一致性 | 归一化在 finalize 同步执行；backfill 走 newapi 日志结构化字段（normalizeBackfillUsage），无跨版本重解释 | **不成立** | 无 |
| R23 无 usage 结算路径 | 现状有 pending → `usage_log_snapshot` 补差路径，设计未写；日志粒度只有 input/output，无缓存细分 → 补差按全价 input 收（方向 = 多收，触 O10） | **部分成立**：路径显式化 + 补差结算打 `billing_flags` 粒度降级标记；per_call 免疫（张数可数） | §7.5 |
| R-门槛 newapi images 透传 | newapi 有 generations/edits（multipart）支持；gpt-image-2 经 issue #4480 转换路径；issue #4478 记录长耗时被切断、流式未按 Images SSE 处理的缺陷 | **成立**：§7.6 增第 5 条——JSON 生成/multipart 编辑/长耗时三场景实测 + 部署版本含 gpt-image-2 支持，callable 前置 | §7.6 |
| R4 rolling ID defer | 自营 newapi 渠道，模型解析在渠道侧 | defer 合理，维持 §12 | 无 |
| R6 272K 误套防护 | §5.4 逐型号核对 + 能力声明门禁已覆盖 | 已覆盖 | 无 |

评审衍生新发现（**待用户裁决**）：

- **N1 原始 usage 凭证不留存**：现状账本只存归一化后的五桶数量（+usageSource），原始响应 usage JSON 不落盘。O10 确立"争议/退款成本"维度后，用户争议时无法复核"当时上游返回了什么"（只能间接引 newapi 侧日志）。codex 案有 `rawProviderUsageJson` 对应物。选项：a) 账本加原始 usage 凭证列（与 O3 不冲突——O3 禁的是用量数量入 JSON 查询，凭证是审计证据非查询字段）；b) 独立留存（日志/表）；c) 不留，依赖 newapi 日志。
