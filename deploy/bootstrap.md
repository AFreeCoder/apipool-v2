# 最小部署引导手册

三个服务：门户 `apipool-v2`（:3000）、New API（:3001）和仅在 Compose 内网监听的
`newapi-metadata-filter`（:8080）。全程在本机；只有前两个服务绑定 `127.0.0.1`。
所有 compose 命令都带 `--env-file .env.deploy`(供构建期 `NEXT_PUBLIC_*` 注入与运行期 env)。

## 0. 准备

```bash
mkdir -p data/portal data/new-api
# 门户容器以 uid 1001(nextjs)运行，需能写 bind-mount 的 portal 库（Linux 上必做，
# 否则建库报 SQLITE_CANTOPEN；macOS Docker Desktop 会自动映射 uid，可跳过）
sudo chown -R 1001:1001 ./data/portal
cp -n .env.deploy.example .env.deploy
# 生成两个密钥并填入 .env.deploy 的 AUTH_SECRET / APIPOOL_CREDENTIALS_SECRET
openssl rand -base64 32   # -> AUTH_SECRET
openssl rand -base64 32   # -> APIPOOL_CREDENTIALS_SECRET
# 设置 NEWAPI_ROOT_PASS（8-20 字符）
```

> 注:门户 `restart: unless-stopped` + 启动迁移失败即退出 = 若迁移持续失败会无限重启。排障时先看 `docker compose --env-file .env.deploy logs apipool-v2`,定位 `[migrate] migration failed` 后再修,必要时临时改 `restart: "no"`。

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
- 模型:`gpt-5.4-mini,gpt-4o-mini`
- 分组:`official`
- 密钥:你的测试 key

或用 API(`$TOKEN` 为上一步 token)。**注意 New API rc.10 建渠道要 `{"mode":"single","channel":{…}}` 包装**(裸 channel 对象会触发服务端 panic):
```bash
# 1) 启用门户 official 对应的 New API 分组
curl -s -X PUT http://localhost:3001/api/option/ \
  -H "Authorization: Bearer $TOKEN" -H 'New-Api-User: 1' -H 'Content-Type: application/json' \
  -d '{"key":"GroupRatio","value":"{\"default\":1,\"official\":1}"}'

# 2) 建渠道（rc.10 格式）。group 必须包含 official，否则门户 official Key 会创建成功但 /v1 调用无路由。
curl -s -X POST http://localhost:3001/api/channel/ \
  -H "Authorization: Bearer $TOKEN" -H 'New-Api-User: 1' -H 'Content-Type: application/json' \
  -d '{"mode":"single","channel":{"name":"apipool-upstream","type":1,"base_url":"https://apipool.dev","models":"gpt-5.4-mini,gpt-4o-mini","key":"<你的测试 key>","group":"official"}}'

# 3) 开自用模式：否则模型未配价时调用会被拒（model_price_error）
curl -s -X PUT http://localhost:3001/api/option/ \
  -H "Authorization: Bearer $TOKEN" -H 'New-Api-User: 1' -H 'Content-Type: application/json' \
  -d '{"key":"SelfUseModeEnabled","value":"true"}'
```

> 验证渠道:`curl -s -H "Authorization: Bearer $TOKEN" -H 'New-Api-User: 1' "http://localhost:3001/api/channel/test/<渠道id>?model=gpt-5.4-mini"` 返回 `success:true` 即上游可用。若修改已有渠道，需要通过 New API 后台保存渠道或重建 abilities，让 `official` 选路表生效。

## 4. 构建并起门户

```bash
docker compose --env-file .env.deploy up -d --build
docker compose --env-file .env.deploy logs -f apipool-v2   # 看到 [entrypoint] applying SQLite migrations 与 server 启动
```

## 5. 走闭环验收

见仓库 spec 第 7 节,或实现计划 Task 9:健康 → 注册绑定 → New API 调额 → 建 Key → curl 真返回 → 禁用 Key 后 401。

## 后验(等有 Stripe 账户)

门户后台启用 Stripe 填测试密钥 → `stripe listen --forward-to http://localhost:3000/api/payment/notify/stripe` → 把 `whsec_...` 填进后台 `stripe_signing_secret`。
