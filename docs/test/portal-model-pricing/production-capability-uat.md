# 门户模型能力生产验收

- 测试日期：2026-07-22
- Portal 基线：`0f0b95d22d0d8a2c110911eaceceed3b5ed788c5`
- Portal 镜像：`sha256:8a703333456530e5420f0326a5f08ffa42189aa981877640e0c8b3b484f23efe`
- New API 基线：`8edbe5073be3ea27eb093653ec36c1867bbf21bd`
- New API 镜像：`sha256:38ab0c6de409859e8720158f5aa4a851c81e3d2f108921d9b048439cdc5823eb`
- 测试方式：生产管理台配置、服务器内真实 API 调用、Portal/New API 数据库与日志脱敏核对

## 结论

**本轮部分通过。**

1. `gpt-5.6-luna` 完整 token meter 真实调用通过，可以关闭对应能力级门禁。
2. 真实 272K+ 长上下文关闭/开启双态通过，可以关闭对应能力级门禁。
3. Images 的真实上游调用能够在生产 New API 完成，但本轮客户端超时早于上游响应，未取得 `b64_json`/URL 响应形态，Images 门禁保持未完成。
4. Images 售卖项已恢复为 `Retired`，当前隐藏且不可调用；Embedding 与 web search 未在本轮验证，既有门禁不变。

## 环境恢复边界

测试开始前，生产环境已从清理前备份中最小恢复一个可使用密码登录的既有管理员身份。只恢复登录用户、credential account、`super_admin` 角色和零余额钱包；未恢复 New API 用户绑定、旧版 Key、Portal API Key 或运行池凭据。恢复前另做 Portal/New API 数据库备份，恢复后数据库完整性检查通过，浏览器登录通过。

根因不是密码错误：此前清理保留了另一个 `super_admin`，但剩余账号只有 GitHub 登录方式；被删除的账号才是当时唯一可使用邮箱密码登录的管理员。本轮未恢复其历史业务数据。

## `gpt-5.6-luna` 配置与普通档验收

管理台按 PLAN 配置并发布：

- 普通档：`input=1`、`cached_input=0.1`、`cache_write=6.25`、`output=6` 美元/1M tokens。
- 长档阈值：272,000 tokens。
- 长档：`input_long=2`、`cached_input_long=0.2`、`cache_write_long=12.5`、`output_long=9` 美元/1M tokens。
- 能力声明：缓存读、缓存写、长上下文；New API 端点参照为 OpenAI Chat/Responses。
- 售卖分组：`codex-discount` → New API `codex特惠`。

服务器内 smoke bundle 使用固定合成用户执行 Chat、Responses、Messages 及流式请求，5/5 真实调用完成结算。脚本同时验证：临时 Portal Key 只保存哈希、请求关联真实 New API 日志、使用 `rk_` 运行凭证、每笔只有一条钱包扣费、`charged` 等于不可变价格版本手算值；结束后 Key 已禁用、钱包余额已恢复。

代表性普通档账本如下：

| 端点 | 非缓存输入 | 缓存读 | 缓存写 | 输出 | `charged`（micro-USD） | 手算 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Messages | 4,384 | 3,840 | 0 | 5 | 4,798 | `4384×1 + 3840×0.1 + 5×6 = 4798` |
| Responses | 544 | 3,840 | 0 | 5 | 958 | `544×1 + 3840×0.1 + 5×6 = 958` |
| Chat Completions | 4,384 | 0 | 0 | 5 | 4,414 | `4384×1 + 5×6 = 4414` |

真实订阅池上游仍返回 `cache_write=0`，本轮据实记 0，没有用合成 fixture 冒充非零用量。目录继续保留 PLAN 要求的 cache write 售价；这与 DESIGN O13“当前渠道字段缺失或恒 0 时数量自然为 0，换渠道后无需改配置即可生效”的既定裁决一致。

Messages 兼容端点额外出现 `unmapped_struct:billing_usage` 观察标记，但标准 usage meter、扣费与 New API token 总量一致；该附加结构不参与结算。

## 272K 双态验收

### 关闭态

`allowLongContext=false` 时发送约 280K 输入，Portal 在上游转发前返回 413：该分组未开放长上下文。该请求未生成结算账本、未产生上游请求与扣费；smoke 临时 Key 已禁用。

