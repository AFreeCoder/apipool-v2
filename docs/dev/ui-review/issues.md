# UI 优化遗留清单

来源：`docs/test/ui-review/ui-audit-2026-07-08.md` 路线图。P0 已全部完成
（见 [p0-implementation.md](p0-implementation.md)）。

## P1（两周内，约 +4~6 分）

- [ ] 品牌 mark 设计 + 替换模板 `public/logo.png`（仍是紫色 ShipAny 图标）
- [ ] 供应商行改灰度 logo 行（现为裸 mono 文本，移动端换行乱）
- [ ] "终端美学" signature 贯穿：控制台 BASE URL 卡改深底终端行 + 复制按钮
- [ ] 错误提示 i18n：创建 Key 失败等 API 错误英文裸奔（错误码 → 前端词条）
- [ ] 创建 Key placeholder 语义修正（"你的 API 密钥" → "Key 名称"）；"反代/官方"分组加说明 tooltip
- [ ] 余额页 `USD $10` 双重货币符 ×7 清理；自定义充值按钮改 outline（单 primary 规则）；当前余额并入页头
- [ ] 空态统一"一句话 + 次按钮"（用量/充值记录/扣费记录/请求日志）
- [ ] 暗色模式下首页渐变色块亮度收敛（`to-primary` 满饱和过亮）
- [ ] 认证页合规声明降权为 footnote；认证卡顶部加品牌 mark

## P2（持续打磨）

- [ ] 首页中段插入模型/价格预览区块，打破"卡片墙"节奏
- [ ] 移动端 hero 代码块横向裁切（卡内 `overflow-x-auto` 或换短示例）
- [ ] 键盘可达性走查（focus 可见性未系统验证）
- [ ] 模型详情页补齐，或去掉目录表格行 hover 的"可点"暗示
- [ ] 控制台概览 H1 与 tab 同名"概览"重复；用量同步错误文案改 warning 语义而非页面描述
- [ ] API 密钥表卡标题勿用机器 URL（"http://… 的 Key" → "API Keys" + 副标题）
