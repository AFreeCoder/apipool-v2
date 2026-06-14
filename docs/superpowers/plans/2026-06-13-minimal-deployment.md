# 最小部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用本地 docker-compose 跑起门户(`apipool-v2`)+ New API 两个服务,门户启动时自动建表,验证「注册→绑定→New API 调额→建 Key→curl 经真实上游返回→禁用 Key 后 401」闭环。

**Architecture:** 两个容器:门户(本仓库 Next.js standalone 镜像,entrypoint 启动时用 drizzle-orm 运行时 migrator 对 SQLite 建表后再起服务)+ New API(`calciumion/new-api` 官方镜像,内置 SQLite)。门户经内部网络 `http://new-api:3000` 走 bridge 访问 New API 管理接口;用户 `curl` 直接打本地发布的 New API `127.0.0.1:3001/v1`。

**Tech Stack:** Next.js standalone、Docker Compose、drizzle-orm/libsql migrator、esbuild(构建期打包迁移脚本)、New API(calciumion/new-api)、curl/bash 引导脚本。

**Spec:** [docs/superpowers/specs/2026-06-13-minimal-deployment-design.md](../specs/2026-06-13-minimal-deployment-design.md)

---

## 前置检查(Prerequisite)

- [ ] **P1: 确认 Docker 与 compose 可用**

Run:
```bash
docker version --format '{{.Server.Version}}' && docker compose version
```
Expected: 打印 Docker 服务端版本号 + Compose 版本(如 `v2.x`)。若报 `Cannot connect to the Docker daemon`,先启动 Docker Desktop。

- [ ] **P2: 确认 esbuild 在依赖中(供构建期打包迁移脚本)**

Run:
```bash
node_modules/.bin/esbuild --version
```
Expected: 打印 `0.25.9`(或相近版本)。若缺失,先 `pnpm install`。

---

## Task 1: gitignore 与 env 模板

**Files:**
- Modify: `.gitignore`(追加一行)
- Create: `.env.deploy.example`

- [ ] **Step 1: 追加 `.env.deploy` 到 .gitignore**

在 `.gitignore` 末尾追加(`.env` 规则是精确匹配,不覆盖 `.env.deploy`):
```
# local deploy env (compose)
.env.deploy
```

- [ ] **Step 2: 创建 `.env.deploy.example`**

```bash
# ===== compose 用部署环境变量模板 =====
# 用法：cp .env.deploy.example .env.deploy 后填写，再 docker compose --env-file .env.deploy ...
# 本文件入库（无密钥）；.env.deploy 已 gitignore。

# ---- 数据库（门户，SQLite 落盘在挂载卷 /data）----
DATABASE_PROVIDER=sqlite
DATABASE_URL=file:/data/portal.db
DB_SINGLETON_ENABLED=true
DB_MAX_CONNECTIONS=1

# ---- 应用密钥（本机生成：openssl rand -base64 32）----
AUTH_SECRET=
APIPOOL_CREDENTIALS_SECRET=

# ---- New API 桥接（服务端，仅门户容器内部用）----
NEWAPI_INTEGRATION_ENABLED=true
APIPOOL_KEY_CREATION_ENABLED=true
NEWAPI_BASE_URL=http://new-api:3000
NEWAPI_ADMIN_TOKEN=
NEWAPI_ADMIN_USER_ID=1
NEWAPI_QUOTA_PER_UNIT=500000

# ---- New API 引导脚本用（deploy/newapi-token.sh 读取；密码限 8-20 字符）----
NEWAPI_ROOT_USER=root
NEWAPI_ROOT_PASS=

# ---- NEXT_PUBLIC_*：构建期注入门户前端包（compose build.args 经 --env-file 取值）----
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_APIPOOL_API_BASE_URL=http://localhost:3001/v1
NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL=gpt-5.4-mini
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore .env.deploy.example
git commit -m "chore(deploy): add .env.deploy template and gitignore entry"
```

---

## Task 2: 迁移脚本源文件

**Files:**
- Create: `deploy/migrate.src.mjs`

