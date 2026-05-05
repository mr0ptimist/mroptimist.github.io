# static/js/ — Image Viewer Scripts

这些 JS 文件为博客提供 DDS/EXR 图片解码和交互式查看功能。经典 script 模式（非 ES module），与 Hugo + PaperMod 主题兼容。

## 文件说明

| 文件 | 加载方式 | 用途 |
|------|---------|------|
| `worker-shared.js` | `<script>` / `importScripts()` | 公共工具：二进制读取、half-float、DXGI 表、BC1-5 解码、格式检测。暴露 `self.ImageCodecShared`。 |
| `dds-parser.js` | `<script>`（依赖 worker-shared） | DDS 解析器。mip/array/cubemap 解析、BC6H/BC7 走 WebGL 硬件解码（需要 `document`）。暴露 `window.DDS`。 |
| `exr-parser.js` | `<script>` 或 `importScripts()` | OpenEXR 解析器（仅 uncompressed）。主线程和 Worker 复用同一文件。暴露 `window.EXR`。 |
| `decode-worker.js` | `new Worker(url)` | Web Worker。通过 `importScripts()` 加载 worker-shared + exr-parser。处理 DDS（BC1-5 + 未压缩）和 EXR。BC6H/BC7 返回失败。 |
| `image-viewer.js` | `<script>`（最后加载） | UI 入口：channel viewer、pixel inspector、mip/array slider、lazy load、缓存管理。 |

## 加载顺序

1. `worker-shared.js` → 定义 `ImageCodecShared`
2. `dds-parser.js` → 定义 `DDS`
3. `exr-parser.js` → 定义 `EXR`
4. `decode-worker.js` → Worker 文件（由 image-viewer 以 `new Worker()` 加载）
5. `image-viewer.js` → 初始化全部 UI 逻辑

## 架构约束

- **不引入 bundler**，不改成 ES module。保持 classic script + `importScripts()`。
- **BC6H/BC7 不解码进 Worker**，依赖 WebGL context，留在主线程 `dds-parser.js`。
- **`public/js/` 是 Hugo 构建输出**，不手动编辑。源码只维护 `static/js/`。
- **Worker URL** 从 `image-viewer.js` 的 `<script src>` 推导，避免硬编码 `/js/...` 路径。
- **`workingDir`** 通过 `window.ImageViewerConfig.workingDir` 注入（Hugo 模板渲染），静态 JS 不包含 Hugo 模板语法。
