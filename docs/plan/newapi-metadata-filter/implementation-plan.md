# NewAPI 受控模型元数据过滤器实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 Docker Compose 内网 Go 服务，实时过滤 NewAPI 公共模型元数据，并让 NewAPI 元信息同步只读取受控结果。

**Architecture:** 服务只提供两个兼容 NewAPI 的 JSON endpoint 和健康检查。每个 JSON 请求实时拉取公共 models.json 与 vendors.json，按版本化白名单过滤、排除 Alibaba/deepseek-r1，并拒绝所有重复 model_name。NewAPI 使用内部服务地址作为 SYNC_UPSTREAM_BASE；过滤失败返回 502，不缓存、不降级。

**Tech Stack:** Go 1.26、net/http、gopkg.in/yaml.v3、Docker Compose、GHCR、GitHub Actions。

---

## 文件结构

| 路径 | 责任 |
|---|---|
| `services/newapi-metadata-filter/go.mod` | 独立 Go 模块与 YAML 依赖。 |
| `services/newapi-metadata-filter/config/official-vendors.yaml` | 白名单与显式模型排除项。 |
| `services/newapi-metadata-filter/internal/config/config.go` | YAML 加载和启动期策略校验。 |
| `services/newapi-metadata-filter/internal/metadata/types.go` | 公共源兼容的 envelope、模型、供应商类型。 |
| `services/newapi-metadata-filter/internal/upstream/client.go` | 有超时和响应上限的公共源拉取。 |
| `services/newapi-metadata-filter/internal/filter/filter.go` | 过滤、供应商裁剪、重复模型拒绝。 |
| `services/newapi-metadata-filter/internal/httpapi/server.go` | HTTP 成功、错误和健康检查响应。 |
| `services/newapi-metadata-filter/cmd/server/main.go` | 环境、依赖装配与服务启动。 |
| `services/newapi-metadata-filter/Dockerfile` | 独立运行镜像和 HEALTHCHECK。 |
| `docker-compose.yml` / `docker-compose.prod.yml` | 内网服务、配置挂载、NewAPI 来源接入。 |
| `.github/workflows/docker-build.yaml` / `.github/workflows/mvp-verify.yaml` | 第二份 GHCR 镜像构建与发布，以及 Go 单元测试门禁。 |
| `deploy/deploy.sh` | 过滤服务健康门禁。 |

### Task 1: 创建模块、策略配置和元数据类型

**Files:**
- Create: `services/newapi-metadata-filter/go.mod`
- Create: `services/newapi-metadata-filter/config/official-vendors.yaml`
- Create: `services/newapi-metadata-filter/internal/config/config.go`
- Create: `services/newapi-metadata-filter/internal/config/config_test.go`
- Create: `services/newapi-metadata-filter/internal/metadata/types.go`

- [x] **Step 1: 写配置失败测试**

覆盖空白名单、重复供应商、排除项引用未白名单供应商：

~~~go
func TestLoadRejectsInvalidPolicy(t *testing.T) {
  path := writeTempFile(t, "official_vendors:\n  - OpenAI\n  - OpenAI\n")
  _, err := Load(path)
  if err == nil || !strings.Contains(err.Error(), "official_vendors") {
    t.Fatalf("expected policy error, got %v", err)
  }
}
~~~

- [x] **Step 2: 运行测试确认失败**

Run: `cd services/newapi-metadata-filter && go test ./internal/config -run TestLoadRejectsInvalidPolicy -v`

Expected: FAIL，因为 `Load` 尚不存在。

- [x] **Step 3: 创建模块、类型和配置实现**

创建 Go 1.26 模块，依赖 `gopkg.in/yaml.v3 v3.0.1`。定义：

~~~go
type Envelope[T any] struct {
  Success bool   `json:"success"`
  Message string `json:"message"`
  Data    []T    `json:"data"`
}

type Model struct {
  Description string          `json:"description"`
  Endpoints   json.RawMessage `json:"endpoints"`
  Icon        string          `json:"icon"`
  ModelName   string          `json:"model_name"`
  NameRule    int             `json:"name_rule"`
  Status      int             `json:"status"`
  Tags        string          `json:"tags"`
  VendorName  string          `json:"vendor_name"`
}

type Vendor struct {
  Description string `json:"description"`
  Icon        string `json:"icon"`
  Name        string `json:"name"`
  Status      int    `json:"status"`
}
~~~

