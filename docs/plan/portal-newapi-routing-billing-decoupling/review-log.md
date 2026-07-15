# 实现计划评审往返记录

> 计划本体：[PLAN.md](PLAN.md) + tasks-01/02/03。设计基线：[../../design/portal-newapi-routing-billing-decoupling/DESIGN.md](../../design/portal-newapi-routing-billing-decoupling/DESIGN.md)。

## 第一轮：Codex 对抗式评审（2026-07-14）

Verdict: needs-attention（NO-SHIP）。10 条 findings（9 high + 1 medium）。经逐条技术核实后用户裁决处置口径：**9 条采纳（F3/F5/F8 按降级方案）、2 个子建议以违反设计 §32 减配裁决为由拒绝**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| F1 | 人工调账幂等键每请求新造 uuid，重试重复入账；审计在事务外 | 成立（真 bug：废掉了 Task 8 正确的幂等机制） | **采纳**：API 要求调用方传跨重试稳定的 `operationId`；审计并入 `applyManualAdjustment` 同一事务（`recordPortalAdminAudit` 的 `writer` 参数传 tx） | T8 / T23 / T24 |
| F2 | `wallet_ledger.user_id` ON DELETE CASCADE 违反 append-only 留痕 | 成立（照抄 credit 先例带入；与 request_ledger 不设 FK 的留痕理由自相矛盾） | **采纳**：`wallet_ledger`/`wallet_account` 的 FK 去掉 cascade（SQLite 默认 NO ACTION，删用户被资金账本挡住）；schema 守卫补"删 user 必须失败"断言 | T1 |
| F3 | cutover 子命令可跳级，legacy 下先开钱包 → 同一笔充值买两份消费 | 核心成立（设计 §13.2 原文"逐态原子推进"，计划未强制） | **降级采纳**：每子命令加前态断言（唯一允许的前置状态组合，违反 exit 78）+ finalize 前置 smoke 通过标志；"结构化证据机器解析/在途连接自动计数"超出 v1 单运营尺度，保持文件存在 + 交互确认 + runbook 人工步骤 | T27 |
| F4 | route 记录 `newapiModelId` 但 rawBody 原样转发，重映射成谎言 | 成立（设计 §2.1 只读不写 + §17 S3 模型重定向非一期，字段是给未来的，计划漏了缝隙闭合） | **采纳（评审首选项）**：v1 发布校验强制 `newapiModelId === portalModelId`，字段保留；UI 不开放输入 | T22 / T24 |
| F5 | worker 落创建时复用 `client.createKey`，其内部 `findTokenByName` 不过滤状态，轮换/恢复会收编刚退休的 disabled token | 成立（计划自相矛盾：外层全量过滤启用、内层第一页不过滤） | **采纳（评审首选项）**：worker 自建状态感知创建原语——`createTokenRaw`（纯 POST）+ 全量按名查过滤启用 + 排除已知旧 token id；**拒绝 "generation 化远端名称"**——设计 §8.1/§16① 已裁决砍掉（砍它的理由是串行无并发竞态；此处问题是历史同名冲突，状态过滤已足够解） | T12 / T14 |
| F6 | `AbortSignal.timeout(firstByte)` 并入 fetch signal，响应头后仍会掐断长 body | 成立（**真 bug**：`AbortSignal.timeout` 不可取消，>120s 的长流必被截断） | **采纳**：可 clear 的 setTimeout + 独立 AbortController，fetch resolve 后立即清除；补"响应头及时、body 超过首包阈值仍成功"测试 | T16 |
| F7 | 流式 return 时 finally 提前释放信号量/清 hardTimer；tee 慢客户端分支无界积压 | 成立（**真 bug**：`return` 触发 finally 时 body 尚未消费，maxInflight 与 hard timeout 双双失效；tee 的慢分支队列无界是 WHATWG 已知行为） | **采纳**：释放/清理移入幂等 finalize；`tee()` 换 `TransformStream` passthrough（等复杂度、天然背压、仍符合 §4.4 "透传优先+旁路提取"意图）+ gateway 目录 `\.tee\(` 零命中守卫 | T17 / T18 |
| F8 | 30s 租约执行期不续心跳，单轮远端调用轻松超期，锁形同虚设 | 机制缺陷成立 | **降级采纳**：stale 30s→5min + worker 间与逐条目穿插心跳（`keepAlive` 回调，内部 10s 节流）+ 心跳失败中止本轮；**拒绝 "fencing token / 逐项 claim"**——设计 §10.1/§32 明文减配（"单写者不需要；业务写入唯一索引本就幂等"），锁的目标是尽力单活、正确性由业务幂等兜底，残余竞态窗口已被唯一索引覆盖 | T19 / T20 / T21 |
| F9 | manual_closed 只写 resolved_at，pending_backfill 永久占槽 | 成立（且设计 §3.6 原文"resolved_at 置位释放占用"，计划落实漏了） | **采纳（评审首选项）**：manual_closed 原子迁移 `pending_backfill → failed_unbilled`（policy B 语义一致）+ resolvedAt + note + 审计；补"人工闭环后立即恢复准入"测试 | T23 |
| F10 | 对账默认 20 页截断不报告 + 水位无条件推 now，孤儿可见性静默失效 | 成立（初次 24h 回扫几乎必撞） | **采纳**：`listAllUsageLogs` 翻页到耗尽（200 页硬上限防死循环）+ 返回 `truncated` 标志；truncated 时处理已取部分但**不推水位**（下一轮重扫，幂等安全）+ 告警；fallback 逐用户满页即告警不推水位 | T12 / T21 |

