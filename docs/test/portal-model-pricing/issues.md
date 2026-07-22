# 门户模型定价与调用计费测试遗留

来源：[`report.md`](report.md) 与 [`code-review.md`](code-review.md)，首次记录于 2026-07-21；本清单已按 2026-07-21 复核结论校准。

## P0：发布阻断与资金风险

- [x] 后台模型编辑与分组折扣编辑触发 Server Action 序列化错误。已改为在 Server Action 内重新取得翻译实例；浏览器复测保存、持久化与公共目录刷新成功，callable/价格版本由目录快照测试覆盖。证据见 [`retest-report.md`](retest-report.md)。
- [x] New API 运行用户/运行凭证缺少与门户钱包解耦的内部运行池。现已按既定阶段二需求实现一次性幂等供应、每小时只读水位监控、显式人工绝对值补充和审计；凭证仅在供应成功后激活，APIPool 调额仍只写本地钱包。
- [x] per_call 图片返回长签名 URL 时张数解析失败并免单。解析改为只验证 URL/b64 字段存在性，不再读取长正文；超过 128 字节 URL 与大 `b64_json` 回归均通过。
- [x] 0 价 tier 在应用、数据库、发布门禁和 settlement 间约束不一致。表单、服务、发布门禁和数据库统一要求正整数，原价或折后价为 0 均被拒绝。

## 发布验证门禁（真实上游证据，对应能力正式对外推广前必须完成）

代码级缺陷已闭环（上方勾选项），但以下项目只能在真实环境取证，本地自动化与合成回归不可替代（[`retest-report.md`](retest-report.md) 同口径）。第 1 项是任何真实用户接入前都必须通过的通用硬门；第 2–5 项是能力级硬门，只阻塞对应模型或能力对外开放。未完成验收的能力必须保持不可调用且不对外宣传（技术兜底已核实：长上下文关即 413、web search 未配价即 400、图片不发布即不可路由），不阻塞已经通过真实验收的基础能力先行开放。第 2、4、5 项承接 `PLAN.md` 最终验收未勾项，第 3 项为测试阶段新增的真实契约门禁；本 `issues.md` 是闭环入口，相关 PLAN 项完成后仅同步进度勾选与回链。通用证据要求：脱敏的请求关联标识、复现命令、关键日志或截图索引；不得保留或提交凭据、用户身份、订单及原始敏感日志。

- [ ] **1. 通用硬门：内部运行池全链路闭环（首次验证，剩余风险最高）**：`POST /api/user/manage` 的 override 契约仅按官方 `v1.0.0-rc.20` 源码与 mock 核对，目标部署实例从未真实调用。验收前固定并记录目标 New API 镜像 tag 或 digest（不得仅以可变的 `latest` 作为验收基线），同时记录实例实际版本。在该实例用全新门户用户完成“注册 → 仅本地钱包入账 → 创建 Key → 运行池自动供应 → 首次真实调用成功”，核对 override 请求、回读水位与脱敏审计（`newapi.runtime_pool.provision`）；全程不得手工修改远端用户数据。该首次真实调用须同时核对账本 meter、`charged` 与钱包扣费一致——首轮 UAT 的真实计费验收跑在修复前代码上，这笔调用是修复后 billing/handler 链路的首个真实计费证据，也是基础能力先行开放的最后一环。前置与观察项：目标环境已配 `NEWAPI_RUNTIME_POOL_TARGET_USD` / `NEWAPI_RUNTIME_POOL_LOW_WATERMARK_USD`、已应用 0013–0016 迁移；正式开放首轮后台任务会对全部存量绑定做一次性供应（真实远端写），观察该轮审计与水位告警；并先跑一次不带 `--apply` 的 `runtime-pool-maintenance` 检查确认水位读数正常。若失败，先按版本、鉴权、配置或契约差异定位；只有确认内部运行池方案无法完成钱包解耦闭环时才回归 P0。
- [ ] **2. 能力级硬门：`gpt-5.6-luna` 完整 token meter 实调（首次验证）**：按 PLAN 最终验收清单在管理台配置完整普通档、cache write、长档与能力声明并发布，完成真实网关调用；核对账本 meter 列、价格版本、凭证关联、`charged` 与手算一致。若真实提供商能返回非零 cache write，用量必须进入对应 meter；取不到时不得用合成 fixture 冒充真实证据，应保持相关能力不开放或按既定定价裁决处理。
- [ ] **3. 能力级硬门：`server_tool_use` 真实形态核实（首次验证）**：代码已把该字段列入 chat/responses 的已映射集合并按 `web_search_requests` 计次，但真实提供商响应从未见过。用真实 chat/responses web search 调用确认字段出现的端点与结构，修正映射并沉淀 fixture。失败后果：web search 工具费计次恒 0（静默免单）或产生假 `unmapped_struct` 告警；通过前保持 web search 不可调用。
- [ ] **4. 能力级硬门：真实图片长 URL/b64 结算回归（修复后回归）**：真实上游分别返回长签名 URL 与 `b64_json` 两种形态，至少覆盖 default/auto 与一个显式 SKU，验证 per_call 按实际张数正常结算、default SKU 对账 `matched`、`skuKey`/`unitCount`/token 照记列正确，且不再产生 `token_mismatch` 与 `unit_count_missing`。同时确认发布配置中的 default 档按当前运营约定采用最贵档。UAT 首轮仅覆盖本地短 URL，此为覆盖缺口补测；通过前保持对应 Images 能力不可调用。
- [ ] **5. 能力级硬门：272K 长上下文开关双态真实回归（修复后回归）**：修复轮改动了 billing/handler，需真实执行 272K+ 请求；关闭 `allowLongContext` 时应在转发前以明确错误拦截，开启后应成功调用并按整请求长档价格结算，同时验证 `longContextApplied=1`、`long_context_block_missed` 漏拦检测不误报，并记录脱敏的请求、账本与 New API 日志关联证据。通过前保持对应模型的长上下文能力关闭。

