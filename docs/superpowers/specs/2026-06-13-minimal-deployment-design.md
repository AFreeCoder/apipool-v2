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

- docker-compose 起门户(`apipool-v2`)+ New API 两个服务,均绑 `127.0.0.1`(门户 :3000、New API :3001),门户经内部网络访问 New API 管理接口。
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
│   ├── apipool-v2       本仓库 Dockerfile 构建（standalone Next.js）= 门户
│   │                    entrypoint 启动时自动迁移建表，再起服务
│   │                    发布 127.0.0.1:3000 → host
│   │                    DATABASE_URL=file:/data/portal.db
│   │                    NEWAPI_BASE_URL=http://new-api:3000   ← 内部
│   │                    bind-mount ./data/portal:/data
│   └── new-api          calciumion/new-api:latest
│                        内部 :3000；本地发布 127.0.0.1:3001 供 curl /v1 + 管理后台
│                        bind-mount ./data/new-api:/data（内置 SQLite）
│                        渠道 → https://apipool.dev（用户自有站，gpt-5.4-mini，已实测 200）
│
└── （后验）stripe listen --forward-to
        http://localhost:3000/api/payment/notify/stripe
```

- 仅两个服务:门户 `apipool-v2` + `new-api`。门户启动时在自己的卷上自动建表(见 §4),无独立迁移服务。
- 门户↔New API:门户经 compose 服务名 `new-api` 走内部地址访问管理接口(bridge)。
- New API 是用户 `curl` 的 `/v1` 网关本身,故**本地发布到 `127.0.0.1:3001`** 供调用验证;门户发布 `127.0.0.1:3000` 供浏览器访问 + 未来 Stripe 转发。
- **New API 管理后台**(加渠道/管模型/管用户由管理员在此操作):本地直接开 `http://localhost:3001` 即是完整后台;**未来服务器**上 New API 同端口既有 `/v1` 又有后台,反代分流——`api.apipool.dev` 只放行 `/v1/*` 给公网,后台走受限入口(如 `newapi.apipool.dev` + Basic Auth/IP 白名单或内网)仅管理员可达。"不暴露公网"指后台不对公众开放,不限制管理员维护。
- 真实上游:引导阶段在 New API 后台加一个渠道,BaseURL `https://apipool.dev`(用户自有站),模型 `gpt-5.4-mini`,填用户测试 key(只进 New API DB / `.env.deploy`,不入库);`curl` 的实际请求经 New API 转发到该上游(已实测 200,产生少量真实费用)。

### 3.1 控制面 vs 数据面(两个独立平面)

系统流量分两条互不重叠的路径,理解这点是整套部署拓扑的关键:

```
控制面（管理，低频）              数据面（推理，高频/流式）
─────────────────                ──────────────────────
浏览器                            用户的 curl / OpenAI SDK
  │ 登录会话                        │ Authorization: Bearer sk-xxx
  ▼                                ▼
门户 apipool-v2 (:3000)          api.apipool.dev (:3001 本地)
  │ 服务端 bridge                   │ 反代只放行 /v1/*
  │ 带 admin token                  ▼
  ▼ 内部地址 NEWAPI_BASE_URL       New API /v1 网关
New API 管理接口                  （校验 sk-key、扣额度、转发上游、记日志）
（建 Key / 查用量 / 查消耗）
```

- **控制面(建 Key、查请求记录、查 token 消耗)**:浏览器只与门户通信;门户用服务端 bridge 经内部地址 `NEWAPI_BASE_URL` 带 admin token 访问 New API 管理接口。**用户浏览器永不直连 New API**。
- **数据面(实际 LLM 调用)**:用户持 `sk-xxx`(它本身就是一个 New API token)直接打 `api.apipool.dev/v1`,反代转发给 New API;**门户不在此路径上**。New API 自己校验 key、扣额度、记用量。
- **为何推理流量不走门户域名**:Next.js 不适合做高吞吐流式代理,绕行徒增延迟并占用 Node 进程;New API 本就是为此而生的网关。两面分离 = 控制面与数据面可独立扩容。
- 控制台展示给用户、填进 SDK `base_url` 的 `NEXT_PUBLIC_APIPOOL_API_BASE_URL` = 数据面入口(本地 `http://localhost:3001/v1`,服务器 `https://api.apipool.dev/v1`)。
- 子域 `api.apipool.dev`(数据面)与第 8 节的 apex 域名冲突无关——冲突只在 `apipool.dev` 本身。

## 4. 产出物(均入库,密钥与 data/ 除外)

| 路径 | 作用 |
|------|------|
| `docker-compose.yml` | apipool-v2(门户) + new-api,两个服务 |
| `.env.deploy.example` | compose 用 env 模板(基础设施密钥,**不含 Stripe**) |
| `deploy/bootstrap.md` | 一次性引导手册(初始化→起服务→配真实渠道→后验 Stripe 指引) |
| `deploy/newapi-token.sh` | 辅助脚本:cookie 登录 New API → 生成 admin access token |
| `deploy/migrate.mjs` + Docker entrypoint | 启动时建表(见下) |
| `.gitignore` 追加 | 确保 `.env.deploy` 不入库(`data/` 已忽略) |

门户镜像:本地默认 `build: .`;compose 内保留注释的 `image: ghcr.io/afreecoder/apipool-v2:latest`,未来服务器改用 CI 镜像。

