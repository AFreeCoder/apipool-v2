# 门户模型定价 测试阶段评审过程记录

- 范围：`docs/test/portal-model-pricing/` 下代码评审与修复的多轮对抗过程。正文结论态见 [`code-review.md`](code-review.md)，修复状态见 [`retest-report.md`](retest-report.md) 与 [`issues.md`](issues.md)。
- 评审对象：分支 `codex/portal-model-pricing-implementation`（评审基线 `96b2add`，修复位于其上的工作树）。

## 第 1 轮（2026-07-21，Claude 静态评审）

- 方法：11 个独立视角（逐行×2、删除行为、跨文件、包装层、语言陷阱、复用、简化、效率、层级、规范）并行扫描 `main...96b2add` diff。
- 产出：16 条 findings（CONFIRMED 10 + PLAUSIBLE 6）+ 清理项；另对 UAT 报告作范围拆分（判 P0-2/P1-1/P1-2 为范围外 pre-existing）并提出"图片计费假通过"论断。

## 第 2 轮（2026-07-21，Codex 反驳与修复）

- 撤销第 1 轮 5 条结论（SKU 缺省走 default、round-half-up、priceMatches 字段集、折扣默认 10000、LONG_METER_MAP 不映射 TTL 桶），理由为与既定设计一致。
- 反驳"b64_json 必然超限"：图片提取器在结构扫描前已剥离 b64 正文，仅长 URL 路径成立。
- 把 newapiRef 单一根因拆为三个独立问题（token 成本参照未固化 / per_call 无对账契约 / token_mismatch 实为字段别名）。
- 推翻 P0-2 的"范围外"划分：重定义为"既定阶段二需求（内部运行池）在本分支补实现"，并连带修复范围外的用量/账单页。
- 修复全部保留项，改写 code-review.md 为结论态、重写 issues.md 勾选状态、新增 retest-report.md。

## 第 3 轮（2026-07-21，Claude 二次核验裁决）

### 对撤销的裁决：5 条全部成立

| 撤销项                                            | 依据（已核原文）                                                                                                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SKU 参数缺省/auto 走 default；default 按最贵档    | DESIGN §5.2:155"default 的语义是参数缺省/auto 档"；DESIGN §9:425"门户 default 档定价方向与 newapi 兜底一致：按最贵档假设"；PLAN:493。admission 对显式完整组合查不到时确有 400 拒绝（`Object.hasOwn`），与设计红线一致 |
| 配置期折算 round-half-up                          | DESIGN §8:411"快照桥配置期折算，round-half-up 到整数 micro-USD"。第 1 轮误报（把运行期 ceilDiv 唯一舍入点的要求错套到配置期），承认失误                                                                               |
| priceMatches 不比对 admissionLongContextThreshold | PLAN E1 勘误 + PLAN:382/397：准入阈值走请求上下文目录现值、不进不可变版本，改目录即时生效无需新版本                                                                                                                   |
| discountRateBps 空 = 10000 不打折                 | DESIGN:249/416 明文默认值                                                                                                                                                                                             |
| LONG_METER_MAP 不映射 cache_write_5m/1h           | DESIGN:129 长档仅四键；DESIGN:166/175 首发 Claude 系不配长档、运营不得自配；TTL 桶与长档换价（OpenAI 1.05M 型号）在首发清单中不相交                                                                                   |

### 对反驳的裁决

- b64 反驳成立：`git show HEAD` 确认修复前 `createImageBodyExtractor` 已含 b64 剥离状态机（skippingString/awaitingB64Value，959-1042 行），DESIGN §7.6:395 亦为此设计。第 1 轮 §2 中 b64 部分为误报，仅长 URL 成立。
- "假通过"措辞校准为"覆盖不完整"：接受。UAT 短 URL/b64 路径通过是真实结果，长签名 URL 未覆盖是测试覆盖缺口而非结论造假。
- P0-2 重定义：接受。比"判为范围外"更负责的处理方式；实现未引入双余额同步，门户钱包唯一事实源边界守住。

### 对修复的核验（逐项读 diff/源码 + 亲跑门禁）