## P1：主要功能与审计错误

- [x] token 成本参照未固化到 `model_price_version`，可比 meter 的外部金额核对退化为 `ref_missing`。现从最近一次有效成本同步报告固化通用 meter map；门户售价未被用作成本参照。
- [x] per_call 缺少独立成本对账策略，所有请求固定产生 `ref_missing:per_call`。default SKU 现在自动比较；非 default SKU 精确记录 `ref_missing:per_call:<sku>`，但不制造金额不匹配结论。
- [x] 图片请求的 token 口径与 New API 日志不一致，产生 `token_mismatch`。归一化已兼容 New API 的 prompt/completion token 字段别名并加入对应 fixture；真实上游复跑统一留在末尾 UAT 项。
- [x] reconcile 免单后的 telemetry update 无状态守卫，竞态下可把 settled 行错标为 waived。两次更新均增加状态条件，并补充 settlement 抢先成功的竞态回归。
- [x] 公共目录隐藏只有输入单价的 Embedding 模型。输入单价可独立展示，输出列显示 `—`；浏览器复测通过。
- [x] 公共目录缺少 per_call 图片 SKU 与单次价格展示。公开 DTO 与模型目录已展示折后 SKU 单次价格；浏览器复测通过。
- [x] tier 编辑器行 key 包含 `skuKey`，输入时重挂载并丢焦点。改用只在新增/初始化时生成的稳定行 ID。
- [x] 用户用量页按模型 token 固定为 0、Key 固定为 `—`，并存在表格列错位。现从请求账本聚合完整 input/output meter，并关联门户 Key 前缀；表格列已校正。
- [x] 用户账单页把请求扣费归为充值、扣费列表为空，小额扣费显示为 `$-0.00`。充值历史只取 recharge，扣费从 settled 请求生成，usage 金额保留 6 位小数。

## P2：契约与体验

- [x] token usage 出现小数时计费 BigInt 转换失败。所有已映射数值现在必须为非负安全整数；非法值归零并记录 `invalid_numeric:<path>`，结算不再抛出 BigInt 异常。
- [x] Images 请求显式拒绝 `stream:true`，避免上游响应形态改变后按次免单。JSON 与 multipart 均在转发前返回 400。
- [x] 图片编辑缺少文件时返回明确 4xx，而不是 500 `convert_request_failed`。multipart 解析要求存在非空 `image` 文件，缺失时返回 400 `invalid_request`。
- [x] 补齐对账表 `admin.apipool.routing.model` 与审计表 `admin.apipool.wallet.reason` 翻译。
- [x] 修正文档中的余额不足状态码、模型示例及 Embeddings/Images/按次计费说明。
- [x] 中文文档页不再提示切换到中文。语言检测改为优先判断当前 pathname locale；浏览器复测通过。
- [x] Checkout 关闭时隐藏充值入口、余额提醒与误导性的空状态文案；浏览器复测通过。
- [x] 新分组运行凭证预热期间返回明确 503 提示和 `Retry-After: 1`。

## 非阻塞清理

- [ ] 收敛重复的 price map 解析、JSON 属性扫描、输入 token 求和与能力键常量；本轮只在不扩大风险的前提下处理。

### 二次评审补充（来源：[`review-log.md`](review-log.md) 第 3 轮，2026-07-21）

- [ ] `overrideUserQuota` 回读确认用严格相等，回读窗口内并发真实消费会误报 mismatch（fail-closed、下轮重试，无资金风险）；可放宽为"回读值 ≥ 目标值 − 窗口容差"或重试一次再判。
- [ ] 运行池监控单次失败（网络抖动）会把 ready 覆写为 error，状态闪烁产生告警噪声；可保留上次有效水位、连续 N 次失败才降级。
- [ ] default=最贵档目前仅是运营约定（PLAN:493 上线清单勾选项），发布门禁不校验 default 与其他 tier 的价格关系；配错则缺省参数请求按低价出高档图。可在 publish-readiness 加"default ≥ 其他各档"警告级检查。
- [ ] 运行池监控对全部活跃绑定串行远端调用，用户规模增长后单轮时长线性拉长；规模化前改分页/并发或按 checkedAt 增量扫描。