**拒绝理由的引用基线**：设计 §16①（串行创建坍缩 epoch/命名/janitor 全套）、§10.1/§32（不做每任务 epoch/每行 claim；业务唯一索引幂等兜底）。两处均为七轮评审 + 过度设计专项评审后的用户裁决，本轮不重开。

处置修订已回写 PLAN.md 与三个 task 文件（2026-07-14）。

## 第二轮：Codex 对抗式评审（2026-07-14）

Verdict: needs-attention（NO-SHIP）。5 条 findings（全 high）。核实结论：**5 条全部成立、无过度评审条目**（评审两次主动声明"无需 fencing/逐行 claim"，遵守了 §32 裁决边界）；其中 R2-F2/R2-F4 是第一轮修订引入的回归/盲区。用户裁决：**5 条全部采纳**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R2-F1 | PLAN"一切以设计为准"会让执行者按 DESIGN §8.3（createKey）/§4.4（tee）原文回退，重新引入 F5/F7 | 成立（设计已冻结不可回填；subagent 执行者只见单任务+PLAN 总则，优先级矛盾真实） | **采纳**：PLAN.md 增设**设计勘误表**（E1–E6），优先级声明改为"以设计为准、勘误表除外"；不改冻结的设计文档 | PLAN |
| R2-F2 | maintenance 前态只收 legacy/maintenance，portal 故障后唯一隔离命令 exit 78——违背设计 §13.2"收敛到 maintenance" | 成立（第一轮修 F3 引入的回归） | **采纳**：maintenance 前态放开为 {legacy, maintenance, portal}（回 legacy 仍不可达）；portal 探测失败自动执行 maintenance 收敛；补两条跳转测试 | T27 |
| R2-F3 | 200 页单调用无 keepAlive；truncated 水位不动 → 窗口 >200 页时每轮重扫同一窗口、永久失活 | 成立（无自愈的结构性死锁，初次 24h 回扫/停机重启可触发） | **采纳**：client 改单页方法 `listAdminUsageLogsPage`；reconcile 改时间片驱动（≤10min/片、片内翻页到耗尽、页间 keepAlive、**每完成一片推水位到片末端**、单轮限片数可续跑）；不引入 claim | T12 / T21 |
| R2-F4 | 孤儿观测行插 request_ledger 撞 portal_key_id/route_version 等 NOT NULL——不可恢复字段只能爆炸或伪造 | 成立（第一轮处置方案的 schema 层缺陷；设计 §10.2 原文"观测行"字段集=可恢复集合，从未要求进主账本） | **采纳（评审首选项）**：新增独立观测表 `reconcile_orphan_observation`（`newapi_request_id` 唯一幂等、反查失败字段留 null、保留原始 tokenName 证据）；对账 waived 视图改双源 | T1 / T21 / T23 |
| R2-F5 | `await req.arrayBuffer()` 后才比大小，chunked/伪造 Content-Length 可绕过 25MB 硬上限 ×64 inflight → OOM | 成立（真 bug：设计 §4.3"硬上限"的本意即有界读取） | **采纳**：`readBodyBounded`——Content-Length 仅预检，`req.body.getReader()` 逐 chunk 累计、超限立即 cancel + 413；补 chunked 超限测试 | T17 |

处置修订已回写（2026-07-14）。

## 第三轮：Codex 对抗式评审（2026-07-14）

Verdict: needs-attention（NO-SHIP）。7 条 findings（全 high）。核实结论：**7 条全部成立、无过度评审条目**；R3-F1 经实读 `client.ts:1404-1409` 验证（公开 `listUsageLogs` 确实不透传 range，第三参被静默忽略）；R3-F7 实为设计基线自身不自洽（§3.3 两维 ref vs §10.4 五桶公式）。用户裁决：**7 条全部采纳**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R3-F1 | fallback 调 `listUsageLogs(creds, 100, 片区间)`，但公开方法只收 (user, limit)、不透传 range——每片读"最新首页"，水位照推 = **静默漏账** | 成立（已实读代码验证） | **采纳**：Task 12 新增 `listUserUsageLogsPage`（显式 page + Unix 秒区间，用户上下文）；Task 21 fallback 只调该方法、复用同款时间片循环；补管理员失败后跨片追平集成测试 | T12 / T21 |
| R3-F2 | 片溢出"停在片起点+告警+人工"重现 R2-F3 死锁（告警不是自愈） | 成立 | **采纳**：溢出自动**二分时间片**推回队列；片长 ≤1s 仍溢出 → 翻页到耗尽兜底（1s 内日志量物理有限）；补"超限后净进展并最终推进水位"测试 | T21 |
| R3-F3 | 信号量在读体前取得、hard timer 在准入后才启动、读体循环无超时——64 个涓流 chunked body 永久占满并发 | 成立（真实 DoS 路径） | **采纳**：hard deadline 提前到信号量取得后启动；`readBodyBounded` 复用 `streamIdleTimeoutMs`（chunk 间隔）+ `nonstreamTotalTimeoutMs`（读体总时长），超时 cancel + 408 `request_timeout`（新错误码）；不加新 env | T4 / T17 |
| R3-F4 | 非流式 `upstream.arrayBuffer()` 无上限物化，64 并发可 OOM 同进程门户 | 成立 | **采纳（评审首选项）**：非流式 2xx 统一走 TransformStream 管道（删 arrayBuffer 分支，代码更少）——内存有界于 extractor 窗口，超窗自动降级 pending_backfill 回填（既有语义） | T17 |
| R3-F5 | `void pipeTo().then(async finalize)` 无人接管——settle 遇 SQLite busy = unhandled rejection **杀进程**；`finalized` 已置位不再重试、账本停 open 占槽 | 成立（最严重） | **采纳**：finalize 账本逻辑 try/catch 全包 + 一次有界重试 + 告警；**sweeper 即最终恢复队列**（open 超时→pending_backfill 既有机制），不新建队列；pipeTo 链补 `.catch` 兜底；补 DB busy 故障注入测试 | T17 / T18 |
| R3-F6 | activate-wallet 两次独立写非原子，半状态（ledger=true/display=false）卡死重跑却放行 portal；portal 前态未查 display/checkout | 成立 | **采纳**：多开关**批量原子写**（tmp 上多轮替换、单次 install）；activate-wallet 幂等收敛半状态（重新确认证据后补齐）；portal 前态查全四开关；补写入中断恢复测试 | T27 |
| R3-F7 | `model_price_version` 仅两维 New API ref，§10.4 公式要五桶×ref——cache 参照读活表 = 假 matched/假 mismatch | 成立（设计基线自身缺口，记勘误 E7） | **采纳**：ref 快照补齐五维（+3 可空 cache ref 列，发布事务从 catalog base×ratio 锁定）；对账只读版本快照，ref 缺维且对应桶非零 → 跳过外部核对（防御，v1 发布校验保证五维齐）；补"发布后改 catalog 基准价、历史重算不变"测试 | T1 / T21 / T22 |

