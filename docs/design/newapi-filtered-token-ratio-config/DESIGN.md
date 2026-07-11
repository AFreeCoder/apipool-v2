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

新端点返回 NewAPI 兼容的 envelope，包含 `model_ratio`、`completion_ratio`、
`cache_ratio` 和空的 `model_price`。`model_price` 为空是明确的安全边界：当前
`models.json` 不足以可靠重建按次计费价格，绝不从全局倍率配置反向过滤或猜测。

现有 `/api/newapi/models.json` 和 `/api/newapi/vendors.json` 的行为不变；其解析时
保留倍率字段仅用于构造新端点。

## 控制台使用

部署后，在 **计费与支付 → 模型定价 → 上游价格同步** 中选择“官方倍率预设”，将
同步端点设为 `custom`，填写完整内部 URL：

```text
http://newapi-metadata-filter:8080/api/newapi/ratio_config-v1-base.json
```

该 URL 由 NewAPI 后端在 Compose 内网请求，不需要发布过滤器宿主机端口。先获取差异，
核对来源后再批量应用。NewAPI 当前前端不持久化这个 custom 值，重新打开弹窗需再次填写。

## 非目标

- 不同步按次计费的 `ModelPrice`；这类模型保留 NewAPI 本地手工配置。
- 不修改渠道、模型元信息表、分组倍率或数据面转发。
- 不在出现同名官方模型时选择优先级；保持 502 fail-closed。