门户 standalone 镜像不含 drizzle-kit(devDep)。本脚本用 `drizzle-orm` 运行时 migrator(生产依赖);构建期由 esbuild 打成自包含 `migrate.cjs`(Task 3),`@libsql/client` 保持 external(门户运行时本就依赖它,必在 standalone 内)。

- [ ] **Step 1: 创建 `deploy/migrate.src.mjs`**

```javascript
// 运行时数据库迁移：对 SQLite 文件建表/补结构。
// 由 Docker 构建期 esbuild 打包为 deploy/migrate.cjs，容器 entrypoint 在起服务前执行。
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL is not set');
  process.exit(1);
}

const migrationsFolder = process.env.MIGRATIONS_DIR || './migrations_sqlite';
const client = createClient({ url });
const db = drizzle({ client });

try {
  await migrate(db, { migrationsFolder });
  console.log('[migrate] migrations applied');
  process.exit(0);
} catch (err) {
  console.error('[migrate] migration failed:', err);
  process.exit(1);
}
```

- [ ] **Step 2: 本机冒烟验证脚本逻辑正确(用临时 sqlite 文件)**

Run:
```bash
DATABASE_URL=file:/tmp/apipool-migrate-test.db MIGRATIONS_DIR=./src/config/db/migrations_sqlite \
  node_modules/.bin/esbuild deploy/migrate.src.mjs --bundle --platform=node --format=cjs --external:@libsql/client --outfile=/tmp/migrate.test.cjs \
  && DATABASE_URL=file:/tmp/apipool-migrate-test.db MIGRATIONS_DIR=./src/config/db/migrations_sqlite node /tmp/migrate.test.cjs \
  && node -e "const{createClient}=require('@libsql/client');(async()=>{const c=createClient({url:'file:/tmp/apipool-migrate-test.db'});const r=await c.execute(\"select name from sqlite_master where type='table' limit 5\");console.log('tables:',r.rows.map(x=>x.name))})()"
```
Expected: 打印 `[migrate] migrations applied`,随后列出若干表名(如 `user`、`__drizzle_migrations` 等)。

- [ ] **Step 3: 清理临时文件**

Run:
```bash
rm -f /tmp/apipool-migrate-test.db /tmp/migrate.test.cjs
```

- [ ] **Step 4: Commit**

```bash
git add deploy/migrate.src.mjs
git commit -m "feat(deploy): add runtime sqlite migrator source"
```

---

## Task 3: Dockerfile —— 构建期注入 NEXT_PUBLIC、打包迁移脚本、带入迁移资产

**Files:**
- Modify: `Dockerfile`(整体替换为下方内容)

- [ ] **Step 1: 用以下内容替换 `Dockerfile`**

```dockerfile
FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat && yarn global add pnpm@10

WORKDIR /app

COPY package.json pnpm-lock.yaml* source.config.ts next.config.mjs ./
RUN pnpm i --frozen-lockfile

# Rebuild the source code only when needed
FROM deps AS builder

WORKDIR /app

# NEXT_PUBLIC_* are inlined into the client bundle at build time. Defaults match
# code defaults so CI builds are unaffected; local compose overrides via build.args.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_APIPOOL_API_BASE_URL=https://api.apipool.dev/v1
ARG NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL=gpt-4o-mini
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_APIPOOL_API_BASE_URL=$NEXT_PUBLIC_APIPOOL_API_BASE_URL \
    NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL=$NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL

COPY . .
RUN pnpm build

# Bundle a self-contained SQLite migrator (drizzle-orm bundled in; @libsql/client
# kept external — it is already part of the standalone runtime the portal uses).
RUN node_modules/.bin/esbuild deploy/migrate.src.mjs \
      --bundle --platform=node --format=cjs \
      --external:@libsql/client \
      --outfile=deploy/migrate.cjs

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    mkdir .next && \
    chown nextjs:nodejs .next

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Migration assets (entrypoint runs them only for sqlite/turso providers)
COPY --from=builder --chown=nextjs:nodejs /app/deploy/migrate.cjs ./migrate.cjs
COPY --from=builder --chown=nextjs:nodejs /app/src/config/db/migrations_sqlite ./migrations_sqlite
COPY --from=builder --chown=nextjs:nodejs /app/deploy/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER nextjs

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV MIGRATIONS_DIR=./migrations_sqlite

# entrypoint runs migrations (sqlite/turso) then starts the standalone server
CMD ["./entrypoint.sh"]
```

