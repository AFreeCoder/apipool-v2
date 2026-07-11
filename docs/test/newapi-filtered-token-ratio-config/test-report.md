# NewAPI 过滤后 Token 倍率配置测试报告

测试日期：2026-07-11（America/Los_Angeles）

## 覆盖结果

| 场景 | 结果 | 证据 |
|---|---|---|
| HTTP 合约 | 通过 | 过滤后的官方 `gpt-5.4-mini` 输出 `0.375 / 6 / 0.1`；同名渠道商记录不进入结果。 |
| 按次价格边界 | 通过 | 响应包含空 `model_price`，不提供自动按次价格同步。 |
| Go 全量测试 | 通过 | `cd services/newapi-metadata-filter && go test ./...`。 |
| 镜像构建 | 通过 | `docker build -t apipool/newapi-metadata-filter:token-ratio-test services/newapi-metadata-filter`。 |
| Compose 静态门禁 | 通过 | 两个既有 deploy 测试 3/3 通过；本地和生产 Compose 均可展开。 |
| 真实公共源 | 通过 | 临时容器请求新端点，`gpt-5.4-mini` 返回 `model_ratio=0.375`、`completion_ratio=6`、`cache_ratio=0.1`、`model_price_entries=0`。 |

## TDD 证据

先新增 `TestServerServesFilteredTokenRatioConfig`，新端点尚未实现时执行：

```text
status = 404, endpoint not found
```

实现后同一测试通过。
