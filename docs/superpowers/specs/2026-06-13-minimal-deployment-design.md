# 最小部署设计:本地 docker-compose 全栈(支付后验)

- 日期:2026-06-13
- 方案:A —— 本地 docker-compose(门户 + New API),SQLite 落盘
- 范围:跑通非支付闭环;Stripe 接线就位但本次不实测(用户尚无 Stripe 账户)

## 1. 背景与约束

APIPool = **门户**(本仓库 Next.js)+ **New API 上游**(`calciumion/new-api`,Go 服务)。
门户通过服务端 bridge 以**内部地址** `NEWAPI_BASE_URL` 调用 New API;按 [docs/07-runbook.md](../../07-runbook.md) 安全模型,New API 不对公网暴露。

约束:

- 当前**无专属服务器**(现有 DigitalOcean 太贵、计划另购),故本次最小部署落在**本机 docker-compose**。
- 同一份 compose 即未来 VPS 的部署件,迁移零返工。
- **无 Stripe 账户** → 支付端到端后验;本次不依赖任何外部凭证。

## 2. 目标与非目标

**目标(本次完成):**

- docker-compose 起 portal + New API,内部网络互通,New API 不发布到 host。
- 跑通闭环:注册 → 自动绑定 New API 用户 → 运营人工调额 → 控制台显示余额 → 建 Key → 经**真实渠道** `curl` 真返回 → 用量可见 → 禁用 Key 后调用 401。
- 产出可复用的部署件与一次性引导手册。

**非目标(本次不做):**

- Stripe/Creem 端到端实测(留作后验,接线已就位)。
- 域名、HTTPS、反向代理(未来服务器再做)。
- 多渠道/多模型编排(本次只配一个真实渠道验证管道)。

## 3. 架构

```
host
├── docker compose（默认 network: apipool-net）
│   ├── portal-migrate   一次性容器（带工具链，run-once）
│   │                    跑 pnpm db:migrate 建表后退出
│   │                    bind-mount ./data/portal:/data
│   ├── portal           本仓库 Dockerfile 构建（standalone Next.js）
│   │                    depends_on: portal-migrate(完成)
│   │                    发布 127.0.0.1:3000 → host
│   │                    DATABASE_URL=file:/data/portal.db
│   │                    NEWAPI_BASE_URL=http://new-api:3000   ← 内部
│   │                    bind-mount ./data/portal:/data
│   └── new-api          calciumion/new-api:latest
│                        内部 :3000；本地发布 127.0.0.1:3001 供 curl /v1
│                        bind-mount ./data/new-api:/data（内置 SQLite）
│                        渠道指向用户的真实 LLM 上游（在后台配置）
│
└── （后验）stripe listen --forward-to
        http://localhost:3000/api/payment/notify/stripe
```

- 门户↔New API:门户经 compose 服务名 `new-api` 走内部地址访问管理接口(bridge)。
- New API 是用户 `curl` 的 `/v1` 网关本身,故**本地发布到 `127.0.0.1:3001`** 供调用验证;门户发布 `127.0.0.1:3000` 供浏览器访问 + 未来 Stripe 转发。
- "不暴露公网"安全模型针对**未来服务器**:反代只放行 `/v1`,管理面(`/api/user` 等)加 Basic Auth/IP 白名单。本地全在 127.0.0.1,无对外暴露。
- 真实上游:引导阶段在 New API 后台加一个渠道,填**用户自己的 LLM 提供方 key**(如 OpenAI),`curl` 的实际请求经 New API 转发到该上游(产生少量真实费用)。

## 4. 产出物(均入库,密钥与 data/ 除外)

| 路径 | 作用 |
|------|------|
| `docker-compose.yml` | portal-migrate + portal + new-api |
| `.env.deploy.example` | compose 用 env 模板(基础设施密钥,**不含 Stripe**) |
| `deploy/bootstrap.md` | 一次性引导手册(初始化→起服务→配真实渠道→后验 Stripe 指引) |
| `deploy/newapi-token.sh` | 辅助脚本:cookie 登录 New API → 生成 admin access token |
| `.gitignore` 追加 | 确保 `.env.deploy` 不入库(`data/` 已忽略) |

门户镜像:本地默认 `build: .`;compose 内保留注释的 `image: ghcr.io/afreecoder/apipool-v2:latest`,未来服务器改用 CI 镜像。

迁移容器 `portal-migrate`:复用门户 Dockerfile 中**带 devDeps 的构建阶段**(含 pnpm + drizzle-kit + 源码),命令 `pnpm db:migrate`,`restart: "no"`,与门户共享 `./data/portal` 绑定卷;门户 `depends_on` 它 `service_completed_successfully`。

## 5. 配置与密钥分层

**env(`.env.deploy`,gitignore)——基础设施密钥,本机生成:**