- [ ] **Step 2: 验证 Dockerfile 引用的文件存在(entrypoint.sh 在 Task 4 创建,先建占位再继续)**

本步只确认 migrations 目录在仓库内:
```bash
ls src/config/db/migrations_sqlite/meta/_journal.json
```
Expected: 路径存在(无报错)。

> 注:`Dockerfile` 的提交放到 Task 4 之后(待 entrypoint.sh 一并提交,避免镜像构建引用缺失文件)。

---

## Task 4: 容器 entrypoint

**Files:**
- Create: `deploy/entrypoint.sh`

- [ ] **Step 1: 创建 `deploy/entrypoint.sh`**

```sh
#!/bin/sh
# 门户容器入口：sqlite/turso 时先建表（失败即中止启动，绝不带空库对外服务），再起服务。
set -e

if [ "${DATABASE_PROVIDER}" = "sqlite" ] || [ "${DATABASE_PROVIDER}" = "turso" ]; then
  echo "[entrypoint] applying SQLite migrations to ${DATABASE_URL}"
  node migrate.cjs
fi

exec node server.js
```

- [ ] **Step 2: 赋可执行位(便于本地查看;镜像内 Dockerfile 也会 chmod)**

Run:
```bash
chmod +x deploy/entrypoint.sh && head -1 deploy/entrypoint.sh
```
Expected: 打印 `#!/bin/sh`。

- [ ] **Step 3: Commit(Dockerfile + entrypoint 一起提交)**

```bash
git add Dockerfile deploy/entrypoint.sh
git commit -m "feat(deploy): migrate-on-startup entrypoint and build-time NEXT_PUBLIC args"
```

---

## Task 5: docker-compose.yml

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: 创建 `docker-compose.yml`**

```yaml
name: apipool-v2

services:
  apipool-v2:
    build:
      context: .
      args:
        NEXT_PUBLIC_APP_URL: ${NEXT_PUBLIC_APP_URL}
        NEXT_PUBLIC_APIPOOL_API_BASE_URL: ${NEXT_PUBLIC_APIPOOL_API_BASE_URL}
        NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL: ${NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL}
    # 未来服务器：改用 CI 镜像替代本地 build
    # image: ghcr.io/afreecoder/apipool-v2:latest
    env_file:
      - .env.deploy
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - ./data/portal:/data
    depends_on:
      - new-api
    restart: unless-stopped

  new-api:
    image: calciumion/new-api:latest
    # 本地发布到 127.0.0.1:3001：既是 /v1 网关（供 curl），也是管理后台（加渠道）
    ports:
      - "127.0.0.1:3001:3000"
    volumes:
      - ./data/new-api:/data
    restart: unless-stopped
```

- [ ] **Step 2: 校验 compose 文件语法(需要 .env.deploy 占位变量;先建空 data 目录)**

Run:
```bash
mkdir -p data/portal data/new-api
cp -n .env.deploy.example .env.deploy
docker compose --env-file .env.deploy config >/dev/null && echo "compose OK"
```
Expected: 打印 `compose OK`(校验通过;此时 .env.deploy 仍是占位,后续 Task 7 填密钥)。

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(deploy): docker-compose for apipool-v2 portal + new-api"
```

---

## Task 6: New API 引导脚本(初始化 root + 取 admin token)

**Files:**
- Create: `deploy/newapi-token.sh`

全新 New API 实例必须先 `POST /api/setup` 建 root,再 `POST /api/user/login` 拿 cookie,带 `New-Api-User: 1` 调 `GET /api/user/token` 取 access token(重新生成语义)。

- [ ] **Step 1: 创建 `deploy/newapi-token.sh`**

```bash
#!/usr/bin/env bash
# 初始化 New API root 并打印管理员 access token（写入 .env.deploy 的 NEWAPI_ADMIN_TOKEN）。
# 依赖 .env.deploy 中的 NEWAPI_ROOT_USER / NEWAPI_ROOT_PASS（密码限 8-20 字符）。
set -euo pipefail

