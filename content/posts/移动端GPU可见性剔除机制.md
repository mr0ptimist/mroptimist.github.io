+++
date = '2026-04-20T10:04:00+08:00'
draft = false
title = '移动端 GPU 可见性剔除机制对比'
tags = ['移动端', 'GPU', '剔除', 'TBDR']
categories = ['图形渲染']
+++

# 1. 移动端 GPU 可见性剔除机制对比

## 1.1 概览

| | PowerVR HSR | Apple HSR | Mali FPK | Adreno LRZ |
|---|---|---|---|---|
| 全称 | Hidden Surface Removal | Hidden Surface Removal | Forward Pixel Kill | Low Resolution Z |
| 架构 | TBDR | TBDR | TBDR | TBDR |
| 粒度 | 逐像素 | 逐像素 | 逐像素（尽力而为） | 逐块（8x8 像素） |
| 保证级 | 不透明物体保证零过度绘制 | 不透明物体保证零过度绘制 | 非保证，尽力剔除 | 非保证，块级粗剔除 |
| 绘制顺序依赖 | 不透明物体顺序无关 | 不透明物体顺序无关 | 正面到背面更优 | Binning pass 构建后顺序无关，但正面到背面可提升 Early-Z 效率 |
| AlphaTest | 失效 | 失效 | 失效 | 失效 |
| Alpha Blend | 失效 | 失效 | 失效 | 失效 |
| gl_FragDepth 写入 | 失效 | 失效 | 失效 | 失效 |

---

## 1.2 PowerVR HSR (Imagination)

### 1.2.1 原理
TBDR 架构中，所有几何体先提交到 Tile，HSR 在 PS 执行前对整个 Tile 做可见性解析，只对最终可见像素跑 PS。

### 1.2.2 特性
- 不透明物体绘制顺序不影响 HSR 效率，overdraw 始终约 1x
- 不需要 Z-prepass，HSR 等效于免费的深度预处理
- AlphaTest / discard 会打断 HSR，GPU 无法提前判断可见性
- 写入 gl_FragDepth 会干扰 HSR（读取 gl_FragCoord.z 本身不影响）

### 1.2.3 最佳实践
- 不需要排序不透明物体
- 尽量减少 discard / alphaTest
- 透明物体仍需从后到前排序
- 使用 PVRTune 分析 HSR 效率

### 1.2.4 适用设备
- iPhone 5s ~ iPhone 7（A7~A10，PowerVR G6430/GX6450/GT7600 系列）
- 部分联发科芯片（早期 PowerVR 授权）

---

## 1.3 Apple GPU HSR (Apple A11+)

### 1.3.1 原理
Apple 自研 GPU（A11 起）采用 TBDR 架构，内置 **Hidden Surface Removal (HSR)**。所有几何体先提交到 Tile，HSR 在 PS 执行前对整个 Tile 做可见性解析，只对最终可见像素跑 PS。A7~A10 使用 PowerVR 授权 GPU，HSR 来自 PowerVR 实现；A11 起为 Apple 独立设计的 GPU，但保留了 TBDR+HSR 架构。

### 1.3.2 特性
- 不透明物体绘制顺序不影响 HSR 效率，overdraw 始终约 1x
- 不需要 Z-prepass，HSR 等效于免费的深度预处理
- AlphaTest / discard 会打断 HSR
- 与 PowerVR HSR 行为一致，A7~A10 直接使用 PowerVR GPU，A11 起为 Apple 自研但保持相同架构

### 1.3.3 最佳实践
- 不需要排序不透明物体
- 尽量减少 discard / alphaTest
- 透明物体仍需从后到前排序

### 1.3.4 芯片支持明细

| GPU 系列 | 代表 SoC | HSR 支持 | 备注 |
|----------|---------|---------|------|
| A7 ~ A10 | iPhone 5s ~ iPhone 7 | 支持 | PowerVR 授权 GPU（G6430/GX6450/GT7600） |
| A11 Bionic | iPhone X / 8 | 支持 | Apple 首款自研 GPU |
| A12 Bionic | iPhone XS / XR | 支持 | Apple 自研 |
| A13 Bionic | iPhone 11 | 支持 | Apple 自研 |
| A14 Bionic | iPhone 12 | 支持 | Apple 自研 |
| A15 Bionic | iPhone 13 | 支持 | Apple 自研 |
| A16 Bionic | iPhone 14 Pro | 支持 | Apple 自研 |
| A17 Pro | iPhone 15 Pro | 支持 | Apple 自研 |
| M1 | iPad Pro / Mac | 支持 | Apple 自研 |
| M2 | iPad Pro / Mac | 支持 | Apple 自研 |
| M3 | Mac | 支持 | Apple 自研 |
| M4 | iPad Pro / Mac | 支持 | Apple 自研 |

