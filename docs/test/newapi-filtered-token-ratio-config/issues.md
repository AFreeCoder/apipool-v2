# 遗留验收项

- [ ] 部署后在 NewAPI 管理控制台的“计费与支付 → 模型定价 → 上游价格同步”选择官方倍率预设，使用 custom 完整端点 `http://newapi-metadata-filter:8080/api/newapi/ratio_config-v1-base.json` 获取差异；确认 `gpt-5.4-mini` 显示 `0.375 / 6 / 0.1` 后批量应用。确认本次同步未产生任何 `model_price` 更新，按次计费模型仍保持本地手工配置。
