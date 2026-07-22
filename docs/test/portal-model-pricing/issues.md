# 门户模型定价与调用计费测试遗留

来源：[`report.md`](report.md)、[`code-review.md`](code-review.md) 与 [`live-uat-report.md`](live-uat-report.md)，首次记录于 2026-07-21；本清单已按第二轮真实用户走查结论校准。

## P0：发布阻断与资金风险

- [x] 后台模型编辑与分组折扣编辑触发 Server Action 序列化错误。已改为在 Server Action 内重新取得翻译实例；浏览器复测保存、持久化与公共目录刷新成功，callable/价格版本由目录快照测试覆盖。证据见 [`retest-report.md`](retest-report.md)。
- [x] New API 运行用户/运行凭证缺少与门户钱包解耦的内部运行池。现已按既定阶段二需求实现一次性幂等供应、每小时只读水位监控、显式人工绝对值补充和审计；凭证仅在供应成功后激活，APIPool 调额仍只写本地钱包。
- [x] per_call 图片返回长签名 URL 时张数解析失败并免单。解析改为只验证 URL/b64 字段存在性，不再读取长正文；超过 128 字节 URL 与大 `b64_json` 回归均通过。
- [x] 0 价 tier 在应用、数据库、发布门禁和 settlement 间约束不一致。表单、服务、发布门禁和数据库统一要求正整数，原价或折后价为 0 均被拒绝。

## 发布验证门禁（真实上游证据，对应能力正式对外推广前必须完成）

代码级缺陷已闭环（上方勾选项），但以下项目只能在真实环境取证，本地自动化与合成回归不可替代（[`retest-report.md`](retest-report.md) 同口径）。第 1 项是任何真实用户接入前都必须通过的通用硬门；第 2–5 项是能力级硬门，只阻塞对应模型或能力对外开放。未完成验收的能力必须保持不可调用且不对外宣传（技术兜底已核实：长上下文关即 413、web search 未配价即 400、图片不发布即不可路由），不阻塞已经通过真实验收的基础能力先行开放。第 2、4、5 项承接 `PLAN.md` 最终验收未勾项，第 3 项为测试阶段新增的真实契约门禁；本 `issues.md` 是闭环入口，相关 PLAN 项完成后仅同步进度勾选与回链。通用证据要求：脱敏的请求关联标识、复现命令、关键日志或截图索引；不得保留或提交凭据、用户身份、订单及原始敏感日志。

- [x] **1. 通用硬门：内部运行池全链路闭环**。已在 New API `v1.0.0-rc.20`、固定镜像 ID `sha256:7111419e43bd33ee65829ff51f3cc04029d32e2eac28dfcb13b654bbea15036d` 上，以全新合成用户完成“注册 → 仅本地钱包入账 → 创建 Key → 首次 503 预热 → 自动供应 → 重试 200 → 门户结算”；全程未手工修改远端用户数据。运行池水位、唯一一次脱敏供应审计、请求 meter、`charged`、钱包余额和追加式流水一致。证据见 [`live-uat-report.md`](live-uat-report.md)。注：本勾选不豁免生产正式开放时的前置与观察项（生产环境变量、存量绑定首轮一次性供应的审计与水位观察、先跑一次不带 `--apply` 的维护检查——本轮 UAT 未执行该脚本检查）；生产 New API 实例镜像与本轮记录的镜像 ID 不一致时，须重新核对 override 契约。
- [ ] **2. 能力级硬门：`gpt-5.6-luna` 完整 token meter 实调（首次验证）**：按 PLAN 最终验收清单在管理台配置完整普通档、cache write、长档与能力声明并发布，完成真实网关调用；核对账本 meter 列、价格版本、凭证关联、`charged` 与手算一致。若真实提供商能返回非零 cache write，用量必须进入对应 meter；取不到时不得用合成 fixture 冒充真实证据，应保持相关能力不开放或按既定定价裁决处理。
- [ ] **3. 能力级硬门：`server_tool_use` 真实形态核实（首次验证）**：代码已把该字段列入 chat/responses 的已映射集合并按 `web_search_requests` 计次，但真实提供商响应从未见过。用真实 chat/responses web search 调用确认字段出现的端点与结构，修正映射并沉淀 fixture。失败后果：web search 工具费计次恒 0（静默免单）或产生假 `unmapped_struct` 告警；通过前保持 web search 不可调用。
- [ ] **4. 能力级硬门：真实图片长 URL/b64 结算回归（修复后回归）**：真实上游分别返回长签名 URL 与 `b64_json` 两种形态，至少覆盖 default/auto 与一个显式 SKU，验证 per_call 按实际张数正常结算、default SKU 对账 `matched`、`skuKey`/`unitCount`/token 照记列正确，且不再产生 `token_mismatch` 与 `unit_count_missing`。同时确认发布配置中的 default 档按当前运营约定采用最贵档。UAT 首轮仅覆盖本地短 URL，此为覆盖缺口补测；通过前保持对应 Images 能力不可调用。Images 对外开放除本条证据外，还须同时闭环 P1 中的 `n` 张数契约与 `response_format` 能力声明两条未勾项——仅勾本条不构成开放条件。
  - 2026-07-21 第二轮 UAT：RunAPI 长 URL 的 generation/edit 均已真实结算；请求 `n=1` 实返 2 张，账本按 `unit_count=2` 和显式 low SKU 正确收 `$0.02`。显式 `b64_json` 请求仍返回 URL，尚缺另一真实 b64 上游证据，因此保持未完成。详见 [`live-uat-report.md`](live-uat-report.md)。
