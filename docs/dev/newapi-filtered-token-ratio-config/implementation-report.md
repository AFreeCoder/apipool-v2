# NewAPI 过滤后 Token 倍率配置开发记录

日期：2026-07-11

## 实现

`newapi-metadata-filter` 新增：

```text
GET /api/newapi/ratio_config-v1-base.json
```

端点对每次请求实时执行既有的官方供应商过滤和重复模型校验；校验通过后仅将过滤结果中
非空的 `ratio_model`、`ratio_completion`、`ratio_cache` 写入对应 Map。`model_price`
始终返回空对象，不参与按次价格同步。

## 数据边界

该端点从过滤后的模型记录直接构建，未读取公共全量 `ratio_config-v1-base.json`。
因此不会继承全量聚合时可能发生的同名模型跨供应商覆盖。

## 控制台接入

NewAPI 价格同步界面使用 custom 完整端点：

```text
http://newapi-metadata-filter:8080/api/newapi/ratio_config-v1-base.json
```

此请求由 NewAPI 容器发起，过滤器不需要新公网路由或 Compose 端口映射。
