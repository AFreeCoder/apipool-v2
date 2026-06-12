# 05 视觉规范（Design System）

> 风格基调：**开发者工具风**（参考 OpenRouter / Vercel / Stripe Docs）。浅色默认，支持深色切换。单一强调色，数据密集但克制，等宽字体点缀代码感。所有 token 与 `src/config/style/theme.css` 的 CSS 变量一一对应——**页面代码只允许使用 token，禁止野生颜色/字号/间距**。

## 1. 设计原则

1. **内容即界面**：模型 ID、价格、用量数字是主角，装饰元素（渐变、插画、阴影）最小化。
2. **单一强调色**：全站只有一个 primary（绿色系），用于主 CTA、激活态、关键数字。其余一律中性灰阶。
3. **等宽字体表达"机器可读"**：模型 ID、Base URL、Key、价格数字、代码示例一律 `--font-mono`。
4. **密度分层**：营销页（首页/models/docs）行高宽松；控制台数据密集（紧凑表格、小字号辅助信息）。
5. **克制的反馈**：hover 只做边框/背景微变，不做位移、缩放、大阴影。

## 2. 色板（对应 theme.css CSS 变量）

### 浅色（`:root`，默认）

| Token | 值 | 用途 |
|---|---|---|
| `--background` | `#ffffff` | 页面底色 |
| `--foreground` | `#0a0a0a` | 正文 |
| `--card` | `#ffffff` | 卡片底（靠 `--border` 区分） |
| `--muted` | `#f5f5f5` | 区块底、表头底 |
| `--muted-foreground` | `#737373` | 辅助文字 |
| `--primary` | `#216d51` | 唯一强调色：主 CTA、激活态、链接 hover |
| `--destructive` | `#e40014` | 危险操作、错误态 |
| `--border` | `#e5e5e5` | 全部分隔线 |
| `--chart-*` | 绿系 + 中性 | 用量图表（chart-3 橙色仅用于警示数据） |

### 深色（`.dark`）

底色 `#0a0a0a`、卡片 `#171717`、primary 提亮为 `#2e8269`、边框用白色低透明度。语义与浅色一一对应，不允许深色独有的颜色。

### 语义状态色

| 状态 | 浅色用法 |
|---|---|
| 成功/可用 | primary 文字 + `primary/10` 底的徽章 |
| 即将上线/中性 | `muted` 底 + `muted-foreground` 文字 |
| 失败/禁用 | `destructive` 文字 + `destructive/10` 底 |
| 等待中 | `muted-foreground` + 加载动效 |

## 3. 字体

| Token | 值 | 用途 |
|---|---|---|
| `--font-sans` | Geist, Inter, system | 标题、正文、UI 控件 |
| `--font-mono` | JetBrains Mono, Fira Code | 模型 ID、价格数字、Key、URL、代码块、表格数据列 |

字号尺度（Tailwind 类，不引入自定义字号）：

- 首页 H1：`text-4xl`/`text-5xl`（桌面），语义一句话价值主张
- 区块标题 H2：`text-3xl`
- 卡片标题 H3：`text-lg`
- 正文：`text-sm`/`text-base`；控制台表格与辅助信息：`text-xs`/`text-sm`
- 大数字（余额、统计卡）：`text-2xl font-mono`

## 4. 间距、圆角与阴影

- 间距使用 Tailwind 4 默认尺度（`--spacing: 0.25rem` 基数），节奏：组件内 `gap-2/3/4`，卡片内边距 `p-4/p-5`，区块垂直 `py-14/py-16`，区块间用 `border-b` 分隔而非大间距。
- 圆角：`--radius: 0.625rem`；卡片 `rounded-xl`，按钮/输入 `rounded-md`，徽章 `rounded-md`。
- 阴影：默认无阴影，仅浮层（popover/dialog/dropdown）用 `--shadow-md`。卡片靠边框区分层级，hover 最多 `--shadow-sm`。

## 5. 组件规范

| 组件 | 规范 |
|---|---|
| 按钮 | 主按钮 `bg-primary` 全站唯一视觉权重最高元素，每屏不超过 1 个；次按钮 `outline`；高度 `h-9`（控制台）/`h-10`（营销页） |
| 表格 | 表头 `bg-muted` + `text-xs uppercase text-muted-foreground`；数据列（价格/ID/数字）右对齐 + mono；行 hover `bg-muted/50`；行高紧凑 `py-2.5` |
| 卡片 | `border rounded-xl bg-card`，无阴影；标题区与内容区用内部间距分隔，不加分隔线 |
| 代码块 | 深底（浅色模式下也用 `#0a0a0a` 深底，制造"终端"对比）+ mono + `text-xs/sm`；带复制按钮；顶部可带文件名/语言标签条 |
| 徽章 | 状态徽章见语义状态色；尺寸 `text-xs px-2 py-0.5` |
| 表单 | 输入框 `h-9 rounded-md border-input`；标签 `text-sm font-medium`；错误信息 `text-destructive text-xs` |
| 空态 | 居中：一句话说明 + 一个次按钮；不放插画 |
| 统计卡 | 标签 `text-xs text-muted-foreground` + 数值 `text-2xl font-mono`；趋势用 primary/destructive 小箭头 |

## 6. 页面布局原则

- 全站最大宽度 `max-w-7xl`，水平 padding `px-4 sm:px-6 lg:px-8`。
- 顶部导航高 `h-14/h-16`，sticky + `backdrop-blur`，右侧主 CTA 进控制台。
- 营销页区块用 `border-b` 分隔，每区块一个标题 + 一个目的，禁止一屏塞两个主题。
- 控制台：左侧窄边栏（或顶部 tab）+ 内容区；内容区第一行是页面标题 + 主操作按钮。
- 移动端 375px 必须可用：表格可横滚，导航折叠为抽屉。

### 各页首屏结构

| 页面 | 首屏自上而下 |
|---|---|
| 首页 | H1 一句话价值 → 副标题 → 主/次 CTA → 深底 curl 代码块（右侧或下方）→ 提供商徽标行 |
| /models | 页面标题 + 筛选器 → 清单表（首屏即见表格，不放 hero） |
| /docs | 文档标题 → Base URL 卡片 → 鉴权说明 → 语言切换代码示例 |
| /dashboard | 余额统计卡行（余额/本月消费/请求数）→ Keys 列表或 tab 区 |

## 7. 动效

- 仅用 `transition-colors`（150ms）与 fumadocs/radix 自带动效。
- 禁止滚动驱动动画、视差、自动轮播。

## 8. 页面验收 Checklist（M3 逐页核验）

- [ ] 页面无 token 之外的颜色（grep 16 进制色值，只允许出现在 theme.css 与深底代码块）
- [ ] 模型 ID、价格、Key、URL、统计数字全部 mono 字体
- [ ] 每屏至多一个 `bg-primary` 主按钮
- [ ] 间距/圆角/字号全部来自规范尺度
- [ ] 浅色/深色双主题下检查一遍（深色无独有颜色、对比度可读）
- [ ] 375px 宽可用，表格可横滚
- [ ] 空态、加载态、错误态三态齐备（控制台页面）
