# 生产源站入口安全边界设计

## 架构

```text
客户 API 请求 ── DNS-only ────────────────┐
                                           │ api2:443 /v1*
浏览器/运营 ── Cloudflare HTTP Proxy ──────┼─> Caddy ─> 127.0.0.1:3000/3001
                                           │ app/newapi:443
GitHub 托管 Runner ── build/push GHCR      │
GitHub Actions ── outbound job channel ─> VPS deploy Runner ─> deploy.sh
owner 固定公网 CIDR ── TCP 22222 ──────────┘
```

同一公网 IP 的 443 必须对 `api2` 客户开放，因此网络层不能按域名区分。Caddy 使用
TLS SNI/HTTP Host 选中站点后执行各自的访问规则。

## Caddy 边界

仓库维护一份从 Cloudflare 官方 `ips-v4` / `ips-v6` 获取并人工核对的 CIDR 文件。
`deploy/configure-caddy.sh` 在生成配置时读取并校验该文件：

- 文件缺失、为空或出现非法 CIDR 时 fail-closed，部署退出 78。
- `app.apipool.dev` 与 `newapi.apipool.dev` 使用 `remote_ip` 检查 TCP 直接对端。
- 直接对端不在 Cloudflare CIDR 时返回 403。
- 不使用客户端可伪造的 `X-Forwarded-For` 作为源站 Cloudflare 身份判断。
- `api2.apipool.dev` 不套用 Cloudflare CIDR，仅保留 `/v1*` 路径白名单。

该方案兼容生产当前 Caddy 2.6.2，不依赖新版本的 `trusted_proxies_strict`。
Cloudflare CIDR 不在部署时动态下载，避免 Cloudflare 列表端点故障阻断正常发布；更新
采用“先添加、验证、再删除”的版本化变更流程。

## GitHub 部署边界

`docker-build.yaml` 保持两个 job：

1. `build-and-push` 继续运行在 `ubuntu-latest`，构建门户与元数据过滤器镜像并推送
   GHCR。
2. `deploy-production` 只在 push 到 `main` 时运行，改为使用 VPS 上带专用标签的
   repository-level self-hosted Runner。

专用 Runner：

- 注册到私有仓库 `AFreeCoder/apipool-v2`，不共享给其他仓库。
- 作为独立非登录用户运行并由 systemd 管理，只需要出站 TCP 443。
- 使用唯一标签 `apipool-prod-deploy`；PR 和验证 workflow 保持 `ubuntu-latest`。
- 保持 Runner 自动更新，避免版本超过 GitHub 支持窗口。
- 不把 Runner 用户直接加入 `docker` 组；通过 root-owned、固定路径的 sudo 包装器
  执行部署。
- nftables 按 Runner UID 限制其网络出口只允许 DNS 与 HTTPS，并显式拒绝云主机
  link-local metadata 网段；root 包装器启动的 Docker 拉取不受该 UID 规则影响。

root 包装器只接受三个输入：checkout 工作目录、`sha-<40 hex>` 镜像标签和 GHCR
用户名。它必须：

- 校验工作目录位于专用 Runner 的 `_work` 目录。
- 校验 checkout HEAD 与镜像 tag 完全一致。
- 只调用 VPS 上已由 owner 经 SSH 安装、root 持有且不可被组/其他用户写入的固定
  `docker-compose.prod.yml` 与 `deploy/` 工具链；workflow checkout 不能覆盖生产脚本。
- 从标准输入接收短期 `GITHUB_TOKEN`，只用于本次 GHCR 登录，退出时注销。
- 调用现有 `deploy/deploy.sh`；备份、Caddy 校验、容器切换、健康检查与自动回滚继续
  由现有脚本负责。

## 网络与端口边界

| 端口 | 来源 | 处理 |
|---|---|---|
| TCP 80/443、UDP 443 | 公网 | 保留，满足 DNS-only API、HTTPS/HTTP3 与证书续期；域名边界由 Caddy 执行 |
| TCP 22222 | owner 确认的 SSH CIDR | 云防火墙与主机防火墙同时允许 |
| TCP 22 | 无 | 完成 22222 验证后停止监听并拒绝入站 |
| TCP 3000/3001 | loopback | Docker 继续绑定 `127.0.0.1` |
| TCP 2019 | loopback | Caddy admin 继续绑定 `127.0.0.1` |
| 其他入站 | 无 | 默认拒绝 |

ICMP/ICMPv6 保留必要的网络诊断与 PMTU 功能；现有连接在防火墙切换时允许继续。

## DNS 切换

1. 先部署并验证 Caddy Cloudflare ACL。
2. 确认 Caddy 已持有 `api2.apipool.dev` 可续期证书。
3. 把 `api2` A/AAAA 记录设为 DNS-only；`app/newapi` 保持 proxied。
4. 验证 `api2` 响应不再包含 Cloudflare 链路标识，路径和 API Key 行为保持不变。

## 故障与回滚

- Runner 切换失败：恢复 workflow 的 SSH deploy job；在公网 SSH 关闭前完成过渡验证。
- Caddy ACL 误伤：恢复 `/etc/caddy/Caddyfile.bak` 并 reload。
- DNS-only 失败：把 `api2` 恢复为 proxied，并记录 524 风险恢复。
- SSH 防火墙误配：应用前保留活动 SSH 会话和腾讯云控制台，设置定时回滚；验证新会话
  成功后再取消回滚。
- 新镜像健康失败：沿用 `deploy.sh` 自动恢复上一 `IMAGE_TAG`。

## 安全残余风险

- `api2` DNS-only 必然公开 VPS IP，443 仍可被扫描或消耗 TLS/Caddy 资源。
- 私有仓库 `main` workflow 对生产部署具有高信任。当前 GitHub Free 私有仓库无法启用
  required reviewer/branch protection；任何具备 write 权限的协作者都具有生产发布能力。
  上线前必须由 owner 明确确认该信任关系，或先降权/升级 GitHub 方案并启用保护。
- 自托管 Runner 不是一次性隔离环境。即使 root 工具链固定且本机出口受限，也不得让
  PR job、任意仓库或不可信 workflow 使用 `apipool-prod-deploy` 标签。
- owner SSH 公网地址若变化，严格 `/32` 白名单会阻断新连接；变更前必须先更新云端和
  主机两层规则。
