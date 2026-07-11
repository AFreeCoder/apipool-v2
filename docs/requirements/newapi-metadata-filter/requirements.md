# NewAPI 受控模型元数据过滤器需求

日期：2026-07-11

## 背景

NewAPI 的“模型 → 元信息 → 同步上游模型”默认从 `basellm/llm-metadata` 公共目录读取模型与供应商数据。该目录将模型开发商、云平台、渠道商、转售商混在同一个 `vendor_name` 字段；同一 `model_name` 可以出现多条记录。

NewAPI 的元信息表每个模型只能存一个 `vendor_id`，同步实现对同名记录采用后出现者覆盖前出现者的方式。因此会把 GPT 等模型显示为 OpenCode Zen、Vivgrid 等渠道商，图标与供应商信息均不可信。

APIPool 继续需要 NewAPI 的批量“同步上游模型”能力，但该能力必须改为读取受控、可验证的元数据源，而不能原样读取公共目录。

## 目标

- 在当前 `APIPool_v2` 仓库内增加一个独立的 Go 运行时服务 `newapi-metadata-filter`。
- 服务实时读取公共 NewAPI 元数据目录，输出只包含模型开发商的兼容 JSON。
- NewAPI 使用 Docker Compose 内网地址访问该服务，作为 `SYNC_UPSTREAM_BASE`。
- 白名单过滤后，同一个 `model_name` 必须唯一；存在重复时明确失败，绝不任选其中一条。
- 上游请求、数据格式或校验失败时明确失败；不缓存、不返回旧数据、不静默降级。
- 供应商白名单与例外项作为受版本控制的配置文件随代码评审、发布和回滚。

## 第一版供应商策略

模型记录必须同时满足以下条件才可输出：

1. `vendor_name` 在白名单内；
2. 该供应商在上游 `vendors.json` 中存在且 `icon` 非空；
3. 该模型不在该供应商的显式排除列表内。

第一版白名单为：

```yaml
official_vendors:
  - OpenAI
  - Anthropic
  - Google
  - DeepSeek
  - Alibaba
  - Moonshot AI
  - minimax
  - Mistral
  - xAI
  - Z.AI
  - doubao
  - Llama

exclude_models_by_vendor:
  Alibaba:
    - deepseek-r1
```

说明：

- `Moonshot AI (China)` 与 `Moonshot AI` 当前模型集合完全相同，只保留后者。
- `Z.AI` 覆盖 `Zhipu AI` 的全部当前模型，并额外包含 `glm-5-turbo`，只保留前者。
- Azure、Vertex、Amazon Bedrock、OpenRouter、OpenCode Zen、Vivgrid 等即使带图标，也属于云平台、渠道商或转售商，不在白名单内。
- 不做供应商别名自动合并、模型名前缀推断或自动优先级选择。后续发现的新问题应由唯一性校验或明确例外项暴露。

## 范围

包含：

- 新增 Go HTTP 服务及其 Dockerfile。
- 新增版本化白名单配置。
- 兼容 NewAPI 的模型与供应商 JSON 输出端点。
- 公共源拉取、响应大小限制、超时、过滤和严格校验。
- 本地与生产 Docker Compose 服务接入。
- NewAPI 的 `SYNC_UPSTREAM_BASE` 环境变量接入。
- 单元、HTTP 集成和 Compose 网络验证。
- 部署与回滚说明。

不包含：

- 修改 NewAPI 上游镜像、前端或数据库结构。
- 修改 NewAPI 控制台“官方仓库”文案。
- 建立定时任务、数据库、缓存、后台 UI 或公网端口。
- 自动补全未进入受控目录的模型元信息。
- 自动判断某个模型是否确属某供应商。
- 门户模型目录、售卖项、分组、价格或 API Key 逻辑改造。

## 功能需求

### HTTP 兼容端点

服务仅提供：

```text
GET /api/newapi/models.json
GET /api/newapi/vendors.json
GET /healthz
```

前两个端点返回与公共源兼容的 envelope：`success`、`message`、`data`。服务不接受调用方传入的上游地址、供应商名称或过滤条件。

### 实时过滤

- 每次请求都实时拉取上游所需 JSON，不使用内存、磁盘或远端缓存。
- 上游地址由服务启动配置确定，默认公共目录地址；生产环境可通过容器环境变量设置。
- 服务只支持 HTTPS 上游地址，并设置连接、响应头和整体请求超时，以及最大响应体大小。

### 输出规则

- `models.json` 只输出符合第一版供应商策略的模型条目。
- `vendors.json` 只输出被保留模型引用的供应商，并保持其带图标的原始供应商信息。
- 输出前按 `model_name` 分组；任何组含两条或更多记录时，端点返回 5xx，并在日志和响应信息中列出模型名及候选供应商。
- `Alibaba/deepseek-r1` 在输出前剔除。

### 失败语义

以下任一情况必须返回非 2xx：上游不可达、上游返回非成功 envelope、JSON 格式不合法、供应商配置不合法、供应商无图标、模型名为空、过滤后模型名重复。

失败不能返回上一次成功的内容。NewAPI 因此不会把不可信数据写入 `models` 或 `vendors` 表。

## 部署需求

- Compose 增加内部服务 `newapi-metadata-filter`，只使用 Compose 默认网络，不映射主机端口。
- NewAPI 服务通过 `http://newapi-metadata-filter:8080` 访问过滤器。
- 本地 Compose 使用该服务源码构建；生产 Compose 使用 CI 生成的不可变镜像标签。
- NewAPI 配置 `SYNC_UPSTREAM_BASE=http://newapi-metadata-filter:8080`，并在过滤器健康后启动。
- 过滤器故障不会影响已经存在的 NewAPI 转发请求；只会使之后发起的“同步上游模型”失败。

## 验收标准

- 用包含渠道商和官方厂商的 fixture 测试时，只输出白名单供应商的模型与供应商。
- `Alibaba/deepseek-r1` 不出现在输出模型列表中。
- Moonshot 与 Z.AI 的规范供应商记录可以输出；相应别名记录不输出。
- 过滤后任一重复 `model_name` 使请求返回非 2xx，并包含冲突模型名和候选供应商。
- 上游不可用或 JSON 无效时端点返回非 2xx，不返回历史结果。
- `vendors.json` 不含未被输出模型引用、图标为空或不在白名单的供应商。
- `docker compose` 下 NewAPI 能解析服务名并获取两个兼容端点。
- 将 `SYNC_UPSTREAM_BASE` 指向过滤器后，NewAPI 的预览/同步不再写入 OpenCode Zen、Vivgrid 等被排除供应商。