处置修订已回写（2026-07-14）。

## 第四轮：Codex 对抗式评审（2026-07-14）

Verdict: needs-attention（NO-SHIP）。5 条 findings（全 high）。核实结论：5 条问题全部成立；**R4-F1 的推荐解法（持久化 finalize 意图）踩到设计 §0#6 明文删除的 dispatch marker 减配**，按降级方案处置。用户裁决：**4 条采纳、R4-F1 降级采纳**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R4-F1 | 流中断 + finalize 双次 DB busy → open 残留 → sweeper 转 pending_backfill → 回填按日志结算 = 对用户失败的请求被错扣（违反 policy B） | 链条成立；但错扣需"中断 ∧ **单条 UPDATE** 连续失败"（busy 敏感的是多语句结算事务，中断路径只写一条条件 UPDATE），窗口极窄 | **降级采纳**：finalize 终态写入重试 1 次 → **3 次退避**（100ms/500ms/2s，单写者 WAL 下单条 UPDATE 三连失败不现实）+ 故障注入测试断言"中断+双 busy+日志有 usage → 三次内收敛 failed_unbilled、零扣费" + 三连失败残余窗口记 issues.md（与设计 §10.2"open 命中日志走结算"的既有近似同源，可对账发现并冲正）；**拒绝持久化意图 marker**——设计 §0#6 明文删除 dispatch marker（用户裁决的 v1 精简） | T17 / T18 / T28 |
| R4-F2 | 价格版本 ref 用门户分组行倍率，路由可指向另一 New API 分组——方向门禁被重映射绕过、历史对账参照错绑 | 成立（设计缺口：§5.3 说"目标分组"但数据流未闭环，记勘误 **E8**） | **采纳（互锁形态）**：价格发布按 **active route 目标分组**（无则 catalog_group 默认）从 `getPricingSnapshot().groupRatios[目标分组]` 取倍率，新增 `model_price_version.ref_newapi_group` 列记录参照分组；路由发布目标分组变化 → 按新倍率重算 active price 方向校验，不过则拒绝（提示先重发价格）；补两模型不同倍率分组门禁测试 | T1 / T22 |
| R4-F3 | `readBodyBounded` 实现骨架仍是 R2-F5 时的两参无超时版（R3-F3 只改了调用处漏改骨架），按骨架实现会重现慢体 DoS | 成立（已实读 tasks-02:656 确认，纯文档内部矛盾） | **采纳**：骨架同步改写——三参（idleMs/totalMs/signal）+ 每次 read 竞速可清理计时器 + signal abort 监听 + 超时/中止 cancel reader + 返回 over_limit/timeout 分类、全路径清理计时器 | T17 |
| R4-F4 | overlap 首片完成即写 `watermark=片末端`，低于旧水位 → 中断后下轮更早重扫、反复中断单调倒退 | 成立（扫描游标与高水位混用） | **采纳**：持久化 `max(旧水位, 片末端)`——overlap 子片只做幂等重扫、永不倒退水位；补"overlap 二分后 keepAlive=false"单调性测试 | T21 |
| R4-F5 | activate-wallet 写文件与 recreate 之间崩溃 → 文件全 true 但容器旧值；重跑判"已全激活"跳过 recreate、portal 只读文件 → 切流到开关未生效的容器 | 成立 | **采纳**：已全激活分支**仍幂等执行 recreate**（compose up -d 天然幂等）+ `docker compose exec printenv` 断言容器内两键实际值；portal 前态同款运行态验证；补"写文件后、recreate 前崩溃"恢复测试。不建健康标记系统（v1 尺度） | T27 |

处置修订已回写（2026-07-14）。

## 第五轮：Codex 对抗式评审（2026-07-14）

