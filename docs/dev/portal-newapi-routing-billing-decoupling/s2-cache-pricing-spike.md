# S2：New API cache 计价字段实测

## 结论

截至 2026-07-15，当前实现机无法从已配置的 New API 管理端 `GET /api/pricing` 取得可解析响应，因此不能确认线上价格快照是否提供 cache read、5 分钟 cache write 或 1 小时 cache write 的独立计价字段。

按 PLAN 的既有裁决，Task 22 采用保守路径：三个 cache 基准价不做自动预填，只能由管理员明确录入并锁定复核；发布价格版本时继续把已复核的五维参照价固化到版本快照。

## 脱敏实测证据

- 配置完整性：本地部署环境已配置 `NEWAPI_BASE_URL`、管理员 token 和管理员用户 ID；实测过程未输出任何配置值。
- Node `fetch`：只读请求失败，底层错误码为 `UND_ERR_SOCKET`，未取得 HTTP 响应体。
- curl 独立复核：退出码为 52（服务端空响应），同样未取得价格字段体。
- 当前桥接层的 `RemotePricingModel` 与已有 fixture 只解析 input/output、model/completion/image ratio 等字段，没有 cache 三维字段；这只能证明现有本地契约，不能代替线上实测。
- 两次请求均为只读 GET；未执行写操作、部署或切流。

## 实现边界

- 不因字段未能实测而猜测字段名、比例或默认价格。
- 不从 input/output 价格推导 cache 三维价格，也不以零值代替未知值。
- 后续若在受信网络取得包含 cache 价格字段的真实 fixture，应新增 fixture 与同步测试，再通过新的设计/计划决定是否开放自动预填；不回写本调研记录。