`Load(path)` 将 YAML 列表变成集合，拒绝空白值、重复值和未授权排除键。

- [x] **Step 4: 写入已确认的策略**

~~~yaml
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
~~~

- [x] **Step 5: 验证并提交**

Run: `cd services/newapi-metadata-filter && go test ./internal/config -v`

Expected: PASS。

~~~bash
git add services/newapi-metadata-filter/go.mod services/newapi-metadata-filter/go.sum \
  services/newapi-metadata-filter/config services/newapi-metadata-filter/internal/config \
  services/newapi-metadata-filter/internal/metadata
git commit -m "feat: add metadata filter policy config"
~~~

### Task 2: 实现受限的上游拉取和纯过滤逻辑

**Files:**
- Create: `services/newapi-metadata-filter/internal/upstream/client.go`
- Create: `services/newapi-metadata-filter/internal/upstream/client_test.go`
- Create: `services/newapi-metadata-filter/internal/filter/filter.go`
- Create: `services/newapi-metadata-filter/internal/filter/filter_test.go`

- [x] **Step 1: 写上游客户端失败测试**

用 `httptest.Server` 覆盖 HTTP 500、success=false、非法 JSON、超过 MaxBytes 和成功解析。目标 API：

~~~go
type Client struct {
  BaseURL  string
  HTTP     *http.Client
  MaxBytes int64
}

func (c Client) FetchModels(ctx context.Context) (metadata.Envelope[metadata.Model], error)
func (c Client) FetchVendors(ctx context.Context) (metadata.Envelope[metadata.Vendor], error)
~~~

- [x] **Step 2: 写过滤器失败测试**

fixture 放入 OpenAI 与 OpenCode Zen 的 gpt-5.5、Alibaba 的 deepseek-r1、Moonshot AI 与 Moonshot AI (China) 的 kimi-k2.6、无图标供应商。断言白名单结果、Alibaba 例外、供应商裁剪和重复错误：

~~~go
result, err := Build(models, vendors, policy)
var duplicate *DuplicateModelError
if !errors.As(err, &duplicate) || duplicate.ModelName != "gpt-5.5" {
  t.Fatalf("expected gpt-5.5 duplicate, got %v", err)
}
_ = result
~~~

- [x] **Step 3: 运行测试确认失败**

Run: `cd services/newapi-metadata-filter && go test ./internal/upstream ./internal/filter -v`

Expected: FAIL，因为客户端和 `Build` 尚不存在。

- [x] **Step 4: 实现上游客户端**

客户端固定追加 `/api/newapi/models.json` 与 `/api/newapi/vendors.json`，使用 request context、超时 HTTP client、LimitReader 和 JSON decoder。非 200、超限、解码失败、success=false 一律返回带资源名和状态的错误；不记录完整正文。

- [x] **Step 5: 实现过滤器**

~~~go
type Result struct {
  Models  []metadata.Model
  Vendors []metadata.Vendor
}

func Build(
  models []metadata.Model,
  vendors []metadata.Vendor,
  policy config.Policy,
) (Result, error)
~~~

顺序为：建立供应商 map → 白名单过滤 → 显式排除 → 检查供应商存在且 icon 非空 → 按 model_name 收集候选 → 任何重复返回 `DuplicateModelError` → 输出模型和被引用供应商。

不得按名称前缀、源顺序或供应商优先级解决冲突。

- [x] **Step 6: 验证并提交**

Run: `cd services/newapi-metadata-filter && go test ./internal/upstream ./internal/filter -v`

Expected: PASS，且 Alibaba/deepseek-r1 不在结果中。

~~~bash
git add services/newapi-metadata-filter/internal/upstream \
  services/newapi-metadata-filter/internal/filter
git commit -m "feat: filter metadata to official vendors"
~~~

### Task 3: 实现 HTTP 服务、启动入口和容器镜像

**Files:**
- Create: `services/newapi-metadata-filter/internal/httpapi/server.go`
- Create: `services/newapi-metadata-filter/internal/httpapi/server_test.go`
- Create: `services/newapi-metadata-filter/cmd/server/main.go`
- Create: `services/newapi-metadata-filter/Dockerfile`

- [x] **Step 1: 写 HTTP handler 失败测试**

成功测试：

~~~go
rr := httptest.NewRecorder()
server.Handler().ServeHTTP(
  rr,
  httptest.NewRequest(http.MethodGet, "/api/newapi/models.json", nil),
)
if rr.Code != http.StatusOK {
  t.Fatalf("status=%d", rr.Code)
}
~~~

