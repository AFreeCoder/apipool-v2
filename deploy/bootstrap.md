# 最小部署引导手册

两个服务:门户 `apipool-v2`(:3000)+ New API(:3001)。全程在本机,均绑 `127.0.0.1`。
所有 compose 命令都带 `--env-file .env.deploy`(供构建期 `NEXT_PUBLIC_*` 注入与运行期 env)。

## 0. 准备

```bash
mkdir -p data/portal data/new-api
cp -n .env.deploy.example .env.deploy
# 生成两个密钥并填入 .env.deploy 的 AUTH_SECRET / APIPOOL_CREDENTIALS_SECRET
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
# 写回 .env.deploy（macOS）
sed -i '' "s|^NEWAPI_ADMIN_TOKEN=.*|NEWAPI_ADMIN_TOKEN=$TOKEN|" .env.deploy
```

## 3. 在 New API 配真实上游渠道

浏览器开 `http://localhost:3001` 用 root 登录 → 渠道 → 新建:
- 类型:OpenAI
- 名称:apipool-upstream
- 代理/BaseURL:`https://apipool.dev`
- 模型:`gpt-5.4-mini`
- 密钥:你的测试 key

或用 API(`$TOKEN` 为上一步 token):
```bash
curl -s -X POST http://localhost:3001/api/channel/ \
  -H "Authorization: Bearer $TOKEN" -H 'New-Api-User: 1' -H 'Content-Type: application/json' \
  -d '{"name":"apipool-upstream","type":1,"base_url":"https://apipool.dev","models":"gpt-5.4-mini","key":"<你的测试 key>","groups":["default"]}'
```

## 4. 构建并起门户

```bash
docker compose --env-file .env.deploy up -d --build
docker compose --env-file .env.deploy logs -f apipool-v2   # 看到 [entrypoint] applying SQLite migrations 与 server 启动
```

## 5. 走闭环验收

见仓库 spec 第 7 节,或实现计划 Task 9:健康 → 注册绑定 → New API 调额 → 建 Key → curl 真返回 → 禁用 Key 后 401。

## 后验(等有 Stripe 账户)

门户后台启用 Stripe 填测试密钥 → `stripe listen --forward-to http://localhost:3000/api/payment/notify/stripe` → 把 `whsec_...` 填进后台 `stripe_signing_secret`。