```
DATABASE_PROVIDER=sqlite
DATABASE_URL=file:/data/portal.db
AUTH_SECRET=<openssl rand -base64 32>
APIPOOL_CREDENTIALS_SECRET=<openssl rand -base64 32>
NEWAPI_INTEGRATION_ENABLED=true
APIPOOL_KEY_CREATION_ENABLED=true
NEWAPI_BASE_URL=http://new-api:3000
NEWAPI_ADMIN_TOKEN=<引导步骤产出>
NEWAPI_ADMIN_USER_ID=1
NEWAPI_QUOTA_PER_UNIT=500000
NEXT_PUBLIC_APP_URL=http://localhost:3000
# 控制台展示给用户的网关地址（本地发布的 New API /v1）
NEXT_PUBLIC_APIPOOL_API_BASE_URL=http://localhost:3001/v1
# 首发模型，设为你真实渠道支持的模型（如 OpenAI key 则 gpt-4o-mini）
NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL=gpt-4o-mini
```

**admin settings(DB,后台 UI,后验阶段填)——Stripe 测试密钥:**
`stripe_enabled=true`、`stripe_secret_key`、`stripe_publishable_key`、`stripe_signing_secret`(`stripe listen` 启动时打印)。本次留空。

## 6. 引导顺序(写进 deploy/bootstrap.md)

1. 复制 `.env.deploy.example` → `.env.deploy`,生成两个 `*_SECRET`。
2. `docker compose up -d new-api` → 浏览器登录 New API(首登设置 root 密码)。
3. `deploy/newapi-token.sh` 生成 admin access token → 写回 `.env.deploy` 的 `NEWAPI_ADMIN_TOKEN`。
4. New API 后台:加一个渠道,填**你的真实 LLM key**(如 OpenAI),绑定 `NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL` 指定的模型。
5. `docker compose up -d`(先跑 `portal-migrate` 建表,再起 `portal`)→ 门户起、内部连通 New API。
6. 建运营管理员账号(用于人工调额):复用迁移容器镜像跑 RBAC 初始化与赋权,如 `docker compose run --rm portal-migrate pnpm rbac:init`。
7.(后验,需 Stripe 账户)后台启用 Stripe 填测试密钥 → `stripe listen --forward-to http://localhost:3000/api/payment/notify/stripe` → 把 `whsec_...` 填进 `stripe_signing_secret`。

> 迁移与运营脚本(rbac:init 等)都由 compose 内 `portal-migrate` 容器镜像执行(自带 pnpm + 源码),共享 `./data/portal` 绑定卷,门户 `depends_on` 迁移成功完成 —— 全程无需本机工具链。

## 7. 验收标准(本次核心)

按 [docs/07-runbook.md](../../07-runbook.md) 第 3 节不可跳步:

1. **健康**:`new-api` 内部 `GET /api/status` `success=true`;门户 `GET /` 200。
2. **绑定**:注册普通用户 → New API 后台可见新建用户(bridge 自动绑定)。
3. **调额**:运营对该用户人工 +$1 → 控制台余额显示一致。
4. **建 Key**:创建 API Key,明文仅展示一次,列表掩码。
5. **调用**:`curl http://localhost:3001/v1/chat/completions`(New API 网关)带建好的 Key → New API → 真实上游 → 真返回;用量页出现日志。
6. **禁用**:禁用该 Key 后同样调用返回 401。

Stripe 验收**本次跳过**,记为后验项(接线已就位,无需改代码)。

## 8. 迁移到未来服务器(零返工)

同一份 `docker-compose.yml` 搬上 VPS:

- 门户镜像切到 ghcr CI 镜像(取消注释 `image:` 行)。
- 门户 :3000 收到反向代理(Caddy/nginx)后,绑 `apipool.dev`,自动 HTTPS;New API 只反代放行 `/v1`,管理面加 Basic Auth/IP 白名单。
- 迁移机制不变(`portal-migrate` 容器照旧)。
- Stripe 改真实公网 webhook(撤掉 `stripe listen`);此时补 Creem 端到端。
- env 与 admin settings 结构不变。

## 9. 风险与回滚

- **New API admin token 重生成语义**:`/api/user/token` 调用后旧 token 失效;引导脚本只在初始化时调一次,记录到 `.env.deploy`。
- **迁移与门户卷一致**:`portal-migrate` 与 `portal` 必须挂同一份 `./data/portal` 卷且 `DATABASE_URL` 相同,否则门户连到未建表的空库;门户 `depends_on` 迁移 `service_completed_successfully` 保证次序。
- **真实渠道产生费用**:`curl` 验证会经真实上游产生少量 LLM 调用费;用最小 `max_tokens` 控制。
- **回滚**:本地部署,`docker compose down` 即停;`data/` 为 bind-mount,删除前先备份。不删 ledger / 订单 / 已建 Key。
