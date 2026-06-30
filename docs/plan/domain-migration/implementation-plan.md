# APIPool 域名迁移实施计划

> **给 agentic worker 的要求：** 实施本计划时使用 `superpowers:executing-plans`，按任务逐项执行；步骤使用 checkbox 追踪。

**目标：** 基于 `docs/requirements/domain-migration/requirements.md`，把 APIPool v2 的仓库默认配置、部署 DNS 指引和公开站点内容调整为迁移期拓扑。

**架构：** 老站排空期内，v2 独立运行在 `app.apipool.dev`（门户 / 登录 / 控制台 / 支付回调）和 `api2.apipool.dev`（用户 API endpoint）。`apipool.dev` 与 `api.apipool.dev` 在 cutover 前继续归老站，v2 文档不得引导新增用户调用 `api.apipool.dev`。公开 API endpoint 只写域名，不把 OpenAI-compatible `/v1` 或其他 provider 协议路径固化进 endpoint。

**技术栈：** Next.js、Docker、GitHub Actions、Caddy、New API、Node.js test runner。

---

## 文件范围

- 新增：`docs/plan/domain-migration/implementation-plan.md`
- 修改：`.env.example`
- 修改：`.github/workflows/docker-build.yaml`
- 修改：`Dockerfile`
- 修改：`deploy/env.production.example`
- 修改：`deploy/configure-caddy.sh`
- 修改：`README.md`
- 修改：`docs/01-product.md`
- 修改：`docs/02-mvp.md`
- 修改：`docs/04-newapi-contract.md`
- 修改：`docs/07-runbook.md`
- 修改：`docs/deployment.md`
- 修改：`src/config/index.ts`
- 修改：`src/config/apipool/public.ts`
- 修改：`src/app/[locale]/(landing)/page.tsx`
- 修改：`content/docs/index.mdx`
- 修改：`content/docs/index.zh.mdx`
- 修改：`tests/deploy/deploy-automation.test.ts`
- 修改：`tests/config/apipool-public-config.test.ts`

### Task 1：运行时与部署默认值

- [x] 更新构建期和运行期公开默认值：
  - `NEXT_PUBLIC_APP_URL` 生产值为 `https://app.apipool.dev`。
  - `NEXT_PUBLIC_APIPOOL_API_BASE_URL` 生产 / 默认公开值为 `https://api2.apipool.dev`，不带 `/v1`。
  - `NEXT_PUBLIC_APIPOOL_SITE_URL=https://apipool.dev` 保持不变，因为排空期根域 SEO 仍由老站保温。
- [x] 更新 Caddy 生成脚本：
  - `app.apipool.dev` 反代到门户。
  - `api2.apipool.dev` 反代到 New API 用户 API。
  - `newapi.apipool.dev` 保持为仅运营访问的 New API 管理面，并加 `X-Robots-Tag: noindex, nofollow`。
- [x] 先更新测试断言，确认旧实现会失败。
- [x] 执行配置与部署相关测试。

### Task 2：公开站点内容

- [x] 将公开 quickstart 的 endpoint 写为 `https://api2.apipool.dev`。
- [x] 具体协议路径只在示例调用里出现：
  - OpenAI-compatible：`/v1/chat/completions`、`/v1/models`。
  - Anthropic / 其他 provider-native：按对应协议路径追加。
- [x] 保持 `apipool.dev` 在 sitemap / canonical 配置中不变。
- [x] 执行公开内容相关测试。

### Task 3：常青文档对齐

- [x] 更新常青文档，描述迁移期拓扑：
  - `docs/deployment.md`
  - `docs/07-runbook.md`
  - `docs/01-product.md`
  - `docs/02-mvp.md`
  - `docs/04-newapi-contract.md`
  - `README.md`
- [x] 记录当前应配置的 DNS：
  - `app.apipool.dev` 指向 v2 VPS。
  - `api2.apipool.dev` 指向 v2 VPS。
  - `newapi.apipool.dev` 指向 v2 VPS，仅运营访问。
  - `apipool.dev` 和 `api.apipool.dev` 在 cutover 前继续指向老站。
- [x] 扫描 v2-facing 的 `api.apipool.dev`、旧 `new` 子域，以及把 `api2` endpoint 与 `/v1` 协议路径错误固化在一起的残留引用。

```bash
rg -n "new\\.apipool\\.dev|api\\.apipool\\.dev|api2\\.apipool\\.dev|app\\.apipool\\.dev" README.md docs deploy .github Dockerfile src content tests .env.example
```

### Task 4：最终验证

- [x] 执行定向测试：

```bash
pnpm test tests/deploy/deploy-automation.test.ts tests/config/apipool-public-config.test.ts tests/api-catalog/catalog.test.ts tests/smoke/mvp-smoke-script.test.ts tests/public-content/indexing.test.ts tests/public-content/locale-copy.test.ts
```

- [x] 执行 TypeScript 与脚本语法检查。
- [x] 确认剩余 `api.apipool.dev` 只出现在老站保护、cutover 或需求说明里，不再作为 v2 迁移期新增用户入口。
