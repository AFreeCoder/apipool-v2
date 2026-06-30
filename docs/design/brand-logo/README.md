# APIPool Logo 方案

日期：2026-06-28

本轮只做方向探索，不替换 `public/logo.png`。现有线上图标仍是旧模板遗留的紫色船形/AI2 风格，和当前站点的绿色开发者工具视觉不一致。

## 输入约束

- 品牌名：APIPool
- 产品定位：开发者 API 门户，统一 Base URL，管理 API Key、余额、模型价格和用量日志。
- 当前视觉：白底、近黑文字、主色 `#216d51`、深色代码块、橙色 `#f99c00` 作少量信号色。
- 使用场景：站点 header 的 22-24px 图标、favicon、横向品牌组合、文档/控制台入口。

## 方案

- A / Endpoint Pool：多个节点汇入一个中心端点，最贴合“一个 API 端点调用所有模型”。小尺寸识别度最好，建议优先推进。
- B / Route Slash：以 API path 斜杠和 A 字母骨架为主，更偏开发者工具；适合 favicon 和 CLI 相关物料。
- C / Key Pool：把 Key 和额度池结合，信任感更强；更适合控制台、账户和账单场景。
- D / Terminal Gateway：从首页终端代码块抽象而来，开发者属性强，但 24px 时细节会损失。
- E / Model Matrix：对应模型目录和价格筛选，产品感强；适合模型页或次级图形系统。
- F / Pool Current：保留 Pool 的水面语义并移除旧紫色模板痕迹；如果希望和旧图标有一点连续性，可选这一版。

## 建议

优先选 A 作为主方向，B 作为备用探索。下一步应把入选方向拆成 `logo-mark.svg`、`logo-horizontal.svg`、`favicon.svg` 三个实际资产，并在 16px、24px、32px、深色背景下分别校验。

## 第二轮：强化 Pool

用户反馈第一轮 Pool 感不足后，新增第二轮方案板：

- `logo-options-v2.svg`
- `logo-options-v2.png`

这一轮将 Pool 作为主视觉，而不是把它作为文字解释：

- G / Reservoir P：P 形水库，品牌名里的 Pool 直接成为图形结构。
- H / Ripple Endpoint：请求落入池面产生涟漪，表达一个端点触发多模型能力。
- I / Confluence Basin：多条供应商通道汇入一个池，再从统一 API 出口调用。
- J / Liquid Brackets：把 `{}` 开发者容器做成池，技术感更强。
- K / Capacity Pool：用水位表达余额、用量和容量，适合控制台。
- L / Double O Pools：直接把 `Pool` 的两个 `o` 做成池面，强调字标识别。

第二轮建议优先看 G、H、L。G 最像完整品牌符号，H 的 Pool 感最直观，L 最适合做长期字标系统。

## 第三轮：字母与 Pool 的抽象组合

用户进一步明确两个方向：一是池子的意象，二是品牌字母；并提到 `apimart.ai` 的 logo 作为参考。第三轮参考的是它的设计方法，而不是复制图形：用几何字母、内轮廓和单色可缩放结构来形成 mark。

- `logo-options-v3.svg`
- `logo-options-v3.png`

第三轮方向：

- M / AP Basin：A + P 的池形负空间，Pool 藏在底部反形里。
- N / Double-O Pool：让 `Pool` 的 O 成为主记忆点，适合做字标系统。
- O / Nested P：嵌套 P 轮廓，最接近 apimart.ai 那类几何内轮廓思路，但图形完全重新设计。
- P / API Channels：三条 API 通道入池，偏深色开发者工具。
- Q / A-O Monogram：A 是入口，O 是池，字母关系明确。
- R / Pool Ligature：把 P + 双 O 连成横向 mark，适合 header 与 favicon 拆分。

第三轮建议优先看 O、R、M。O 最像一个成熟科技品牌 mark，R 对品牌名 `Pool` 的绑定最强，M 兼顾 AP 字母和池形负空间。