### 开启态

开启同一 listing 后再次发送约 280K 输入，Responses 真实返回并完成结算：

| 项目 | 结果 |
| --- | --- |
| Portal meter | 非缓存输入 280,542；缓存读 3,840；缓存写 0；输出 27 |
| 长档判定 | `longContextApplied=1` |
| 阈值与价格版本 | 272,000；不可变价格版本 v2 包含完整四个长档 rate |
| 手算 | `280542×2 + 3840×0.2 + 27×9 = 562095 micro-USD` |
| 实际扣费 | 562,095 micro-USD |
| 告警 | 无 `long_context_block_missed`，`billing_flags` 为空 |
| New API 关联 | 日志联结成功；渠道 5、分组 `codex特惠`、运行 Token 类型 `rk_` |
| token 对照 | Portal 输入合计 284,382，与 New API prompt tokens 284,382 一致；输出均为 27 |

关闭态价格版本不含长档 rate 和阈值；开启后旧版本退休并生成 v2，历史普通请求仍引用旧版本，符合不可变快照设计。

## Images 真实上游探针

### 配置

- Portal 模型：`gpt-image-2`，分类 Image，按次计费。
- SKU：`default=$0.02/次`；`quality=low;size=1024x1024=$0.01/次`，default 保持高于显式 low 档。
- 验收分组：复用此前无 listing、无活跃 Key、无路由和价格版本的 `discount-1`，映射到生产 New API `openai官方折扣`。

### 直连结果

服务器内创建一次性 New API Token，限定模型与分组，请求参数为 `n=1`、low、1024×1024、`response_format=b64_json`。完整 Token 只存在于探针进程内，未打印、未落盘；探针结束后软删除，数据库确认无存活的 UAT Token。

真实请求到达渠道 1。New API 在 323 秒后收到上游 200，并记录按次成本、14 个 prompt tokens、196 个 completion tokens；但探针客户端在 240 秒超时并关闭连接，New API 写响应时出现 `broken pipe`。因此本轮只能确认“生产 New API 与该供应商能够完成真实 Images 请求”，不能确认响应数据究竟是 `b64_json` 还是 URL，也不能从响应 `data.length` 核对实际张数。

本轮按已授权的一次付费 Images 调用边界未重复生成。Images 门禁、`n` 契约和 `response_format` 契约均保持未完成，售卖项最终设为 `Retired`；数据库确认没有活跃 Images 路由或价格版本。

下次只需把客户端超时提高到至少 420 秒，并继续只输出以下脱敏字段：HTTP 状态、`data.length`、含 `b64_json` 的元素数、含 URL 的元素数。若直连形态正确，再临时开放 listing 做一次 Portal 网关调用并核对 `skuKey`、`unitCount`、token 照记列与 `charged`；无论结果如何，未闭环全部 Images 契约前恢复 `Retired`。

## 验收工具观察

`deploy/live-smoke.sh` 当前会在读取命令行环境后再次加载 `.env.deploy`，并且没有把 `APIPOOL_SMOKE_IMAGE_MODEL`、`APIPOOL_SMOKE_LONG_CONTEXT_MODEL`、`APIPOOL_SMOKE_LONG_CONTEXT_TOKENS` 透传进 smoke 容器。首次用命令前缀覆写时实际仍跑了默认 `gpt-5.5`，经账本核对后未误记为 Luna 证据；本轮随后直接调用同一 smoke bundle，并在加载服务器 env 后显式覆写和透传变量完成验收。

该问题只影响验收命令可靠性，不影响线上网关运行；修复前每轮必须用账本复核实际模型，不能只看 “Gateway smoke passed”。

## 最终清理状态

- 所有 smoke Portal Key 已禁用，合成用户钱包已恢复运行前余额。
- Images 一次性 New API Token 已删除，无存活 UAT Token。
- Images listing 为 `Retired`，无活跃路由或价格版本。
- `gpt-5.6-luna` listing 保持 Available，长上下文开关保持开启；普通档与长档均已有真实生产证据。
- 未创建支付订单，未恢复废弃账号、旧版 Key、Portal Key 或历史运行池绑定。
