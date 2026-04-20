+++
date = '2026-04-20T10:00:00+08:00'
draft = false
title = 'Nanite: A Deep Dive'
tags = ['UE', 'GPU', 'Nanite', 'VisBuffer', 'LOD']
categories = ['图形渲染']
+++

# Nanite: A Deep Dive

> **来源**: [Karis_Nanite_SIGGRAPH_Advances_2021_final](https://advances.realtimerendering.com/s2021/Karis_Nanite_SIGGRAPH_Advances_2021_final.pdf) — Brian Karis, Rune Stubbe, Graham Wihlidal
> **会议**: SIGGRAPH 2021 *Advances in Real-Time Rendering in Games* course
> **作者主讲**: Brian Karis (Engineering Fellow, Epic Games)
> **主题**: UE5 全新虚拟几何系统 Nanite 的深度技术解析

---

## 目录

1. [愿景与现实](#1-愿景与现实)
2. [可选方案的探索](#2-可选方案的探索)
3. [GPU Driven Pipeline](#3-gpu-driven-pipeline)
4. [三角形 Cluster Culling 与 Occlusion Culling](#4-三角形-cluster-culling-与-occlusion-culling)
5. [Visibility Buffer 与可见性/材质解耦](#5-visibility-buffer-与可见性材质解耦)
6. [次线性扩展与 Cluster 层次结构](#6-次线性扩展与-cluster-层次结构)
7. [LOD 裂缝问题与 DAG 构建](#7-lod-裂缝问题与-dag-构建)
8. [构建流程详解（Build Operations）](#8-构建流程详解build-operations)
9. [简化算法与误差度量](#9-简化算法与误差度量)
10. [运行时视相关 LOD 选择](#10-运行时视相关-lod-选择)
11. [并行 LOD 选择与层次裁剪](#11-并行-lod-选择与层次裁剪)
12. [Persistent Threads 与两 Pass Occlusion Culling](#12-persistent-threads-与两-pass-occlusion-culling)
13. [光栅化（软件 + 硬件混合）](#13-光栅化软件--硬件混合)
14. [小三角形与微多边形软光栅器](#14-小三角形与微多边形软光栅器)
15. [小实例（Tiny Instances）与 Imposter](#15-小实例tiny-instances与-imposter)
16. [延迟材质求值（Deferred Material Evaluation）](#16-延迟材质求值deferred-material-evaluation)
17. [流水线性能数据](#17-流水线性能数据)
18. [阴影：Virtual Shadow Maps](#18-阴影virtual-shadow-maps)
19. [Streaming（几何流送）](#19-streaming几何流送)
20. [压缩：内存表示与磁盘表示](#20-压缩内存表示与磁盘表示)
21. [结果与未来工作](#21-结果与未来工作)
22. [致谢与参考文献](#22-致谢与参考文献)

---

## 1. 愿景与现实

### 1.1 The Dream（梦想）

像 Virtual Texturing 那样**虚拟化几何**：

- **不再有预算限制**：Polycount、Draw calls、Memory 都不再需要管。
- **直接使用电影级源美术资源**：无需手动优化。
- **零质量损失**。
- 美术可以摆放任意数量、任意密度的网格，由他们自由决定如何构建场景。

> Brian 强调：在生产环境中，时间和金钱常常比"渲染技术"更影响最终质量。任何能让美术更高效、艺术表达更直接、让更多美术更狂野地参与制作的技术，都会带来巨大回报。

### 1.2 Reality（现实）

虚拟化几何 **比 Virtual Texturing 难得多**：

1. 不仅仅是内存管理问题；
2. 几何细节直接影响渲染开销（不像纹理那样只是采样开销）；
3. 几何不像纹理那样**可以被简单滤波**。

---

## 2. 可选方案的探索

### 2.1 Voxels（体素）

- 体素 / 隐式表面看似有潜力，但本质是**uniform resampling（均匀重采样）**，意味着信息损失。
- 一个 2M 多边形的胸像被重采样到 13M narrow band SDF 体素后仍显得"blobby"，而数据量是原来的 6 倍。
- 对**有机表面**尚可，对**硬表面建模**则极具破坏性。
- 核心问题：
  - 数据稀疏需求 vs 光线投射性能；
  - 数据结构需要极强自适应才能保留锐利边缘；
  - 即使如此，最精细分辨率仍不等于原始网格。
- 不愿完全更换 CG 工作流：仍需支持 UV、tiling detail map、不破坏材质/工具体系。
- 体素+UV 的接缝、薄结构消失、属性穿透、动画驱动等问题非常多。

### 2.2 Subdivision Surfaces（细分曲面）

- 仅能放大细节，不能简化（最简就是 base cage）。
- 美术建模的 cage 通常已比游戏 low poly 还高，电影级别更糟糕一个数量级。
- 需要"美术建模选择"与"渲染开销"完全解耦，细分做不到。

### 2.3 Displacement Maps（位移贴图）

- 类似法线贴图那样捕获位移；vector displacement 可让 low poly 更低。
- 但**位移无法改变曲面 genus**——不能将球面位移成圆环。例：链条无法用一个简单网格位移得出。
- 也是 uniform resampling，对硬表面破坏严重。
- 适合放大细节，**不适合通用简化**。

### 2.4 Points（点）

- 点光栅化非常快，但**需要补洞**。
- 无法通过单纯的点判断"小缝是该有的"还是"洞需要填补"——这正是连接性（=三角形索引缓冲区）的作用。

### 2.5 Triangles（三角形）

> 经过长期探索，作者结论：**对 UE 的需求来说，没有比三角形更高质或更快的方案**。其他表示有其用武之地，但 Nanite 的核心是三角形。

---

## 3. GPU Driven Pipeline

将 UE 渲染器升级为 state-of-the-art 三角形管线：

- **Renderer 改为 Retained Mode**：
  - GPU 中持有完整场景表示；
  - 跨帧持久化；
  - 仅在变化处稀疏更新。
- 所有 Nanite 顶点/索引数据存放在**单个大资源**中，无需 bindless 即可一次访问全部。
- 每个 view：
  - GPU instance cull；
  - 三角形光栅化；
- 仅绘制深度时，整场景可用 1 次 `DrawIndirect` 完成。

---

## 4. 三角形 Cluster Culling 与 Occlusion Culling

### 4.1 Cluster Culling

- 将三角形聚合成**clusters**，每个 cluster 构建包围盒；
- 基于包围盒进行 **frustum cull** 与 **occlusion cull**；
- Cone-based backface culling 通常意义不大，因为背面 cluster 几乎都被 occlusion cull 干掉。

### 4.2 Hi-Z 遮挡剔除

- 针对 **HZB (Hierarchical Z-Buffer)** 进行测试；
- 计算 cluster 在屏幕空间的 rect，找到 rect ≤ 4×4 像素的最低 mip 层进行测试。

### 4.3 HZB 从哪来？两 Pass 遮挡剔除

- 重投影上一帧 z-buffer 的方案近似且不保守。
- 核心假设：**上一帧可见的物体本帧很可能仍然可见**。
- 不要重投影深度图，而要**重投影几何**：
  1. 绘制上一帧可见的对象 → 生成本帧 HZB；
  2. 用该 HZB 测试本帧"现在可见但上帧未可见"的对象。
- 几乎完美的 occlusion culling，仅在极端可见性变化时退化。

> First GPU-driven occlusion culling: *March of the Froblins* [38]
> First two-pass occlusion: *Patch-based Occlusion Culling for Hardware Tessellation* [19]

---

## 5. Visibility Buffer 与可见性/材质解耦

### 5.1 解耦的目的

希望消除：
- 光栅化中切换 shader；
- 材质求值时的 overdraw；
- 用 depth prepass 减少 overdraw 的额外开销；
- 密集网格的 pixel quad 浪费。

可选方案：REYES、Texture space shading、Deferred materials。
对象空间着色普遍有 **4× 以上 overshade**，view-dependent / animating / non-UV materials 也难以缓存。

### 5.2 Visibility Buffer 的具体形式

- 光栅化阶段写入最小的几何数据：**Depth | InstanceID | TriangleID**；
- 材质 pixel shader（per-pixel）：
  1. Load VisBuffer；
  2. Load instance transform；
  3. Load 3 vert indexes；
  4. Load 3 positions；
  5. Transform positions to screen；
  6. Derive barycentric coordinates；
  7. Load and lerp attributes。

> 术语注解：作者认为只有 ObjectID + TriangleID（顶多再加 barycentric）才能叫 "Visibility Buffer"，把顶点属性写到屏幕缓冲属于 deferred texturing。

### 5.3 优势

- 听上去慢，但缓存命中率高，且没有 overdraw / pixel quad 低效；
- Material pass 写 GBuffer，可与现有 deferred shading 渲染器无缝集成；
- **整个不透明几何可以一个 draw 完成**，完全 GPU driven；
- 每个 view 仅光栅化一次三角形，无需多 pass 减 overdraw。

---

## 6. 次线性扩展与 Cluster 层次结构

### 6.1 为何需要次线性

- Visibility Buffer 仍是 **O(N)** 实例 + 三角形；
- 实例 100 万级别可接受，但三角形线性增长不能接受；
- Ray Tracing 是 O(log N)，但理论 O(log N) → O(1) 在 cache miss 主导下差距可能巨大；
- 屏幕像素数有限，不该绘制多于像素数的三角形；
- **理想：cost 与屏幕分辨率挂钩，与场景复杂度无关 ⇒ 常数时间 ⇒ LOD 必须存在**。

### 6.2 Cluster Hierarchy

- 在 cluster 粒度上做 LOD；
- 构建一个 LOD 树：父节点是子节点的简化版本；
- 运行时找到匹配目标 LOD 的"切割面"；
- 同一网格不同部分可处于不同 LOD，**view dependent**：基于 cluster 的 screen-space projected error。

### 6.3 Streaming（虚拟化部分）

- 整棵树不必常驻内存；
- 任何"切割面"以下都可作为叶子，其余丢弃；
- 按需求请求数据（类似 Virtual Texturing）；
- 没有的子节点 → 从磁盘请求；常驻但久未使用 → 驱逐。

---

## 7. LOD 裂缝问题与 DAG 构建

### 7.1 朴素方案与失败

- 各 cluster 独立选 LOD ⇒ 边界不匹配 ⇒ **裂缝**。
- Naive 解：锁定共享边界。
- 失败原因：相同边界跨多层级一直被锁，**密集 cruft 堆积**；balanced tree 中可能从 LOD0 一路画到根都无法穿越某条锁定边。

### 7.2 解决方案：分组 + 强制同 LOD 决策

- 在 build 时把 cluster 分组，**强制同组 cluster 做同一 LOD 决策**；
- 同组之间不再独立 ⇒ 不可能错位 ⇒ 不会裂缝；
- 分组内部的共享边可以**解锁并合并**（视作内部边）。
- 关键技巧：**逐层级交替分组边界**，使得本层的边界在下一层成为内部，不再被持续锁定。

### 7.3 备选方案对照

| 方案 | 评价 |
|---|---|
| 直接索引邻居顶点（VDPM 系列） | 三角形粒度太细、计算与内存代价大 |
| Skirts（裙边） | 来自地形渲染，对任意 mesh 不直观；要求 manifold/watertight，clipping 复杂 |
| Implicit dependency（Progressive Buffers, Adaptive TetraPuzzles） | LOD 必须固定距离带；TetraPuzzles 按空间划分导致单个 cluster 三角形数失控 |
| **Explicit dependency（Quick-VDR, Batched Multi-Triangulation）** | **Nanite 主要参考的方向** |

Nanite 是 Quick-VDR 与 Batched Multi-Triangulation 的混合 + 自有洞见：
- 之前的工作以三角形分组，导致每组三角形数不固定；
- **Nanite 以 cluster 分组，使每组始终为 128 的整数倍**，从而 split 后 cluster 完美填充 128 三角形。

---

## 8. 构建流程详解（Build Operations）

### 8.1 流程

```
Cluster original triangles
While NumClusters > 1:
    Group clusters to clean their shared boundary
    Merge triangles from group into shared list
    Simplify to 50% the # of triangles
    Split simplified triangle list into clusters (128 tris)
```

### 8.2 DAG 形态

- Merge + Split → 形成 **DAG**（不是 tree）；
- 所有 siblings 同时连到所有 parents；
- 优势：从 LOD0 到根的任何路径都必经过某条边 ⇒ 不会有持续锁定的边。

### 8.3 如何选择分组的 cluster

- 选共享边界最多的 cluster 一起分组（共享多 ⇒ 锁少）；
- 这是一个**Graph Partitioning** 问题：
  - 节点：cluster；
  - 边：相连 cluster 之间，权重 = 共享三角形边数；
  - 额外加入空间临近边（处理孤岛）；
  - 最小 edge cut ⇔ 最少锁定边。
- 用 **METIS 库**求解。

### 8.4 初始 cluster 构建

多目标优化：

| 优化目标 | 原因 |
|---|---|
| 最小化 cluster bounds extent | 提升 culling 效率 |
| NumTris/cluster ≤ 上限（128） | 填满光栅化 wave |
| NumVerts ≤ 上限 | 受 primitive shader 限制 |
| 最小化 cluster 间共享边 | 边界被锁，限制简化 |

实操中只优化 2 项（边界数 + 三角形数），其余靠相关性。本质同样是 graph partitioning（mesh dual），唯一不同是要求**严格的分区上限**——通过容许少量 slack 与 fallback 实现。

### 8.5 Split = 初始聚类

> 简化后再 split 成 128-三角形 cluster 这一步，本质上和初始 leaf cluster 构建是同一过程。

---

## 9. 简化算法与误差度量

### 9.1 算法

- **Edge collapsing decimation**；
- 优先 collapse 最小 error 边；
- 误差用 **Quadric Error Metric (QEM)**；
- 对新顶点位置/属性做最小误差优化；
- 高度优化的实现，质量与速度均超越商业方案；
- 返回简化引入的 error 估计值，用于运行时投影到屏幕像素 → 决定 LOD 选择。

### 9.2 难点：误差度量

- 不知道材质属性（光泽、UV、vertex color）⇒ 无法精确预测感知误差；
- Position 与 Attribute（如法线偏差）的混合本质是无理论根基的 hack；
- 法线偏差与尺度无关，位置偏差与尺度相关 ⇒ 平衡极难。
- Nanite 解决方法：以 cluster group 为简化单位，**按平均三角形面积归一化网格** → 让大型 mesh 的远处部分与小型 mesh 表现一致。
- 实践收益：把"统计室"vs"洞穴"两个 demo 从 2-3× 差异拉平到大致相同的三角形数。

### 9.3 预滤波（Future Work）

- 法线分布可滤（类似 normal map → roughness）；可参考 SGGX；需作用到 diffuse 与 BxDF；
- 难点：非均匀三角形大小、顶点 footprint 不对称、minification/magnification 同时发生；
- 可见性的预滤波 = partial coverage，三角形 mesh 不再合适；
- 最佳方案应是 **mesh+volume hybrid**（superpixel = mesh，subpixel = volumetric）；
- 渲染 partial coverage 的体素方式：stochastic / ray march / point scatter / OIT。
- 对 grass、leaves、hair 等 aggregate 至关重要，仍是 open question。

---

## 10. 运行时视相关 LOD 选择

### 10.1 选择逻辑

- 同一 group 简化前后的 cluster **共享外部边界，可互换** ⇒ LOD 系统的本质；
- 基于估计的 screen-space error 选择；
- error 投影时考虑距离、投影角度，并在 cluster 包围球内取使误差最大化的点。

### 10.2 同组同决策（无需通信）

- 同组所有 cluster 存储**统一的 error 与 sphere bounds**；
- 同输入 ⇒ 同输出，自然一致，无需通信。

### 10.3 一次正确切割：单调误差

- LOD 选择 ⇔ 在 DAG 上找一条切割面；
- 局部判定：`ParentError > threshold && OurError ≤ threshold` ⇒ 绘制本 cluster；
- **完全可并行**；
- 但仅当切割唯一存在；要求"父 view error ≥ 子 view error"，即误差函数沿任何路径单调；
- 通过离线 build 修改父节点存储的 error / bounds 实现（父值 ≥ 子值）。

### 10.4 无缝 LOD：靠 TAA

- 每帧二选一（父 or 子）；
- 不做 geomorphing/cross fade（昂贵 + 数据多）；
- **仅当 error < 1 像素时切换**——感知上无差别 + Temporal AA 自然平滑；
- 这就是为什么准确的 error estimate 至关重要。

### 10.5 关于角度 LOD

- 当前 cluster error 是 object-space 标量，**未考虑掠射角**；
- 类似 mipmap 仅按距离决定 ⇒ 掠射角度 over-tessellate；
- 解决需各向异性 LOD，无法在 cluster 选择级别完成（必须同 mip 选择一样各向同性）；
- 这种问题在其它表示（点云 overdraw、SDF/SVO 表面 skim）中也存在。

---

## 11. 并行 LOD 选择与层次裁剪

### 11.1 为什么 LOD 也需要层次裁剪

- 远场景下绝大多数 cluster 太精细，浪费评估；
- 大场景下需快速拒绝 → 层次结构。

### 11.2 加速结构（Hierarchical Culling）

- 既然 LOD 选择完全 local，可以**任意构建加速结构**；
- 可剔除条件：`ParentError ≤ threshold || ClusterError > threshold`；
- 如果父节点已足够精细，就无需检查子节点；
- 因此加速结构应基于 **ParentError** 而非 ClusterError；
- Nanite 选择 **BVH8**：内部节点 8 个孩子；叶节点 = group 内 cluster 列表（共享 parent）。

### 11.3 朴素遍历的问题

- Dependent DispatchIndirect，每层一次，全局同步；
- 必须保留最坏深度的 dispatch ⇒ 末尾空 dispatch；
- 提高 fanout 部分缓解，但小/远物体仍浪费。

---

## 12. Persistent Threads 与两 Pass Occlusion Culling

### 12.1 Persistent Threads

- 理想：父过 → 立刻子开始；从 compute 直接 spawn 新线程（目前不可行）；
- 替代：固定数量线程 + 自管理 job queue；
- 单 dispatch、无递归深度限制、不需要反复 drain GPU；
- 平均节省 25%，复杂场景节省 10–60%；
- 依赖未在 D3D/HLSL 中规定的调度行为：**一个已开始执行的 thread group 不会被无限饿死**——目前在所有测试过的 console/GPU 上都成立，但仍只是优化、并非必需。

### 12.2 Cluster Culling 整合

- 节点活动数有时不足以填满 GPU；
- 通过引入第二个 cluster 队列：节点稀少时先处理 cluster 队列；
- 以 64 为批避免 divergence。

### 12.3 两 Pass Occlusion Culling 实战

- 显式跟踪上一帧可见集太复杂（LOD 选择不同、可能已被 streaming 卸载）；
- 改为：**测试当前选中的 cluster 是否在上一帧可见**（用上一帧 transform 测试上一帧 HZB）；
- 流程：
  ```
  PrevHZB Test → Visible → Raster → Rebuild HZB
                                         ↓
                Occluded → Retest → Visible / Disoccluded → Raster → Rebuild HZB
  ```

### 12.4 Culling Dataflow

```
Main Pass:
  PrevHZB + GPUScene
    → Instance Culling
    → Persistent Hierarchy/Cluster Culling
    → SW Rasterizer / HW Rasterizer
    → Build HZB

Post Pass (针对 occluded instances + occluded nodes/clusters):
    → Instance Culling
    → Persistent Hierarchy/Cluster Culling
    → SW Rasterizer / HW Rasterizer
    → Build HZB
    → Material Passes
```

整个 Nanite 管线 **跑两遍**（第 2 遍只补 disocclusion，远小于第 1 遍）。Frustum/LOD 等与 occlusion 无关的剔除只做一次。

---

## 13. 光栅化（软件 + 硬件混合）

### 13.1 像素级细节

- 三角形 > 1 像素一般无法实现像素级无误差；
- 必须能绘制 **像素大小的三角形**。

### 13.2 小三角形对硬件光栅化器的不友好

- 硬件光栅化器：macro tile binning → micro tile 4×4 → 输出 2×2 quad；
- **highly parallel in pixels, not triangles**；
- 现代 GPU 一般 4 tris/clock；输出 `SV_PrimitiveID` 更糟；
- Primitive/Mesh shaders 仍受瓶颈；
- 结论：**软件光栅化可以打败硬件**。

### 13.3 软光栅器：3× 更快

- 比基于 primitive shader 的最快实现快约 3×；
- 比传统 VS/PS 路径快得多；
- 微多边形的极端情况下优势更明显。

### 13.4 深度测试：64-bit Atomic

- 失去 ROP 与硬件 depth test，但仍需 z-buffering；
- 不能 tile 锁，单 tile / 单像素可能多三角形并发；
- 解决：**全屏 64-bit `InterlockedMax`**；
- 64-bit 高位为 depth（用于 depth test）、低位为 payload（visible cluster index + triangle index）；
- payload 必须 ≤ 34 bit ⇒ Visibility Buffer 真正的威力体现。

格式示意：

```
[ Depth: 30 bits | VisibleClusterIndex: 27 bits | TriangleIndex: 7 bits ]
```

---

## 14. 小三角形与微多边形软光栅器

### 14.1 微多边形软光栅器结构

- 128 三角形/cluster ⇒ threadgroup size 128；
- **第 1 阶段**：1 thread per vertex
  - Transform vertex；
  - 存到 groupshared；
  - 顶点 > 128 时循环（最多 256）。
- **第 2 阶段**：1 thread per triangle
  - Fetch indexes；
  - Fetch transformed positions；
  - 计算 edge equations 与 depth gradient；
  - 计算 screen bounding rect；
  - 对 rect 内每个像素：若在三角形内 → 写像素。

### 14.2 内层循环（基础版）

```hlsl
for (uint y = MinPixel.y; y < MaxPixel.y; y++) {
    float CX0 = CY0; float CX1 = CY1; float CX2 = CY2;
    float ZX = ZY;

    for (uint x = MinPixel.x; x < MaxPixel.x; x++) {
        if (min3(CX0, CX1, CX2) >= 0)
            WritePixel(PixelValue, uint2(x,y), ZX);

        CX0 -= Edge01.y; CX1 -= Edge12.y; CX2 -= Edge20.y;
        ZX  += GradZ.x;
    }
    CY0 += Edge01.x; CY1 += Edge12.x; CY2 += Edge20.x;
    ZY  += GradZ.y;
}
```

- `WritePixel` = 把 depth + payload 打包后 atomic-max 写到屏幕；
- 不引入额外固定开销，因为期望迭代很少。

### 14.3 硬件光栅化路径

- 大三角形交给 HW raster；
- 选择粒度：**每 cluster** 决定 SW or HW；
- HW 也使用 **64b atomic 写 UAV**——不绑定 color/depth，避免与 SW 路径合并造成无法 async overlap；
- 严格遵循 DirectX 光栅化规则，确保 SW/HW 之间无 pixel crack。

### 14.4 Scanline 软光栅器

- "多大算大"远超预期：cluster 边长 < 32 像素都用 SW；
- 微多边形 rect 遍历空检率高；
- **Scanline 优化**：直接解出每行覆盖 X 区间，仅迭代被覆盖像素。

```hlsl
float3 Edge012   = { Edge01.y, Edge12.y, Edge20.y };
bool3  bOpenEdge = Edge012 < 0;
float3 InvEdge012 = (Edge012 == 0) ? 1e8 : rcp(Edge012);

for (uint y = MinPixel.y; y < MaxPixel.y; y++) {
    float3 CrossX = float3(CY0, CY1, CY2) * InvEdge012;
    float3 MinX = bOpenEdge ? CrossX : 0;
    float3 MaxX = bOpenEdge ? (MaxPixel.x - MinPixel.x) : CrossX;

    float x0 = ceil(max3(MinX.x, MinX.y, MinX.z));
    float x1 = min3(MaxX.x, MaxX.y, MaxX.z);
    float ZX = ZY + GradZ.x * x0;

    x0 += MinPixel.x; x1 += MinPixel.x;
    for (float x = x0; x <= x1; x++) {
        WritePixel(PixelValue, uint2(x,y), ZX);
        ZX += GradZ.x;
    }
}
```

- 失去精确定点数学，但实测无问题；
- 当 wave 内任一三角形 X loop > 4 像素时启用 scanline 版本。

### 14.5 光栅化 Overdraw 现状

- 无 per-triangle culling；
- 无 HW HiZ 像素级剔除；
- SW HZB 来自上一帧，仅按 cluster 粒度剔除；
- 易出现 overdraw 的场景：大 cluster、重叠 cluster、aggregate（叶/草）、快速运动；
- Overdraw cost：
  - 小三角形：bound on vertex transform + setup；
  - 中三角形：bound on coverage test；
  - 大三角形：bound on atomic。

> Per-triangle occlusion culling 因两 pass occlusion 与 1-thread/triangle 映射的 divergence 问题不被采用。
> 当前依赖上一帧 HZB 是 Nanite 最大缺陷之一；未来需考虑 streaming HiZ。

---

## 15. 小实例（Tiny Instances）与 Imposter

### 15.1 问题

- DAG 终止于 1 个根 cluster（128 三角形），cost 不再随分辨率缩放；
- 不能简单按距离剔除：可能是建筑结构件，整栋楼会消失；
- 美术拿到 Nanite 后实例数推得比多边形更多——"实例是新的三角形"。

### 15.2 必须合并

- 即便渲染 sublinear，**内存**也线性增长；
- 10M instance × float4×3 = 457MB；
- 未来希望支持**层次实例化**（实例的实例的实例）；
- 但仍需在远处合并为 unique proxy；目标：尽量推远那个距离。

### 15.3 Visibility Buffer Imposters

- 12×12 view direction（XY 经 octahedral 映射，dithered direction 量化）；
- 12×12 像素/方向；正交投影；按 mesh AABB 紧贴；
- 8:8 Depth, TriangleID；
- **40.5KB / mesh，常驻**；
- 用 ray march 处理方向间视差（很少几步即可）；
- 直接在 instance culling pass 中绘制，绕过 visible instances 列表；
- 可被注入屏幕 visibility buffer，支持材质重映射、非均匀缩放等；
- 缺点：相邻同 mesh 切换可见、希望未来替换为更优方案。

---

## 16. 延迟材质求值（Deferred Material Evaluation）

### 16.1 VisBuffer 解码（材质 PS 前奏）

```
Load VisBuffer
Load VisibleCluster   → InstanceID, ClusterID
Load instance transform
Load 3 vert indexes
Load 3 positions
Transform positions to screen
Derive barycentric coords
Load and lerp attributes
```

### 16.2 Material ID 推导

```
VisibleCluster        → InstanceID, ClusterID
ClusterID + TriangleID → MaterialSlotID
InstanceID + MaterialSlotID → MaterialID
```

### 16.3 一个 Material 一个全屏 Quad

- 不匹配 ID 的像素跳过；
- CPU 不知道哪些 material 实际可见，所有 material 的 draw 都得发；
- 不能每像素挨个比对每 material。

### 16.4 用深度测试硬件做材质裁剪

- Stencil 不行（每 material 要 reset）；
- 改为利用 depth test：**MaterialID → Depth value**；
- Compute shader 同时输出 standard depth + material depth + HTILE（HiZ 加速）；
- 每 material 绘制全屏 quad，quad Z = MaterialDepth，depth test = EQUAL。

> 来自 Dawn engine [50]，对方还按 material 屏幕 rect 缩小覆盖，但 Nanite 中同 material 经常分布在屏幕两端，rect 法效果差。

### 16.5 Tile 级精细裁剪

- 多数材质只覆盖小区域，HiZ 良好但还能更好；
- 改为**8×4 tile grid**，按 32-bit mask 在 vertex shader 中将不需要的 tile 设 X = NaN 杀掉；
- Wave intrinsics 不可用时退化为 64×64 + 64-bit mask（可能 alias，但实测良好）；
- 该模块正在重构，未来可能完全 compute-based；
- 可用时使用 rect primitives 避免对角 overshade（PC API 支持不完美，console 走该路径）。

### 16.6 UV Derivatives

- 仍是 coherent pixel shader，可用 finite difference；
- Pixel quad 跨三角形 → 微多边形下大幅减少 quad overdraw（**好事**）；
- 但 quad 也跨深度断面、UV seam、不同对象 → 衍生噪声 mip。

### 16.7 解析导数（Analytic Derivatives）

- 计算三角形 attribute gradient；
- 在 artist 创建的 material node graph 上**链式法则自动传播**；
- 不可解析的算子退回 finite differences；
- 替换 `Sample` 为 `SampleGrad`；
- 实测开销 < 2%（仅作用于影响纹理采样的运算；virtual texturing 本身已 SampleGrad）。

> Mathematically simple chain rule per op；理想实现应在 shader compiler（如 OSL），目前在 node graph → HLSL 翻译阶段完成 [77, 78]。

---

## 17. 流水线性能数据

### 17.1 一帧示例（Lumen in the Land of Nanite demo）

| 指标 | 数值 |
|---|---|
| Main pass: Instances pre-cull | 896 322 |
| Main pass: Instances post-cull | 3 668 |
| Cluster node visits | 1 536 794 |
| Cluster candidates | 184 828 |
| Visible clusters SW | 6 686 |
| Visible clusters HW | 102 804 |
| Post pass: Instances pre-cull | 365 |
| Post pass: Instances post-cull | 19 139 |
| Cluster node visits | 458 805 |
| Visible clusters SW | 7 370 |
| Visible clusters HW | 536 |
| **总光栅化 Clusters** | **199 420** |
| **总光栅化 Triangles** | **25 041 711** |
| **总光栅化 Vertices** | **19 851 262** |

> 同帧用传统 UE4 路径需要光栅化 10 亿+三角形；Nanite 仅 25M。整个 demo 这个数字基本恒定。

### 17.2 时间开销（动态分辨率，平均 ~2496×1404 上采样到 4K，TAAU；现已可用 TSR）

| 阶段 | 时间 |
|---|---|
| Clear VisBuffer | 66 µs |
| Main Pass: InstanceCull | 108 µs |
| Main Pass: ClusterCull | 406 µs |
| Main Pass: Rasterize | 1 148 µs |
| BuildHZB | 99 µs |
| Post Pass: InstanceCull | 125 µs |
| Post Pass: ClusterCull | 102 µs |
| Post Pass: Rasterize | 183 µs |
| Nanite::BasePass | 217 µs |
| DepthExport / Emit GBuffer | 2 084 µs |
| **整 VisBuffer 绘制** | **~2.5 ms** |
| **VisBuffer → GBuffer 材质 pass** | **~2 ms** |

适合 60Hz 游戏。

---

## 18. 阴影：Virtual Shadow Maps

### 18.1 为什么不用 RT

- 阴影射线数 > 主视图射线数；
- 当前 DXR 不够灵活：复杂 LOD 逻辑、自定义三角形编码、无法部分更新 BVH；
- HW 三角形格式 + BLAS 体积是 Nanite 内存格式的 3-7×；不带属性也比 Nanite 高 60%；
- 未来会探索 RT，但当前选择 raster 路径并复用所有现有工作；
- 多光源 ⇒ Nanite cost 不能因阴影而失控；
- 多数光源 + 投射阴影几何**不动** ⇒ 缓存。

### 18.2 Virtual Shadow Maps 架构

- 16K × 16K shadow map（spot:1; point:6 cube; directional: N clipmaps）；
- mip 选择：1 texel = 1 pixel；
- 仅渲染屏幕实际采样到的 shadow pixel；
- Nanite 自然按需 culling/LOD 到所需细节；
- Page size = 128×128，page table = 128×128（含 mips）。

### 18.3 Page 分配

- 屏幕像素投到 shadow space → 选 mip → 标记需要的 page；
- 为所有需要的 page 分配物理页；
- 已缓存且未失效的页直接复用；
- 多数帧只更新动物体 + 摄像机移动后的 frustum 边缘；
- 未对投影斜率做 mip 选择补偿（实测 craggy rock 噪声大，靠 global mipbias 平衡）。

### 18.4 Multi-View Rendering

- Nanite 管线深、同步开销大；spinning up 多次代价高；
- `NumShadowViews = NumLights × NumShadowMaps × NumMips` 巨多；
- Nanite 支持 view 数组：**一次 chain dispatch 渲染整场景所有 light 的所有 shadow map 的所有 mip**；
- 极端情况下相比独立调用快 100×。

### 18.5 Page 寻址与裁剪

- 在 HZB 测试旁加 needed-page 测试，未覆盖 needed page 即裁剪；
- 物理纹理在虚拟空间不连续 → 跨页 cluster 不能直接寻址；
  - **SW raster**：每 overlapped page 发一个 cluster，做一次 page 转译 + 像素 scissor；保持 inner loop 简洁（额外 shift 都能测出影响）；
  - **HW raster**：cluster 大、重叠多页，逐像素做虚拟到物理转译再 atomic 写。

### 18.6 Nanite Shadow LOD

- Page 规则：1 texel = 1 pixel；
- LOD：< 1 像素误差；
- 阴影 cost 也按分辨率扩展（× per-pixel light 数）；
- Shadow triangle 与 primary triangle 不一定一致 → self-shadow 错配 → 用短屏幕空间 trace 弥补；
- 默认 shadow Nanite LOD bias = 2 像素误差（已有 screen trace 弥补）。

---

## 19. Streaming（几何流送）

### 19.1 概念

- 类似 Virtual Texturing：GPU 请求、CPU 异步填充；
- DAG 中断切割必须**始终是有效切割**——不允许产生裂缝。

### 19.2 Streaming Unit

- Cluster group 是简化的最小单位 ⇒ 也是 streaming 的最小单位；
- 任何 cluster 必须等同 group 兄弟全部加载后才能渲染；
- 几何大小可变 → 用**固定大小 page**（避免内存碎片），每页存放可变数量 cluster。

### 19.3 Paging

- 按空间局部性把 group 装进 fixed-size page；
- **Root page 始终常驻**：含 DAG 顶部，保证总有可绘制内容；
- Page 内容：index data + vertex data + meta（bounds, LOD info, material tables 等）；
- 常驻 page 全部存在一个大 GPU ByteAddressBuffer。

### 19.4 Group 部分（解决 slack）

- Cluster ~2KB，group 8-32 cluster ⇒ 整 group 装页 slack 大；
- **Split group across pages**（page 内 cluster 粒度装填），group 全部到位后才启用；
- 平均 1KB/page slack（128KB page 仅 ~1% 浪费）；
- Group 的 part 总是分配到连续页，便于一次请求。

### 19.5 决定 Stream 什么

- VT 直接由 UV/gradient 决定；
- Nanite 必须遍历 hierarchy，看"如果在内存里会不会画"；
- 因此**culling hierarchy 始终全量常驻**（小，仅 group 元数据）；
- 优点：traversal 与当前流送状态独立；
- 新对象可立即请求所有需要级别，不必逐帧逐级；否则 IO latency × 层级数 → 明显 pop in。

### 19.6 Streaming Requests

- Persistent shader 在 culling 中输出 page 请求（含按 LOD error 决定的优先级）；
- 同时也对常驻页发请求来更新优先级；
- CPU 异步读回：补全 DAG 依赖、按总优先级发 IO、驱逐低优先级页；
- IO 完成后：安装 GPU page、修复 GPU 端指针（pages、split groups、leaf 标记）。

---

## 20. 压缩：内存表示与磁盘表示

### 20.1 两种表示

| 维度 | 内存表示 | 磁盘表示 |
|---|---|---|
| 用途 | 直接渲染 | streaming 时转码到内存格式 |
| 解码代价 | 近瞬时 | 可承受高代价 |
| 随机访问 | 必须支持（VisBuffer） | 不需要 |
| 假设 | — | 数据将被 byte-based LZ 压缩 |
| 目标 | 节省内存 / 带宽 | 减少压缩后磁盘体积 |

### 20.2 顶点量化与编码（内存）

- 全局量化（美术控制 + 启发式）；
- **Cluster 局部坐标**（相对该 cluster 的 min/max range）；
- Per-cluster custom vertex format：每分量取 `ceil(log2(range))` bits；
- 顶点是 bit-stream，不字节对齐；需要 vertex declaration 解码；
- GPU bitstream reader：编译时给定每次读取上限，仅在累计上限溢出才 refill ⇒ 重要省时（divergent lane 尤甚）。

### 20.3 顶点位置（避免裂缝）

- 量化必须一致，否则裂缝；
- 跨对象（模块化关卡）尤甚，build 阶段不知道摆放；
- 解决：**对象空间网格 + 用户可选的 2 的幂步长（如 1/16cm），中心在物体原点**；
- **不要按 bounds 归一化**；
- 当 quantization level、scale、translation（步长倍数）一致（90° 整倍数旋转也行）时，跨对象顶点完美对齐；
- 仅 leaf level 完美对齐；高 LOD 因简化决策不同存在差异（远处误差 ≤ 像素，影响小）。

### 20.4 三角形与属性（内存）

- **三角形索引**：`base index` + 两个 5-bit 正向 offset（构建器保证三角形索引跨度 ≤ 32）；典型 ~17 bits/tri (7+5+5)；
- **UV**：处理 seam，排除最大 gap，等效双区间编码；
- **Normal**：octahedral 编码；
- **Tangent**：**0 bits**！每像素从 UV gradient 隐式推导。

### 20.5 隐式切线空间

- Tangent / bitangent = view-space 法向平面上的 U/V 方向，可推导；
- 与 Mikkelsen 屏幕空间推导类似，但 Nanite 直接用三角形局部 uv/position delta（barycentric / texture LOD 已计算过的数据）；
- 高多边形场景下连续性问题不显著；将来支持显式 tangent；
- 出处见 Schüler [84]。

### 20.6 Material Tables

- 每 cluster 存材质表，按三角形范围记录材质归属；
- 32 bit 双编码：
  - 快路径：3 个 range；
  - 慢路径：指向独立内存，最多 64 material；
- 三角形按材质排序后存 range，查询时按 triangle index 在 range 里查找。

### 20.7 磁盘：硬件 LZ + GPU 转码

- 假设硬件 LZ（console 已具备，PC 走 DirectStorage）；
- 不自造 entropy coder，**专注 LZ 不擅长的部分**：domain-specific transforms；
- 转码上 **GPU**，并行化高，PS5 上当前未优化代码已 ~50 GB/s；
- GPU 转码可直接引用已驻 parent page 数据，省去 CPU 副本；
- 未来可能数据直接 disk → GPU，绕开 CPU。

### 20.8 LZ 优化技巧

- 对齐到字节：上采样数据让 LZ 找到更多 match，且不打乱 byte 统计；
- 同类型数据相邻排列，最小化 match offset；
- 偏好小字节值，让字节统计更偏，提升 entropy coding 收益。

### 20.9 顶点去重（磁盘）

- 聚类天然产生重复（共享边界 & 简化未触及的顶点）；
- LZ 看不到（编码差异 + parent 数据只在 GPU page pool）；
- 改为存**引用**（仅同页或父页，父页保证已加载）；
- ~30% 顶点可编码为引用；
- 多级一起 stream 时 streamer 做 topology sort，确保父先于子；
- 解码引用时需要把源 bitstream 重编为当前 cluster 格式；
- 未来可扩展为**预测编码**（不仅精确匹配）。

### 20.10 拓扑编码（磁盘）

- 基于 generalized triangle strips：
  - 第一个三角形 3 个 index，后续每三角形仅 1 新 index；
  - 允许每步显式 left/right（而非交替），形成更长 strip；
  - 顶点按首次使用排序，首次引用的 index 等于"已见顶点数"，可省略；
  - 已见顶点引用以 5-bit 偏移自最高已见顶点；
  - 用 bitscan/popcount 支持随机访问。
- 结构 = 一系列 bitmask（重置/左右/是否显式引用 + ref 值）；
- ~5 bits/tri（vs 内存格式 ~17 bits/tri）；
- 原本想用作 memory 格式，因解码不够快被推到 transcoding 阶段；既不是内存最优也不是磁盘最优，未来可继续优化。

---

## 21. 结果与未来工作

### 21.1 Lumen in the Land of Nanite 数据

| 指标 | 数值 |
|---|---|
| Input triangles | 433M |
| Nanite triangles | 882M |
| Raw data（full float, byte index, 隐式 tangent） | 25.90 GB |
| Memory format | 7.67 GB |
| Memory 格式压缩后 | 6.77 GB |
| Compressed disk format | 4.61 GB（较 Early Access **改进 ~20%**） |
| 5.6 bytes / Nanite triangle | — |
| 11.4 bytes / input triangle | — |
| 1M triangle ≈ 10.9MB on disk | — |

> 压缩使用 PC 上 Kraken Compression Level 5 作为 LZ 后端。压缩仍有大量改进空间。

### 21.2 当前限制

- 已支持：刚体几何（占场景 >90%），允许对象移动；
- **不支持**：
  - Translucent / masked materials；
  - Non-rigid deformation、骨骼动画等；
- 在 aggregate（草、叶、毛发）等"许多微小物体形成多孔体"场景中表现不佳。

### 21.3 未来方向

- Nanite everything（Nanite 即默认渲染方式）；
- Ray tracing（含 out-of-core RT）；
- Tessellation（位移、高阶曲面、像素级位移贴图）；
- Variable rate shading；
- Many view rendering；
- 大规模实例（fractal instancing、层次实例）；
- Foliage、Animation、Terrain。

---

## 22. 致谢与参考文献

### 22.1 致谢

- **Nanite 共同作者**：Rune Stubbe、Graham Wihlidal
- **Virtual Shadow Maps**：Ola Olsson、Andrew Lauritzen
- UE5 渲染团队
- Epic 美术团队

### 22.2 主要参考文献（按主题分组）

#### Virtual Texturing
1. van Waveren 2012, *Software Virtual Textures*
2. Barrett 2008, *Sparse Virtual Textures*

#### Voxels / SDFs
3-12. Carmack 2007/2008、Olick 2008、Laine & Karras 2010 (*Efficient Sparse Voxel Octrees*)、Crassin 2011 (*GigaVoxels*)、Yoon et al. 2006 (*R-LODs*)、Chajdas 2014、Novak & Dachsbacher 2012、Reichl 2012、Áfra 2013
13-16. Frisken 2000 (*ASDF*)、Bastos & Celes 2008、Evans 2015 (*Dreams PS4*)、Aaltonen 2018 (*Claybook*)

#### Subdivision / Displacement
17. Catmull & Clark 1978
18. Nießner et al. 2012 *Feature Adaptive GPU Rendering of Catmull-Clark*
19. Nießner & Loop 2012 *Patch-based Occlusion Culling for Hardware Tessellation*
20. Brainerd et al. 2016 *Adaptive Quadtrees*
21-29. Geometry Images、HSTA、Adaptive Quad Patches、Displaced Subdivision Surfaces、MAPS、Smooth Parameterization、Adaptive multi-chart、Seamless、Neural Subdivision

#### Points
30-36. QSplat、Far Voxels、Multi-way kd-Trees、Schütz 2020/2021、Marroquim 2007、Zhang & Pajarola 2007

#### GPU Driven Culling
37. Kumar et al. 1996 *Hierarchical BackFace Culling*
38. Shopf et al. 2008 *March of the Froblins*
39. Hill & Collin 2011 *Practical, Dynamic Visibility for Games*
40. Haar & Aaltonen 2015 *GPU-Driven Rendering Pipelines*
41. Wihlidal 2016 *Optimizing the Graphics Pipeline with Compute*
42. Chajdas 2016 *AMD GeometryFX*

#### GPU Work Queue
43. Kerbl et al. 2018 *The Broker Queue*

#### Decoupled Materials / Visibility Buffer
44. Burns et al. 2010 *A Lazy Object-Space Shading Architecture*
45. Fatahalian et al. 2010 *Quad-Fragment Merging*
46. Hillesland & Yang 2016 *Texel Shading*
47. Burns & Hunt 2013 *The Visibility Buffer*
48. Stachowiak 2015 *A Deferred Material Rendering System*
49. Aaltonen 2016 *Modern textureless deferred rendering techniques*
50. Doghramachi & Bucci 2017 *Deferred+: Dawn Engine*

#### View-Dependent Progressive Meshes
51. Ulrich 2002 *Chunked LOD*
52. Yoon et al. 2004 *Quick-VDR*
53. Cignoni et al. 2004 *Adaptive TetraPuzzles*
54. Cignoni et al. 2005 *Batched Multi-Triangulation*
55. Ponchio 2008 PhD 论文
56. Sander & Mitchell 2005 *Progressive Buffers*
57. Sugden & Iwanicki 2011 *Mega Meshes*
58. Hu et al. 2010 *Parallel View-Dependent LoD Control*
59. Derzapf et al. 2010 *Out-of-Core Progressive Meshes*
60. Derzapf & Guthe 2012 *Dependency Free Parallel Progressive Meshes*

#### Graph Partitioning
61. Karypis & Kumar 1999 *METIS*

#### Simplification
62. Garland & Heckbert 1997 *QEM*
63. Garland & Heckbert 1998 *Color & Texture QEM*
64. Hoppe 1999 *New quadric metric*
65. Hoppe & Marschner 2000 *Efficient minimization of QEM*

#### Prefiltering
66. Heitz & Neyret 2012 *SVO Prefiltering*
67. Loubet & Neyret 2017 *Hybrid mesh-volume LoDs*

#### Temporal AA
68. Karis 2014 *High-Quality Temporal Supersampling*

#### Rasterization
69. Abrash 2009 *Rasterization on Larrabee*
70. Laine & Karras 2011 *High-Performance Software Rasterization on GPUs*
71. Kenzel et al. 2018 *cuRE*
72. Fatahalian et al. 2009 *Data-Parallel Rasterization of Micropolygons*
73. Brunhaver et al. 2010 *Hardware Implementation of Micropolygon Rasterization*
74. Weber 2014 *Micropolygon Rendering on the GPU*
75. Giesen 2013 *Triangle rasterization in practice*

#### Imposters
76. Brucks 2018 *Octahedral Impostors*

#### Analytic Derivatives
77. Piponi 2004 *Auto-Diff, C++ Templates and Photogrammetry*
78. Gritz et al. 2010 *Open Shading Language*

#### Virtual Shadow Maps
79. Fernando et al. 2001 *Adaptive Shadow Maps*
80. Lefohn et al. 2007 *Resolution-matched shadow maps*
81. Olsson et al. 2014 *Efficient Virtual Shadow Maps for Many Lights*
82. Olsson et al. 2015 *More Efficient Virtual Shadow Maps for Many Lights*

#### Compression
83. Meyer 2012 *Real-Time Geometry Decompression on Graphics Hardware*
84. Schüler 2013 *Normal Mapping Without Precomputed Tangents*
85. Mikkelsen 2020 *Surface Gradient–Based Bump Mapping Framework*

---

## 附：阅读路线建议

| 想了解 | 直接看 |
|---|---|
| 整体设计哲学 | §1, §2, §6, §21 |
| Cluster/DAG 与 LOD 选择 | §6–§11 |
| GPU 调度与遮挡剔除 | §3, §4, §11, §12 |
| 软光栅 + 64-bit atomic | §13, §14 |
| 材质 / VisBuffer 流程 | §5, §16 |
| 阴影体系 | §18 |
| 流送与压缩工程细节 | §19, §20 |
| 性能数字 | §17, §21 |