| 修复                                | 核验结果                                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server Action 序列化                | 根因确认为翻译函数 `t` 被 inline action 闭包捕获（不可序列化）；修复后 action 体内 0 处闭包 `t` 引用，改为 `getTranslations` 内部求值                                                         |
| 图片张数解析                        | `findDirectStringPropertyPresence` 只做 `skipJsonString` 字节跳过、不解码值，无长度上限；长 URL/大 b64 均可计数                                                                               |
| 0 价一致性                          | 表单（`<=0` throw）/服务（`<=0` 拒）/发布门禁（基准价与**折后价**均拦 0）三层与 DB `CHECK(>0)`、settlement 正数要求对齐                                                                       |
| 成本参照固化                        | `model_price_version` 增 `newapi_ref_rates_json/tiers_json`（0015），publish-readiness:387 从目录 source\* 换算写入，priceMatches 纳入两列比较                                                |
| per_call 对账                       | `referenceExpectedCharge` 对 default SKU 用 `newapiRefTiersJson` 自动比对；非 default 记 `ref_missing:per_call:<sku>` 不产生金额不匹配                                                        |
| reconcile 竞态                      | waived 条件更新成功才写 telemetry；settledByLog 统计补齐                                                                                                                                      |
| 运行池 ensureRuntimePoolProvisioned | 幂等标记条件 update（`isNull(provisionedAt)`）抢占；catch 分支同守卫不覆写已成功行；审计只含数字无凭据                                                                                        |
| 运行池 overrideUserQuota            | `add_quota+override` 绝对值写入；按用户加锁；**override 后回读确认**严格相等；正整数校验                                                                                                      |
| 激活门                              | `processCredential` 在 ensureBinding 后阻断：供应失败凭证不激活                                                                                                                               |
| 后台任务                            | `INVARIANT_EVERY_MS=1h` 注册 runtime_pool_monitor，`bootstrap:true` 兜底未供应绑定、无 `apply` 不自动补充；维护脚本仅认 `--apply`，未知参数拒绝                                               |
| usage 边界防御                      | `num()` 收紧为非负安全整数；`invalid_numeric:<path>` 递归标记；server_tool_use 进 chat/responses 映射集；images 双路径（JSON+multipart）转发前拒 `stream:true`；multipart 要求非空 image 文件 |
| React key                           | tier 行改稳定 `rowId`（单调计数，不含受控值）                                                                                                                                                 |
| 门禁（亲测非采信自述）              | `tsc --noEmit` 通过；`pnpm test` 811 pass / 0 fail / 1 skip                                                                                                                                   |

### 第 3 轮新发现（轻微，全部记入 issues.md 非阻塞节）

1. override 回读严格相等在回读窗口内遇并发真实消费会误报 mismatch（fail-closed、下轮重试，无资金风险）。
2. 运行池监控失败（网络抖动）把 ready 覆写为 error，产生告警闪烁，下轮自愈。
3. default=最贵档是运营约定（PLAN:493 上线清单），发布门禁不校验 default 与其他档的价格关系；配错则缺省参数请求按低价出高档图。
4. 运行池监控对全部绑定串行远端调用，用户规模大时单轮时长线性增长。

## 第 4 轮（2026-07-21，第二轮真实上游 UAT 与复核）

- Codex 在 `ac9fd81` 上执行第二轮真实上游 UAT（[`live-uat-report.md`](live-uat-report.md)，本地 New API 接 RunAPI/sub2api）：通用硬门（运行池全链路闭环）通过并勾选，固定镜像 digest 取证；图片长 URL generation/edit 真实结算通过但 b64 上游证据缺、长上下文仅完成 200-token 夹具双态，门禁 4/5 保持未勾；新增 P1×3（成本同步覆写 `source_supported_endpoint_types` 致 Embedding 公开价隐藏、`n=1` 实返 2 张按 2 张收费、`response_format=b64_json` 被静默忽略）与 P2×5（文案/缓存/可观测性）。
- Claude 复核裁决：门禁 1 勾选成立（五步链、计费核对、镜像 digest、脱敏审计齐备；唯一缺口是维护脚本检查未执行，已在勾选注记中标明生产开放不豁免）；门禁 4/5 不勾的克制正确。P1 新 #1 根因链经读码证实：`pricing-sync:414` 覆写 → `queries:311` `includes('embedding')` 启发式失效 → `requiresOutputPrice` 误判——即第 1 轮层级视角警示的 endpointTypes 子串推断脆弱性首次真实爆雷，修复应以门户自有分类/能力为事实源。issues 补两处防误读注记：门禁 1 生产观察项不随 UAT 勾选豁免；门禁 4 回链 P1 图片契约两条（仅勾门禁 4 不构成 Images 开放条件）。

## 终裁（2026-07-21，第 4 轮后更新）

- 第 1 轮 16 条中：5 条撤销成立（含 1 条 CONFIRMED 误报、4 条本就待设计确认）、1 条部分误报（b64）、其余全部确认并已修复；修复经逐项核验与门禁亲测，代码级闭环。
- 发布判定：**维持不可发布**，但性质已变——通用硬门（运行池 override 契约）已真实闭环，剩余阻断为：①P1 成本同步破坏 Embedding 公开价展示（生产定时任务必然触发，发布前必修）；②图片 `n`/`response_format` 契约两条（Images 开放前置）；③能力级门禁 2/3/5 的真实证据（luna、web search、272K+）。基础文本能力的真实调用与结算证据已齐备，待 ①修复后具备分层开放条件。
