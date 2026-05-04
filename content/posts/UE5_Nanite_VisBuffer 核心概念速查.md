+++
date = '2026-04-20T14:00:00+08:00'
draft = false
title = 'Nanite VisBuffer 核心概念速查'
tags = ['UE', 'GPU', 'Nanite', 'VisBuffer']
categories = ['图形渲染']
+++

# Nanite VisBuffer 核心概念速查

Nanite 是 UE5 的虚拟化几何系统，其核心创新是用 **Visibility Buffer（可见性缓冲）** 替代传统 G-Buffer，将几何处理与材质着色完全解耦。本文梳理 VisBuffer 管线中涉及的关键概念。

## VisBuffer 整体管线

```
Mesh → Instance → Cluster Group → Cluster → Triangle → VisBuffer → Material Pass
```

1. **Culling Pass（计算着色器）**：GPU 端逐 Cluster 做视锥/遮挡/屏幕尺寸剔除
2. **Rasterization Pass**：将可见像素写入 VisBuffer（仅存 ID，不做材质计算）
3. **Material Pass**：全屏 Pass 读取 VisBuffer，解码 ID，仅对可见像素着色一次

> 来源：Brian Karis, "A Deep Dive into Nanite Virtualized Geometry", SIGGRAPH 2021 (Advances in Real-Time Rendering)

---

## 三角形（Triangle）

Cluster 内的基本渲染单元。每个 Cluster 包含最多 **128 个三角形**。在 VisBuffer 中，三角形 ID 占约 7 bit（2^7 = 128），用于在 Material Pass 中定位该三角形的三个顶点并做重心坐标插值。

VisBuffer 中 Triangle ID 的作用：
- 查找三角形对应的 3 个顶点索引
- 结合重心坐标插值 UV、Normal、Tangent 等属性
- 在 Material Pass 中执行材质着色

> 来源：UE5 源码 `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteDataDecode.ush`，解码函数 `DecodeTriangle()`

---

## 簇（Cluster）

Nanite 中最核心的调度单位。每个 Cluster 包含 **最多 128 个三角形和最多 128 个顶点**，是以下操作的原子单位：

| 操作 | 说明 |
|------|------|
| LOD 选择 | 基于屏幕空间尺寸，选择合适 LOD 的 Cluster |
| 流送 | 从磁盘按 Cluster 粒度加载/卸载 |
| 剔除 | 视锥、遮挡、屏幕尺寸阈值剔除均以 Cluster 为单位 |
| 光栅化路径选择 | 大三角形走硬件光栅化，小三角形走软件光栅化 |

相邻 Cluster 在同一 LOD 共享边缘以避免裂缝，LOD 切换发生在 Cluster 边界而非逐三角形。

> 来源：Brian Karis, "A Deep Dive into Nanite Virtualized Geometry", SIGGRAPH 2021
> 来源：Arseny Kapoulkine (zeux), "Nanite: GPU-driven rendering", zeux.io, 2022

---

## 实例（Instance）

实例指同一 Mesh 几何体使用不同 Per-Instance Data（主要是 Transform 矩阵）多次绘制。在 UE5 中：

- **ISM / HISM**：`UInstancedStaticMeshComponent` / `UHierarchicalInstancedStaticMeshComponent`，一个 Primitive 包含数千个 Instance
- **Nanite 下的实例化**：Nanite 的 GPU 驱动管线在 Cluster 层级逐 Instance 做剔除，比传统实例化（仅能在整个 Instance Bounds 层级剔除）更精细

VisBuffer 中 Instance ID 占约 27 bit，通过 Instance ID 查找 `FInstanceDraw` 缓冲区获取 Transform、材质索引等数据。

> 来源：UE5 源码 `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteStructs.h`，`FInstanceDraw` 结构体
> 来源：Epic Games, "Nanite Virtualized Geometry", UE 官方文档

---

## 图元（Primitive）

在 UE 渲染器中，Primitive 指 `UPrimitiveComponent`（及其渲染线程对应的 `FPrimitiveSceneProxy`），是场景注册的原子单位：

