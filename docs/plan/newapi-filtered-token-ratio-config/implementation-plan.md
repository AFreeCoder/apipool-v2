# NewAPI 过滤后 Token 倍率配置实施计划

日期：2026-07-11

- [x] 在上游模型类型中保留 `ratio_model`、`ratio_completion` 和 `ratio_cache`。
- [x] 复用官方供应商过滤结果生成兼容 NewAPI 的 Token `ratio_config`。
- [x] 暴露不发布宿主机端口的 `/api/newapi/ratio_config-v1-base.json`。
- [x] 覆盖官方模型保留、渠道商同名模型排除、空 `model_price` 的 HTTP 合约测试。
- [x] 验证 Go 全量测试、过滤器镜像、Compose 配置和真实公共源返回。
- [ ] 部署后在 NewAPI 管理控制台以 custom 内网 URL 获取差异并确认一次批量同步。
