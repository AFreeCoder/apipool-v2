# NewAPI 受控模型元数据过滤器测试报告

测试日期：2026-07-11（America/Los_Angeles）

## 覆盖结果

| 场景 | 结果 | 证据 |
|---|---|---|
| 策略加载 | 通过 | 拒绝空白白名单、重复供应商及越权排除项。 |
| 上游读取 | 通过 | 覆盖 HTTP 非 200、`success=false`、非法 JSON、响应体超限及正常响应。 |
| 过滤规则 | 通过 | 非官方供应商、`Alibaba/deepseek-r1`、无图标供应商被拒绝；重名 `model_name` 返回错误。 |
| HTTP 合约 | 通过 | 两个 NewAPI 兼容 endpoint 返回 envelope；重名返回 502 和 `duplicate_model_name`。 |
| 镜像 | 通过 | 多阶段镜像以非 root 用户启动，`/healthz` 返回 200。 |
| Compose | 通过 | 过滤器无发布端口，NewAPI 依赖其健康状态并使用内部 `SYNC_UPSTREAM_BASE`。 |
| 真实公共源 | 通过 | 过滤后得到 229 个模型；未发现 OpenCode Zen、Vivgrid 或 `Alibaba/deepseek-r1`。 |
| 本地 NewAPI 网络联调 | 通过 | 临时 NewAPI 在 `127.0.0.1:3002` 返回 `/api/status` 200，容器内可经过滤器读取模型数据。 |

## 执行的关键命令

```bash
cd services/newapi-metadata-filter && go test ./...
pnpm exec tsx --test tests/deploy/newapi-metadata-filter-compose.test.ts
pnpm exec tsx --test tests/deploy/newapi-metadata-filter-deploy.test.ts
docker build -t apipool/newapi-metadata-filter:test services/newapi-metadata-filter
docker compose config
```

完整项目门禁也已执行：`pnpm exec tsc --noEmit --pretty false`、`pnpm test`、
`pnpm lint`、`pnpm build` 与 `pnpm smoke:mvp`。类型检查、测试与构建通过；lint 为
仓库既有的 195 条 warning、0 error。`smoke:mvp` 因本地缺少 live smoke 所需密钥和
用户 ID 而按项目既有行为跳过。

真实公共源验证使用容器内请求
`/api/newapi/models.json`。该服务没有缓存；一次验证成功不替代后续同步前的预览。

## 限制与后续验收

本地临时 NewAPI 处于未初始化状态，未执行控制台“同步上游”写入元信息表。该操作需要在
具有管理员登录态且确认可修改目标数据库的环境中，先预览供应商、图标与标签，再明确执行。
数据面渠道转发未被本服务修改；本地联调只验证了 NewAPI 到过滤器的控制面网络路径。
