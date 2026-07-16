# 生产源站入口安全边界需求

## 背景

`api2.apipool.dev` 的图片生成请求可能超过 Cloudflare HTTP 代理等待时间并返回 524。
该 API 域名需要切换为 DNS-only，直接访问现有腾讯云 VPS，以避免请求继续受
Cloudflare HTTP 超时约束。

`app.apipool.dev` 与 `newapi.apipool.dev` 仍通过 Cloudflare 代理。当前 GitHub
Actions 的生产部署 job 从标准托管 Runner 通过公网 SSH 进入 VPS，而标准托管
Runner 的出口网段数量大且动态变化，不适合作为长期入站白名单。

## 目标

1. 保持单台 VPS，不新增 CLB、独立反向代理或构建服务器。
2. `api2.apipool.dev` 以 DNS-only 方式公开服务任意合法 API 客户。
3. `api2.apipool.dev` 只暴露 OpenAI-compatible `/v1*` 数据面，不暴露 New API
   管理接口。
4. `app.apipool.dev` 与 `newapi.apipool.dev` 的源站请求只接受 Cloudflare 官方
   HTTP 代理网段，阻止绕过 Cloudflare 的 Host/SNI 直连。
5. GitHub Actions 继续在 GitHub 托管 Runner 构建镜像；VPS 只拉取不可变
   `sha-<commit>` 镜像并部署。
6. GitHub 部署改为 VPS 上的仓库级专用 Runner 主动通过 HTTPS 出站领取任务，取消
   GitHub 托管 Runner 对 VPS 的公网 SSH 入站依赖。
7. SSH 日常运维只保留 `22222`，并在云防火墙与主机防火墙中仅允许 owner 确认的
   SSH 公网 CIDR；验证完成后停止监听 `22`。
8. 门户、New API 与 Caddy 管理端口继续只监听回环地址，不新增公网容器端口。
9. 所有入口收紧步骤都必须具备可验证的备份、自动或人工回滚路径，避免锁死 SSH、
   自动部署或公开 API。

## 非目标

- 不隐藏 `api2.apipool.dev` DNS-only 记录暴露的 VPS 公网 IP。
- 不承诺以单 IP 网络防火墙抵御 `api2` 面向公网后产生的全部 DDoS 风险。
- 不在本轮改造图片生成为异步任务或轮询协议。
- 不把门户或 New API 迁移到 Cloudflare Workers/Tunnel。
- 不在 VPS 本地构建门户或元数据过滤器镜像。

## 业务级约束

- 443 端口由三个域名共用。由于 `api2` 必须接受任意客户来源，网络层不能把整个
  443 端口只限制为 Cloudflare 网段；`app/newapi` 的 Cloudflare 边界必须在 Caddy
  按域名执行。
- Caddy 当前提供 HTTP/3，主机与云防火墙必须同时保留 UDP `443`，不能只放 TCP
  `443` 造成 DNS-only API 客户静默降级。
- 标准 GitHub 托管 Runner 的动态网段不得整体加入 VPS 入站白名单。
- self-hosted Runner 仅用于私有仓库的生产部署 job，不运行 PR、构建、测试或任意
  其他仓库工作负载。
- 生产密钥、Runner 注册 token、SSH 地址白名单和 Cloudflare 凭据不得提交到仓库。

## 验收方向

- GitHub 托管 Runner 成功构建并推送两个 GHCR 镜像。
- 生产部署 job 在专用 VPS Runner 上完成，VPS 无需接受 GitHub Runner 的 SSH 入站。
- 经 Cloudflare 访问 `app/newapi` 正常；绕过 Cloudflare 直连源站时返回 403。
- `api2/v1/models` 无 Key 返回 401，`api2/api/status` 返回 404，且响应链路不再经过
  Cloudflare HTTP 代理。
- `3000/3001/2019` 不对公网监听。
- SSH `22222` 仅允许确认的 CIDR，`22` 不再监听；保留腾讯云控制台救援入口。
- 生产备份、上一个稳定镜像、Caddy 配置备份与防火墙回滚均可用。
