# APIPool 域名迁移 · 实施计划

日期：2026-06-30

## 执行原则

- 只合入本次域名迁移相关改动，不夹带主工作树中的其它未完成修改。
- 公开 API Endpoint 保持 provider-neutral，不带 `/v1`。
- OpenAI-compatible、Anthropic native 等协议路径只在具体调用示例或运行时代码处拼接。
- 过程文档按项目规范放在 `docs/requirements/domain-migration/` 与 `docs/plan/domain-migration/`。

## 任务清单

- [x] 更新 build-time 与 runtime 默认配置：`NEXT_PUBLIC_APP_URL=https://app.apipool.dev`，`NEXT_PUBLIC_APIPOOL_API_BASE_URL=https://api2.apipool.dev`。
- [x] 更新 Caddy 配置脚本，分别反代门户、用户 API Endpoint 和 New API 管理面。
- [x] 更新 smoke、模型目录 quickstart 和首页代码示例，使 OpenAI-compatible 路径在调用处追加。
- [x] 更新英文/中文快速接入文档，解释 endpoint 与 provider 协议路径的区别。
- [x] 更新 README、产品定位、MVP、New API 契约、运维手册和发布手册。
- [x] 新增本需求文档和中文实施计划。
- [x] 补充测试，守住公开 endpoint 不带 `/v1` 的约束。

## 发布验证

- [x] `git status -sb`
- [x] `git branch --show-current`
- [x] `git log --oneline --decorate -n 5`
- [x] `pnpm exec tsc --noEmit --pretty false`
- [x] `pnpm test`
- [x] `pnpm lint`
- [x] `pnpm build`
- [x] `pnpm smoke:mvp`（本地缺 live 凭据，命令成功并按设计跳过）
- [x] `docker compose --env-file deploy/env.production.example --env-file <release-env> -f docker-compose.prod.yml config`
- [ ] 推送到 `origin/main` 后跟踪 GitHub Actions 与生产运行态。
