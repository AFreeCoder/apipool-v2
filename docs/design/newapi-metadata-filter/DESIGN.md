# NewAPI 受控模型元数据过滤器设计

日期：2026-07-11

## 决策

在 `APIPool_v2` 中新增独立 Go Compose service，而不是：

- 直接信任公共 `basellm` 目录；
- 修改 NewAPI 上游镜像；
- 新建公网静态站点或定时生成任务。

服务名为 `newapi-metadata-filter`，源码位于：

```text
services/newapi-metadata-filter/
```

它不是门户 Next.js 应用的一部分，也不属于 NewAPI fork。它与门户、NewAPI 并列部署，但仅供 NewAPI 在 Docker 内网调用。

## 架构

```text
NewAPI 管理控制台
  │ 点击“模型 → 元信息 → 同步上游模型”
  ▼
NewAPI
  │ SYNC_UPSTREAM_BASE=http://newapi-metadata-filter:8080
  ▼
newapi-metadata-filter（Go，Compose 内网）
  │ 实时拉取、过滤、校验
  ▼
basellm/llm-metadata 公共目录
```

NewAPI 仍拥有渠道、能力、路由、模型元信息落库和控制台逻辑。过滤器不接触 NewAPI 数据库、不调用 RunAPI、不参与实际模型请求转发；它只替换 NewAPI 元信息同步时读取的 JSON 来源。

## 服务接口

监听 `:8080`，不发布宿主机端口。

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/newapi/models.json` | 拉取上游模型与供应商数据，过滤并校验后返回模型 envelope。 |
| GET | `/api/newapi/vendors.json` | 拉取上游供应商与模型数据，过滤并校验后返回实际被模型引用的供应商 envelope。 |
| GET | `/healthz` | 仅报告服务已启动且本地配置可解析；不触发外部请求。 |

模型和供应商端点均只接受 GET，不接受参数，不代理任意 URL。所有上游 URL 由进程环境确定，避免把服务变成 SSRF 代理。

## 配置

版本化配置文件：

```text
services/newapi-metadata-filter/config/official-vendors.yaml
```

包含精确供应商名称白名单和按供应商排除的模型 ID。第一版内容以需求文档为准。

运行时环境变量：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `UPSTREAM_METADATA_BASE` | `https://basellm.github.io/llm-metadata` | 公共目录根地址。 |
| `LISTEN_ADDR` | `:8080` | 服务监听地址。 |
| `REQUEST_TIMEOUT_SECONDS` | `15` | 单次上游拉取总超时。 |
| `MAX_RESPONSE_BYTES` | `10485760` | 单份上游 JSON 的最大字节数。 |

`UPSTREAM_METADATA_BASE` 不放在 HTTP 请求参数中。生产环境仅在需要切换公共目录镜像时设置它。

## 过滤与校验流程

每个元数据请求实时执行以下步骤：

1. 从 `${UPSTREAM_METADATA_BASE}/api/newapi/models.json` 和 `vendors.json` 拉取 JSON。
2. 验证 HTTP 成功、envelope 成功、`data` 为数组、响应体不超限。
3. 建立供应商名到供应商记录的映射。
4. 遍历模型记录，仅保留：
   - `vendor_name` 在 `official_vendors`；
   - 对应供应商存在且 `icon` 非空；
   - 不命中 `exclude_models_by_vendor`；
   - `model_name` 非空。
5. 以 `model_name` 分组。任何模型名保留两条以上记录都失败，错误包含每条候选的供应商名称；不采用 first/last-wins 或优先级猜测。
6. 从通过校验的模型集合提取被引用的供应商，输出对应供应商记录。

该流程有意不做模型厂商推断。供应商白名单无法判断的跨厂商代售模型，只能通过显式排除项处理；`Alibaba/deepseek-r1` 是第一条此类例外。

## 响应与故障

成功时返回 HTTP 200 与兼容 NewAPI 的 envelope。

