# GPT Image 2 分组接口文档设计

> 状态：已确认并进入实施。
>
> 确认日期：2026-08-20。
>
> 方案记录：[Issue #18](https://github.com/AFreeCoder/apipool-v2/issues/18)。

## 1. 目标与约束

生产目录在“官方分组”和“特惠分组”下都提供同一个公开模型 ID
`gpt-image-2`。文档必须让用户从左侧目录先选择分组，再阅读该分组的模型能力和
计费语义，同时保持下列运行时约束：

- 请求中的模型始终为 `gpt-image-2`，不为不同分组派生新的公开模型 ID。
- 分组由 API Key 在创建时绑定，请求体不接受 `group` 参数。
- 官方分组按可靠的终态 token usage 结算；特惠分组按成功交付图片数与
  `resolution` SKU 结算。
- 两个分组共用 APIPool 的异步图片任务协议。
- 客户文档不暴露上游模型名、上游分组、内部任务 ID、渠道或路由开关。

## 2. 信息架构

Fumadocs 通过目录和本地化 `meta` 文件生成侧边栏，不增加手写 React 导航：

```text
API 文档
├── 快速接入
├── 官方分组（默认展开）
│   └── GPT Image 2
├── 特惠分组（默认展开）
│   └── GPT Image 2
└── 通用参考
    └── 图片异步任务
```

英文路由与中文路由分别为：

| 内容         | 英文                         | 中文                            |
| ------------ | ---------------------------- | ------------------------------- |
| 官方分组模型 | `/docs/official/gpt-image-2` | `/zh/docs/official/gpt-image-2` |
| 特惠分组模型 | `/docs/discount/gpt-image-2` | `/zh/docs/discount/gpt-image-2` |
| 图片异步任务 | `/docs/common/image-tasks`   | `/zh/docs/common/image-tasks`   |

不同 pathname 让两个同名侧栏项都能稳定定位当前页面；父级分组名称负责消除同名歧义。

## 3. 页面职责

### 3.1 通用图片异步任务

公共参考页是异步协议的权威来源，负责说明：

- `POST /v1/images/generations` 与 `POST /v1/images/edits` 返回
  `202 Accepted`、APIPool task ID 和 `Location`；
- `GET /v1/tasks/{task_id}` 必须使用提交任务时的原 API Key；
- `submission_unknown`、`submitted`、`processing`、`meter_pending`、
  `completed` 和 `failed` 状态；
- 完成结果中的 `data[].url`、`expires_at` 与 `result_expires_at`；
- 轮询、临时错误、失败结果和跨 Key 查询语义。

分组模型页只保留可复制的最短完整流程，并链接到该公共参考页，避免两份状态机正文漂移。

### 3.2 官方分组模型页

首屏明确“官方分组 Key / `gpt-image-2` / Token 计费”，提供文生图、multipart
编辑、提交和完成响应示例。参数表只承诺当前适配器与已验证上游共同支持的字段；完成
响应展示规范化 `usage`，计费说明链接公开模型页而不写死价格。

### 3.3 特惠分组模型页

首屏明确“特惠分组 Key / `gpt-image-2` / 按张计费”，突出 `resolution`
取值、`n` 的目标张数以及“实际成功交付张数 × 提交时锁定的 SKU”语义。完成响应不
伪造 token `usage`，价格同样以公开模型页为准。

### 3.4 快速接入

Quickstart 只保留一个最小图片提交示例和两个分组页面入口，并把通用的“所有图片都按张
计费”改为“计费依据由 Key 所属分组决定”。完整状态机和参数不在 Quickstart 重复维护。

## 4. 公开边界

客户页面允许出现的身份只有门户分组名称、公开模型 ID、公开端点、APIPool task ID 与
客户结果。以下内容必须由测试阻止进入 `content/docs`：

- 两个上游模型别名；
- 上游服务名、内部异步提交路径与上游分组名；
- 内部路由开关或 `group` 请求字段；
- 上游 task ID、渠道 ID 和原始结果 URL。

## 5. 验证

- 测试本地化 `meta` 的目录顺序、分组名称、默认展开状态和页面清单。
- 测试三个主题均有中英文页面，两个模型页只使用公开模型 ID。
- 测试公共异步契约、分组计费差异和 Quickstart 入口。
- 运行公开文案防泄漏测试、TypeScript、ESLint 和生产构建。
- 生产真实调用属于后续发布门禁，本地文档实施不触发部署。

## 6. 依据

- 异步任务和分组结算实现：[Issue #6](https://github.com/AFreeCoder/apipool-v2/issues/6)。
- 门户分组收敛结果：[Issue #12](https://github.com/AFreeCoder/apipool-v2/issues/12)。
- 定价规则：[分组定价档案](../group-pricing-profiles/DESIGN.md)。
- 门户路由边界：[门户与上游路由及计费解耦](../portal-newapi-routing-billing-decoupling/DESIGN.md)。
