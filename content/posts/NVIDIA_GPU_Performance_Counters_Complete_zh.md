+++
date = '2026-04-20T10:02:00+08:00'
draft = false
title = 'NVIDIA GPU性能计数器完整参考手册'
tags = ['GPU', 'NVIDIA', 'Nsight', '性能分析']
categories = ['性能优化']
+++

# NVIDIA GPU性能计数器完整参考手册 (NvPerf/Nsight系列)

## 文件信息
- **CSV文件示例**: `Unity_2026.04.02_10.06_frame628066.pagecache.nvperf.csv`
- **参数总数**: 2958个性能计数器
- **工具演进**: nvperf → Nsight系列工具（推荐）

---

## 一、性能计数器命名规则详解

### 1.1 Nsight Compute命名规范
根据[Nsight Compute Profiling Guide](https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html)：

**基本格式**: `unit__(subunit?)_(pipestage?)_quantity_(qualifiers?)`

**接口计数器**: `unit__(subunit?)_(pipestage?)_(interface)_quantity_(qualifiers?)`

**组成部分**:
- **unit**: GPU逻辑或物理单元（如sm、dram、lts）
- **subunit**: 单元内的子单元（可选）
- **pipestage**: 管线阶段（可选）
- **quantity**: 测量的内容（字节、计数、比率等）
- **qualifiers**: 附加谓词（操作类型、访问模式等）

### 1.2 后缀含义
- **`.avg`**: 平均值
- **`.max`**: 最大值  
- **`.min`**: 最小值
- **`.sum`**: 总和
- **`(bytes)`**: 单位标识（字节）
- **`_op_read`**: 读取操作
- **`_op_write`**: 写入操作
- **`_lookup_hit`**: 查找命中
- **`_lookup_miss`**: 查找未命中

---

## 二、GPU硬件架构单元详解

