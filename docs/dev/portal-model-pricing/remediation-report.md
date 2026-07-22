# 门户模型定价评审缺陷修复记录

- 日期：2026-07-21
- 输入：[`../../test/portal-model-pricing/code-review.md`](../../test/portal-model-pricing/code-review.md)、[`../../test/portal-model-pricing/report.md`](../../test/portal-model-pricing/report.md)
- 复测：[`../../test/portal-model-pricing/retest-report.md`](../../test/portal-model-pricing/retest-report.md)

## 实际完成

- 修复管理端模型、listing 新建与编辑的 Server Action 翻译闭包问题，并用浏览器验证保存、持久化和重定向。
- 统一按次 tier 的正价格约束，修复 tier 行输入重挂载。
- usage 归一化增加非负安全整数边界、OpenAI server tool 映射和 New API Images 字段别名。
- 图片响应计数改为字段存在性扫描，避免长签名 URL 和大 b64 正文造成漏计；Images 流式请求改为转发前拒绝，multipart 编辑要求非空图片文件。
- 将最近一次有效 New API 成本同步结果按通用 meter map 固化进不可变价格版本；default 按次 SKU 可自动对账，非 default SKU 保留精确的不可比较原因。
- 修复 reconcile 的 settlement/waive 竞态状态覆盖和统计遗漏。
- 补齐公共 Embedding/按次价格、控制台用量与账单数据、Checkout 关闭态、翻译和公开文档。
- 实现与门户钱包解耦的 New API 内部运行池：运行 Key 激活前完成一次性幂等供应，存量绑定由后台补齐；每小时只监控水位，远端补充必须由显式 `--apply` 运维命令触发并写脱敏审计。

## 与既定设计的边界

- 未恢复门户钱包与 New API quota 的双余额同步；该做法会破坏门户钱包唯一事实源。
- 内部运行池方案直接落实既定阶段二需求中的“大额内部运行池 + 定期人工补充”，没有新增双余额设计；默认目标 `$1000`、低水位 `$100` 均可由部署变量调整。
- 本轮只增强 multipart 校验，继续遵循 25 MiB 整体缓冲的内测期裁决；流式落盘仍为后续 feature。
- 自动化 fixture 和合成浏览器验证不冒充真实上游调用证据，真实图片、web search 与长上下文复测仍留在 test 阶段。