- [ ] **5. 能力级硬门：272K 长上下文开关双态真实回归（修复后回归）**：修复轮改动了 billing/handler，需真实执行 272K+ 请求；关闭 `allowLongContext` 时应在转发前以明确错误拦截，开启后应成功调用并按整请求长档价格结算，同时验证 `longContextApplied=1`、`long_context_block_missed` 漏拦检测不误报，并记录脱敏的请求、账本与 New API 日志关联证据。通过前保持对应模型的长上下文能力关闭。
  - 2026-07-21 第二轮 UAT：200-token 低成本阈值夹具已完成关闭 413、开启 200、`longContextApplied=1` 与整请求长档价验证；真实 272K+ 请求仍未执行，不能据此勾选。详见 [`live-uat-report.md`](live-uat-report.md)。

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
- [ ] New API 成本参照同步后，Embedding 的门户卖价数据未被覆盖，但公开目录把输入价隐藏为 `—`。真实同步把 `source_supported_endpoint_types` 更新为 `["openai"]`，公开查询因此未识别为 Embedding-only，空输出价触发整价隐藏。应以门户模型分类/能力为主判定，或将 New API 通用端点类型映射为稳定的计费端点语义；补充“真实同步后仍显示 input-only 价格”的回归。证据见 [`live-uat-report.md`](live-uat-report.md)。
- [ ] Images generation 与 edit 请求显式传入 `n=1`，RunAPI 均实际返回 2 张图；网关按 `data.length=2` 正确结算，但用户会为超出请求数量的结果支付双倍按次费用。对外开放前必须明确各路由是否支持 `n`：不支持时在转发前拒绝非真实固定值，支持时校验返回张数与请求一致；不得继续接受 `n=1` 后静默按 2 张收费。补充 generation/edit 的真实契约与结算回归。证据见 [`live-uat-report.md`](live-uat-report.md)。
- [ ] Images 请求显式指定 `response_format=b64_json`，RunAPI 仍返回 URL 且网关按成功响应透传。当前通道既有调研已知只返回 URL，但 API 层未声明或校验该能力。应把响应格式纳入模型/路由能力：不支持时在转发前明确 4xx，支持时必须验证真实响应形态；不得静默忽略用户参数。证据见 [`live-uat-report.md`](live-uat-report.md)。

## P2：契约与体验

- [x] token usage 出现小数时计费 BigInt 转换失败。所有已映射数值现在必须为非负安全整数；非法值归零并记录 `invalid_numeric:<path>`，结算不再抛出 BigInt 异常。
- [x] Images 请求显式拒绝 `stream:true`，避免上游响应形态改变后按次免单。JSON 与 multipart 均在转发前返回 400。
- [x] 图片编辑缺少文件时返回明确 4xx，而不是 500 `convert_request_failed`。multipart 解析要求存在非空 `image` 文件，缺失时返回 400 `invalid_request`。
- [x] 补齐对账表 `admin.apipool.routing.model` 与审计表 `admin.apipool.wallet.reason` 翻译。
- [x] 修正文档中的余额不足状态码、模型示例及 Embeddings/Images/按次计费说明。
- [x] 中文文档页不再提示切换到中文。语言检测改为优先判断当前 pathname locale；浏览器复测通过。
- [x] Checkout 关闭时隐藏充值入口、余额提醒与误导性的空状态文案；浏览器复测通过。
- [x] 新分组运行凭证预热期间返回明确 503 提示和 `Retry-After: 1`。
- [ ] Checkout 关闭时，API Key 页仍提示“发起付费调用前，请先在余额页充值”；应改为环境无关的余额说明或随 Checkout 状态隐藏。
- [ ] 同一会话在后台保存 listing 折扣后，通过客户端路由返回公开模型页仍可能显示旧价格，完整刷新才更新；需补充公共目录的路由缓存失效或刷新提示。
- [ ] Key 页把官方分组显示为 `Official`，而公开目录显示“官方”；统一用户侧中文名称。
- [ ] 管理员调额会正确改变余额且不冒充充值，但普通用户看不到调额来源记录；评估增加只读的余额变动历史，避免余额变化不可解释。
- [ ] 管理端用户详情只展示 New API 绑定，未展示内部运行池的 `ready/low/depleted/error`、最近水位、检查时间和脱敏供应审计；本轮只能借助数据库核对。增加只读运行池状态与审计入口，明确其是内部运行额度而非用户钱包余额。

## 非阻塞清理

- [ ] 收敛重复的 price map 解析、JSON 属性扫描、输入 token 求和与能力键常量；本轮只在不扩大风险的前提下处理。

### 二次评审补充（来源：[`review-log.md`](review-log.md) 第 3 轮，2026-07-21）

- [ ] `overrideUserQuota` 回读确认用严格相等，回读窗口内并发真实消费会误报 mismatch（fail-closed、下轮重试，无资金风险）；可放宽为"回读值 ≥ 目标值 − 窗口容差"或重试一次再判。
- [ ] 运行池监控单次失败（网络抖动）会把 ready 覆写为 error，状态闪烁产生告警噪声；可保留上次有效水位、连续 N 次失败才降级。
- [ ] default=最贵档目前仅是运营约定（PLAN:493 上线清单勾选项），发布门禁不校验 default 与其他 tier 的价格关系；配错则缺省参数请求按低价出高档图。可在 publish-readiness 加"default ≥ 其他各档"警告级检查。
- [ ] 运行池监控对全部活跃绑定串行远端调用，用户规模增长后单轮时长线性拉长；规模化前改分页/并发或按 checkedAt 增量扫描。