### 2.1 计算核心单元
| 单元前缀 | 中文名称 | 功能描述 | 对应文档 |
|----------|----------|----------|----------|
| **`sm__`** | 流多处理器 | GPU的主要计算单元，包含多个CUDA核心，执行着色器指令 | [Nsight Compute Profiling Guide](https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html) |
| **`smsp__`** | SM子分区 | SM内的四个子分区，各含调度器、寄存器文件和执行单元 | 同上 |
| **`tpc__`** | 纹理处理集群 | 包含多个SM和纹理单元的处理集群 | [Nsight Graphics System Architecture](https://docs.nvidia.com/nsight-graphics/UserGuide/gpu-trace-system-architecture.html) |
| **`vpc__`** | 顶点处理集群 | 处理顶点着色相关任务的集群 | 同上 |

### 2.2 图形管线单元
| 单元前缀 | 中文名称 | 功能描述 | 对应文档 |
|----------|----------|----------|----------|
| **`fe__`** | 前端单元 | 图形管线的初始阶段，处理命令分发 | [Nsight Graphics Advanced Learning](https://docs.nvidia.com/nsight-graphics/AdvancedLearning/index.html) |
| **`gr__`** | 图形渲染单元 | 图形渲染相关操作 | 同上 |
| **`raster__`** | 光栅化单元 | 将图元转换为像素片段 | 同上 |
| **`pes__`** | 图元引擎状态 | 协调顶点、曲面细分、几何等阶段 | 同上 |

### 2.3 内存系统单元
| 单元前缀 | 中文名称 | 功能描述 | 对应文档 |
|----------|----------|----------|----------|
| **`dram__`** | DRAM内存控制器 | 设备主内存（GDDR6/GDDR5X）访问控制器 | [Nsight Compute Profiling Guide](https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html) |
| **`fbpa__`** | 帧缓冲区分区 | 帧缓冲区内存分区管理 | [Nsight Graphics System Architecture](https://docs.nvidia.com/nsight-graphics/UserGuide/gpu-trace-system-architecture.html) |
| **`lts__`** | 本地纹理存储 | 纹理数据的本地存储 | 同上 |
| **`l1tex__`** | L1纹理缓存 | 包含L1数据缓存和纹理处理两个并行管线 | 同上 |

### 2.4 缓存系统单元
| 单元前缀 | 中文名称 | 功能描述 | 对应文档 |
|----------|----------|----------|----------|
| **`gcc__`** | 图形命令缓存 | 图形命令的缓存系统 | [Nsight Graphics Advanced Learning](https://docs.nvidia.com/nsight-graphics/AdvancedLearning/index.html) |
| **`l2__`** | L2缓存 | 为GPU所有单元提供服务，一致性的中心点 | [Nsight Graphics System Architecture](https://docs.nvidia.com/nsight-graphics/UserGuide/gpu-trace-system-architecture.html) |
| **`syslts__`** | 系统本地纹理存储 | 系统级的纹理存储管理 | 同上 |

### 2.5 其他系统单元
| 单元前缀 | 中文名称 | 功能描述 | 对应文档 |
|----------|----------|----------|----------|
| **`idc__`** | 指令分发单元 | 指令分发相关操作 | [Nsight Compute Profiling Guide](https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html) |
| **`pcie__`** | PCI Express总线 | CPU-GPU数据传输总线 | [Nsight Graphics System Architecture](https://docs.nvidia.com/nsight-graphics/UserGuide/gpu-trace-system-architecture.html) |
| **`prop__`** | 预ROP单元 | 协调深度和颜色像素处理，管理API顺序 | [Nsight Graphics Advanced Learning](https://docs.nvidia.com/nsight-graphics/AdvancedLearning/index.html) |
| **`rtcore__`** | 光线追踪核心 | 专用光线追踪处理单元 | 同上 |

---

## 三、图形管线处理阶段详解

### 3.1 前端处理（World Pipe）
根据[Nsight Graphics Advanced Learning](https://docs.nvidia.com/nsight-graphics/AdvancedLearning/index.html)：

1. **PD (Primitive Distributor)**
   - 从索引缓冲区获取索引
   - 向顶点着色器发送三角形

2. **VAF (Vertex Attribute Fetch)**
   - 读取顶点属性值
   - 发送至顶点着色器

3. **PES + VPC**
   - 协调顶点、曲面细分、几何等阶段数据流转

### 3.2 光栅化处理（Screen Pipe）

4. **RASTER**
   - 从World Pipe接收图元
   - 输出像素和覆盖掩码

5. **PROP (Pre-ROP)**
   - 协调深度和颜色像素处理
   - 管理API执行顺序

### 3.3 像素输出处理

6. **ZROP**
   - 执行深度和模板测试

7. **CROP**
   - 执行最终颜色混合
   - 更新渲染目标

---

## 四、执行管线架构详解

根据[Nsight Compute Profiling Guide](https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html)：

### 4.1 算术管线
- **ALU**: 负责大多数位操作和逻辑指令
- **FMA**: 处理大多数FP32算术运算
- **FP64**: 双精度浮点运算单元

### 4.2 内存访问管线
- **LSU**: 发出负载、存储、原子和归约指令
- **TEX**: 纹理查找和过滤操作

### 4.3 专用计算管线
- **张量核心**: 执行MMA指令的专用管线
- **光线追踪核心**: 专用光线相交测试

---

## 五、性能分析方法论

### 5.1 峰值性能百分比分析法
根据[NVIDIA Peak Performance Analysis Blog](https://developer.nvidia.com/blog/the-peak-performance-analysis-method-for-optimizing-any-gpu-workload/)：

**三步分析法**：
1. **捕获与分解**: 使用Nsight Graphics捕获帧，通过时间戳查询识别昂贵的GPU工作负载
2. **性能分析**: 在特定调用范围上运行Range Profiler，收集PerfWorks指标
3. **SOL分析**: 检查前5个硬件单元及其SOL%值（相对于最大容量的实现吞吐量）

### 5.2 决策框架
- **SOL% > 80%**: 从瓶颈单元移除工作（例如减少纹理指令、使用查找表）
- **SOL% < 60%**: 提高效率（解决空闲周期、缓存命中率低、资源效率低下）
- **SM限制器**: 检查"SM Throughput For Active Cycles"
  - >80%: 指令吞吐量限制
  - <60%: 占用率或延迟问题

### 5.3 关键优化策略
1. **减少寄存器使用**: 提高SM占用率
2. **批量纹理获取**: 隐藏TEX延迟
3. **使用紧凑纹理格式**: 如R11G11B10F vs. RGBA16F
4. **最小化状态变更**: 减少GPU管线排空
5. **循环展开**: 改善指令调度

---

## 六、工具使用指南

### 6.1 Nsight Compute CLI工具
根据[Nsight Compute CLI](https://docs.nvidia.com/nsight-compute/NsightComputeCli/index.html)：

**指标查询命令**:
```bash
ncu --query-metrics          # 列出基础指标名称
ncu --query-metrics-mode all # 显示带后缀的完整指标名称
ncu --list-metrics           # 显示活动部分的指标
```

**性能分析命令**:
```bash
# 基本分析
ncu --set basic ./application

# 收集特定指标
ncu --metrics sm__throughput.avg,dram__bytes.sum ./app

# 使用预定义部分
ncu --section ComputeWorkloadAnalysis ./app

# 多设备分析
ncu --devices 0,1 ./app

# 保存结果
ncu -o report.ncu-rep ./app
```

### 6.2 指标映射表
| CLI参数 | 目的 | 示例 |
|---------|------|------|
| `--section <name>` | 收集特定指标组 | `--section MemoryWorkloadAnalysis` |
| `--metrics <list>` | 收集单个指标 | `--metrics sm__inst_executed.avg` |
| `--set basic/full` | 使用预定义指标集 | `--set full` |
| `--devices <list>` | 选择GPU设备 | `--devices 0,2` |
| `-o <file>` | 保存结果到文件 | `-o profile.ncu-rep` |

### 6.3 传统工具（已弃用）
```bash
# nvperf（已弃用，仅作参考）
nvperf --query-metrics      # 查询可用指标
nvperf --query-events       # 查询可用事件
nvperf -m dram__bytes.avg ./app
```

---

## 七、性能计数器类别详解

### 7.1 内存带宽和访问计数器
```
dram__bytes.avg (bytes)        # DRAM平均字节访问量
dram__bytes_op_read.sum        # DRAM读取字节总和
dram__bytes_op_write.sum       # DRAM写入字节总和
dram__sectors.avg              # DRAM平均扇区访问量
fbpa__dram_read_bytes.avg      # 帧缓冲区DRAM读取字节平均值
fbpa__dram_write_bytes.avg     # 帧缓冲区DRAM写入字节平均值
pcie__tx_bytes.avg             # PCIe发送字节平均值
```

### 7.2 绘制和几何处理计数器
```
fe__draw_count.avg             # 平均绘制调用次数
fe__output_ops.avg             # 平均输出操作次数
fe__pixel_shader_barriers.avg  # 像素着色器屏障平均数
gr__triangles.avg              # 平均处理的三角形数
raster__pixels.avg             # 平均光栅化像素数
```

### 7.3 缓存性能计数器
```
gcc__average_cache_request_hit_rate  # 平均缓存命中率
gcc__cache_requests_type_constant_lookup_hit  # 常量缓存查找命中
gcc__cache_requests_type_instruction_lookup_miss  # 指令缓存查找未命中
l1tex__data_pipe_lsu_wavefronts_mem_shared.avg  # L1数据管道共享内存访问
l2__data_pipe_lsu_wavefronts_mem_shared.avg     # L2数据管道共享内存访问
```

### 7.4 计算性能计数器
```
sm__inst_executed.avg          # 平均执行的指令数
sm__inst_executed_op_global.avg # 全局操作执行的指令数
sm__warps_active.avg           # 平均活动的warp数
sm__throughput.avg.pct_of_peak_sustained_elapsed  # SM吞吐量占峰值百分比
tpc__tex_requests.avg          # 纹理请求平均数
```

### 7.5 光线追踪计数器
```
rtcore__triangle_intersections.avg  # 三角形相交测试平均数
rtcore__bounding_box_tests.avg      # 包围盒测试平均数
rtcore__ray_traversal_steps.avg     # 光线遍历步数平均数
```

---

## 八、性能瓶颈诊断指南

### 8.1 内存瓶颈识别
1. **高`dram__bytes`值**: 表示大量内存访问
   - 优化建议：使用共享内存、减少全局内存访问
2. **高`dram__bytes_op_read`**: 读取密集型应用
   - 优化建议：预取数据、使用常量内存
3. **高`dram__bytes_op_write`**: 写入密集型应用
   - 优化建议：合并写入、使用原子操作

### 8.2 渲染瓶颈识别  
1. **高`fe__draw_count`**: 大量绘制调用
   - 优化建议：实例化渲染、合并绘制调用
2. **低`fe__output_ops`**: 前端输出效率低
   - 优化建议：减少状态变更、优化命令缓冲区

### 8.3 计算瓶颈识别
1. **低`sm__warps_active`**: SM占用率低
   - 优化建议：增加线程块大小、减少寄存器使用
2. **高`sm__inst_executed_op_global`**: 过多全局内存指令
   - 优化建议：使用共享内存、优化内存访问模式

### 8.4 缓存性能分析
1. **低`gcc__average_cache_request_hit_rate`**: 缓存命中率低
   - 优化建议：改善数据局部性、调整缓存策略
2. **高`*_lookup_miss`**: 缓存未命中多
   - 优化建议：数据预取、内存对齐优化

---

## 九、工具演进和替代方案

### 9.1 已弃用工具
- **nvperf**: 传统命令行性能分析工具
- **Visual Profiler**: 图形化性能分析工具

### 9.2 现代工具套件
1. **Nsight Systems**
   - **用途**: 全系统性能分析
   - **特点**: 分析CPU、GPU、内存、I/O等整个系统
   - **适用场景**: 系统级瓶颈识别

2. **Nsight Compute**
   - **用途**: 内核级性能分析
   - **特点**: 深入分析CUDA内核性能
   - **适用场景**: 计算内核优化

3. **Nsight Graphics**
   - **用途**: 图形应用性能分析
   - **特点**: DirectX、Vulkan、OpenGL分析
   - **适用场景**: 图形渲染优化

### 9.3 迁移指南
| 旧工具功能 | 新工具替代方案 |
|------------|----------------|
| `nvperf --metrics` | `ncu --metrics` |
| `nvperf --query-metrics` | `ncu --query-metrics` |
| Visual Profiler图形分析 | Nsight Compute GUI |
| API追踪分析 | Nsight Systems时间线分析 |

---

## 十、重要注意事项

### 10.1 计数器可用性
- 不同GPU架构（Turing、Ampere、Ada Lovelace等）支持不同的计数器集
- 使用`ncu --query-metrics`查询当前GPU支持的所有计数器
- 架构能力级别（Compute Capability）影响计数器可用性

### 10.2 性能开销
- 收集大量计数器可能影响应用性能（2-10%开销）
- 生产环境谨慎使用完整指标收集
- 推荐使用`--set basic`进行初步分析

### 10.3 数据解读
- 结合具体应用场景分析计数器值
- 使用SOL%框架进行标准化比较
- 多次运行取平均值以减少波动

### 10.4 单位注意
- 计数器可能有单位标识，如`(bytes)`、`(cycles)`等
- 比率类计数器通常无单位或使用`%`、`ratio`等

---

## 附录：参考文档链接

1. **[Nsight Compute Profiling Guide](https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html)** - 计数器命名规则、硬件单元、管线定义
2. **[Nsight Graphics Advanced Learning](https://docs.nvidia.com/nsight-graphics/AdvancedLearning/index.html)** - 图形管线各单元的功能说明
3. **[Nsight Graphics System Architecture](https://docs.nvidia.com/nsight-graphics/UserGuide/gpu-trace-system-architecture.html)** - GPU系统架构图解
4. **[NVIDIA Peak Performance Analysis Blog](https://developer.nvidia.com/blog/the-peak-performance-analysis-method-for-optimizing-any-gpu-workload/)** - 性能分析方法论
5. **[Nsight Compute CLI](https://docs.nvidia.com/nsight-compute/NsightComputeCli/index.html)** - CLI工具与指标映射表
6. **[CUDA Profiler User's Guide](https://docs.nvidia.com/cuda/profiler-users-guide/index.html)** - 传统工具参考（已弃用）

---

*文档基于NVIDIA官方文档和实际CSV文件分析整理*
*最后更新: 2026年4月2日*
*适用工具: Nsight Compute 2022.3+ / Nsight Graphics 2022.3+*