- 静态网格、骨骼网格、灯光等都是 Primitive
- 每个 Primitive 有独立的 Transform、Bounds、LOD 设置
- **Nanite 交互**：启用 Nanite 的 StaticMeshComponent 仍然是 Primitive，但不走传统 `FMeshDrawCommand` 绘制路径，而是被收集进 Nanite 自身的 GPU 驱动渲染管线

关键区别：
- **Primitive** = 场景级对象（Component）
- **Instance** = 渲染优化手段（同一几何体多次绘制）
- 一个 ISM Primitive 可包含数千个 Instance

> 来源：Epic Games, UE 官方文档 "Nanite Virtualized Geometry"
> 来源：UE5 源码 `Engine/Source/Runtime/Engine/Classes/Components/PrimitiveComponent.h`

---

## 过度绘制（Overdraw）

传统渲染中，重叠几何体导致同一像素被多次着色（即使只有最前面的可见），浪费 GPU 时间。

Nanite 通过 VisBuffer 两阶段架构**消除 Material Pass 中的过度绘制**：

1. **Visibility Pass**：仍有过度绘制（多个三角形光栅化到同一像素），但此 Pass 仅写入 ID（极低带宽开销），不做材质计算
2. **Material Pass**：每个像素**恰好着色一次**，零过度绘制

| 阶段 | Overdraw | 开销 |
|------|----------|------|
| Visibility Pass | 有（硬件深度测试自然淘汰） | 极低（仅写 ID） |
| Material Pass | 零 | 完整材质着色 |

着色代价 = O(屏幕分辨率)，而非 O(三角形数量)。

> 来源：Brian Karis, "A Deep Dive into Nanite Virtualized Geometry", SIGGRAPH 2021
> 来源：Epic Games, "Nanite Virtualized Geometry", SIGGRAPH 2021 课程

---

## 着色率（Shading Rate）

Nanite 的 VisBuffer 架构天然实现了**每像素恰好一次着色**，这本身就是一种着色率控制。此外：

- **Variable Rate Shading (VRS)**：Nanite 可利用硬件 VRS 在运动模糊区域或重度后处理区域降低着色分辨率
- **材质排序**：Material Pass 中像素按材质 ID 分组，提升缓存一致性和着色器切换效率

> 来源：Epic Games, UE 官方文档 "Nanite Virtualized Geometry"
> 来源：Brian Karis, SIGGRAPH 2021 Nanite 技术演讲

---

## 光栅分桶（Raster Bin）

Nanite 在光栅化阶段将 Cluster 按材质特性分桶（Bin），不同桶走不同的光栅化路径。以下为简化示意（实际实现使用 `FNaniteRasterBin` 等结构，更为复杂）：

```
分桶类别（简化示意）：
- Opaque   — 标准不透明几何
- Masked   — Alpha Test / 遮罩几何
- Compute  — 需要计算光栅化的几何（WPO、曲面细分等）
```

| Bin | 路径 | 说明 |
|-----|------|------|
| **Opaque** | 硬件光栅化（最快） | 无 Alpha Test、无 WPO，仅写 VisBuffer |
| **Masked** | 硬件光栅化（需评估遮罩） | Visibility Shader 中需计算 Opacity Mask 以决定是否丢弃像素 |
| **Compute** | 软件（计算着色器）光栅化 | WPO / 曲面细分等需要修改顶点位置的情况，走 `NaniteComputeRasterizer.usf` |

材质到 Bin 的分配逻辑在 `NaniteMaterialShader.cpp` 的 `GetRasterBin()` 中：如果材质使用 WPO 或曲面细分，则 `bMustBeComputeRasterized = true`，强制进入 Compute Bin。

> 来源：UE5 源码 `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteRenderContext.h`
> 来源：UE5 源码 `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteMaterialShader.cpp`

---

## 计算 WPO（Compute WPO）