校验或上游故障时返回 HTTP 502，JSON 响应包含固定错误码、可读消息和（对于重复模型）冲突详情；服务日志记录相同上下文。不存在内存、磁盘或远端缓存，因此不会把旧的成功数据伪装成当前上游数据。

NewAPI 同步逻辑会把非 200 当作上游同步失败，且不进入创建/覆盖元信息的写入阶段。这是故意的 fail-closed 边界。

## Docker Compose 集成

本地 `docker-compose.yml`：

- 增加 `newapi-metadata-filter`，以 `services/newapi-metadata-filter` 为 build context。
- 挂载版本化 YAML 配置为只读文件。
- 不配置 `ports`。
- `new-api` 增加 `SYNC_UPSTREAM_BASE=http://newapi-metadata-filter:8080`。
- `new-api` 依赖过滤器健康检查。

生产 `docker-compose.prod.yml`：

- 过滤器使用 CI 推送的第二个 GHCR 镜像，使用与发布同一提交对应的不可变 tag。
- 仍不映射主机端口。
- 通过 `NEWAPI_METADATA_FILTER_IMAGE` 与 `IMAGE_TAG` 选择镜像。
- `new-api` 同样设置内部 `SYNC_UPSTREAM_BASE` 并依赖健康检查。

`SYNC_UPSTREAM_BASE` 必须作为 `new-api` 容器环境变量传入；仅写入 `.env.deploy` 不会生效。

## 代码组织

```text
services/newapi-metadata-filter/
├── cmd/server/main.go          # 进程启动、配置加载、HTTP server
├── internal/config/            # YAML 解析和启动期配置校验
├── internal/upstream/          # 有边界的 HTTP 拉取和 envelope 解析
├── internal/filter/            # 纯过滤、去重、供应商裁剪逻辑
├── internal/httpapi/           # 三个 HTTP handler
├── testdata/                   # 公开源 fixture
├── config/official-vendors.yaml
├── go.mod
└── Dockerfile
```

`internal/filter` 不依赖 HTTP 或 Docker，所有供应商策略和重复冲突都能通过 fixture 单测覆盖。

## 测试设计

- `internal/filter` 单测：白名单过滤、无图标剔除、`Alibaba/deepseek-r1` 排除、供应商裁剪、重复模型拒绝。
- `internal/upstream` 单测：超时、非 200、无效 JSON、错误 envelope、响应体超限。
- `internal/httpapi` 使用 `httptest`：两份兼容 JSON、502 故障结构与 `/healthz`。
- Dockerfile 构建测试：Go 单测通过后构建最小运行镜像。
- Compose 集成测试：从 `new-api` 网络命名空间访问过滤器，确认 `/api/newapi/*` 可用且不存在宿主机端口映射。
- NewAPI 联调：先调用预览，再同步；确认受控源创建/覆盖的供应商只来自白名单。

## 发布与回滚

发布前先构建过滤器镜像，并以同一提交 SHA 发布。部署后按顺序验证：

1. 过滤器 `/healthz` 返回 200；
2. Docker 内网两个 JSON 端点返回 200；
3. 输出模型名唯一，且输出供应商均在白名单内；
4. NewAPI `sync_upstream/preview` 成功；
5. 管理员确认冲突字段后执行同步，并检查模型广场显示。

回滚只需将 Compose 镜像 tag 与 `SYNC_UPSTREAM_BASE` 恢复到上一已验证版本，再重启过滤器和 NewAPI。过滤器的 fail-closed 行为不会影响已经运行中的模型转发。

## 风险与边界

- 这不会修复公共源缺失的官方模型条目；未输出的模型继续使用 NewAPI 自身名称兜底展示。
- 供应商白名单不是模型归属证明；未来发现跨厂商代售条目时，先新增显式排除项，不扩大自动推断。
- 当前 NewAPI 控制台仍显示“官方仓库”文案，但其实际请求由 `SYNC_UPSTREAM_BASE` 指向内网过滤器；文案改造不属于第一版。
- 不缓存意味着每次同步都依赖公共源可用性，这是与“错误必须暴露”一致的有意取舍。