**迁移并进门户启动**:门户镜像构建时把 `migrations_sqlite/*.sql` 一并打入,容器 entrypoint 先用 **drizzle-orm 运行时 migrator**(`drizzle-orm` 本就是生产依赖,无需 drizzle-kit/devDeps)在挂载的 `/data/portal.db` 上建表/补结构,成功后再 `node server.js` 起服务。迁移失败则启动中止(快速失败,不带空库对外服务)。这样 compose 只有两个服务,`docker compose up` 一条命令完成建表+起服务。

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
# 首发模型，与真实渠道一致（用户自有上游已实测可用）
NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL=gpt-5.4-mini
```

**admin settings(DB,后台 UI,后验阶段填)——Stripe 测试密钥:**
`stripe_enabled=true`、`stripe_secret_key`、`stripe_publishable_key`、`stripe_signing_secret`(`stripe listen` 启动时打印)。本次留空。

## 6. 引导顺序(写进 deploy/bootstrap.md)

1. 复制 `.env.deploy.example` → `.env.deploy`,生成两个 `*_SECRET`。
2. `docker compose up -d new-api` → 浏览器开 `http://localhost:3001` 登录 New API(首登设置 root 密码)。
3. `deploy/newapi-token.sh` 生成 admin access token → 写回 `.env.deploy` 的 `NEWAPI_ADMIN_TOKEN`。
4. New API 后台:加一个渠道,BaseURL `https://apipool.dev`、模型 `gpt-5.4-mini`、填测试 key(已实测可用)。
5. `docker compose up -d` → 门户 entrypoint 自动建表后起服务、内部连通 New API。
6. 浏览器开 `http://localhost:3000` 注册一个普通用户;在 New API 后台给该用户加额度(本次最小验证的调额方式)。
7.(后验,需 Stripe 账户)门户后台启用 Stripe 填测试密钥 → `stripe listen --forward-to http://localhost:3000/api/payment/notify/stripe` → 把 `whsec_...` 填进 `stripe_signing_secret`。

> 全程无需本机工具链:建表由门户 entrypoint 自动完成。门户运营面(账本调额、对账)及其 RBAC 本次不启用,留待真需要时配置。

## 7. 验收标准(本次核心)

按 [docs/07-runbook.md](../../07-runbook.md) 第 3 节不可跳步:

1. **健康**:`new-api` 内部 `GET /api/status` `success=true`;门户 `GET /` 200。
2. **绑定**:注册普通用户 → New API 后台可见新建用户(bridge 自动绑定)。
3. **调额**:在 New API 后台给该用户加额度 → 门户控制台余额经 bridge 读取显示一致。
4. **建 Key**:创建 API Key,明文仅展示一次,列表掩码。
5. **调用**:`curl http://localhost:3001/v1/chat/completions`(New API 网关)带建好的 Key → New API → 真实上游 → 真返回;用量页出现日志。
6. **禁用**:禁用该 Key 后同样调用返回 401。

Stripe 验收**本次跳过**,记为后验项(接线已就位,无需改代码)。

## 8. 迁移到未来服务器(零返工)

同一份 `docker-compose.yml` 搬上 VPS:

- 门户镜像切到 ghcr CI 镜像(取消注释 `image:` 行)。
- 门户 :3000 收到反向代理(Caddy/nginx)后,绑 `apipool.dev`,自动 HTTPS;New API 反代分流:`api.apipool.dev` 只放行 `/v1/*`,管理后台走受限入口(`newapi` 子域 + Basic Auth/IP 白名单或内网)。
- 迁移机制不变(门户 entrypoint 启动时自动建表)。
- Stripe 改真实公网 webhook(撤掉 `stripe listen`);此时补 Creem 端到端。
- env 与 admin settings 结构不变。
- 给 `apipool-v2` / `new-api` 加资源限制(`mem_limit` / `cpus` 或 `deploy.resources.limits`),避免高负载下争抢宿主机资源(见第 9 节服务隔离)。

> ⚠️ 域名冲突待决:本次上游用的是用户现有站 `https://apipool.dev`,而 v2 品牌域名也规划为 `apipool.dev` / `api.apipool.dev`。v2 正式上线前需定夺:v2 换域名,或把现有站迁走,二者不能同占 `apipool.dev`。

## 9. 风险与回滚

- **New API admin token 重生成语义**:`/api/user/token` 调用后旧 token 失效;引导脚本只在初始化时调一次,记录到 `.env.deploy`。
- **启动迁移失败要快速失败**:门户 entrypoint 建表失败必须中止启动(非 0 退出),绝不带空库对外服务;建表对同一挂载卷 `/data/portal.db` 幂等可重复执行。
- **真实渠道产生费用**:`curl` 验证会经真实上游产生少量 LLM 调用费;用最小 `max_tokens` 控制。
- **服务隔离**:`apipool-v2` 与 `new-api` 是独立容器,各挂各的卷(独立 SQLite,无锁竞争)、各发布不同 host 端口、生命周期独立(一方崩溃不影响另一方,各 `restart: unless-stopped`)。**唯一共享的是宿主机 CPU/内存**(容器非虚拟机);本地无所谓,服务器加资源限制即可隔开。
- **回滚**:本地部署,`docker compose down` 即停;`data/` 为 bind-mount,删除前先备份。不删 ledger / 订单 / 已建 Key。
