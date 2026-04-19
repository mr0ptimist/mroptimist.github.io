+++
date = '2026-04-20T10:03:00+08:00'
draft = false
title = 'NvPerf GPU 性能计数器参考手册'
tags = ['GPU', 'NVIDIA', 'Nsight', '性能分析']
categories = ['性能优化']
+++

# NvPerf GPU 性能计数器参考手册

本文档基于 NVIDIA 官方文档，对 NvProfAnalyzer 中使用的所有 GPU 性能计数器进行中文解释。

## 参考文档来源

- [Nsight Compute Profiling Guide](https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html) — 计数器命名规则、硬件单元、管线定义
- [Nsight Graphics Advanced Learning](https://docs.nvidia.com/nsight-graphics/AdvancedLearning/index.html) —
  图形管线各单元的功能说明
- [Nsight Graphics System Architecture](https://docs.nvidia.com/nsight-graphics/UserGuide/gpu-trace-system-architecture.html) —
  GPU 系统架构图解
- [NVIDIA Peak Performance Analysis Blog](https://developer.nvidia.com/blog/the-peak-performance-analysis-method-for-optimizing-any-gpu-workload/) —
  性能分析方法论
- [Nsight Compute CLI](https://docs.nvidia.com/nsight-compute/NsightComputeCli/index.html) — CLI 工具与指标映射表

---

## 一、计数器命名规则

NVIDIA 性能计数器遵循统一的命名格式：

```
单元__(子单元?)_(管线阶段?)_度量_(限定符?)
```

示例解读：

- **`sm__inst_executed`**
    - 单元: SM | 度量: inst_executed (指令执行) | 限定符: 无
    - → SM 执行的 warp 指令总数

- **`sm__inst_executed_pipe_fma`**
    - 单元: SM | 度量: inst_executed | 限定符: pipe_fma
    - → FMA 管线执行的 warp 指令数

- **`smsp__thread_inst_executed_pipe_tex_pred_on`**
    - 单元: SMSP | 度量: thread_inst_executed | 限定符: pipe_tex, pred_on
    - → TEX 管线中谓词开启的线程级指令数

- **`l1tex__t_bytes_pipe_tex_mem_texture_op_tex`**
    - 单元: L1TEX | 度量: t_bytes | 限定符: pipe_tex, mem_texture, op_tex
    - → 纹理采样操作通过 L1 的字节数

### 聚合后缀

每个计数器有多个子指标（在 CSV 列名中体现）：

| 后缀                              | 含义                 |
|---------------------------------|--------------------|
| `.sum`                          | 所有实例的总和（如所有 SM 之和） |
| `.avg`                          | 所有实例的平均值           |
| `.min`                          | 最小值                |
| `.max`                          | 最大值                |
| `.ratio`                        | 比率值（ratio 类型指标）    |
| `.pct`                          | 百分比值（ratio 类型指标）   |
| `.per_second`                   | 每秒速率               |
| `.per_cycle_active`             | 每活跃周期的值            |
| `.per_cycle_elapsed`            | 每经过周期的值            |
| `.pct_of_peak_sustained_active` | 占活跃时峰值持续速率的百分比     |

---

## 二、GPU 硬件单元

### 计算单元

| 单元       | 全称                         | 说明                                                             |
|----------|----------------------------|----------------------------------------------------------------|
| **SM**   | Streaming Multiprocessor   | 流式多处理器，GPU 核心计算单元。执行着色器代码，以 32 线程为一组（Warp）调度执行。每个 SM 包含 4 个子分区 |
| **SMSP** | SM Sub-Partition           | SM 子分区。每个 SM 被分为 4 个处理块，每个块拥有独立的 warp 调度器、寄存器堆和执行单元            |
| **TPC**  | Thread Processing Cluster  | 线程处理集群。包含一个或多个 SM，以及指令缓存 (ICC) 和索引常量缓存 (IDC)                   |
| **GPC**  | General Processing Cluster | 通用处理集群。包含 SM、纹理单元和 L1 缓存（以 TPC 形式），在芯片上复制多份                    |

### 内存层次

| 单元        | 全称                         | 说明                                                                                      |
|-----------|----------------------------|-----------------------------------------------------------------------------------------|
| **L1TEX** | Level 1 Data/Texture Cache | L1 数据/纹理缓存。位于 GPC 内，为 SM 提供低延迟缓存。包含两条并行管线：LSU（加载/存储）和 TEX（纹理查找/过滤）。处理全局、本地、共享、纹理和表面内存操作 |
| **LTS**   | L2 Cache Slice             | L2 缓存切片。位于 L1 和 DRAM 之间，服务 GPU 所有单元，是全局一致性的中心点。工作在物理地址空间                                |
| **DRAM**  | Device Memory              | 设备显存。GPU 全局和本地内存的物理存储位置                                                                 |
| **GCC**   | GPC Constant Cache         | GPC 常量缓存。位于 GPC 内的 L1.5 级缓存，负责缓存常量数据和指令                                                 |

#### 显存访问层级与计数器关系

Shader 的纹理/内存请求不会直接到 DRAM，而是经过两级缓存逐层过滤：

```
Shader 请求 → L1/TEX Cache → L2 Cache (LTS) → DRAM
```

- **L1 命中** → 直接返回数据，不产生下游流量
- **L1 未命中** → 请求发往 L2
- **L2 命中** → 数据返回 L1
- **L2 未命中** → 请求发往 DRAM

对应计数器的数据流：

```
l1tex__t_bytes.sum              L1 总吞吐（全部请求）
  ├ l1tex__t_bytes_lookup_hit   L1 命中 → 到此为止
  └ l1tex__t_bytes_lookup_miss  L1 未命中 → 变成 L2 请求
        ↓
lts__t_bytes.sum                L2 总吞吐（含 L1 miss + PE/RASTER 等来源）
  └ lts__t_sectors_lookup_miss  L2 未命中 → 变成 DRAM 请求
        ↓
dram__bytes.sum                 实际 DRAM 流量
```

因此 DRAM 吞吐远小于 L1 吞吐，是经过两级缓存过滤后的结果。例如 L1 命中率 93% 意味着只有 7% 的请求需要访问 L2，再经 L2 过滤后到
DRAM 的更少。

#### L2 请求来源单元 (lts__t_sectors_srcunit_*)

L2 缓存接收来自多个硬件单元的请求，通过 `lts__t_sectors_srcunit_*.sum` 计数器可以区分来源：

- **TEX** — 纹理单元。SM 中 shader 的纹理采样（`tex2D` 等）和内存加载操作，L1 未命中后发往 L2。通常是 L2 请求的主要来源
- **PE** — Pixel Engine（像素引擎）。即 ROP 管线（PROP + ZROP + CROP），负责深度/模板测试和颜色混合，读写 Render Target 和
  Depth Buffer 时产生 L2 请求
- **RASTER** — 光栅化器。ZCull 阶段读取层级深度缓冲 (Hi-Z) 做粗粒度深度剔除时产生的 L2 请求
- **GCC** — GPC Constant Cache。常量缓存和指令缓存的 L1.5 未命中后发往 L2，用于获取 shader 常量和指令数据

典型分布（以纹理密集型 drawcall 为例）：

```
TEX      67.6%   ← shader 纹理/内存访问（主体）
PE       29.4%   ← ROP 读写 RT/Depth Buffer
RASTER    2.6%   ← ZCull 读 Hi-Z
GCC       0.4%   ← 常量/指令缓存 miss
```

TEX 占比高说明 L2 压力主要来自纹理采样；PE 占比高说明 ROP 深度/颜色缓冲区读写量大（如高分辨率 MSAA 或大量 Late-Z）。

### 图形管线单元

| 单元         | 全称                     | 说明                                                                      |
|------------|------------------------|-------------------------------------------------------------------------|
| **FE**     | Frontend               | 前端。负责管理驱动发送的工作负载的整体流程，并处理同步操作                                           |
| **VPC**    | Viewport Clip          | 视口裁剪。执行图元的裁剪 (clip) 和剔除 (cull) 操作                                       |
| **RASTER** | Rasterizer             | 光栅化器。接收来自 world pipe 的图元，输出像素（片段）和采样点（覆盖掩码）供 PROP、Pixel Shader 和 ROP 处理 |
| **PROP**   | Pre-ROP                | 预光栅操作。编排深度和颜色像素/采样点的流动，负责 API 顺序的像素着色、深度测试和颜色混合。处理 Early-Z 和 Late-Z 模式  |
| **ZROP**   | Z Raster Operation     | Z 光栅操作。执行深度测试、模板测试和深度/模板缓冲区更新                                           |
| **CROP**   | Color Raster Operation | 颜色光栅操作。执行最终颜色混合和渲染目标更新                                                  |
| **PCIE**   | PCI Express            | PCIe 总线。CPU-GPU 数据传输通道                                                  |

---

## 三、SM 执行管线

SM 内部包含多条专用执行管线，不同类型的指令被路由到对应的管线执行：

| 管线            | 全称                       | 处理的指令类型                                                                |
|---------------|--------------------------|------------------------------------------------------------------------|
| **ALU**       | Arithmetic Logic Unit    | 大多数**整数**指令：位操作（AND/OR/XOR/SHIFT）、整数加减、比较、最值。也处理低频 FP32 操作（比较、min/max） |
| **FMA**       | Fused Multiply-Add       | **FP32 浮点**运算：FADD、FMUL、FMAD。也处理整数乘法和点积运算                              |
| **FMA Heavy** | FMA 重载子管线                | 复杂的 FP32/FP16 运算                                                       |
| **FMA Lite**  | FMA 轻载子管线                | 简单的浮点运算                                                                |
| **TEX**       | Texture Unit             | 将**纹理和表面**指令转发给 L1TEX 单元的 TEXIN 阶段进行处理                                 |
| **LSU**       | Load Store Unit          | 发出**加载、存储、原子和规约**指令到 L1TEX 单元，处理全局、本地和共享内存访问                           |
| **XU**        | Transcendental Unit      | **超越函数**：sin、cos、倒数平方根 (rsqrt)、指数、对数等。也处理**类型转换**指令                    |
| **ADU**       | Address Divergence Unit  | **地址发散处理**：分支/跳转的地址发散。也支持常量加载和栅栏操作                                     |
| **CBU**       | Convergence Barrier Unit | **Warp 级收敛**、栅栏和分支指令                                                   |
| **IPA**       | Interpolation            | **属性插值**管线，用于图形管线中片段属性的插值                                              |
| **Tensor**    | Tensor Core              | **张量/矩阵**乘法运算（深度学习常用）                                                  |
| **Uniform**   | Uniform Data Path        | **标量**指令执行，所有线程使用相同输入并生成相同输出                                           |

### XU 超越函数详细说明

XU 管线对应 SASS 指令 `MUFU`（Multi-Function Unit），是 SM 中吞吐量最低的管线之一。
当 `XU/PS线程` 值偏高时，需要重点排查以下函数的使用频率。

**硬件直接支持的核心函数（1 次 MUFU 调用）：**

| SASS 操作     | HLSL / GLSL                  | 说明      |
|-------------|------------------------------|---------|
| `MUFU.RCP`  | `rcp(x)`, `1.0/x`            | 倒数      |
| `MUFU.RSQ`  | `rsqrt(x)`, `inversesqrt(x)` | 倒数平方根   |
| `MUFU.SQRT` | `sqrt(x)`                    | 平方根     |
| `MUFU.SIN`  | `sin(x)`                     | 正弦      |
| `MUFU.COS`  | `cos(x)`                     | 余弦      |
| `MUFU.EX2`  | `exp2(x)`                    | 2^x     |
| `MUFU.LG2`  | `log2(x)`                    | log2(x) |

**编译器分解为多次 MUFU 调用的复合函数：**

| HLSL / GLSL          | 分解方式                                  | XU 次数 |
|----------------------|---------------------------------------|-------|
| `pow(x, y)`          | `exp2(y * log2(x))` = LG2 + FMA + EX2 | 2     |
| `exp(x)`             | `exp2(x * 1.4427)` = FMA + EX2        | 1     |
| `log(x)`             | `log2(x) * 0.6931` = LG2 + FMA        | 1     |
| `tan(x)`             | `sin(x) / cos(x)` = SIN + COS + RCP   | 3     |
| `atan(x)`            | 多项式近似 + MUFU 组合                       | 多次    |
| `asin(x)`, `acos(x)` | 多项式近似 + MUFU 组合                       | 多次    |
| `normalize(v)`       | `v * rsqrt(dot(v,v))` = FMA + RSQ     | 1     |
| `length(v)`          | `sqrt(dot(v,v))` = FMA + SQRT         | 1     |
| `distance(a,b)`      | `length(a-b)` = FMA + SQRT            | 1     |
| `smoothstep()`       | 包含除法 → RCP                            | 1     |
| `lit()`              | 包含 `pow` → LG2 + EX2                  | 2     |

> **注意**：`pow` 最容易被忽略——一次 `pow()` 调用会产生 2 次 XU 操作（LG2 + EX2）。

**同样走 XU 管线的类型转换指令：**

| SASS 指令 | 说明                     |
|---------|------------------------|
| `I2F`   | 整数 → 浮点                |
| `F2I`   | 浮点 → 整数                |
| `F2F`   | 浮点精度转换 (FP32 <-> FP16) |
| `I2I`   | 整数位宽转换                 |

---

## 四、计数器详解（按分析模块分组）

### 4.1 GPU 时间与耗时

| 计数器                                     | 含义                                    |
|-----------------------------------------|---------------------------------------|
| `gpu__time_duration`                    | GPU 执行 drawcall 期间的总周期数（从开始到结束的时钟周期）  |
| `gpu__time_active`                      | GPU 实际活跃的时钟周期数（排除空闲等待时间）              |
| `gpu__time_duration_measured_wallclock` | 挂钟时间（Wall Clock），单位**纳秒**。是最接近真实耗时的度量 |
| `gpu__time_duration_measured_user`      | 用户态度量的时间，单位纳秒                         |
| `gpu__time_start`                       | drawcall 开始时的时间戳                      |
| `gpu__time_end`                         | drawcall 结束时的时间戳                      |

### 4.2 前端 (FE)

| 计数器                          | 含义                                 |
|------------------------------|------------------------------------|
| `fe__draw_count`             | Draw Call 数量。该 event 中驱动提交的绘制调用次数  |
| `fe__output_ops`             | 前端输出操作总数                           |
| `fe__pixel_shader_barriers`  | 像素着色器栅栏数量。PS 阶段的同步点个数              |
| `fe__output_ops_cmd_go_idle` | 前端发出 "go idle" 命令的次数。GPU 进入空闲状态的次数 |

### 4.3 着色器线程启动

| 计数器                               | 含义                                                                            |
|-----------------------------------|-------------------------------------------------------------------------------|
| `sm__threads_launched_shader_vs`  | 顶点着色器 (VS) 启动的**线程**总数                                                        |
| `sm__threads_launched_shader_ps`  | 像素着色器 (PS) 启动的**线程**总数                                                        |
| `sm__threads_launched_shader_cs`  | 计算着色器 (CS) 启动的**线程**总数                                                        |
| `tpc__threads_launched_shader_vs` | 同上（TPC 级别计数，备用数据源）                                                            |
| `tpc__threads_launched_shader_ps` | 同上（TPC 级别计数）                                                                  |
| `tpc__threads_launched_shader_cs` | 同上（TPC 级别计数）                                                                  |
| `sm__ps_quads_launched`           | PS 启动的 **Quad**（2x2 像素块）数量。每个 Quad 包含 4 个线程，即使部分像素被三角形边缘覆盖也会全部执行（helper lane） |

### 4.4 SM 指令执行

#### Warp 级指令（每条 warp 指令 = 最多 32 个线程同时执行的同一条指令）

| 计数器                               | 含义                                                                   |
|-----------------------------------|----------------------------------------------------------------------|
| `sm__inst_executed`               | SM 执行的 **warp 指令**总数。1 条 warp 指令 = 1 个 warp（≤32 线程）执行同一条指令。这是所有管线的总计 |
| `sm__inst_executed_pipe_alu`      | 通过 **ALU** 管线执行的 warp 指令数（整数/位运算）                                    |
| `sm__inst_executed_pipe_fma`      | 通过 **FMA** 管线执行的 warp 指令数（FP32 浮点运算）                                 |
| `sm__inst_executed_pipe_fmaheavy` | 通过 FMA Heavy 子管线执行的 warp 指令数                                         |
| `sm__inst_executed_pipe_fmalite`  | 通过 FMA Lite 子管线执行的 warp 指令数                                          |
| `sm__inst_executed_pipe_tex`      | 通过 **TEX** 管线执行的 warp 指令数（纹理采样）                                      |
| `sm__inst_executed_pipe_lsu`      | 通过 **LSU** 管线执行的 warp 指令数（内存加载/存储）                                   |
| `sm__inst_executed_pipe_xu`       | 通过 **XU** 管线执行的 warp 指令数（超越函数）                                       |
| `sm__inst_executed_pipe_adu`      | 通过 ADU 管线执行的 warp 指令数（地址发散处理）                                        |
| `sm__inst_executed_pipe_cbu`      | 通过 CBU 管线执行的 warp 指令数（分支/收敛控制）                                       |
| `sm__inst_executed_pipe_ipa`      | 通过 IPA 管线执行的 warp 指令数（属性插值）                                          |
| `sm__inst_executed_pipe_tensor`   | 通过 Tensor Core 管线执行的 warp 指令数                                        |
| `sm__inst_executed_pipe_uniform`  | 通过 Uniform 管线执行的 warp 指令数（标量常量路径）                                    |
| `sm__inst_executed_pipe_aluheavy` | 通过 ALU Heavy 子管线执行的 warp 指令数（复杂整数运算）                                 |

> **重要**：`sm__inst_executed` 系列是 **warp 级别**计数。当 `.sum` 后缀时，是所有 SM 的总和。1 条 warp 指令实际包含最多 32
> 个线程的执行。

#### 线程级指令

| 计数器                                           | 含义                                                                                 |
|-----------------------------------------------|------------------------------------------------------------------------------------|
| `smsp__thread_inst_executed`                  | 所有线程执行的指令总数（线程级别）。关系：`smsp__thread_inst_executed.sum ≤ sm__inst_executed.sum × 32` |
| `smsp__thread_inst_executed_pred_on`          | 谓词为真时线程执行的指令数。用于衡量分支收敛率：`pred_on / total` 越高说明分支发散越少                               |
| `smsp__thread_inst_executed_pipe_tex_pred_on` | TEX 管线中谓词开启的**线程级**指令数。用于精确计算每像素纹理采样次数                                             |
| `smsp__thread_inst_executed_pipe_lsu_pred_on` | LSU 管线中谓词开启的**线程级**指令数。用于精确计算每像素内存访问次数                                             |
| `smsp__thread_inst_executed_pipe_xu_pred_on`  | XU 管线中谓词开启的**线程级**指令数。用于精确计算每像素超越函数调用次数                                            |

> **warp 级 vs 线程级**：`sm__inst_executed` 是 warp 级别（1 次计数 = 1 个 warp 发射 1 条指令），
`smsp__thread_inst_executed` 是线程级别（1 次计数 = 1 个线程执行 1 条指令）。
`smsp__thread_inst_executed / sm__inst_executed` 可算出每 warp 平均活跃线程数。

#### 各着色器阶段指令

| 计数器                              | 含义                              |
|----------------------------------|---------------------------------|
| `smsp__inst_executed_shader_vs`  | VS（顶点着色器）阶段执行的 warp 指令数         |
| `smsp__inst_executed_shader_ps`  | PS（像素着色器）阶段执行的 warp 指令数         |
| `smsp__inst_executed_shader_cs`  | CS（计算着色器）阶段执行的 warp 指令数         |
| `smsp__inst_executed_shader_gs`  | GS（几何着色器）阶段执行的 warp 指令数         |
| `smsp__inst_executed_shader_tcs` | TCS/HS（曲面细分控制着色器）阶段执行的 warp 指令数 |
| `smsp__inst_executed_shader_tes` | TES/DS（曲面细分求值着色器）阶段执行的 warp 指令数 |

### 4.5 PS 线程淘汰（Kill Mask）

**Kill Mask 概念**：GPU 在像素着色器执行前后对像素进行淘汰。`killmask_off` 表示正常执行的线程（非预淘汰），`killmask_on` 表示已被
ZCull 等机制预先标记为淘汰的线程。

| 计数器                                                                               | 含义                                 |
|-----------------------------------------------------------------------------------|------------------------------------|
| `tpc__threads_launched_shader_ps_killmask_off`                                    | 正常执行的 PS 线程数（未被预先标记淘汰）             |
| `tpc__threads_launched_shader_ps_killmask_off_output_passed`                      | 正常执行且最终**有效输出**的 PS 线程数            |
| `tpc__threads_launched_shader_ps_killmask_off_output_killed`                      | 正常执行但最终**被淘汰**的 PS 线程数             |
| `tpc__threads_launched_shader_ps_killmask_off_output_killed_reason_discard`       | 因 `discard()`/`clip()` 被淘汰的线程数     |
| `tpc__threads_launched_shader_ps_killmask_off_output_killed_reason_coverage_mask` | 因覆盖遮罩被淘汰的线程数（helper lane 或多重采样未覆盖） |
| `tpc__threads_launched_shader_ps_killmask_on`                                     | 被 ZCull 等机制**预先标记淘汰**的 PS 线程数      |

### 4.6 深度测试（Early-Z / Late-Z）

GPU 深度测试流水线的三个层级：

| 阶段          | 粒度             | 时机          | 说明                                                                                      |
|-------------|----------------|-------------|-----------------------------------------------------------------------------------------|
| **ZCull**   | 块级 (8×8 tiles) | 像素着色器**之前** | 粗粒度深度剔除。使用每个 tile 的 min/max 深度元数据快速拒绝整块不可见像素。按前到后排序可提高剔除效率                              |
| **Early-Z** | 逐像素            | 像素着色器**之前** | 精细深度测试。在 PS 执行前逐像素判断是否可见，避免对不可见像素执行着色器。当 PS 写入深度或使用 `discard()` 时会被禁用                   |
| **Late-Z**  | 逐像素            | 像素着色器**之后** | 延迟深度测试。当无法使用 Early-Z 时的回退路径（PS 修改了深度输出 `SV_Depth`、使用了 `discard`/`clip`、或使用了 alpha test） |

| 计数器                                            | 含义                             |
|------------------------------------------------|--------------------------------|
| `prop__prop2zrop_pixels`                       | 发送给 ZROP 的总像素数                 |
| `prop__prop2zrop_pixels_mode_earlyz`           | 以 **Early-Z** 模式处理的像素数         |
| `prop__prop2zrop_pixels_mode_earlyz_op_passed` | Early-Z 测试**通过**的像素数           |
| `prop__prop2zrop_pixels_mode_earlyz_op_killed` | Early-Z 测试**淘汰**的像素数           |
| `prop__prop2zrop_pixels_mode_latez`            | 以 **Late-Z** 模式处理的像素数          |
| `prop__prop2zrop_pixels_mode_latez_op_passed`  | Late-Z 测试**通过**的像素数            |
| `prop__prop2zrop_pixels_mode_latez_op_killed`  | Late-Z 测试**淘汰**的像素数            |
| `prop__prop2zrop_samples_mode_earlyz`          | Early-Z 模式的采样点数（多重采样时每像素多个采样点） |
| `prop__prop2zrop_samples_mode_latez`           | Late-Z 模式的采样点数                 |

> **优化提示**：Early-Z 比例越高越好。Late-Z 比例高说明 PS 使用了 `discard()`、写入了深度值或使用了 alpha test，导致 GPU
> 无法提前剔除不可见像素。

### 4.7 ZCull（粗粒度深度剔除）

| 计数器                                                               | 含义                                    |
|-------------------------------------------------------------------|---------------------------------------|
| `raster__zcull_input_samples`                                     | ZCull 接收的**输入采样点**总数                  |
| `raster__zcull_input_samples_op_accepted`                         | ZCull **接受**（通过）的采样点数                 |
| `raster__zcull_input_samples_op_accepted_reason_trivial_accept`   | **无条件接受**的采样点数（整个 tile 在最近深度之前，确定可见）  |
| `raster__zcull_input_samples_op_accepted_reason_ambiguous`        | **模糊接受**的采样点数（无法确定可见性，需要逐像素深度测试进一步判定） |
| `raster__zcull_input_samples_op_rejected`                         | ZCull **拒绝**（剔除）的采样点数                 |
| `raster__zcull_input_samples_op_rejected_reason_depth_test`       | 因**深度测试**被剔除的采样点数（tile 在最远深度之后）       |
| `raster__zcull_input_samples_op_rejected_reason_stencil`          | 因**模板测试**被剔除的采样点数                     |
| `raster__zcull_input_samples_op_rejected_reason_depth_bounds`     | 因**深度边界**测试被剔除的采样点数                   |
| `raster__zcull_input_samples_op_rejected_reason_near_far_clipped` | 因**近远裁剪面**被裁剪的采样点数                    |
| `raster__zcull_output_samples`                                    | ZCull 输出的采样点总数（通过 ZCull 进入后续阶段的采样点）   |

### 4.8 VPC 几何处理（视口裁剪/剔除）

| 计数器                                  | 含义                              |
|--------------------------------------|---------------------------------|
| `vpc__input_prims`                   | VPC 接收的**输入图元**总数               |
| `vpc__clip_input_prims`              | 进入裁剪阶段的图元数                      |
| `vpc__clip_input_prims_op_clipped`   | **被裁剪**的图元数（图元跨越视口边界，被切分为多个三角形） |
| `vpc__clip_input_prims_op_unclipped` | **未被裁剪**的图元数（完全在视口内）            |
| `vpc__clip_output_prims`             | 裁剪后输出的图元数（被裁剪的图元会生成多个新图元）       |
| `vpc__cull_input_prims`              | 进入剔除阶段的图元数                      |
| `vpc__cull_input_prims_op_culled`    | **被剔除**的图元数（背面剔除、退化三角形等）        |
| `vpc__cull_input_prims_op_passed`    | 剔除后**通过**的图元数                   |
| `vpc__output_prims`                  | VPC 最终输出的图元数                    |
| `vpc__output_attrs`                  | VPC 输出的顶点属性数量                   |

### 4.9 DRAM 显存带宽

| 计数器                      | 含义                                     |
|--------------------------|----------------------------------------|
| `dram__bytes`            | 显存 (VRAM) 总吞吐量（读+写字节数）                 |
| `dram__bytes_op_read`    | 显存**读取**的字节数                           |
| `dram__bytes_op_write`   | 显存**写入**的字节数                           |
| `dram__sectors_op_read`  | 显存读取的扇区 (sector) 数。1 sector = 32 bytes |
| `dram__sectors_op_write` | 显存写入的扇区数                               |
| `pcie__read_bytes`       | 通过 **PCIe** 总线从系统内存读取的字节数              |

### 4.10 L1/TEX 缓存

| 计数器                                                      | 含义                                           |
|----------------------------------------------------------|----------------------------------------------|
| `l1tex__t_bytes`                                         | L1TEX 缓存的**总**吞吐量（字节）                        |
| `l1tex__t_bytes_lookup_hit`                              | L1 缓存**命中**的字节数                              |
| `l1tex__t_bytes_lookup_miss`                             | L1 缓存**未命中**的字节数（需要向 L2 请求）                  |
| `l1tex__t_bytes_pipe_tex`                                | **TEX 管线**（纹理）通过 L1 的总字节数                    |
| `l1tex__t_bytes_pipe_tex_mem_texture`                    | 纹理内存通过 L1 的字节数                               |
| `l1tex__t_bytes_pipe_tex_mem_texture_op_tex`             | 纹理**采样操作**通过 L1 的字节数                         |
| `l1tex__t_bytes_pipe_tex_mem_texture_op_tex_lookup_hit`  | 纹理采样操作在 L1 **命中**的字节数                        |
| `l1tex__t_bytes_pipe_tex_mem_surface`                    | 表面内存 (RT/UAV/Buffer) 通过 L1 的字节数              |
| `l1tex__t_bytes_pipe_tex_mem_surface_lookup_hit`         | 表面内存在 L1 **命中**的字节数                          |
| `l1tex__t_bytes_pipe_tex_mem_surface_op_ld`              | 表面**读取**操作通过 L1 的字节数                         |
| `l1tex__t_bytes_pipe_tex_mem_surface_op_ld_lookup_hit`   | 表面读取在 L1 **命中**的字节数                          |
| `l1tex__t_bytes_pipe_lsu`                                | **LSU 管线**（加载/存储）通过 L1 的字节数                  |
| `l1tex__t_sectors_lookup_hit`                            | L1 缓存命中的**扇区**数                              |
| `l1tex__t_sectors_lookup_miss`                           | L1 缓存未命中的**扇区**数                             |
| `l1tex__data_bank_conflicts_pipe_lsu_mem_shared`         | 共享内存的 **Bank 冲突**总数。多个线程同时访问同一 bank 的不同地址时发生 |
| `l1tex__data_bank_conflicts_pipe_lsu_mem_shared_op_atom` | 共享内存 **Atomic 操作**引起的 bank 冲突数               |
| `l1tex__data_bank_conflicts_pipe_lsu_mem_shared_op_ld`   | 共享内存 **Load 操作**引起的 bank 冲突数                 |

### 4.11 L2 缓存 (LTS)

| 计数器                                                   | 含义                                    |
|-------------------------------------------------------|---------------------------------------|
| `lts__t_bytes`                                        | L2 缓存总吞吐量（字节）                         |
| `lts__t_sectors`                                      | L2 缓存处理的扇区总数                          |
| `lts__t_requests`                                     | L2 缓存接收的请求总数                          |
| `lts__t_sectors_lookup_miss_realtime`                 | L2 **未命中**的扇区数（需要向 DRAM 请求）           |
| `lts__t_sectors_op_read_lookup_miss_realtime`         | L2 **读取未命中**的扇区数                      |
| `lts__t_sectors_op_write_lookup_miss_realtime`        | L2 **写入未命中**的扇区数（写回 DRAM）             |
| `lts__average_t_sector_hit_rate_realtime`             | L2 缓存**总体命中率**（ratio 类型，0~1）          |
| `lts__average_t_sector_hit_rate_srcunit_tex_realtime` | L2 缓存中来自 **TEX 单元**请求的命中率             |
| `lts__average_t_sector_srcnode_gpc_hit_rate`          | L2 缓存中来自 **GPC** 请求的命中率               |
| `lts__average_t_sector_srcnode_hub_hit_rate`          | L2 缓存中来自 **Hub**（系统互连）请求的命中率          |
| `lts__t_sectors_srcunit_tex`                          | 来自 **TEX** 单元的 L2 请求扇区数               |
| `lts__t_sectors_srcunit_gpc`                          | 来自 **GPC** 的 L2 请求扇区数                 |
| `lts__t_sectors_srcunit_pe`                           | 来自 **PE**（Primitive Engine）的 L2 请求扇区数 |
| `lts__t_sectors_srcunit_raster`                       | 来自 **RASTER** 单元的 L2 请求扇区数            |
| `lts__t_sectors_srcunit_ce`                           | 来自 **CE**（Copy Engine）的 L2 请求扇区数      |
| `lts__t_sectors_srcunit_gcc`                          | 来自 **GCC**（常量缓存）的 L2 请求扇区数            |

### 4.12 GCC（全局常量/指令缓存）

| 计数器                                                    | 含义                           |
|--------------------------------------------------------|------------------------------|
| `gcc__cache_requests_type_constant`                    | **常量数据**缓存请求总数               |
| `gcc__cache_requests_type_constant_lookup_hit`         | 常量数据缓存**命中**次数               |
| `gcc__cache_requests_type_constant_lookup_miss`        | 常量数据缓存**未命中**次数              |
| `gcc__cache_requests_type_instruction`                 | **指令**缓存请求总数                 |
| `gcc__cache_requests_type_instruction_lookup_hit`      | 指令缓存**命中**次数                 |
| `gcc__cache_requests_type_instruction_lookup_miss`     | 指令缓存**未命中**次数                |
| `gcc__cache_requests_type_tsheader`                    | **TS Header**（细分头信息）缓存请求总数   |
| `gcc__cache_requests_type_tsheader_lookup_hit`         | TS Header 缓存**命中**次数         |
| `gcc__cache_requests_type_tsheader_lookup_miss`        | TS Header 缓存**未命中**次数        |
| `gcc__average_cache_request_type_instruction_hit_rate` | 指令缓存的**平均命中率**（ratio 类型，0~1） |

### 4.13 SM Occupancy 与调度

| 计数器                                                    | 含义                                                                   |
|--------------------------------------------------------|----------------------------------------------------------------------|
| `smsp__average_warps_active_per_inst_executed`         | 每条指令执行时平均**活跃 warp 数**。反映 SM 的占用率 (Occupancy)。`.pct` 子指标给出占理论最大值的百分比 |
| `smsp__average_warps_active_per_issue_active`          | 每个 issue slot 活跃时平均活跃 warp 数                                         |
| `smsp__average_inst_executed_per_warp`                 | 每个 warp 平均执行的指令数                                                     |
| `sm__average_threads_launched_per_warp`                | 每个 warp 平均启动的**线程数**（最大 32）。低值说明三角形太小产生了大量非满载 warp                   |
| `sm__average_threads_launched_per_warp_shader_vs`      | VS 阶段每 warp 平均线程数                                                    |
| `sm__average_threads_launched_per_warp_shader_cs`      | CS 阶段每 warp 平均线程数                                                    |
| `smsp__thread_inst_executed_pred_on_per_inst_executed` | 每条 warp 指令中平均**谓词开启**的线程数。`.pct` 表示占 32 的百分比，反映分支发散程度                |
| `tpc__average_registers_per_thread`                    | 每线程使用的**寄存器数**（所有着色器阶段的加权平均值）。寄存器数越多，可同时驻留的 warp 越少，Occupancy 越低     |
| `tpc__average_registers_per_thread_shader_ps`          | **PS 阶段**每线程使用的寄存器数。比全局值更准确反映 PS 的资源占用                               |
| `tpc__average_sharedmem_bytes_per_cta`                 | 每个 CTA（线程块）使用的**共享内存**字节数                                            |
| `tpc__average_tram_bytes_per_warp`                     | 每个 warp 使用的 **TRAM**（临时寄存器存储）字节数                                     |
| `tpc__average_isbe_bytes_per_warp`                     | 每个 warp 使用的 **ISBE**（指令状态缓冲区）字节数                                     |

### 4.14 SMSP Warp Stall（Warp 停顿原因）

Warp 停顿发生在 warp 因等待某种资源或依赖而无法发射指令时。理解停顿原因是性能优化的关键。

每个停顿指标的格式为 `smsp__average_warps_issue_stalled_<原因>_per_issue_active`，表示每个活跃的 issue slot 中平均有多少
warp 因该原因停顿。

| 停顿原因                           | 含义                                                                                                                      | 优化建议                                         |
|--------------------------------|-------------------------------------------------------------------------------------------------------------------------|----------------------------------------------|
| **long_scoreboard**            | 等待**长延迟**的数据依赖返回——来自全局内存 (LDG/STG)、纹理 (TEX)、表面 (SURFACE) 等离开 SM 的内存操作。停顿出现在**依赖结果的消费者**指令上                              | 优化内存访问模式、提高缓存命中率、使用共享内存缓存频繁访问的数据、增加独立指令以隐藏延迟 |
| **long_scoreboard_pipe_l1tex** | long_scoreboard 的子类，专门等待 **L1TEX** 管线返回数据                                                                               | 同上                                           |
| **short_scoreboard**           | 等待**短延迟**的数据依赖——来自 MIO（杂项 I/O）或 RTCORE 操作，包括：共享内存加载/存储、3D 属性加载/存储、像素属性插值、索引常量加载 (LDC)、超越函数 (rcp/rsqrt/sin/cos 通过 XU 管线) | 减少共享内存 bank 冲突、减少超越函数使用频率、在生产者和消费者之间插入独立指令   |
| **tex_throttle**               | **纹理单元满载**。TEX 管线的输入 FIFO 已满，warp 无法提交新的纹理请求                                                                            | 减少纹理采样次数、使用更小的纹理格式、优化 mipmap 使用              |
| **barrier**                    | 等待**同步栅栏** (`__syncthreads()` 等)。部分线程先到达同步点后只能等待其他线程。仅当使用共享内存需要同步时才需要                                                   | 检查是否可以减少同步点、尝试平衡各 warp 的工作量                  |
| **lg_throttle**                | **Local/Global 内存满载**。LSU 管线的本地/全局内存输入 FIFO 已满                                                                          | 减少全局内存访问频率、使用共享内存或寄存器替代                      |
| **math_pipe_throttle**         | **数学管线满载**。指令发射速度超过了数学执行管线的处理能力                                                                                         | 减少计算密度、将部分计算移至查找表                            |
| **mio_throttle**               | **MIO（杂项 I/O）满载**。可能由本地、全局、共享、属性、IPA、索引常量加载 (LDC) 等操作触发                                                                 | 减少相关操作的频率                                    |
| **mio_throttle_pipe_mio**      | MIO 管线的子类停顿                                                                                                             | 同上                                           |
| **dispatch_stall**             | **指令分发阻塞**。下一条指令尚未就绪（可能是指令缓存未命中或指令队列问题）                                                                                 | 提高指令缓存命中率、减少动态分支                             |
| **not_selected**               | warp 有可发射的指令，但**未被调度器选中**（另一个 warp 被选中了）。不是真正的停顿，表示 warp 就绪但未轮到                                                         | 通常无需优化，表示 Occupancy 良好                       |
| **no_instruction**             | warp **没有可用的指令**。可能在等待指令缓存加载                                                                                            | 检查指令缓存命中率、减少控制流复杂度                           |
| **branch_resolving**           | warp 正在**解析分支**目标地址，等待分支判定结果                                                                                            | 减少动态分支、使用 `[branch]`/`[flatten]` 属性控制分支行为    |
| **drain**                      | warp 已执行完毕，正在**排空**剩余的内存写入和像素导出操作                                                                                       | 通常无需优化，是 warp 正常退出流程                         |
| **sleeping**                   | warp 处于**休眠**状态                                                                                                         | 通常无需关注                                       |
| **wait**                       | 等待**其他事件**完成                                                                                                            | 根据具体上下文判断                                    |
| **misc**                       | 其他未分类的停顿原因                                                                                                              | 根据具体情况分析                                     |
| **selected**                   | warp 成功**发射了一条指令**。这不是停顿，是正常的指令发射                                                                                       | 越高越好                                         |

> **记分板 (Scoreboard) 机制**：每个 warp 有 6 个记分板，编译器用来追踪指令间的数据依赖关系。记分板记录哪些寄存器正在等待某条
> in-flight 指令的写入。"Long" 表示离开 SM 的高延迟操作，"Short" 表示 SM 内部的低延迟操作。停顿出现在**消费者**
> 指令上，但根本原因在对应的
**生产者**指令。

---

## 五、常用计算公式

| 指标          | 公式                                                                | 说明                                                         |
|-------------|-------------------------------------------------------------------|------------------------------------------------------------|
| PS 指令/线程    | `smsp__inst_executed_shader_ps × eff_tpw / ps_threads`            | eff_tpw = `smsp__thread_inst_executed / sm__inst_executed` |
| TEX/PS 线程   | `smsp__thread_inst_executed_pipe_tex_pred_on / ps_threads`        | 每像素纹理采样次数                                                  |
| FMA/ALU 比值  | `sm__inst_executed_pipe_fma / sm__inst_executed_pipe_alu`         | >1 浮点密集，<1 整数密集                                            |
| IPC (全 GPU) | `sm__inst_executed.sum / gpu__time_active.sum`                    | 所有 SM 每 GPU 周期的 warp 指令总数                                  |
| 分支收敛率       | `smsp__thread_inst_executed_pred_on / smsp__thread_inst_executed` | 100% = 完全收敛，低值 = 分支发散严重                                    |
| L1 命中率      | `l1tex__t_sectors_lookup_hit / (hit + miss)`                      | L1 缓存效率                                                    |
| L2 命中率      | `lts__average_t_sector_hit_rate_realtime.ratio × 100`             | L2 缓存效率                                                    |
| Early-Z 比例  | `prop__prop2zrop_pixels_mode_earlyz / prop__prop2zrop_pixels`     | 越高越好                                                       |
| PS 有效输出率    | `tpc__...killmask_off_output_passed / ps_threads`                 | 反映像素着色器的有效利用率                                              |

---

## 六、术语表

| 术语                | 说明                                                      |
|-------------------|---------------------------------------------------------|
| **Warp**          | 32 个线程组成的执行单元。SM 以 warp 为单位调度和执行指令                      |
| **Quad**          | 2×2 像素块。PS 始终以 Quad 为单位执行，即使部分像素不在三角形内（产生 helper lane）  |
| **Helper Lane**   | Quad 中不在三角形覆盖范围内的线程。它们参与计算（用于梯度计算）但不产生输出                |
| **Sector**        | 32 字节对齐的内存块。缓存和内存传输的基本单位                                |
| **Predicate**     | 谓词。CUDA/GPU 指令的条件执行机制。`pred_on` 表示条件为真、指令实际执行的线程        |
| **Occupancy**     | SM 占用率。活跃 warp 数占最大可驻留 warp 数的比例。受寄存器数、共享内存用量影响         |
| **CTA**           | Cooperative Thread Array（协作线程数组），即线程块 (Thread Block)    |
| **Scoreboard**    | 记分板。硬件结构，追踪寄存器的数据依赖关系，防止 RAW 冒险                         |
| **TRAM**          | 临时寄存器文件 (Temporary Register) 存储                         |
| **ISBE**          | 指令状态缓冲条目 (Instruction State Buffer Entry)，追踪 warp 的指令状态 |
| **Bank Conflict** | 共享内存 Bank 冲突。多个线程同时访问同一 bank 的不同地址导致串行化                 |
| **MIO**           | 杂项 I/O (Miscellaneous I/O)，处理共享内存、属性加载等 SM 内部低延迟操作      |

---

## 七、数值评估参考（怎样判断好坏）

以下给出各关键指标的参考阈值。实际最优值因场景而异（前向渲染 vs 延迟渲染、写实 vs 风格化、移动端 vs 桌面端），
此处以**桌面端典型游戏 drawcall** 为基准，帮助快速判断是否存在明显问题。

### 7.1 缓存命中率

| 指标            | 优秀   | 正常     | 偏低     | 严重   | 说明                                          |
|---------------|------|--------|--------|------|---------------------------------------------|
| L1 总体命中率      | >90% | 70~90% | 50~70% | <50% | 低命中率说明纹理/buffer 随机访问严重，大量请求穿透到 L2           |
| L2 总体命中率      | >80% | 60~80% | 40~60% | <40% | 低命中率导致大量 DRAM 访问，带宽瓶颈                       |
| L2 纹理命中率      | >75% | 50~75% | 30~50% | <30% | 纹理 working set 超过 L2 容量，考虑降低纹理分辨率/使用 mipmap |
| 指令缓存命中率 (GCC) | >95% | 85~95% | 75~85% | <75% | 低值说明 shader 过大或动态分支导致指令缓存频繁换入换出             |
| 常量缓存命中率 (GCC) | >98% | 90~98% | 80~90% | <80% | 常量数据通常应有极高命中率，低值异常                          |

### 7.2 Occupancy（SM 占用率）

| 指标                       | 参考值                                                 | 说明                                                                                  |
|--------------------------|-----------------------------------------------------|-------------------------------------------------------------------------------------|
| Warps Active/Inst (.pct) | **>50%** 正常；**>30%** 可接受；**<30%** 偏低                | 并非越高越好——如果 shader 完全 compute bound，中等 occupancy 也能打满 SM。但低 occupancy 会导致无法隐藏内存延迟    |
| 寄存器/线程 (PS)              | **16~32** 轻量；**32~64** 中等；**64~128** 偏重；**>128** 过重 | 寄存器越多 → occupancy 越低。RTX 3090 每 SM 有 65536 寄存器，128 reg/thread 时最多驻留 16 warp (= 50%) |
| 共享内存/CTA                 | **0** 图形渲染通常不用；**>0** CS 正常                         | 共享内存占用过多也会降低 occupancy                                                              |

### 7.3 Warp 活跃线程 / 分支发散

| 指标                   | 优秀          | 正常         | 偏低       | 说明                                          |
|----------------------|-------------|------------|----------|---------------------------------------------|
| 活跃线程/Warp            | **32** (满载) | **28~31**  | **<24**  | <24 说明大量小三角形产生了很多非满载 warp，或 quad 浪费严重       |
| 分支收敛率 (pred_on%)     | **>95%**    | **85~95%** | **<85%** | <85% 表示 shader 中有大量 if/else 分支导致线程发散，部分线程空转 |
| Predicated On (.pct) | **>90%**    | **70~90%** | **<70%** | 同上，另一种表示方式                                  |

### 7.4 Shader 复杂度特征

| 指标          | 典型范围          | 怎么判断                                                       | 说明                                     |
|-------------|---------------|------------------------------------------------------------|----------------------------------------|
| PS 指令/线程    | **10~200** 常见 | >500 很重的 shader；<10 极简 shader                              | 数值本身无好坏，但同屏大量高值 drawcall 则 SM 可能成为瓶颈   |
| TEX/PS 线程   | **1~8** 常见    | >10 纹理采样密集；0 无纹理（纯计算）                                      | 高值配合低 L1/L2 命中率 → 带宽瓶颈                 |
| LSU/PS 线程   | **0~5** 常见    | >5 buffer 访问频繁                                             | 高值配合 long_scoreboard 停顿 → 内存瓶颈         |
| XU/PS 线程    | **0~2** 常见    | >3 超越函数密集                                                  | 高值配合 short_scoreboard 停顿 → XU 管线瓶颈     |
| FMA/ALU 比值  | **0.5~3**     | >3 纯浮点计算；<0.3 纯整数/逻辑                                       | 结合管线分布和 throughput 一起看                 |
| IPC (全 GPU) | 因 SM 数量而异     | RTX 3090 (82 SM): 典型 100~400；RTX 4090 (128 SM): 典型 150~600 | 全 GPU 聚合值 = 所有 SM 总和 / 周期，不是单 SM 的 IPC |

### 7.5 管线指令分布

| 管线  | 典型占比   | 偏高意味着              | 优化方向                                         |
|-----|--------|--------------------|----------------------------------------------|
| FMA | 30~60% | shader 浮点运算密集      | 简化数学表达式、用近似函数替代精确计算、利用半精度 (FP16)             |
| ALU | 15~40% | 整数/位运算较多           | 通常正常，除非占比 >80% 说明 shader 做了大量整数位操作           |
| TEX | 5~30%  | 纹理采样密集             | 减少采样次数、降低纹理分辨率、使用纹理 atlas                    |
| LSU | 5~20%  | buffer 读写频繁        | 合并 buffer 访问、使用 SRV 替代 buffer load、减少 UAV 写入 |
| XU  | 1~10%  | sin/cos/rsqrt 使用频繁 | 用近似函数替代 (如 Taylor 展开)、查找表替代                  |
| CBU | 1~5%   | 正常                 | 过高说明分支过多                                     |
| IPA | 0~5%   | 图形渲染正常             | 减少 varying 输出数量可降低                           |

### 7.6 深度测试效率

| 指标                 | 优秀       | 正常         | 偏差       | 说明                                                    |
|--------------------|----------|------------|----------|-------------------------------------------------------|
| Early-Z 比例         | **>90%** | **60~90%** | **<50%** | <50% 说明大量像素走了 Late-Z 路径，检查 PS 是否使用了 discard/clip/写深度  |
| ZCull 拒绝率          | **>50%** | **20~50%** | **<10%** | 高拒绝率 = 有效剔除了不可见像素。低值说明未按前到后排序或 ZCull 被 alpha test 等破坏 |
| ZCull Ambiguous 占比 | **<20%** | **20~50%** | **>50%** | 高 Ambiguous 说明 ZCull 无法做出明确判断，tile 的 min/max 深度范围过大   |

### 7.7 PS 有效输出率

| 指标                      | 优秀       | 正常         | 偏差       | 说明                                                                      |
|-------------------------|----------|------------|----------|-------------------------------------------------------------------------|
| PS 有效输出率 (passed/total) | **>95%** | **85~95%** | **<85%** | 低值说明大量 PS 线程被浪费（discard、coverage mask、helper lane）                      |
| discard 淘汰率             | **<2%**  | **2~10%**  | **>10%** | 高 discard 率 = alpha test/clip 频繁，浪费了 PS 执行。考虑改用 alpha blend 或 Z-prepass |
| killmask_on 占比          | **<5%**  | **5~20%**  | **>20%** | 被 ZCull 预淘汰的线程占比高说明渲染顺序不佳或存在大量重叠几何                                      |

### 7.8 VPC 几何效率

| 指标                     | 参考值                  | 说明                              |
|------------------------|----------------------|---------------------------------|
| VPC 剔除率 (culled/input) | **30~60%** 正常        | 背面剔除等。0% 说明所有三角形都是正面、或者没有开启背面剔除 |
| 裁剪率 (clipped/input)    | **<5%** 正常           | >10% 说明有大量三角形跨越视口边界，产生额外裁剪开销    |
| 输出图元/输入图元              | 接近 **1 - cull_rate** | 剔除后留下的有效图元比例                    |

### 7.9 显存带宽

| 指标                  | 参考值          | 说明                                                    |
|---------------------|--------------|-------------------------------------------------------|
| 单个 drawcall DRAM 吞吐 | 因分辨率和复杂度而异   | 关注的是相对值——同类 drawcall 中异常高的值需要排查                       |
| 读写比                 | 通常 **读 > 写** | 读取占主导（纹理采样、buffer 读取）。写入高说明 UAV 大量写入或 RT 写入           |
| PCIe 读取             | **0** 理想     | >0 说明有资源需要从系统内存拉取（uncached texture、CPU buffer），严重性能问题 |

### 7.10 Warp Stall（停顿原因）

以下是停顿占比的参考判断：

| 停顿原因                   | 正常范围 | 值得关注   | 严重瓶颈 | 典型场景                                  |
|------------------------|------|--------|------|---------------------------------------|
| **selected**           | 越高越好 | —      | —    | 这是"成功发射"，不是停顿。占比高说明 SM 利用率好           |
| **long_scoreboard**    | <30% | 30~50% | >50% | 内存/纹理延迟主导。shader 等待全局内存或纹理数据返回        |
| **short_scoreboard**   | <15% | 15~30% | >30% | 共享内存 bank 冲突、超越函数延迟。SM 内部依赖           |
| **tex_throttle**       | <10% | 10~25% | >25% | 纹理采样过于密集，TEX 管线饱和                     |
| **lg_throttle**        | <10% | 10~25% | >25% | 全局/本地内存访问过于密集                         |
| **math_pipe_throttle** | <10% | 10~20% | >20% | 计算密集，数学管线饱和                           |
| **barrier**            | <10% | 10~30% | >30% | 同步点过多或线程负载不均                          |
| **not_selected**       | <40% | —      | —    | 有空闲 warp 在等待调度——通常是好事，说明 occupancy 充足 |
| **no_instruction**     | <5%  | 5~15%  | >15% | 指令缓存未命中或 shader 控制流复杂                 |
| **dispatch_stall**     | <5%  | 5~10%  | >10% | 指令分发管线问题                              |
| **drain**              | <5%  | —      | —    | 正常的 warp 退出，通常不需要关注                   |

> **怎么读停顿数据**：先看 `selected` 占比——它代表 SM 在多少比例的周期中成功发射了指令。剩下的部分被各种停顿原因瓜分。找出占比最大的
> 1~2 个停顿原因，就是当前 drawcall 的主要瓶颈。

### 7.11 综合判断流程

```
1. 先看 GPU 耗时 → 这个 drawcall 值不值得优化？
   └ 单个 drawcall 占帧时间 >5% → 值得深入分析
   └ <0.1ms 的 drawcall 通常不是瓶颈

2. 看管线分布 → shader 在做什么？
   └ FMA 占主导 → 计算密集型
   └ TEX 占主导 → 纹理密集型
   └ LSU 占主导 → 内存密集型

3. 看 Warp Stall → 瓶颈在哪？
   └ long_scoreboard 主导 → 内存/纹理延迟瓶颈
   └ math_pipe_throttle 主导 → 计算吞吐瓶颈
   └ tex_throttle 主导 → 纹理单元饱和
   └ selected 占比很高 → SM 利用率好，可能瓶颈在别处 (ROP/Raster等)

4. 看缓存命中率 → 内存层次是否高效？
   └ L1 命中率低 → 访问模式不友好 (随机访问/stride过大)
   └ L2 命中率低 → working set 过大，带宽受限
   └ L2 TEX 命中率低 → 纹理太大/mipmap 不合适

5. 看深度测试 → 是否存在不必要的像素着色？
   └ Early-Z 比例低 → discard/写深度导致 Late-Z 回退
   └ ZCull 拒绝率低 → 渲染顺序不佳
   └ PS discard 率高 → alpha test 浪费

6. 看 PS 效率 → 像素着色器是否在做无用功？
   └ 有效输出率低 → helper lane、discard 浪费
   └ 活跃线程/warp 低 → 小三角形多，quad 浪费严重
```

---

*本文档由 NvProfAnalyzer 自动生成，基于 NVIDIA Nsight Compute / Nsight Graphics / Nsight Perf SDK 官方文档整理。*