Verdict: needs-attention（NO-SHIP）。7 条 findings（全 high；评审确认 R4-F3/F4/F5 修订已闭环）。核实结论：**7 条全部成立、无过度评审、无踩裁决区**——R5-F1/F2 是第四轮修订不彻底被追出，R5-F3 是协议级真 bug（Anthropic `message_start` 的占位 usage）。用户裁决：**7 条全部采纳**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R5-F1 | R4-F2 半闭环：切组时"先重发价格"不可执行（价格发布按当前 route 取分组=鸡生蛋），校验通过路径留下 ref=A、route=B 错绑 | 成立 | **采纳（重映射原子双发）**：目标分组 ≠ active price 的 `refNewapiGroup` 时，`publishModelRoute` **必须携带新五维价格**，同一事务原子完成 retire/insert 价格(refB) + retire/insert 路由(B)；同分组独立发布不变；`resolveActiveRoute` 加 fail-closed 断言 `route.newapiGroup === price.refNewapiGroup`（不一致 → 404+告警，封并发窗口） | T15 / T22 |
| R5-F2 | 三次退避只包 2xx finalize——非 2xx/无响应分支裸调一次 `markFailedUnbilled`；`requestIdCaptured` 看响应头而非 DB 写结果，capture 失败被忽略 | 成立 | **采纳**：抽公共原语 `persistTerminal`（3 次退避）覆盖**全部**准入后终态写（capture/failed/pending/settle）；`captureRequestId` 不再吞 DB 异常（唯一冲突→false 不可重试，异常上抛由原语重试）；`requestIdCaptured` 以 capture 持久化结果为准，失败按 failed_unbilled；补"500+id+busy"与"capture busy 后成功响应"故障注入 | T9 / T17 / T18 |
| R5-F3 | `finish()` 非空即结算，忽略完整性——Messages `message_start` 含占位 usage，delta 前中断 → 截断响应被按部分桶扣费（设计 §4.3 原文"完整 usage"） | 成立（协议级真 bug；T18 场景 14 固化了错误） | **采纳**：extractor 返回 `{ usage, complete }` 协议级完整标志（Chat=含 usage 末尾 chunk、Responses=`response.completed`、Messages=**见过 `message_delta.usage`**、非流式=子树提取成功）；不完整一律 `failed_unbilled`；改写场景 14 + 补 start 后/delta 后两个中断测试 | T7 / T17 / T18 |
| R5-F4 | 响应头后、首 chunk 前无任何活动计时器（首包已清、idle 未启、非流式 total 只有注释）→ 零 chunk 响应占满并发到 1h hard | 成立 | **采纳**：进入 pipeTo 前立即启动 idle（流式）/total（非流式）计时器，idle 随 chunk 重置，cleanup 统一清除；补"响应头后零 chunk"与"非流式涓流"测试 | T17 / T18 |
| R5-F5 | maintenance 写 env 后、recreate/recaddy/探测前崩溃 → 文件=maintenance 但 Caddy 仍 legacy，activate-wallet 只读文件即放行 → 旧数据面接单时激活钱包 | 成立（与 R4-F5 同构，API_MODE 维度） | **采纳**：`activate-wallet` 与 `portal` 前态追加**实时 503/404 双探测**（复用 probe），失败拒绝并提示重跑 maintenance；补"写 env 后被 kill"恢复测试 | T27 |
| R5-F6 | 幂等 readBack 只按键查、不核对载荷——同 operationId 误用于不同用户/金额时谎报 alreadyApplied，资金操作静默丢失 | 成立 | **采纳**：readBack 命中后比对规范化载荷（userId/金额/reason/operator），不一致抛 `idempotency_conflict`（API 层 409 语义）；补不同用户/金额/并发冲突测试 | T8 / T23 |
| R5-F7 | `resolveActiveRoute` 骨架只查 `status.isCallable`，漏 vendor/group/category 全 active + active capability——运营紧急下线后模型仍可调仍计费 | 成立（骨架与规格文字不符） | **采纳**：api-catalog 抽共享 callable 谓词（完整 join，单一实现），gateway/`getCallableModelIds`/公开目录三处复用、禁止重写；补五个维度失活的列表+转发双拒绝测试 | T15 / T25 |

处置修订已回写（2026-07-14）。

## 第六轮：Codex 对抗式评审（2026-07-14）

Verdict: needs-attention（NO-SHIP）。5 条 findings（4 high + 1 medium；评审确认第五轮完整 usage/实时隔离/幂等载荷/callable 约束已闭环）。核实结论：4 条 high 成立采纳；**R6-F5 降级**——评审给的两条替代路径（failed_unbilled=协议演进期全免单、pending_backfill=回填同样不识新维度）都比现状损失更大，且现状正是设计 §5.1 "宁少勿错、靠对账发现"原意。

> **甄别标准补充（用户裁决 2026-07-14）**：自本轮起，接纳评审意见增加**项目阶段校准**维度——项目未正式上线、无真实用户流量，findings 按"当前阶段真实暴露度 × 修复成本比"甄别，防止以成熟产品标准要求 pre-launch 项目；上线即暴露的攻击面仍修，规模化/多管理员并发类场景优先记 issues 延后。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R6-F1 | 重复 model 键 / `\u` 转义键使计费模型与上游执行模型分叉（Go 后值覆盖），高价模型可按低价调用 | 成立（上线即暴露的计费绕过攻击面；转义逃逸也实核为真——readJsonString 不解码 `\uXXXX`） | **采纳**：`readJsonString` 规范解码 JSON 转义；`extractTopLevelModel` **全量扫描**（body 已在内存、线性无放大）、顶层 model 恰好一个否则拒绝；新错误码 `invalid_request`(400)；对账用量层补 `log.model_name == ledger.newapi_model_id` 一致性核对 | T4 / T7 / T17 / T21 |
| R6-F2 | 发布事务无内部 CAS——独立价格发布与 A→B 重映射并发交错可产生 route=B/price(ref=A)（fail-closed 只保不资损，模型持续 404） | 成立（单运营下概率低——UI 双开标签页可踩；修复是既有条件 UPDATE 范式、成本极低，按阶段校准仍值得顺手修） | **采纳**：发布事务内按事务前捕获的 active ID 条件 retire（`WHERE id=:captured AND status='active'`），affected 不符整体回滚返回"配置已变更请重试"；补并发交错测试 | T22 |
| R6-F3 | 非 2xx 透传在 cleanup 之后 return——500 头后停顿的 body 无计时器、槽已释放，可重复触发耗尽连接 | 成立 | **采纳**：**所有带 body 的上游响应统一走受控管道**（非 2xx 的 finalize 退化为纯 cleanup，账本已在 return 前写好）；401/403 被替换为网关错误体时显式 `upstream.body.cancel()`；补"500 头后零 chunk"测试 | T17 / T18 |
| R6-F4 | `install` 是复制非 rename——中断可截断 `.env.deploy`，而 configure-caddy 对缺失 API_MODE **默认 legacy** = 损坏文件静默重开 newapi 后门 | 成立（后果链比评审所述更重） | **采纳**：同目录 mktemp + 完整写入 + chmod + `sync` + `mv -f`（rename 原子）；cutover `require_state` 读到空值一律 exit 78（不沿用 legacy 默认）；测试断言实现用 mv 且无 install | T27 |
| R6-F5 | unmapped 非零维度仍结算已知桶并永久 settled，协议演进期系统性少计费 | 批评成立但替代路径更糟（failed=全免单；pending 回填同样不识新维度、殊途同归） | **降级采纳**：维持 settle 行为（= 设计 §5.1 "靠对账发现"原意，差额经 amount_mismatch 浮现 + manual_adjustment 可补）；补强可见性——`unmapped_usage_dimension` 进告警最小集、补"未知维度必产生 amount_mismatch 可见"测试、issues.md 记录权衡与恢复路径 | T17 / T21 / T28 |

