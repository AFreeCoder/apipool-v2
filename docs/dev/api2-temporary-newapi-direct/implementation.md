# api2 临时直连 New API 实施记录

## 背景

2026-07-16 运营确认：门户尚未准备好，现有单一测试用户使用 New API
原生 Key。`newapi.apipool.dev` 经 Cloudflare 代理时，长耗时图片请求可返回
524；而当前 `api2.apipool.dev` 进入门户网关，既不识别旧 Key，也只支持
端点白名单。

## 实施结论

- `api2.apipool.dev` 继续使用 DNS-only。
- Caddy 将 `api2.apipool.dev/v1*` 的所有路径直接转发到
  New API `127.0.0.1:3001`，不经过门户网关。
- `api2.apipool.dev` 的非 `/v1*` 路径继续固定返回 404，不暴露
  New API 管理面。
- `newapi.apipool.dev/v1*` 继续固定返回 404，只保留受保护的运营面。
- 该直连入口使用 New API 原生鉴权、配额和日志，不经过门户钱包。
- 临时直连期间保持 `APIPOOL_CHECKOUT_ENABLED=false`，不执行门户
  `go-live open-checkout`；否则会出现门户收款但公网 API 绕过门户钱包的计费分裂。

## 后续边界

门户正式 API 将使用回收后的 `api.apipool.dev`。在正式端点、门户 Key
和所需 API 端点全部验收前，不作废临时用户的 New API 原生 Key，也不将
`api2.apipool.dev` 切回门户网关。
