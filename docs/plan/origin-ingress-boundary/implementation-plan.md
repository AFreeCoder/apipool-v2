# 生产源站入口安全边界实施计划

## 基线与回滚

- [x] 记录 `origin/main`、线上 `IMAGE_TAG`、现有 Runner、Caddy、监听端口和防火墙状态。
- [x] 确认最新生产备份可列出，上一个稳定镜像可恢复。
- [ ] 保存当前 Caddy 与防火墙配置，确认腾讯云控制台救援入口可用。

## 仓库实现

- [x] 加入版本化 Cloudflare IPv4/IPv6 CIDR 文件及格式校验。
- [x] 为 `app/newapi` 生成 Caddy `remote_ip` 源站 ACL，保持 `api2` 公共 `/v1*`。
- [x] 加入 root-owned 部署 Runner 包装器及参数、checkout SHA、GHCR token 校验。
- [x] 固定生产工具链为 owner 经 SSH 安装的 root-owned 副本，workflow 不可覆盖。
- [x] 限制 Runner UID 只能访问 DNS/HTTPS，并拒绝云 metadata 网段。
- [x] 把生产部署 job 切换到 `apipool-prod-deploy`，移除公网 SSH secrets 依赖。
- [x] 更新 `README.md`、`docs/deployment.md` 与 `docs/07-runbook.md` 当前态说明。
- [x] 补齐部署自动化测试、workflow 边界测试和脚本语法检查。

## 本地验证

- [x] 运行 `bash -n`、Caddy 2.6.2 配置校验和 workflow 静态检查。
- [x] 运行 `pnpm exec tsc --noEmit --pretty false`、`pnpm test`、`pnpm lint`、
  `pnpm build`、`pnpm smoke:mvp`。
- [x] 运行生产 Compose 配置渲染。
- [x] 审计 `origin/main..candidate` 的全部提交和文件范围。

## Runner 过渡

- [ ] 确认当前所有 GitHub write 协作者均属于生产发布信任边界；否则先降权或启用付费保护。
- [ ] 在 VPS 安装校验过 SHA-256 的当前 GitHub Actions Runner。
- [ ] 创建独立 Runner 用户、systemd 服务、root 包装器与最小 sudoers 规则。
- [ ] 注册为仓库级 `apipool-prod-deploy` 并确认 online/idle。
- [ ] 在关闭 GitHub SSH 入站前完成一次由新 Runner 执行的生产部署。

## Caddy、DNS 与线上验收

- [ ] 发布候选到 `main` 并监控 build、verify、deploy 三段状态。
- [ ] 验证备份、`release.env`、容器、回环健康与关键日志。
- [ ] 验证经 Cloudflare 的 `app/newapi` 正常，绕过 Cloudflare 直连返回 403。
- [ ] 将 `api2` 切为 DNS-only，验证 401/404、真实调用与非 Cloudflare 链路。
- [ ] 运行 VPS production live smoke。

## SSH 与防火墙收口

- [ ] 获得 owner 明确确认的 SSH CIDR，不以临时动态地址替代。
- [ ] 先在腾讯云防火墙与主机防火墙加入 22222 白名单并验证第二条 SSH 会话。
- [ ] 设置定时自动回滚后停止 SSH 22 监听，默认拒绝其他非 Web 入站。
- [ ] 验证 GitHub 部署仍只走出站 443，再取消自动回滚。
- [ ] 更新最终部署文档、测试报告与遗留风险。