处置修订已回写（2026-07-14）。

## 第七轮：Codex 对抗式评审（2026-07-15）

Verdict: needs-attention（NO-SHIP）。6 条 findings（5 high + 1 medium；评审确认 R6-F2/F3/F5 闭环、R6-F1 计费语义已补齐）。**评审已遵守阶段校准**（R7-F5 主动声明"单 Key 可触发、非规模化问题"，只一条列 medium，未重开任何裁决）。核实结论：6 条全部成立、无过度评审；其中 R7-F1/F4 是前几轮处置新引入、R7-F5 是 R6-F1 改全量扫描的副作用。用户裁决：**6 条全部采纳**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R7-F1 | `buildUpstreamHeaders` 白名单透传漏 `Sec-WebSocket-Protocol`——New API TokenAuth 从中提取 `openai-insecure-api-key` 覆盖注入的运行 Key（实测上游行为，带源码行号），击穿决策 6 凭证全剥离 | 成立（最隐蔽；上线即暴露） | **采纳**：`sec-websocket-protocol` 加入 `CREDENTIAL_HEADERS` 剥离集；补恶意备用凭证覆盖测试（断言到达 mock 上游零残留） | T6 |
| R7-F2 | 非流式提取器"任意深度首个 usage"——Messages 用户可控 `tool_use.input` 内塞低值 usage 先于真实 usage 命中 complete → 高成本请求按最低金额结算 | 成立（计费伪造攻击面；tool input schema 是可控输入） | **采纳**：非流式提取器接 `endpoint` 参数，只认协议**根级** usage 路径（chat/embeddings=顶层 `usage`；responses=顶层 `usage` 或 `response.usage`；messages=顶层 `usage`）；非根级命中/结构异常 → pending_backfill（日志回填走 New API 权威 usage，绕开伪造）；补 `tool_use.input.usage` 前置测试 | T7 / T17 |
| R7-F3 | `deploy.sh:41-48` 每次普通部署直连 configure-caddy 不过 `require_state`——缺失 API_MODE 默认 legacy = 静默重开直连后门；R6-F4 只护了 cutover 一半 | 成立（比评审所述更该修——是 R6-F4 修复不彻底的证明） | **采纳**：防线下沉到 configure-caddy 本身——生产态缺失/空 API_MODE 直接 exit 78（不再默认 legacy）；首次部署模板显式写 `APIPOOL_API_MODE=legacy`；deploy-automation 测试改"显式 legacy 成功、缺失零副作用失败" | T26 |
| R7-F4 | 加 `newWalletRecharge` 时漏改 `order.ts:221` 早退条件——wallet-only 充值（无 credit/subscription）走单表 update 跳过事务体，订单 PAID 但钱包流水全丢 | 成立（真 bug，会让 wallet 激活当天充值全部丢账） | **采纳**：早退条件补 `&& !newWalletRecharge`、结果类型同步；补 wallet-only 事务路径 + PAID 重放测试 | T11 |
| R7-F5 | R6-F1 改全量扫描的副作用：移除 256KB 窗口 + TextDecoder 全量字符串 → 64×25MB×(bytes+UTF-16) 可上 GiB，单 Key 触发 OOM 同进程门户 | 成立（评审判定"非规模化、单 Key 可触发"，正确） | **采纳**：`extractTopLevelModel` 改**字节级状态扫描**（直接在 Uint8Array 上按 UTF-8 找 `"model"` 键、转义在字节层解码），不物化完整字符串——保留恰一键+转义解码语义、峰值降常量级；补近上限并发内存预算测试 | T7 |
| R7-F6 | 信号量 module-level，handler 取槽后大段可抛错逻辑无外层 catch——异常泄漏槽 + 留 open 账本，Next 错误边界回收不了进程内计数 | 成立（medium：全程未覆盖的兜底路径） | **采纳**：外层 try/catch + `bodyOwnershipTransferred` 标志——管道接管前异常统一 cleanup + persistTerminal 收束账本，接管后交 finalize；补鉴权/路由/准入/转发阶段异常注入测试 | T17 / T18 |

处置修订已回写（2026-07-15）。