WPO（World Position Offset）是材质中修改顶点世界位置的功能（如风吹树木、水面波动）。WPO 与 Nanite 存在根本冲突：

**冲突原因**：
- Nanite 的 GPU 剔除（`NaniteCulling.usf`）依赖 Cluster Bounds，这些 Bounds 在离线构建时计算，**不包含 WPO 偏移**
- 如果用硬件光栅化处理 WPO 几何，Cluster 可能因 Bounds 不准确而被错误剔除（物体消失）

**解决方案 — Compute WPO Bin**：
- 使用 WPO 的材质被分配到 `RASTER_BIN_COMPUTE`
- 走**计算着色器软件光栅化**路径，在光栅化阶段内联执行 WPO 顶点变换
- 使用单独的着色器排列（Shader Permutation）

**性能影响**：
- Compute 路径比硬件光栅化慢约 2-4 倍
- 需在材质或项目设置中显式启用 "Compute Nanite WPO"
- UE 5.3+ 起对 WPO 支持有所改善，部分小偏移量场景可通过 Bounds 扩展留在硬件路径

**启用方式**：
```
// 材质编辑器中勾选 "Evaluate World Position Offset" 选项
// 或项目级 CVar（具体名称以当前引擎版本为准）
r.Nanite.AllowComputeWPO 1
```

> 来源：UE5 源码 `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteMaterialShader.cpp`，`GetRasterBin()` 逻辑
> 来源：UE5 源码 `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteComputeRasterizer.usf`
> 来源：Epic Games, UE 官方文档 "Nanite Virtualized Geometry"，WPO 注意事项章节

---

## VisBuffer 编码格式

VisBuffer 为全屏 64 bit 纹理（`R32G32_UINT`，两个 32 bit 通道），每个像素编码：

| 通道 | 字段 | 位数 | 说明 |
|------|------|------|------|
| Low 32 bit (R) | ClusterIndex | 0–18 (19 bit) | Cluster 在 Mesh 中的索引 |
| Low 32 bit (R) | TriangleIndex | 19–25 (7 bit) | Cluster 内三角形索引 (0–127) |
| Low 32 bit (R) | Flags | 26–31 | 双面、材质标记等 |
| High 32 bit (G) | InstanceID | 0–26 (27 bit) | Instance 索引 |
| High 32 bit (G) | Flags | 27–31 | Instance 级标记 |

解码伪代码（简化自 `NaniteDataDecode.ush`）：

```hlsl
uint ClusterIndex  = Low32  & 0x7FFFF;
uint TriangleIndex = (Low32  >> 19) & 0x7F;
uint InstanceID    = High32 & 0x7FFFFFF;
```

> 来源：UE5 源码 `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteDataDecode.ush`
> 来源：UE5 源码 `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteStructs.h`，`FVisibleCluster` 结构体

> **注意**：以上 bit 分配基于 UE5 早期版本分析，Epic 在后续版本中可能调整了具体位数分配。准确值以当前引擎源码为准。

---

## 参考来源汇总

| 来源 | 类型 | 链接 |
|------|------|------|
| Brian Karis, "A Deep Dive into Nanite Virtualized Geometry" | SIGGRAPH 2021 演讲 | [Advances in Real-Time Rendering 2021](https://advances.realtimerendering.com/s2021/) |
| Epic Games, "Nanite Virtualized Geometry" | SIGGRAPH 2021 课程 | [Advances in Real-Time Rendering 2021](https://advances.realtimerendering.com/s2021/) |
| Arseny Kapoulkine (zeux), "Nanite: GPU-driven rendering" | 技术博客 | [meshoptimizer - zeux.io](https://zeux.io/2021/08/30/nanite-talk/) |
| Epic Games, "Nanite Virtualized Geometry" | UE 官方文档 | [Nanite Virtualized Geometry - UE Docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine) |
| UE5 源码 | 引擎源码 | [GitHub - EpicGames/UnrealEngine](https://github.com/EpicGames/UnrealEngine) (需要关联 Epic 账号) |
