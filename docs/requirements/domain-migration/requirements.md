# APIPool 域名迁移 · 需求文档

日期：2026-06-30

## 背景

APIPool v2 需要在不影响老站流量和既有 API 调用的前提下启用新的门户与 API 入口。排空期内，新系统先使用独立子域，待业务与 DNS 条件成熟后再切换根域和正式 API 域。

## 目标

- 启用 v2 门户域名 `app.apipool.dev`。
- 启用 v2 用户 API Endpoint `api2.apipool.dev`。
- 保持 New API 运营管理面 `newapi.apipool.dev`，并继续标记为不索引。
- 保持 `apipool.dev` 与 `api.apipool.dev` 在排空期归老站，避免误切正式流量。
- 公开 API Endpoint 不固化 OpenAI、Anthropic 等 provider 的协议路径；协议路径由具体 SDK 或调用示例追加。
- 同步更新项目文档、示例、测试与 DNS/Caddy 配置脚本。

## 域名矩阵

| 域名                 | 排空期归属           | 用途                         |
| -------------------- | -------------------- | ---------------------------- |
| `apipool.dev`        | 老站                 | 老站入口，暂不切 v2          |
| `api.apipool.dev`    | 老站                 | 老 API 入口，暂不切 v2       |
| `app.apipool.dev`    | APIPool v2           | 门户、登录、控制台、支付回调 |
| `api2.apipool.dev`   | APIPool v2           | 用户 API Endpoint            |
| `newapi.apipool.dev` | APIPool v2 / New API | 运营管理面，仅运营访问       |

## API Endpoint 规则

- `NEXT_PUBLIC_APIPOOL_API_BASE_URL` 只保存裸 endpoint：`https://api2.apipool.dev`。
- OpenAI-compatible 调用示例在调用处追加 `/v1/chat/completions`、`/v1/models` 等协议路径。
- Anthropic native 调用按其协议要求追加路径或配置 SDK baseURL，不把 `/v1` 写死进 APIPool 公开 endpoint。
- 文档中需要解释 endpoint 与 provider 协议 base URL 的差异，避免用户误以为 APIPool endpoint 自身带版本号。

## DNS 与反代要求

- Caddy 门户站点块：`app.apipool.dev` → `127.0.0.1:3000`。
- Caddy API 站点块：`api2.apipool.dev` → `127.0.0.1:3001`。
- Caddy New API 管理站点块：`newapi.apipool.dev` → `127.0.0.1:3001`，保留 `X-Robots-Tag: noindex, nofollow`。
- 支付 webhook 回调地址使用 `https://app.apipool.dev/api/payment/notify/<provider>`。

## 验收标准

- 环境变量、Docker build args、生产 env 模板都指向 `app.apipool.dev` 与 `api2.apipool.dev`。
- 用户可见文档和 quickstart 不再把 `/v1` 固化进公开 API Endpoint。
- smoke、目录 quickstart 和首页示例仍能正确构造 OpenAI-compatible 调用路径。
- 部署手册和运维手册包含排空期域名矩阵、健康检查和回滚边界。
- 自动化测试覆盖 workflow 域名、Caddy 反代、公开配置和 quickstart curl。