## 第八轮：Codex 对抗式评审（2026-07-15）

Verdict: needs-attention（NO-GO）。2 条 findings（1 high + 1 medium；评审确认第七轮 6 项中 4 项已闭环、"其余四项未发现新的实质性阻塞"）。收敛显著（findings 数 10→5→7→5→7→5→6→2）。核实结论：2 条全部成立、均为第七轮修订自身未尽收尾、无过度评审（评审遵守阶段校准、第二条列 medium）。用户裁决口径：**2 条全部采纳**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R8-F1 | R7-F5 半闭环：`readJsonStringBytes` 被主循环对每个字符串调用且无差别累积每个字节——25MB 单个 content 串仍物化成 number[]+Uint8Array，单 Key ×64 并发可 OOM 同进程门户 | 成立（上线即暴露的单 Key OOM，阶段校准=必修） | **采纳**：改零分配扫描——非候选字符串只做转义感知边界跳过（不累积字节）、只对顶层候选键名有界比较、model 值设 512B 明确上限（超限 malformed）；Task 18 补单个近 25MB 字符串紧堆 + 准入前并发内存测试 | T7 / T18 |
| R8-F2 | R7-F3 逃生口过宽：server-bootstrap 无条件设 `APIPOOL_ALLOW_MISSING_API_MODE=1`，而 runbook 允许重跑 bootstrap 对齐环境——portal 切流后状态行损坏时重跑会把空值当 legacy 重开后门，抵消 R7-F3 | 成立（常规运维即可触发的后门重开路径） | **采纳**：删掉 bypass 变量；bootstrap 首次初始化原子写显式 `APIPOOL_API_MODE=legacy`（仅 `.env.deploy` 不存在时写、已存在不动）；configure-caddy 回到"生产态空值一律 exit 78、无逃生口"；补"portal 后删 API_MODE 再跑 bootstrap 必须失败且不改 Caddy"回归测试 | T26 |

处置修订已回写（2026-07-15）。

## 第九轮：Codex 对抗式评审（2026-07-15）

Verdict: needs-attention（NO-GO）。2 条 findings（1 high + 1 medium）——均为第八轮两条修订的收尾漏洞（loop-until-dry 尾部），修复均简化代码。用户裁决：**2 条全部采纳**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R9-F1 | R8-F1 仍留洞：保留 `found: string[]` 收集全部顶层 model 值（各 ≤512B）、扫描后才判重——25MB body 塞满 `"model":"x"` 可 2M 次命中 × 分配 × 64 并发 → GC 风暴/OOM | 成立（单 Key OOM 残余路径） | **采纳**：只存第一个 model 值、遇第二个顶层 model 立即返回 ambiguous、不建数组（更简单）；Task 18 补重复 model 键紧堆并发测试 | T7 / T18 |
| R9-F2 | R8-F2 自相矛盾：主文"仅文件不存在时写 legacy"，细节/测试 255 却"缺行就 grep||追加 legacy"——后者给损坏态补 legacy 重开后门、与测试 256 冲突 | 成立（文档内部矛盾 = 实现会选错分支重开后门） | **采纳**：统一到文件级——仅 `.env.deploy` 文件整体不存在时原子创建写 legacy；文件已存在但 API_MODE 缺失/空/非法 → 绝不修复、configure-caddy exit 78；改写测试 255、保留 256 | T26 |

处置修订已回写（2026-07-15）。

## 第十轮：Codex 对抗式评审（2026-07-15）

Verdict: needs-attention（NO-GO）。1 条 finding（high；R9-F1 确认闭环）。收敛到单条。核实结论：成立、非过度评审——R7-F3/R9-F2 修复链最后盲区。用户裁决：**采纳**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R10-F1 | configure-caddy 骨架 `API_MODE="${APIPOOL_API_MODE:-$(read_env_value ...)}"` 仍 env 优先——deploy/bootstrap 继承进程环境，shell 残留/导出的 legacy 会盖过文件 portal 值 → 重开直连后门，绕过钱包计费 | 成立（文件级 fail-closed 被 env 优先旁路；沿袭既有 APIPOOL_API_UPSTREAM 的 env-first 范式盲区） | **采纳**：API_MODE **只从 .env.deploy 读**（单一事实源）；若 env 也设了且与文件值不符 → 硬 exit 78（操作员混淆 fail-loud）；补 file=portal/env=legacy、缺行/env=legacy 两个零副作用失败测试 + 覆盖 deploy/bootstrap 调用链；三态 print-config 测试改经临时 .env.deploy 注入（不再走 env） | T26 |

处置修订已回写（2026-07-15）。

## 第十一轮：Codex 对抗式评审（2026-07-15）

Verdict: needs-attention（NO-GO）。1 条 finding（medium；R10-F1 确认闭环、无 env 旁路）。核实结论：成立、非过度评审——是 Caddy 三态改造引入的确定性部署期卡死（符合 Caddy 固定指令顺序 basic_auth 先于 handle）。用户裁决：**采纳**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R11-F1 | newapi vhost 的 `/v1* → 404` 靠文本位置排在 `$newapi_guards` 前，但 Caddy 按固定指令顺序 `basic_auth` 先于 `handle` 执行——Basic Auth 部署下无凭据探测 `newapi/v1/models` 得 401 而非门禁要求的 404，切流状态机每个门禁被顶死无法推进；字符串级 fixture 测不出运行语义 | 成立（确定性部署期卡死，仓库生产文档明确用 Basic Auth） | **采纳**：记勘误 **E9**；newapi vhost 改两个互斥 `handle`——`handle /v1*` 固定 404（无 auth）、无 matcher fallback `handle` 内放 basic_auth/IP guard + 反代；测试升级为真实 `caddy adapt` 断言（Basic Auth 启用时 `/v1/models` 带/不带凭据均 404、管理路径未认证仍 401，不放宽门禁接受 401） | PLAN(E9) / T26 |