重复 fixture 必须返回 502、success=false、code=duplicate_model_name 和 conflicts。POST 与未知路径返回 404 或 405，且不会拉取上游。

- [x] **Step 2: 运行失败测试**

Run: `cd services/newapi-metadata-filter && go test ./internal/httpapi -v`

Expected: FAIL，因为 server 尚不存在。

- [x] **Step 3: 实现 handler 和入口**

`main.go` 读取 UPSTREAM_METADATA_BASE、LISTEN_ADDR、REQUEST_TIMEOUT_SECONDS、MAX_RESPONSE_BYTES、CONFIG_PATH。默认配置路径为 `/app/config/official-vendors.yaml`；配置无效即退出非零。

两个 JSON handler 每次调用 FetchModels、FetchVendors、Build。成功响应为兼容 envelope；失败响应为：

~~~json
{"success":false,"code":"duplicate_model_name","message":"filtered metadata contains duplicate model_name","conflicts":[]}
~~~

healthz 只报告服务已经启动并成功加载策略，不请求外部源。日志只包含路径、状态、耗时和错误码。

- [x] **Step 4: 写 Dockerfile**

使用 golang:1.26-alpine 编译，再用 alpine:3.22 运行。运行镜像安装 wget、复制默认 YAML、以非 root 用户运行，并定义：

~~~dockerfile
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz >/dev/null || exit 1
~~~

- [x] **Step 5: 验证并提交**

Run:

~~~bash
cd services/newapi-metadata-filter
go test ./...
docker build -t apipool/newapi-metadata-filter:test .
docker run --rm -d --name newapi-metadata-filter-test -p 18080:8080 \
  apipool/newapi-metadata-filter:test
curl -fsS http://127.0.0.1:18080/healthz
docker rm -f newapi-metadata-filter-test
~~~

Expected: Go 测试通过，healthz 返回 200。

~~~bash
git add services/newapi-metadata-filter/internal/httpapi \
  services/newapi-metadata-filter/cmd services/newapi-metadata-filter/Dockerfile
git commit -m "feat: serve filtered NewAPI metadata"
~~~