BASE="${NEWAPI_LOCAL_URL:-http://localhost:3001}"
ROOT_USER="${NEWAPI_ROOT_USER:-root}"
: "${NEWAPI_ROOT_PASS:?set NEWAPI_ROOT_PASS (8-20 chars) in env}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

# 1) 初始化 root（已初始化则忽略报错）
curl -s -X POST "$BASE/api/setup" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ROOT_USER\",\"password\":\"$NEWAPI_ROOT_PASS\",\"confirmPassword\":\"$NEWAPI_ROOT_PASS\"}" \
  >/dev/null || true

# 2) 登录拿 cookie 会话
curl -s -c "$JAR" -X POST "$BASE/api/user/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ROOT_USER\",\"password\":\"$NEWAPI_ROOT_PASS\"}" >/dev/null

# 3) 取 admin access token（带 New-Api-User: 1；重新生成语义）
TOKEN="$(curl -s -b "$JAR" -H 'New-Api-User: 1' "$BASE/api/user/token" | sed -n 's/.*"data":"\([^"]*\)".*/\1/p')"

if [ -z "$TOKEN" ]; then
  echo "ERROR: failed to obtain admin access token from $BASE/api/user/token" >&2
  exit 1
fi
echo "$TOKEN"
```

- [ ] **Step 2: 赋可执行位并语法检查**

Run:
```bash
chmod +x deploy/newapi-token.sh && bash -n deploy/newapi-token.sh && echo "syntax OK"
```
Expected: 打印 `syntax OK`。

- [ ] **Step 3: Commit**

```bash
git add deploy/newapi-token.sh
git commit -m "feat(deploy): newapi bootstrap script (setup root + admin token)"
```

---

## Task 7: 引导手册 deploy/bootstrap.md

**Files:**
- Create: `deploy/bootstrap.md`

- [ ] **Step 1: 创建 `deploy/bootstrap.md`**

````markdown
# 最小部署引导手册

两个服务:门户 `apipool-v2`(:3000)+ New API(:3001)。全程在本机,均绑 `127.0.0.1`。

## 0. 准备

```bash
mkdir -p data/portal data/new-api
cp -n .env.deploy.example .env.deploy
# 生成两个密钥并手动填入 .env.deploy 的 AUTH_SECRET / APIPOOL_CREDENTIALS_SECRET
openssl rand -base64 32   # -> AUTH_SECRET
openssl rand -base64 32   # -> APIPOOL_CREDENTIALS_SECRET
# 设置 NEWAPI_ROOT_PASS（8-20 字符）
```

## 1. 起 New API

```bash
docker compose --env-file .env.deploy up -d new-api
# 等健康（公开接口）
until curl -sf http://localhost:3001/api/status >/dev/null; do sleep 2; done
curl -s http://localhost:3001/api/status | head -c 200; echo
```

## 2. 初始化 root + 取 admin token

```bash
set -a; . ./.env.deploy; set +a   # 载入 NEWAPI_ROOT_USER/PASS
TOKEN="$(./deploy/newapi-token.sh)"
echo "admin token = $TOKEN"
# 把它写回 .env.deploy 的 NEWAPI_ADMIN_TOKEN=
```

## 3. 在 New API 配真实上游渠道

浏览器开 `http://localhost:3001` 用 root 登录 → 渠道 → 新建:
- 类型:OpenAI
- 名称:apipool-upstream
- 代理/BaseURL:`https://apipool.dev`
- 模型:`gpt-5.4-mini`
- 密钥:你的测试 key

或用 API(把 `$TOKEN` 换成上一步的 token):
```bash
curl -s -X POST http://localhost:3001/api/channel/ \
  -H "Authorization: Bearer $TOKEN" -H 'New-Api-User: 1' -H 'Content-Type: application/json' \
  -d '{"name":"apipool-upstream","type":1,"base_url":"https://apipool.dev","models":"gpt-5.4-mini","key":"<你的测试 key>","groups":["default"]}'
```

## 4. 构建并起门户

```bash
docker compose --env-file .env.deploy up -d --build
docker compose logs -f apipool-v2   # 看到 [entrypoint] applying SQLite migrations 与 server 启动
```

## 5. 走闭环验收

见仓库 spec 第 7 节,或本计划 Task 9。

## 后验(等有 Stripe 账户)

门户后台启用 Stripe 填测试密钥 → `stripe listen --forward-to http://localhost:3000/api/payment/notify/stripe` → 把 `whsec_...` 填进后台 `stripe_signing_secret`。
````

- [ ] **Step 2: Commit**

```bash
git add deploy/bootstrap.md
git commit -m "docs(deploy): minimal deployment bootstrap runbook"
```

---

## Task 8: 实际起服务 + 初始化 New API + 配渠道

> 这一步执行引导手册,产生真实运行的本地环境。需要 .env.deploy 已填好密钥与 `NEWAPI_ROOT_PASS`,以及用户的真实上游 key。

- [ ] **Step 1: 准备 data 目录与 .env.deploy(填密钥)**

Run:
```bash
mkdir -p data/portal data/new-api
test -f .env.deploy || cp .env.deploy.example .env.deploy
```
然后编辑 `.env.deploy`:`AUTH_SECRET` / `APIPOOL_CREDENTIALS_SECRET` 各填 `openssl rand -base64 32`;`NEWAPI_ROOT_PASS` 填 8-20 字符。

- [ ] **Step 2: 起 New API 并等健康**

Run:
```bash
docker compose --env-file .env.deploy up -d new-api
until curl -sf http://localhost:3001/api/status >/dev/null; do echo "waiting new-api..."; sleep 2; done
curl -s http://localhost:3001/api/status
```
Expected: 返回 JSON 含 `"success":true` 与 `quota_per_unit`。

- [ ] **Step 3: 初始化 root 并取 admin token,写回 .env.deploy**

Run:
```bash
set -a; . ./.env.deploy; set +a
TOKEN="$(./deploy/newapi-token.sh)"
echo "len=${#TOKEN} token=$TOKEN"
# 写回（macOS sed -i ''）
sed -i '' "s|^NEWAPI_ADMIN_TOKEN=.*|NEWAPI_ADMIN_TOKEN=$TOKEN|" .env.deploy
grep '^NEWAPI_ADMIN_TOKEN=' .env.deploy
```
Expected: token 长度约 32,且已写回 .env.deploy。

- [ ] **Step 4: 配置真实上游渠道**

Run(把 `<KEY>` 换成用户测试 key):
```bash
curl -s -X POST http://localhost:3001/api/channel/ \
  -H "Authorization: Bearer $TOKEN" -H 'New-Api-User: 1' -H 'Content-Type: application/json' \
  -d '{"name":"apipool-upstream","type":1,"base_url":"https://apipool.dev","models":"gpt-5.4-mini","key":"<KEY>","groups":["default"]}'
```
Expected: 返回 `"success":true`。若失败,改用 `http://localhost:3001` UI 手动建渠道(类型 OpenAI、BaseURL `https://apipool.dev`、模型 `gpt-5.4-mini`)。

- [ ] **Step 5: 构建并起门户**

Run:
```bash
docker compose --env-file .env.deploy up -d --build
docker compose ps
docker compose logs --since 2m apipool-v2 | grep -E "\[entrypoint\]|migrations applied|server" | head
```
Expected: `apipool-v2` 与 `new-api` 均 `Up`;日志出现 `[entrypoint] applying SQLite migrations` 与 `[migrate] migrations applied`。

---

## Task 9: 闭环验收(spec 第 7 节)

> 不可跳步:前步失败不被后步通过替代。

- [ ] **Step 1: 健康**

Run:
```bash
curl -s -o /dev/null -w "newapi=%{http_code}\n" http://localhost:3001/api/status
curl -s -o /dev/null -w "portal=%{http_code}\n" http://localhost:3000/
```
Expected: `newapi=200` 且 `portal=200`。

- [ ] **Step 2: 注册 → 绑定**

用浏览器开 `http://localhost:3000/sign-up` 注册一个普通用户(邮箱 + 密码),完成后:
```bash
# 在 New API 后台核对该用户已被 bridge 自动创建
curl -s -H "Authorization: Bearer $TOKEN" -H 'New-Api-User: 1' \
  "http://localhost:3001/api/user/search?keyword=<注册邮箱前缀>" | head -c 400; echo
```
Expected: New API 用户列表中出现与门户注册对应的新用户。

- [ ] **Step 3: 调额(New API 后台加额度)→ 控制台余额一致**

在 `http://localhost:3001` 后台给该用户加额度(如 +$1 → quota +500000),回到门户控制台余额页刷新。
Expected: 门户余额经 bridge 读取显示与所加额度一致(允许少量聚合延迟,刷新后一致)。

- [ ] **Step 4: 建 Key**

门户控制台「API Keys」创建一个 Key,复制明文(形如 `sk-...`)。
Expected: 明文仅展示一次,列表里其余位置为掩码。

- [ ] **Step 5: 调用 → 真返回**

Run(把 `<SK>` 换成上一步明文 Key):
```bash
curl -s http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer <SK>" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.4-mini","messages":[{"role":"user","content":"reply with: ok"}],"max_tokens":16}' \
  -w "\n---HTTP %{http_code}---\n"
```
Expected: HTTP 200,返回含 `"content":"ok"`(或相近);门户用量页随后出现该次调用日志。

- [ ] **Step 6: 禁用 Key → 401**

门户把该 Key 禁用,再跑一次 Step 5 的 curl。
Expected: 返回 401(鉴权失败)。

- [ ] **Step 7: 记录验收结果**

把六步实际输出贴入 `docs/superpowers/plans/2026-06-13-minimal-deployment.md` 末尾「验收记录」或单独 `.tmp/` 笔记;若任一步失败,转 systematic-debugging。

---

## Task 10: 收尾

- [ ] **Step 1: 确认无密钥入库**

Run:
```bash
git status --porcelain
git ls-files | grep -E "\.env\.deploy$|^data/" && echo "LEAK!" || echo "no secrets tracked"
```
Expected: 打印 `no secrets tracked`;`.env.deploy` 与 `data/` 未被跟踪。

- [ ] **Step 2: 更新 spec 验收状态(可选)**

在 spec 第 7 节标注「本地实测通过(日期)」。

- [ ] **Step 3: Commit(若有 Step 2 改动)**

```bash
git add docs/superpowers/specs/2026-06-13-minimal-deployment-design.md
git commit -m "docs(deploy): mark minimal deployment acceptance verified locally"
```

---

## Spec 覆盖自检

- §3 架构(两服务、内部网络、本地端口 3000/3001)→ Task 5
- §3.1 控制面 vs 数据面 → Task 9 Step 2/5(管理走门户、调用走 :3001)
- §4 产出物(compose / env 模板 / bootstrap / newapi-token / 迁移 entrypoint / gitignore)→ Task 1–7
- §4 迁移并进门户启动(drizzle-orm 运行时 migrator,esbuild 打包,DATABASE_PROVIDER 守卫)→ Task 2/3/4
- §5 配置分层(env 基础设施密钥;Stripe 留空)→ Task 1
- §6 引导顺序 → Task 7/8
- §7 验收 6 步 → Task 9
- §9 风险(启动迁移失败即中止、真实渠道费用、服务隔离)→ Task 4(set -e)、Task 9 Step 5(max_tokens)
- Stripe 后验 → bootstrap.md 末尾「后验」段(本次不执行)