**总结：A7~A10 使用 PowerVR 授权 GPU，HSR 来自 PowerVR 实现。A11 起 Apple 自研 GPU，独立实现 TBDR+HSR 架构，全系列支持 HSR。**

### 1.3.5 官方文档
- [Apple Metal Best Practices Guide](https://developer.apple.com/library/archive/documentation/3DDrawing/Conceptual/MTLBestPracticesGuide/index.html)
- [Harness Apple GPUs with Metal (WWDC 2020)](https://developer.apple.com/videos/play/wwdc2020/10602/)
- [Apple Metal](https://developer.apple.com/metal/)

---

## 1.4 Mali FPK (ARM)

### 1.4.1 原理
Forward Pixel Kill 允许后提交的不透明片元"杀死"先提交的被遮挡片元，在 PS 执行前丢弃。

### 1.4.2 特性
- 不是保证级的，极端情况下仍可能有过度绘制
- 后画的物体可以杀死先画的被遮挡片元
- 配合 Early Z 一起工作
- 能力弱于 PowerVR HSR

### 1.4.3 最佳实践
- 不透明物体正面到背面排序仍有帮助
- 避免 discard / alphaTest
- 透明物体从后到前排序
- 可用 Pixel Local Storage 实现近似 OIT

### 1.4.4 适用设备
- 三星 Exynos 全系
- 联发科天玑系列（Mali GPU）
- 部分国产芯片

### 1.4.5 芯片支持明细

| GPU 系列 | 代表 SoC | FPK 支持 |
|----------|---------|---------|
| Mali-T6xx/T7xx/T8xx (Midgard) | Exynos 5/7, Kirin 920/930 | 支持（Midgard 架构引入 FPK，T860/T880 增强 FPK） |
| Mali-G71 (Bifrost) | Kirin 960 | 支持 |
| Mali-G72 | Exynos 9810 | 支持 |
| Mali-G76 | Kirin 980 | 支持 |
| Mali-G57 | Dimensity 800 | 支持 |
| Mali-G77 | Exynos 990 | 支持 |
| Mali-G78 | Kirin 9000 | 支持 |
| Mali-G710 | Dimensity 8100 | 支持 |
| Mali-G715 | Dimensity 9200 | 支持 |
| Mali-G720 | Dimensity 9300 | 支持 |

**总结：FPK 在 Midgard 架构（T6xx/T7xx/T8xx）即已引入，T860/T880 增强。Bifrost (G71+) 及 Valhall 架构完整支持并持续优化。**

### 1.4.6 官方文档
- [ARM Mali GPU Best Practices](https://developer.arm.com/documentation/101897/latest/)
- [Mali Forward Pixel Kill (FPK Patent US9619929B2)](https://patents.google.com/patent/US9619929)
- [ARM Mali Midgard Architecture Explored (AnandTech)](https://www.anandtech.com/show/8234/arms-mali-midgard-architecture-explored/4)

---

## 1.5 Adreno LRZ (Qualcomm)

### 1.5.1 原理
维护一个低分辨率（1/8）深度缓冲，在 binning pass 中构建每个 8x8 像素块的深度值，rendering pass 中据此做早期剔除。官方描述为 **"draw order independent depth rejection"**（绘制顺序无关的深度剔除）。

### 1.5.2 特性
- 粒度为 8x8 像素块，每块存储一个 Z16_UNORM 深度采样，无法精确到像素
- **绘制顺序无关**：LRZ 值在 binning pass 由所有几何体构建，rendering pass 中基于预构建的值剔除，不依赖绘制顺序
- 正面到背面排序仍可提升 Early-Z 效率（Early-Z 是 LRZ 之外的补充机制）
- 深度写入方向不能中途切换（如从 LESS 切到 GREATER），否则 LRZ 失效
- 深度写入必须开启，深度比较函数需为 LESS/LESS_EQUAL 或 GREATER/GREATER_EQUAL
- A650+ (SD 865+) 支持 GPU 端方向追踪和跨 renderpass 复用 LRZ
- A7XX 引入双向 LRZ，消除方向切换的性能损失

### 1.5.3 最佳实践
- 不透明物体正面到背面排序可提升 Early-Z 效率（LRZ 本身绘制顺序无关）
- 严重过度绘制场景加 depth pre-pass，可提升 20-40% 性能
- 避免 discard / alphaTest / gl_FragDepth 写入（会临时禁用 LRZ）
- 避免 fragment shader 中写入 SSBO / image（会强制 Late-Z，与 LRZ 不兼容）
- Vulkan 下利用 VkRenderPass load/store 帮助驱动判断 LRZ 使用时机

### 1.5.4 适用设备
- 高通骁龙（Adreno GPU），国产安卓手机最大份额 GPU

### 1.5.5 芯片支持明细

| GPU 系列 | 代表 SoC | LRZ 支持 |
|----------|---------|---------|
| Adreno 4xx 及更早 | SD 801/805 等 | 不支持 |
| Adreno 5xx | SD 820/821/835/660 等 | 部分支持（实验性，有硬件限制） |
| Adreno 612 | SD 675 | 完整支持 |
| Adreno 615/616 | SD 670/710 | 完整支持 |
| Adreno 618 | SD 730/730G | 完整支持 |
| Adreno 619 | SD 750G | 完整支持 |
| Adreno 620 | SD 765/765G | 完整支持 |
| Adreno 630 | SD 845 | 完整支持 |
| Adreno 640 | SD 855/855+ | 完整支持 |
| Adreno 650 | SD 865/865+ | 完整支持 |
| Adreno 660 | SD 888 | 完整支持 |
| Adreno 642L | SD 780G/778G | 完整支持 |
| Adreno 730 | SD 8 Gen 1 | 完整支持 |
| Adreno 740 | SD 8 Gen 2 | 完整支持 |
| Adreno 750 | SD 8 Gen 3 | 完整支持 |

**总结：Adreno 6xx 及以后完整支持，Adreno 5xx 部分支持，更早不支持。**

### 1.5.6 官方文档
- [Qualcomm Developer](https://www.qualcomm.com/developer)
- [Low-resolution-Z on Adreno GPUs (Danylo Piliaiev, Igalia)](https://blogs.igalia.com/dpiliaiev/adreno-lrz/)
- [Low Resolution Z Buffer (Mesa Freedreno 文档)](https://docs.mesa3d.org/drivers/freedreno/hw/lrz.html)
- [LRZ Buffer Support on Turnip (Samuel Iglesias, Igalia)](https://blogs.igalia.com/siglesias/2021/04/19/low-resolution-z-buffer-support-on-turnip/)
- [Low Resolution Buffer Based Pixel Culling (Qualcomm Patent US20120280998)](https://patents.google.com/patent/US20120280998)

---

## 1.6 针对石头+地表场景的建议

### 1.6.1 场景描述
管线顺序：PBR → 石头 → 草 → 地表
问题：石头屏占比高、PS 复杂、大量在地表之下被遮挡

### 1.6.2 各硬件下方案

| 硬件 | 地表后画能否自动剔除石头 | 推荐方案 |
|---|---|---|
| PowerVR | 能，HSR 自动处理 | 不改顺序也行，但 AlphaTest 地表除外 |
| Mali | 部分能，FPK 尽力剔除 | 建议调顺序，地表先画 |
| Adreno | 部分能，LRZ 在 binning pass 构建深度后可做块级剔除，但粒度为 8x8 不精确 | 建议调顺序，地表先画以配合 Early-Z |

### 1.6.3 通用方案（全平台有效）

```
方案1: 调渲染顺序
  地表 → PBR → 石头 → 草
  最简单，深度测试自然挡住地下石头

方案2: 地表 Z-prepass
  地表 Z-prepass（ColorMask 0）→ PBR → 石头 → 草 → 地表正式绘制
  适合不想改最终绘制顺序的场景

方案3: 石头 depth prepass
  石头 Z-prepass → 石头正式绘制 → ...
  解决石头自身遮挡，但不解决地表遮挡石头的问题
```

### 1.6.4 注意事项
- 地表如果是 AlphaTest，HSR/FPK/LRZ 全部失效，必须依赖排序或 prepass
- Z-prepass 不会导致 Z-fight（同一 VS 输出深度一致）
- 正式绘制用 ZTest LEqual（默认），不会被自己的 prepass 深度剔除
- 双 Pass 方案顶点处理翻倍，draw call 翻倍

---

## 1.7 Early-Z（传统 IMR GPU 基线）

### 1.7.1 原理
GPU 固定管线中，深度测试发生在 PS 之前（称为 Early-Z）。如果片元被已有深度值遮挡，直接丢弃，不执行 PS。

### 1.7.2 特性
- 顺序强依赖：只有先画的更近物体写入深度后，后画的更远物体才能被剔除
- 背面到正面绘制 = Early-Z 完全无效，所有 PS 白跑
- 不是保证级，以下情况 GPU 会将深度测试推迟到 PS 之后（Late-Z）：
  - PS 中使用 discard / clip / alphaTest
  - PS 中写入 gl_FragDepth / SV_Depth
  - PS 中读取深度值（gl_FragCoord.z）
- Early-Z 是 PC 桌面 GPU（NVIDIA / AMD IMR 架构）和所有移动 GPU 的基础能力

### 1.7.3 最佳实践
- 不透明物体正面到背面排序
- 严重过度绘制场景加 Z-prepass
- 避免 PS 中 discard / 深度写入 / 深度读取
- 透明物体放最后，从后到前画

---

## 1.8 全方案对比

| | Early-Z (IMR) | PowerVR HSR | Apple HSR | Mali FPK | Adreno LRZ |
|---|---|---|---|---|---|
| 架构 | IMR（立即模式） | TBDR | TBDR | TBDR | TBDR |
| 剔除粒度 | 逐像素 | 逐像素 | 逐像素 | 逐像素（尽力） | 逐块（8x8 像素） |
| 保证级 | 不保证（可退化为 Late-Z） | 不透明保证零 overdraw | 不透明保证零 overdraw | 尽力剔除 | 尽力剔除 |
| 顺序依赖 | 强：必须正面到背面 | 无：不透明顺序无关 | 无：不透明顺序无关 | 弱：正面到背面更优 | 弱：LRZ 绘制顺序无关，正面到背面可提升 Early-Z |
| back-to-front 时 | PS 全跑，零剔除 | 不透明仍零 overdraw | 不透明仍零 overdraw | 部分剔除 | LRZ 仍可剔除（binning pass 已构建深度） |
| AlphaTest | 退化为 Late-Z | HSR 失效 | HSR 失效 | FPK 失效 | LRZ 失效 |
| Alpha Blend | 不适用（需混合） | 不适用 | 不适用 | 不适用 | 不适用 |
| gl_FragDepth | 退化为 Late-Z | HSR 失效 | HSR 失效 | FPK 失效 | LRZ 失效 |
| 需要 Z-prepass | 常需要 | 不需要 | 不需要 | 视场景 | 建议加 |
| 额外开销 | 无 | HSR 硬件单元 | HSR 硬件单元 | FPK 硬件单元 | LRZ 额外显存+带宽 |
| 典型平台 | PC 桌面 GPU / 所有 GPU 基线 | iPhone 5s~7（A7~A10 PowerVR） | iPhone 8+ / iPad / Mac（A11+ Apple 自研） | Exynos / 天玑 / 麒麟 | 骁龙全系 |

### 1.8.1 关键差异解读

1. **Early-Z 是所有人的基线**：HSR/FPK/LRZ 都是在 Early-Z 基础上的增强，不是替代。当这些增强机制失效时，退回到 Early-Z 行为。

2. **顺序依赖是核心区别**：
   - Early-Z：石头先画地表后画 → 石头 PS 白跑（深度缓冲还没有地表深度）
   - LRZ：binning pass 中已构建所有几何体的低精度深度 → 即使石头先画，LRZ 仍可在 rendering pass 中剔除被遮挡片元（但粒度为 8x8 块级）
   - HSR（PowerVR / Apple）：同一 Tile 内所有几何体先收集完再解析可见性 → 石头 PS 不白跑（像素级精确）
   - FPK：介于两者之间，后画的更近片元可以杀死先排队的片元

3. **AlphaTest 是共同弱点**：所有方案遇到 discard 都失效，因为 GPU 无法在不执行 PS 的情况下知道片元是否存活。

---

## 1.9 参考文档

- [Imagination PowerVR Architecture - Hidden Surface Removal](https://docs.imgtec.com/starter-guides/powervr-architecture/html/topics/hidden-surface-removal-efficiency.html)
- [Sorting Objects on PowerVR Hardware (Imagination Blog)](https://blog.imaginationtech.com/sorting-objects-and-geometry-on-powervr-hardware/)
- [Do Not Use Discard (PowerVR 文档)](https://docs.imgtec.com/starter-guides/powervr-architecture/html/topics/rules/do-not-use-discard.html)
- [Apple Metal Best Practices Guide](https://developer.apple.com/library/archive/documentation/3DDrawing/Conceptual/MTLBestPracticesGuide/index.html)
- [Harness Apple GPUs with Metal (WWDC 2020)](https://developer.apple.com/videos/play/wwdc2020/10602/)
- [ARM Mali GPU Best Practices](https://developer.arm.com/documentation/101897/latest/)
- [Mali Forward Pixel Kill (FPK Patent US9619929B2)](https://patents.google.com/patent/US9619929)
- [ARM Mali Midgard Architecture Explored (AnandTech)](https://www.anandtech.com/show/8234/arms-mali-midgard-architecture-explored/4)
- [Qualcomm Developer](https://www.qualcomm.com/developer)
- [Low-resolution-Z on Adreno GPUs (Igalia)](https://blogs.igalia.com/dpiliaiev/adreno-lrz/)
- [Low Resolution Z Buffer (Mesa Freedreno 文档)](https://docs.mesa3d.org/drivers/freedreno/hw/lrz.html)
- [LRZ Buffer Support on Turnip (Igalia)](https://blogs.igalia.com/siglesias/2021/04/19/low-resolution-z-buffer-support-on-turnip/)
- [Low Resolution Buffer Based Pixel Culling (Qualcomm Patent)](https://patents.google.com/patent/US20120280998)
