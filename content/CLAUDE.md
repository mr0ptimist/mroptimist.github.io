---
name: posts 目录写作指南
description: Hugo 博客 content/posts 目录下 Markdown 文章的 front matter 格式与写作规范
type: project
---

# content/posts/ CLAUDE.md

## 文章 Front Matter 格式

使用 **TOML** 格式（`+++` 分隔），**不要用** YAML（`---`）格式。项目中大部分文章已统一为 TOML。

```toml
+++
date = '2026-04-20T10:00:00+08:00'
draft = false
title = '文章标题'
tags = ['标签1', '标签2']
categories = ['分类名']
hidden = true   # 可选，私密文章
+++
```

## 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `date` | 是 | ISO 8601 格式，带时区 `+08:00`。影响文章排序 |
| `draft` | 是 | `true`=草稿（仅 `hugo serve -D` 可见），`false`=正式发布 |
| `title` | 是 | 文章标题，会显示在列表页和 `<title>` |
| `tags` | 是 | 标签数组，用于 `/tags/` 页面聚合 |
| `categories` | 是 | 分类数组，用于 `/categories/` 页面聚合 |
| `hidden` | 否 | `true` 时文章被隐藏，需在导航栏输入密码（hugo.toml 中 `secretPassword`）后才能查看 |

## 已有的分类/标签约定

**categories**（选一个）：
- `图形渲染`
- `性能优化`
- `博客`

**tags**（按需选多个）：
- `移动端`, `GPU`, `剔除`, `TBDR`, `NVIDIA`, `Nsight`, `UE`, `RenderDoc`, `Shader Debug`, `文档`

新建文章时优先复用已有标签和分类，保持聚合页一致。

## 正文规范

- 正文标题用 `##` `###` 逐级递减，不要跳级
- 可在正文 `# 标题` 开头（与 front matter title 独立），也可以不写正文标题直接从 `##` 开始
- 代码块标注语言：` ```cpp ` ` ```ini ` ` ```bash ` 等
- 表格用 GFM 语法
- 图片使用 Hugo Page Bundle 组织：文章含图片时，md 和图片放在 `content/posts/{文章名}/` 目录下（md 命名为 `index.md`），用相对路径 `![](image.webp)` 引用
- VSCode 粘贴图片后，运行 `organize_post_images.py`（或 `bat/organize_images_整理贴图.bat`）自动整理到 Page Bundle 并压缩（PNG→WebP，>1920px 自动缩放）
- 整理后原图保留为 `.bak` 文件，验证无误后手动删除
- 中文与英文/数字之间加空格（排版惯例）
- 所有 `##` 标题会自动被 JS 渲染为可折叠区块（`details/summary`），因此：
  - 不要在 `##` 前后添加额外的 `<details>` 或折叠 HTML，会冲突
  - `###` 及以下标题不会被自动折叠，正常书写即可
  - 折叠状态默认展开，用户可手动折叠并持久化到 sessionStorage

## 研究类文章规范

- 涉及技术细节、硬件规格、架构原理等非通用知识时，**必须上网搜索验证**，不可凭记忆编写
- 每个关键论据、数据、引用**必须标注来源**，格式如：
  - 正文内：`据 [Qualcomm 官方文档](URL) 描述……`
  - 章节末尾：用 `### 参考` 或 `### 官方文档` 列出所有来源链接
- **严禁幻觉**：不确定的信息不写，查不到权威来源的标注"待验证"
- 优先引用：官方文档 > 官方博客 > 论文/专利 > 知名技术博客 > 社区讨论
- **引用网址必须验证可访问**：每个外链写入文章前必须 curl 或浏览器确认返回 200，404/超时的链接不使用，替换为可用的替代来源

## Mermaid 图表规范（兼容 11.x）

**已通过 JS 自动修复解决**：浏览器 HTML 解析器会吞掉 `<<interface>>` 中的 `<interface>` 标签，`runMermaid()` 在 mermaid 渲染前自动修复 `&lt;<` → `&lt;&lt;` 并通过 `textContent` 写回。写 mermaid 时直接用 `<<interface>>`，无需手动转义。

**仍需注意**：flowchart 未加引号的节点标签含 `()` `,` `:` `@` `→` `×` `+` `=` 等会 Syntax error，所有节点标签和 subgraph 标题一律用 `["..."]` 包裹。

**验证**：`npx @mermaid-js/mermaid-cli -i file.mmd -o out.png`

## 文件命名

- 用中文或英文均可，已有示例：`移动端GPU可见性剔除机制.md`、`NVIDIA_GPU_Performance_Counters_Complete_zh.md`
- 文件名不影响 URL，URL 由 hugo.toml 的 `defaultContentLanguage` 和文件名自动生成

## 新建文章流程

推荐用项目 `bat/` 目录下的 `new-post_新建文章.bat`，或直接运行根目录的 `new-post.py`，会自动生成带 front matter 的模板。
