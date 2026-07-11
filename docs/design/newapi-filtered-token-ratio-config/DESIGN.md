# NewAPI 过滤后 Token 倍率配置设计

日期：2026-07-11

## 目标

让 NewAPI 的“上游价格同步”读取与模型元信息相同的官方供应商集合，避免公共全量
`ratio_config-v1-base.json` 对同名模型发生跨供应商覆盖后被直接写入本地定价。

## 方案

扩展已有的 `newapi-metadata-filter`，不新增容器和定时任务。

```text
上游 models.json + vendors.json
  → 官方供应商过滤、显式排除、同名 fail-closed
  → 唯一的官方模型记录
  → ratio_model / ratio_completion / ratio_cache
  → /api/newapi/ratio_config-v1-base.json
```

端点返回 NewAPI 兼容的 envelope，包含 `model_ratio`、`completion_ratio`、
`cache_ratio` 和空的 `model_price`。同一响应还通过 `GET /api/pricing` 提供兼容
别名，供 NewAPI 普通同步渠道的默认端点调用。`model_price` 为空是明确的安全边界：当前
`models.json` 不足以可靠重建按次计费价格，绝不从全局倍率配置反向过滤或猜测。

现有 `/api/newapi/models.json` 和 `/api/newapi/vendors.json` 的行为不变；其解析时
保留倍率字段仅用于构造新端点。

## 控制台使用

部署后，在 NewAPI 渠道中新增一条禁用的同步专用渠道：

```text
名称：官方过滤倍率
Base URL：http://newapi-metadata-filter:8080
状态：禁用
模型：留空，不参与任何数据面路由
```

在 **计费与支付 → 模型定价 → 上游价格同步** 中选择该渠道即可。NewAPI 默认请求
`/api/pricing`，由兼容别名返回过滤后的倍率配置，不需要选择 custom 或重复填写 URL。
请求由 NewAPI 后端在 Compose 内网发起，过滤器不需要发布宿主机端口。

## 非目标

- 不同步按次计费的 `ModelPrice`；这类模型保留 NewAPI 本地手工配置。
- 不启用同步专用渠道，也不在其中配置模型，避免它被误作真实上游。
- 不修改渠道、模型元信息表、分组倍率或数据面转发。
- 不在出现同名官方模型时选择优先级；保持 502 fail-closed。
