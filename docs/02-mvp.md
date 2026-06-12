# 02 MVP 定义

## 1. MVP 是什么

MVP 是一个**垂直闭环切片**，而不是一组展示页面。验收只看一条线能否走通：

```
注册 → 充值（真实支付） → 创建 Key → 真实调用模型 → 控制台看到用量和余额变化
```

任何不在这条线上的功能，默认不进 MVP。

## 2. 核心决策

| 决策点 | 结论 |
|---|---|
| 付费形态 | 充值美元余额、按量扣费（对齐 New API quota 机制） |
| 支付渠道 | Stripe + Creem 双接（模板现成），账号并行申请、先批先用 |
| 首批模型 | OpenAI + Anthropic 提供商分组，至少 1 个模型真实可调 |
| 品牌 | APIPool / `apipool.dev`，Logo 与主色不阻塞上线（视觉规范见 05-design-system.md） |
| 后台 | New API 承担网关职责，对用户完全隐藏（契约见 04-newapi-contract.md） |

## 3. 页面范围（5 个）

| # | 页面 | 路由 | 信息架构 |
|---|------|------|---------|
| 1 | 首页 | `/` | 首屏：一句话价值主张 + Base URL/curl 代码块 + 主 CTA（进控制台/看文档）；第二屏：模型价格表节选（指向 /models）；第三屏：接入三步（注册→充值→调用）；页脚 |
| 2 | 模型/价格页 | `/models` | 一张数据密集的清单表：模型 ID、提供商、能力、输入/输出价格（官方价对比）、状态。支持按提供商/能力筛选。**不做每模型详情页** |
| 3 | 快速接入文档 | `/docs` | 一页真正可用的接入文档：Base URL、鉴权方式、curl/JS/Python 示例、OpenAI SDK 兼容说明、常见错误码 |
| 4 | 控制台 | `/dashboard` | 三个区块（tab 或子页）：**Keys**（列表/创建/复制/禁用/删除）、**充值**（套餐选择 → checkout → 余额展示与充值记录）、**用量**（请求数/Token/消费、模型分布、最近日志） |
| 5 | 登录注册 | `/sign-in` `/sign-up` | 模板现成，仅换肤 |

辅助路由：法律页（隐私/条款，模板现成）、admin 运营后台（调额/对账，不对用户暴露）。

历史路由处理：`/pricing`、`/blog/*`、`/updates`、`/showcases`、`/models/[slug]` 全部 redirect 到保留页面，防死链（守护测试：`tests/public-content/legacy-public-routes.test.ts`）。

## 4. 用户故事（验收视角）

1. 新访客在首页 30 秒内理解"一个端点接入多个模型"，并能找到价格表和文档。
2. 开发者在 `/models` 看到模型清单与价格，在 `/docs` 复制示例代码即可接入。
3. 新用户注册后，在控制台用测试卡（上线后真实卡）充值 $5，余额立即可见。
4. 用户创建 Key，用 `https://api.apipool.dev/v1` 真实调用至少一个模型成功。
5. 调用后，用量页能看到请求数、Token、消费日志；余额相应减少。
6. 用户禁用 Key 后，同一 Key 调用被拒绝。

## 5. 明确不做（MVP 范围外清单）

- 每模型独立详情页（`/models/[slug]` 保留 redirect）
- 订阅套餐制（charge 一次性充值之外的付费形态）
- 博客、SEO 内容矩阵、案例展示页
- Playground / 在线调试
- 用量导出、复杂账单明细、发票
- 团队/组织账户
- 邀请返佣
- 现有 APIPool 用户迁移
- 用户可见的 New API 任何痕迹（文案、域名、错误信息——守护测试：`tests/public-content/locale-copy.test.ts`）

## 6. 验收标准

产品验收：第 4 节用户故事全部走通，全程无人工介入（运营调额仅作为支付故障的兜底，不在主路径上）。

技术验收：

- `pnpm test` / `pnpm lint` / `pnpm build` 全绿。
- 支付幂等：同一 webhook 重放多次，只入账一次、只加额一次。
- New API 故障时支付不丢账：本地账本停 pending，恢复后可重试补加额（见 06-payments-ledger.md）。
- 浏览器侧永不出现 `newapiUserId`、`newapiKeyId`、admin token、内部域名。
- 视觉验收：5 个页面逐页通过 05-design-system.md 的 checklist，首页与控制台由产品负责人（用户本人）确认。