处置修订已回写（2026-07-15）。

## 第十二轮：Codex 对抗式评审（2026-07-15）

Verdict: needs-attention（NO-GO）。1 条 finding（medium；R11-F1 两互斥 handle 结构确认正确）。核实结论：成立、非过度评审——两 handle 结构对，但我的 shell 拼装有换行 bug（命令替换吞尾换行）。用户裁决：**采纳**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R12-F1 | `$(printf\|sed)` 生成 `newapi_guards_indented` 确定性吞尾换行 → guards 末行与 reverse_proxy 挤同行（`}\t\treverse_proxy`）→ 非空 guards 的 Caddyfile 非法、`caddy validate` 失败保留旧路由、切流卡死；且我加的 caddy adapt 测试在无 caddy 的 CI 里 skip、默认 CI 发现不了 | 成立（切流执行阻断；对文档支持的 Basic Auth 模式产出非法配置） | **采纳**：① guards 拼装不依赖尾换行——非空时显式补回换行、`reverse_proxy` 独占一行；② CI（mvp-verify/docker-build）固定装 caddy，三种 guards 配置（空/basic_auth/IP）强制跑真实 `caddy adapt`+`caddy validate`，缺二进制时 release gate **失败而非 skip** | T26 |

处置修订已回写（2026-07-15）。

## 第十三轮：Codex 对抗式评审（2026-07-15）

Verdict: needs-attention（NO-GO）。1 条 finding（high；R12-F1 Caddy 确认闭环）。核实结论：成立、非过度评审——单 Key 聚合内存 OOM 是新面（前几轮只做了 model 扫描零分配、未覆盖 body 缓冲本身），评审明确要求 v1 简化不恢复双预算。用户裁决：**采纳**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R13-F1 | 内存上限=MAX_INFLIGHT×MAX_BODY_BYTES=64×25MB；readBodyBounded 用 chunks[]+末尾等尺寸 Uint8Array（拷贝瞬间双份 ~50MB/请求），全在 admitRequest 之前——单个有余额 Key 可 OOM 同进程门户+网关 | 成立（单个已鉴权 Key 触发的进程级 OOM，上线即暴露） | **采纳（v1 简化，不恢复双预算）**：① readBodyBounded 单块有界写入——合法 Content-Length 时按声明一次精确分配填充（消除双拷贝、覆盖多数大请求），仅 chunked 无 CL 回退 chunks+concat；② `GATEWAY_MAX_INFLIGHT` 默认 64→16 + env 表注明"内存上限=两者乘积、按 VPS 调"；③ Task 18 压测固定覆盖默认并发+最大 body、断言 RSS/heapUsed/external 峰值 | PLAN / T17 / T18 |

处置修订已回写（2026-07-15）。

## 第十四轮：Codex 对抗式评审（2026-07-15）

Verdict: needs-attention（NO-GO）。2 条 findings（1 high + 1 medium）。核实结论：2 条全部成立、无过度评审——R14-F1 是 R13 修复自带的 bug（Number(null)===0 陷阱 + 无 CL 回退的内存洞），R14-F2 是简化 cutover 时漏实现的设计 §461 门禁。用户裁决：**采纳**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R14-F1 | R13 读体两 bug：① `Number(null)===0` → 缺 CL 头建零长 single、首个 chunk 即误拒，chunked 回退不可达；② 只补 null 判定则无 CL 走 chunks+concat=双份 800MB（非声明 400MB）；Task 18 只测有 CL、无数值阈值 | 成立（我引入的真 bug，单 Key OOM 未真正闭环） | **采纳**：修 CL 检测（`rawCL===null` 分支）+ **两路径统一单块缓冲**（有 CL 按声明精确分配、无 CL 分配 maxBytes 填充后 subarray）——内存上限恒 inflight×maxBytes；Task 18 补无 CL 正常/超限取消/16×25MB 无 CL 同步屏障压测 + rss/heapUsed/external 明确数值阈值 | T17 / T18 |
| R14-F2 | 漏设计 §461 门禁：activate-wallet 只切开关+运行态校验、smoke 只覆盖推理扣费+manual_adjustment，不走支付回调→PAID→recharge 流水→停写 credit——webhook/wallet-only 事务(R7-F4 类)/美分换算 bug 会全门禁通过并开放 checkout，首笔真实付款 PAID 却无可消费余额 | 成立（开放收款前的设计基线门禁，非可延后） | **采纳**：activate-wallet 与 portal 间加受控首笔充值双写 smoke（断言 order PAID、order_no 恰一条 recharge、美分换算正确、零 credit、余额守恒、重放幂等）；标志绑定当前发布、portal/finalize 强制校验；测试后带审计调账冲回 | T27 |

处置修订已回写（2026-07-15）。

## 第十五轮：Codex 对抗式评审（2026-07-15）