### Task 4: 接入本地和生产 Compose

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`
- Modify: `deploy/env.production.example`
- Create: `tests/deploy/newapi-metadata-filter-compose.test.ts`

- [x] **Step 1: 写 Compose 静态失败测试**

断言两份 Compose 都有 newapi-metadata-filter；new-api 的 SYNC_UPSTREAM_BASE 为内部服务地址；depends_on 使用 service_healthy；过滤服务没有 ports。生产配置还必须以 NEWAPI_METADATA_FILTER_IMAGE 和 IMAGE_TAG 选择镜像。

- [x] **Step 2: 运行失败测试**

Run: `pnpm exec tsx --test tests/deploy/newapi-metadata-filter-compose.test.ts`

Expected: FAIL，因为 Compose 尚未包含服务。

- [x] **Step 3: 修改 Compose 和环境示例**

本地服务以 `./services/newapi-metadata-filter` 构建，生产服务使用第二份 GHCR 镜像。两者都将配置 YAML 只读挂载到 `/app/config/official-vendors.yaml`，均不发布端口。

两份 new-api service 都增加内部 SYNC_UPSTREAM_BASE 环境变量，并依赖过滤服务健康。生产环境示例增加过滤器镜像名称。

- [x] **Step 4: 验证并提交**

Run:

~~~bash
pnpm exec tsx --test tests/deploy/newapi-metadata-filter-compose.test.ts
docker compose config >/tmp/apipool-compose.yaml
docker compose up -d --build newapi-metadata-filter
docker compose exec -T newapi-metadata-filter wget -q -O - http://127.0.0.1:8080/healthz
docker compose exec -T newapi-metadata-filter wget -q -O - \
  http://127.0.0.1:8080/api/newapi/models.json >/tmp/models.json
jq -e '.success == true and (.data | type == "array")' /tmp/models.json
docker compose down
~~~

Expected: 配置展开、服务健康、endpoint 合法，且 `docker compose port newapi-metadata-filter 8080` 没有端口映射。

~~~bash
git add docker-compose.yml docker-compose.prod.yml deploy/env.production.example \
  tests/deploy/newapi-metadata-filter-compose.test.ts
git commit -m "feat: wire NewAPI metadata filter into compose"
~~~

### Task 5: 扩展 CI 和生产部署健康检查

**Files:**
- Modify: `.github/workflows/docker-build.yaml`
- Modify: `.github/workflows/mvp-verify.yaml`
- Modify: `deploy/deploy.sh`
- Create: `tests/deploy/newapi-metadata-filter-deploy.test.ts`

- [x] **Step 1: 写 CI/部署失败测试**

断言镜像工作流以服务目录为 context 构建第二镜像，并使用与门户相同的 SHA 标签；断言 MVP 验证工作流安装 Go 1.26 并执行 `go test ./...`；断言部署归档包含过滤器 config 目录；断言 deploy.sh 在 NewAPI 前等待过滤服务健康。

- [x] **Step 2: 运行失败测试**

Run: `pnpm exec tsx --test tests/deploy/newapi-metadata-filter-deploy.test.ts`

Expected: FAIL，因为工作流和部署脚本尚未包含该服务。

- [x] **Step 3: 修改工作流和 deploy 脚本**

镜像工作流为过滤器加入独立 metadata 和 build-push 步骤，context 为服务目录。MVP 验证工作流安装 Go 并运行过滤器单元测试。部署归档包含服务 config 目录。

在 deploy.sh 的 healthcheck 起始处，使用 compose 获取过滤容器 ID，并循环检查 Docker Health.Status；60 次、每次 2 秒后仍非 healthy 则失败并走已有回滚分支。过滤器不接入 Caddy。

- [x] **Step 4: 验证并提交**

Run:

~~~bash
pnpm exec tsx --test tests/deploy/newapi-metadata-filter-deploy.test.ts
env IMAGE_TAG=sha-test docker compose \
  -f docker-compose.prod.yml config >/tmp/apipool-prod-compose.yaml
~~~

Expected: 测试通过，生产 Compose 能解析第二镜像和内部依赖。

~~~bash
git add .github/workflows/docker-build.yaml .github/workflows/mvp-verify.yaml deploy/deploy.sh \
  tests/deploy/newapi-metadata-filter-deploy.test.ts
git commit -m "ci: publish and verify metadata filter"
~~~

### Task 6: 写运维文档、完整测试与本地 NewAPI 联调

**Files:**
- Modify: `docs/deployment.md`
- Create: `docs/test/newapi-metadata-filter/test-report.md`

- [x] **Step 1: 更新部署文档**

新增“NewAPI 受控模型元数据同步”小节，说明控制台入口不变、来源经过内网过滤器、重复模型必须先修配置、排障用 docker compose logs 和容器内 wget、回滚使用前一个 IMAGE_TAG 和现有 deploy.sh。

- [x] **Step 2: 运行完整验证**

Run:

~~~bash
cd services/newapi-metadata-filter && go test ./...
cd ../..
pnpm exec tsc --noEmit --pretty false
pnpm test
pnpm lint
pnpm build
pnpm smoke:mvp
docker compose config
~~~

Expected: 全部通过；任何既有失败都停止并记录，不绕过。

- [x] **Step 3: 执行本地 NewAPI 联调**

1. 执行 `docker compose up -d --build`；
2. 确认过滤输出不含 OpenCode Zen、Vivgrid、Alibaba/deepseek-r1；
3. 用本地管理员会话执行“同步上游模型 → 预览”；只有供应商、图标、标签全部来自白名单时才执行同步；
4. 请求本地 pricing，确认 gpt-5.5 对应 OpenAI；
5. 对已有 RunAPI 渠道发起模型请求，确认过滤器不改变数据面转发。

- [x] **Step 4: 写报告并提交**

报告记录公共源时间、输出模型/供应商数、排除命中数、重复数、命令结果、预览/同步结果、数据面回归和遗留项。

~~~bash
git add docs/deployment.md docs/test/newapi-metadata-filter/test-report.md
git commit -m "docs: document metadata filter operations"
~~~

## 计划自检

- 白名单、Alibaba 例外和重复 fail-closed 由 Task 1 与 Task 2 实现和测试。
- 实时无缓存、上游限制和非 2xx 故障由 Task 2 与 Task 3 覆盖。
- Compose、内部 DNS、SYNC_UPSTREAM_BASE、CI 镜像和部署健康由 Task 4 与 Task 5 覆盖。
- 控制台同步、模型展示和数据面不回归由 Task 6 验收。
- 未引入自动别名合并、模型归属推断或未定义优先级。