Verdict: needs-attention（NO-GO）。1 条 finding（high；readBodyBounded 确认闭环）。核实结论：成立、非过度评审——每次发布都动真钱路径、从第一个付费用户起成立，仓库本有"部署后 live-smoke"既有实践，非规模化顾虑。用户裁决：**采纳（按阶段校准取轻量 fail-closed 版）**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R15-F1 | 充值 smoke 门禁只在 cutover.sh portal/finalize（一次性）；go-live 后常规 `deploy.sh <新tag>` 换镜像不重跑、标志绑旧版本 → 回归 recharge 路径(R7-F4 类)的新镜像直接接真实支付、订单 PAID 但钱包不入账 | 成立（每次发布动真钱路径，非可延后） | **采纳（轻量 fail-closed，不做每次部署完整 maintenance 循环）**：`deploy.sh` 增部署后门禁——若 portal 态且 checkout 已开，重建后跑新镜像 recharge smoke：成功刷新 `.cutover-recharge-ok`（绑新 IMAGE_TAG）；失败则 `set APIPOOL_CHECKOUT_ENABLED=false` 冻结 checkout + 告警（不留开放）；补"portal+checkout=true、旧标志、发布新 tag、smoke 失败 → checkout 冻结"回归测试 | T27 |

处置修订已回写（2026-07-15）。

## 第十六轮：Codex 对抗式评审（2026-07-15）

Verdict: needs-attention（NO-GO）。1 条 finding（high）——R15-F1 修复的两个 fail-open 漏洞。核实结论：成立、非过度评审（评审明确"从首个真实支付用户起成立"）。用户裁决：**采纳（共享单发布门控信号，不做重状态机）**。

| # | Finding | 核实 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R16-F1 | R15 门禁两个 fail-open：① `checkoutEnabled()` 是 `!==false`——缺失/空/非法值判为开、与门禁 `="true"` 不一致→缺失值时门禁跳过但收款开放；② 只门控 checkout 创建，`notify/callback` 的 `handleCheckoutSuccess`（PAID→wallet 双写）不看开关→冻结前已建会话回调仍在不可信新镜像结算；③ smoke 在容器替换后才跑，替换→smoke 窗口内新镜像已对外 checkout=true | 成立（从首个真实支付用户成立） | **采纳**：① `checkoutEnabled()` 统一 fail-closed（仅精确 `true` 开、缺失/空/非法关）；② deploy.sh 冻结在前替换在后（portal+checkout 路径先冻再换、smoke 过才重开）；③ `handleCheckoutSuccess` wallet 双写分支同受 `checkoutEnabled()` 门控——冻结时订单仍 PAID（不丢 webhook）、wallet recharge 延后，由 reconcile "PAID 订单缺 recharge 流水→按 order_no 幂等补入"重新应用（复用 reconcile_worker）；补 smoke 窗口回调/冻结后 webhook/缺失-非法 checkout 值三回归测试 | T3 / T11 / T21 / T27 |

处置修订已回写（2026-07-15）。

## 第十七轮：Codex 对抗式评审（2026-07-15）

Verdict: needs-attention（NO-GO）。3 条 findings（全 high）——**全部由第十六轮修复自身造成**。核实结论：R16 的"结算共享门控 + 延后 + reconcile 补入"三件套是过度设计，衍生 3 个新 high。按 receiving-code-review 纪律（一修复衍生多问题→重审修复本身）+ 阶段校准，**回退 R16 过度部分**而非再打补丁。用户裁决：**采纳（回退）**。

| # | Finding | 根因 | 处置 | 落点 |
| --- | --- | --- | --- | --- |
| R17-F1 | 冻结态 smoke 必然失败：先写 checkout=false 再跑调 handleCheckoutSuccess 的 smoke，但 R16 让 wallet recharge 仅在 checkoutEnabled() 为 true 时生成→smoke 第三断言失败、首切无法进 portal、常规发布固定 exit75 | R16② 过度设计 | **回退 R16②**：撤"wallet 双写受 checkoutEnabled 门控"——recharge 路径不受该开关约束、smoke 正常跑 | T11 |
| R17-F2 | reconcile 补入仅 gated on WALLET_LEDGER_WRITE_ENABLED：新容器首轮 tick（checkout 仍 false、smoke 未过）就在未验证镜像写真钱；且误命中钱包激活前 PAID 订单（本有 credit/远端加额）→双重权益、违反"存量用 manual_adjustment 不伪造 recharge" | R16③ 过度设计 | **回退 R16③**：撤 reconcile 幂等补入检查（不再需要——无延后） | T21 |
| R17-F3 | 冻结回调早退跳过远端充值：walletEnabled ∧ checkout=false 时 newCredit/newWalletRecharge 都空→走早退裸订单行→applyApipoolRecharge 不执行→apipool_ledger_entry/远端加额永久缺失 | R16② 的连带 | **随 R16② 回退消失**：一次性订单不再因冻结走早退，applyApipoolRecharge 照常 | T11 |

**保留 R16 正确部分**：`checkoutEnabled()` fail-closed（门控创建）+ deploy.sh 冻结在前替换在后 smoke 过才重开（门控发布）。**残留已知局限**：换镜像前已建在途会话的 webhook 可能在"新镜像 smoke 未过"数秒窗口结算一笔——钱包不变量自检兜底可见 + 人工冲正，秒级窗口、pre-launch 低量可接受（记 issues.md）。

处置修订已回写（2026-07-15）。

## 第十八轮：Codex 对抗式评审（2026-07-15）—— **GO**

Verdict: **approve**。No material findings。第十七轮回退已闭环：Task 11 结算仅受 walletEnabled 控制并保留远端充值、Task 21 已删 reconcile 补入、Task 27 保留 checkout 创建 fail-closed + 换镜像冻结创建 + recharge smoke 过才重开；在途 webhook 秒级窗口按已裁决局限处理。

**评审收口。** 十八轮对抗式评审（10+5+7+5+7+5+6+2+2+1+1+1+1+2+1+1+3+GO），全部 findings 逐条闭环或按用户裁决口径处置（含项目阶段校准防过度评审、多处减配裁决拒绝、第十七轮一次过度设计回退）。下一步：按计划进入实施，Task 11/21/27 回归测试作为合并与发布门禁。
