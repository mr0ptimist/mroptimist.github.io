---
title: "UE5 Nanite 与传统渲染管线的深度源码对比"
date: 2026-04-21
tags: ["UE5", "Nanite", "Rendering", "SourceCode"]
---

> 本文基于 UE 5.4/5.5 引擎源码，从源码层面深入对比 Nanite 渲染管线与传统网格渲染管线的差异。所有代码引用均标注了引擎内的原始路径。

---

## 1. 宏观架构概览

传统渲染管线和 Nanite 管线的最根本区别在于：**几何处理的主导权从 CPU 转移到了 GPU**，并且**材质着色从 Pixel Shader 迁移到了 Compute Shader**。

| 维度 | 传统渲染 (Traditional) | Nanite |
|------|----------------------|--------|
| **几何裁剪** | CPU-driven Frustum/Occlusion Culling | GPU-driven Cluster Culling + Two-Pass Occlusion |
| **LOD** | 离散 LOD (StaticMesh LOD0~N) | 连续 LOD (Cluster Hierarchy, Runtime Streaming) |
| **光栅化** | 硬件光栅化 (Fixed Function RS) | 软件光栅化 (Compute) + 硬件光栅化 (Mesh/Prim Shader) |
| **中间表示** | 无 (直接写 GBuffer/FrameBuffer) | Visibility Buffer (VisBuffer64) |
| **材质着色** | Pixel Shader (`BasePassPixelShader.usf`) | Compute Shader (`ComputeShaderOutputCommon.ush`) |
| **GBuffer 输出** | `SV_Target` MRT | UAV (`ComputeShadingOutputs.OutTargetN`) |
| **DrawCall** | `FMeshDrawCommand` (CPU 组装) | Indirect Dispatch (GPU 驱动) |

---

## 2. 渲染入口与调度

### 2.1 传统渲染的入口

传统渲染的顶层调度在 `FDeferredShadingSceneRenderer::Render()` 中，通过 `RenderBasePass()` 等函数发起。每个 `FPrimitiveSceneProxy` 会在 `FMeshPassProcessor` 中被转换为 `FMeshDrawCommand`，最终由 `FParallelMeshDrawCommandPass` 提交到 RHI。

**关键源码位置（`[每帧]` 调用）：**
```cpp
// Engine/Source/Runtime/Renderer/Private/DeferredShadingRenderer.cpp
void FDeferredShadingSceneRenderer::Render(FRDGBuilder& GraphBuilder, const FSceneRenderUpdateInputs* SceneUpdateInputs)
{
    // ...
    // 传统 BasePass 通过 MeshDrawCommands 提交
    // FBasePassMeshProcessor 处理所有非 Nanite 的 MeshBatch
}
```

### 2.2 Nanite 渲染的入口

Nanite 的渲染由 `FDeferredShadingSceneRenderer::RenderNanite()` 专门处理，它在 `Render()` 流程中被调用。

**关键源码位置（`[每帧]` 调用）：
```cpp
// Engine/Source/Runtime/Renderer/Private/DeferredShadingRenderer.cpp:1370
void FDeferredShadingSceneRenderer::RenderNanite(
    FRDGBuilder& GraphBuilder,
    const TArray<FViewInfo>& InViews,
    FSceneTextures& SceneTextures,
    bool bIsEarlyDepthComplete,
    FNaniteBasePassVisibility& InNaniteBasePassVisibility,
    TArray<Nanite::FRasterResults, TInlineAllocator<2>>& NaniteRasterResults,
    TArray<Nanite::FPackedView, SceneRenderingAllocator>& PrimaryNaniteViews,
    FRDGTextureRef FirstStageDepthBuffer)
{
    // 1. 初始化 RasterContext (VisBuffer / DepthOnly)
    RasterContext = Nanite::InitRasterContext(..., Nanite::EOutputBufferMode::VisBuffer, ...);

    // 2. 创建 NaniteRenderer (GPU Culling + Rasterization)
    TUniquePtr<Nanite::IRenderer> NaniteRenderer = Nanite::IRenderer::Create(...);
    NaniteRenderer->DrawGeometry(
        Scene->NaniteRasterPipelines[ENaniteMeshPass::BasePass],
        RasterResults.VisibilityQuery,
        *NaniteViewsToRender,
        SceneInstanceCullQuery);
    NaniteRenderer->ExtractResults(RasterResults);

    // 3. 导出深度目标 (Emit Depth Targets) [每帧]
    Nanite::EmitDepthTargets(GraphBuilder, *Scene, InViews[ViewIndex], ...);

    // 4. BasePass Shading (Compute Shader) [每帧]
    Nanite::DispatchBasePass(GraphBuilder, ShadingCommands, SceneRenderer, ...);
}
```

---

## 3. 几何数据结构与存储

### 3.1 传统渲染：Vertex Buffer + Index Buffer

传统网格的数据以标准的 `FStaticMeshVertexBuffer` / `FStaticMeshIndexBuffer` 形式存储，通过 `FLocalVertexFactory` 声明顶点输入布局。

**关键源码位置（顶点布局定义 `[离线/Cook]` 绑定到 InputLayout，`[每帧]` 通过 VertexBuffer 传入 GPU）：**
```hlsl
// Engine/Shaders/Private/LocalVertexFactory.ush:50
struct FVertexFactoryInput
{
    float4  Position    : ATTRIBUTE0;
    HALF3_TYPE  TangentX    : ATTRIBUTE1;
    HALF4_TYPE  TangentZ    : ATTRIBUTE2;   // TangentZ.w contains sign of tangent basis determinant
    HALF4_TYPE  Color       : ATTRIBUTE3;
    float4  TexCoords0      : ATTRIBUTE4;
    float4  TexCoords1      : ATTRIBUTE5;
    // ... up to 8 UV channels
    uint VertexId : SV_VertexID;
};
```

顶点数据在 VS 中通过 `VertexFactoryGetWorldPosition()` 转换到世界空间，再经 WPO (World Position Offset) 扰动后进入裁剪空间。

### 3.2 Nanite：Cluster Page Data + Hierarchy Buffer

Nanite 使用**虚拟化几何体（Virtualized Geometry）**。原始三角形网格在 **Cook 时（`[离线]`）** 被分割为大小统一的 **Cluster**（最大 128 个三角形、256 个顶点），并组织成层次结构（BVH）。运行时通过 `Nanite::GStreamingManager` **每帧异步**流送所需 Page。

**关键定义（`[离线决定的数据结构]`）：**
```cpp
// Engine/Shaders/Shared/NaniteDefinitions.h:21
#define NANITE_MAX_CLUSTER_TRIANGLES_BITS   7
#define NANITE_MAX_CLUSTER_TRIANGLES        (1 << NANITE_MAX_CLUSTER_TRIANGLES_BITS)  // 128
#define NANITE_MAX_CLUSTER_VERTICES_BITS    8
#define NANITE_MAX_CLUSTER_VERTICES         (1 << NANITE_MAX_CLUSTER_VERTICES_BITS)   // 256
```

运行时，Cluster 数据以 Page 为单位流送到 GPU：
```hlsl
// Engine/Shaders/Private/Nanite/NaniteDataDecode.ush:60
struct FPageHeader
{
    uint    NumClusters;
    uint    MaxClusterBoneInfluences;
    uint    MaxVoxelBoneInfluences;
};

struct FCluster
{
    uint    PageBaseAddress;
    uint    NumVerts;
    uint    PositionOffset;
    uint    NumTris;
    uint    IndexOffset;
    int3    PosStart;
    uint    BitsPerIndex;
    int     PosPrecision;
    uint3   PosBits;
    // ... quantized normals, tangents, UVs, colors
};
```

GPU 端通过 `ByteAddressBuffer ClusterPageData` 读取这些压缩后的顶点数据，并在 Compute Shader 中手动解码。

---

## 4. 裁剪系统（Culling）

### 4.1 传统渲染：CPU 裁剪 + GPU Scene

传统渲染中，`FSceneRenderer` 在 `InitViews()` 阶段执行 CPU 端的视锥裁剪和 HZB 遮挡裁剪。可见的 `FPrimitiveSceneProxy` 被转换为 `FMeshBatch`，再经过 `FMeshPassProcessor` 生成 `FMeshDrawCommand`。

**关键流程（`[每帧]` 调用）：**
```cpp
// Engine/Source/Runtime/Renderer/Private/SceneRendering.cpp
BeginInitViews(GraphBuilder, SceneTexturesConfig, InstanceCullingManager, ...);
// -> FrustumCull [每帧] -> OcclusionCull (HZB) [每帧] -> BuildMeshDrawCommands [每帧]
```

### 4.2 Nanite：GPU-driven Two-Pass Occlusion Culling

Nanite 将裁剪完全搬到 GPU。它维护一个 Cluster Group 的层次结构（Hierarchy），通过 Compute Shader 逐层遍历 BVH 节点，执行视锥裁剪、LOD 选择和 HZB 遮挡测试。

**关键源码位置（裁剪 Pass 为 `[每帧]` 调用）：**
```cpp
// Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.cpp:37
#define CULLING_PASS_NO_OCCLUSION       0
#define CULLING_PASS_OCCLUSION_MAIN     1   // [每帧] 主裁剪 Pass
#define CULLING_PASS_OCCLUSION_POST     2   // [每帧] Two-Pass 遮挡补全 Pass
#define CULLING_PASS_EXPLICIT_LIST      3   // [按需] 显式列表裁剪（如 VSM、Lumen）
```

在 `FDeferredShadingSceneRenderer::RenderNanite()` 中，Nanite 默认启用 **Two-Pass Occlusion**：
```cpp
// Engine/Source/Runtime/Renderer/Private/DeferredShadingRenderer.cpp:1475
Nanite::FConfiguration CullingConfig = { 0 };
CullingConfig.bTwoPassOcclusion = true;   // 第一 Pass 渲染可见集群，第二 Pass 补全上一帧被遮挡但本帧可能可见的集群
CullingConfig.bUpdateStreaming = true;    // 同时驱动数据流送
```

裁剪结果存储在 `VisibleClustersSWHW` Buffer 中，供后续的光栅化阶段读取。

---

## 5. 光栅化（Rasterization）

### 5.1 传统渲染：固定功能硬件光栅化

传统渲染完全依赖 GPU 的固定功能光栅化器（Fixed Function Rasterizer）。VS 输出 `SV_Position`，硬件自动执行三角形遍历、深度测试和像素着色器调度。

**传统 VS 入口：**
```hlsl
// Engine/Shaders/Private/BasePassVertexShader.usf:32
void Main(
    FVertexFactoryInput Input,
    out FBasePassVSOutput Output
#if USE_GLOBAL_CLIP_PLANE
    , out float OutGlobalClipPlaneDistance : SV_ClipDistance
#endif
)
{
    FVertexFactoryIntermediates VFIntermediates = GetVertexFactoryIntermediates(Input);
    float4 WorldPosition = VertexFactoryGetWorldPosition(Input, VFIntermediates);
    // Apply WPO
    WorldPosition.xyz += GetMaterialWorldPositionOffset(VertexParameters);
    // Transform to clip space
    Output.Position = mul(RasterizedWorldPosition, ResolvedView.TranslatedWorldToClip);
}
```

### 5.2 Nanite：软件光栅化 + 硬件光栅化混合

Nanite 根据三角形大小**动态选择光栅化路径**：

```cpp
// Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.h:25
enum class ERasterScheduling : uint8
{
    HardwareOnly = 0,           // 仅硬件光栅化
    HardwareThenSoftware = 1,   // 大三角形用硬件，小三角形用软件（Compute）
    HardwareAndSoftwareOverlap = 2, // 两者重叠执行
};
```

阈值由 `r.Nanite.MinPixelsPerEdgeHW` 控制（默认 32 像素）。小于此阈值的三角形进入 **Compute Shader 软件光栅化**。

**软件光栅化的核心逻辑：**
```hlsl
// Engine/Shaders/Private/Nanite/NaniteRasterizer.ush:28
template< uint SubpixelSamples, bool bBackFaceCull >
FRasterTri SetupTriangle( int4 ScissorRect, float4 Verts[3] )
{
    FRasterTri Tri;
    // 16.8 fixed point edge setup
    Tri.Edge01 = Vert0 - Vert1;
    Tri.Edge12 = Vert1 - Vert2;
    Tri.Edge20 = Vert2 - Vert0;

    float DetXY = Tri.Edge01.y * Tri.Edge20.x - Tri.Edge01.x * Tri.Edge20.y;
    Tri.bBackFace = (DetXY >= 0.0f);

    // Half-edge constants for rasterization walk
    Tri.C0 = Tri.Edge12.y * Vert1.x - Tri.Edge12.x * Vert1.y;
    Tri.C1 = Tri.Edge20.y * Vert2.x - Tri.Edge20.x * Vert2.y;
    Tri.C2 = Tri.Edge01.y * Vert0.x - Tri.Edge01.x * Vert0.y;

    Tri.Barycentrics_dx = float3( -Tri.Edge12.y, -Tri.Edge20.y, -Tri.Edge01.y ) * ScaleToUnit;
    Tri.Barycentrics_dy = float3(  Tri.Edge12.x,  Tri.Edge20.x,  Tri.Edge01.x ) * ScaleToUnit;

    return Tri;
}
```

软件光栅化使用 **Half-Space 算法**在 Compute Shader 中逐像素遍历三角形，并通过 `ImageInterlockedMaxUInt64` 原子操作写入 **Visibility Buffer**。

### 5.3 Visibility Buffer

Nanite 不直接输出 GBuffer，而是先输出一个 **64-bit Visibility Buffer**（`VisBuffer64`）。每个像素存储了足够的信息来反推是哪个三角形的哪个像素。

**写入逻辑：**
```hlsl
// Engine/Shaders/Private/Nanite/NaniteWritePixel.ush:20
void WritePixel(
    RWTexture2D<UlongType> OutBuffer,
    uint PixelValue,        // Packed ClusterIndex + TriangleIndex + Barycentrics
    uint2 PixelPos,
    uint DepthInt
)
{
#if COMPILER_SUPPORTS_UINT64_IMAGE_ATOMICS
    const UlongType Pixel = PackUlongType(uint2(PixelValue, DepthInt));
    ImageInterlockedMaxUInt64(OutBuffer, PixelPos, Pixel);  // 原子 Max（Z-test）
#else
    #error UNKNOWN_ATOMIC_PLATFORM
#endif
}
```

Visibility Buffer 的设计是 Nanite 最核心的创新之一：它把**几何分辨率**和**着色分辨率**解耦，使得后续着色可以在 Compute Shader 中以任意粒度（Quad / Pixel / Tile）执行。

---

## 6. 材质着色（Material Shading）

### 6.1 传统渲染：Pixel Shader

在传统渲染中，BasePass 的顶点工厂输出插值器（Interpolants），由 Pixel Shader 进行材质计算并输出到 MRT。

**传统 PS 入口：**
```hlsl
// Engine/Shaders/Private/BasePassPixelShader.usf
// MainPS 是实际入口，经过大量宏和包含后展开
void MainPS(...)
{
    FPixelShaderIn PixelShaderIn = ...;
    FPixelShaderOut PixelShaderOut = ...;

    // Material evaluation
    FMaterialPixelParameters MaterialParameters = GetMaterialPixelParameters(...);
    // ... BRDF, lighting, GBuffer packing

    // Output to GBuffer via SV_Target
    return PixelShaderOut;
}
```

### 6.2 Nanite：Compute Shader

Nanite 的 BasePass Shading 完全在 **Compute Shader** 中执行。这是 Nanite 与传统渲染差异最大的地方。

**核心文件（`[每帧]` 每个 ShadingBin 触发一次 Indirect Dispatch）：**
```hlsl
// Engine/Shaders/Engine/Private/ComputeShaderOutputCommon.ush
```

该文件顶部注释明确说明了其设计目标：
```hlsl
/*=============================================================================
ComputeShaderOutputCommon.ush: To allow CS input/output passed into functions
through a single struct, allowing for a more readable code
(less #ifdefs, reducing the boolean hell)
=============================================================================*/
```

#### 6.2.1 Compute Shader 入口

```hlsl
// Engine/Shaders/Private/ComputeShaderOutputCommon.ush:235
// [每帧] 每个 ShadingBin 通过 DispatchIndirect 调用一次
[numthreads(COMPUTE_MATERIAL_GROUP_SIZE, 1, 1)]
void MainCS(
    uint ThreadIndex : SV_GroupIndex,
    uint GroupID : SV_GroupID
#if WORKGRAPH_NODE
    , DispatchNodeInputRecord<FShaderBundleNodeRecord> InputRecord
#endif
)
{
    const uint ShadingBin       = GetShadingBin();          // Root Constant 0
    const bool bQuadBinning     = GetQuadBinning() != 0u;   // Root Constant 1
    const uint DataByteOffset   = GetDataByteOffset();      // Root Constant 3

    const uint PixelIndex = (GroupID * COMPUTE_MATERIAL_GROUP_SIZE) + ThreadIndex;

    // 从 ShadingBinData 读取该 ShadingBin 的元数据
    const uint3 ShadingBinMeta = NaniteShading.ShadingBinData.Load3(ShadingBin * NANITE_SHADING_BIN_META_BYTES);
    const uint ElementCount = ShadingBinMeta.x;
    const uint ElementIndex = bQuadBinning ? (PixelIndex >> 2) : PixelIndex;

    // 读取打包的像素位置、VRS Shift、WriteMask
    uint2 PixelPos;
    uint2 VRSShift;
    uint PixelWriteMask;
    // ... (unpack from ShadingBinData)

    // 计算 SVPositionXY (Centroid-like sampling)
    const float2 SVPositionXY = PixelPos + int2(WriteMaskFirstIndex & 1, (WriteMaskFirstIndex >> 1) & 1) + 0.5f;

    // 调用与传统 Pixel Shader 完全相同的材质评估逻辑
    ProcessPixel(ShadingBin, PixelPos, SVPositionXY, ElementIndex, PixelIndex, PixelWriteMask, HelperLaneCount);
}
```

#### 6.2.2 ShadePixel：在 CS 中调用 PS 逻辑

```hlsl
// Engine/Shaders/Private/ComputeShaderOutputCommon.ush:44
FPixelShaderOut ShadePixel(const float2 SVPositionXY, uint QuadIndex, uint QuadPixelWriteMask)
{
    const bool bHighPrecision = GetHighPrecision() != 0u;

#if IS_NANITE_PASS
    FNaniteFullscreenVSToPS NaniteInterpolants = (FNaniteFullscreenVSToPS)0;
    NaniteInterpolants.TileIndex = QuadIndex;
#else
    FVertexFactoryInterpolantsVSToPS Interpolants = (FVertexFactoryInterpolantsVSToPS)0;
#endif

    const float4 SvPosition = float4(SVPositionXY, 0.0f, 1.0f);

    FPixelShaderIn PixelShaderIn = (FPixelShaderIn)0;
    FPixelShaderOut PixelShaderOut = (FPixelShaderOut)0;
    PixelShaderIn.SvPosition = SvPosition;
    PixelShaderIn.bIsFrontFace = false;

#if PIXELSHADEROUTPUT_BASEPASS
    FBasePassInterpolantsVSToPS BasePassInterpolants = (FBasePassInterpolantsVSToPS)0;
    // 关键：调用与传统 BasePass PS 完全相同的函数入口
    FPixelShaderInOut_MainPS(Interpolants, BasePassInterpolants, PixelShaderIn, PixelShaderOut, EyeIndex, QuadPixelWriteMask);
#endif

    return PixelShaderOut;
}
```

**核心洞察：** `FPixelShaderInOut_MainPS` 就是传统 `BasePassPixelShader.usf` 中的 Pixel Shader 主入口。Nanite 没有重写材质评估逻辑，而是**把同样的 Pixel Shader 代码在 Compute Shader 中调用**。

#### 6.2.3 ExportPixel：UAV 输出

计算着色器无法使用 `SV_Target`，因此 Nanite 通过 **UAV** 输出到 GBuffer：

```hlsl
// Engine/Shaders/Private/ComputeShaderOutputCommon.ush:113
void ExportPixel(const uint2 PixelPos, FPixelShaderOut ShadedPixel)
{
#if PIXELSHADEROUTPUT_MRT0
    ComputeShadingOutputs.OutTarget0[PixelPos] = ShadedPixel.MRT[0];
#endif
#if PIXELSHADEROUTPUT_MRT1
    ComputeShadingOutputs.OutTarget1[PixelPos] = ShadedPixel.MRT[1];
#endif
#if PIXELSHADEROUTPUT_MRT2
    ComputeShadingOutputs.OutTarget2[PixelPos] = ShadedPixel.MRT[2];
#endif
#if PIXELSHADEROUTPUT_MRT3
    ComputeShadingOutputs.OutTarget3[PixelPos] = ShadedPixel.MRT[3];
#endif

#if SUBSTRATE_OPAQUE_DEFERRED
    // Substrate 额外输出到 2D Array UAV
    UNROLL
    for (uint LayerIt = 0; LayerIt < SUBSTRATE_BASE_PASS_MRT_OUTPUT_COUNT; ++LayerIt)
    {
        ComputeShadingOutputs.OutTargets[uint3(PixelPos, LayerIt)] = ShadedPixel.SubstrateOutput[LayerIt];
    }
    ComputeShadingOutputs.OutTopLayerTarget[PixelPos] = ShadedPixel.SubstrateTopLayerData;
#endif
}
```

### 6.3 Shading Binning

Nanite 的另一个关键优化是 **Shading Binning**。由于 Compute Shader 不能像 Pixel Shader 那样被硬件自动按材质批次调度，Nanite 在 GPU 上预先对像素按材质（ShadingBin）进行分类。

**C++ 端的 Shading Binning 调度（`[每帧]` 调用）：**
```cpp
// Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShading.cpp:1443
FShadeBinning ShadeBinning(
    FRDGBuilder& GraphBuilder,
    const FScene& Scene,
    const FViewInfo& View,
    const FIntRect InViewRect,
    const FNaniteShadingCommands& ShadingCommands,
    const FRasterResults& RasterResults,
    const TConstArrayView<FRDGTextureRef> ClearTargets)
{
    // 1. Count Pass: 统计每个 ShadingBin 的像素数量
    // 2. Reserve Pass: 为每个 Bin 分配全局 Buffer 偏移
    // 3. Scatter Pass: 将像素坐标打包写入 ShadingBinData
}
```

**对应的 Compute Shader：**
```hlsl
// Engine/Shaders/Private/Nanite/NaniteShadeBinning.usf
// ShadingBinBuildCS (COUNT / SCATTER / RESERVE / VALIDATE)
```

每个 ShadingBin 对应一种材质变体。DispatchBasePass 时，每个可见 Bin 每帧发起一次 `DispatchIndirectComputeShader`：

```cpp
// Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShading.cpp:820
// [每帧] 每个可见 ShadingBin 执行一次 Indirect Dispatch
FRHIComputeShader* ComputeShaderRHI = ShadingCommand.Pipeline->ComputeShader;
SetComputePipelineState(RHICmdList, ComputeShaderRHI);
RHICmdList.SetBatchedShaderParameters(ComputeShaderRHI, ShadingParameters);
RHICmdList.DispatchIndirectComputeShader(IndirectArgsBuffer, IndirectOffset);
```

---

## 7. GBuffer 与渲染目标输出

### 7.1 传统渲染：RenderTarget + SV_Target

传统 BasePass 通过绑定 RenderTarget，在 Pixel Shader 中使用 `SV_Target0~7` 输出：

```hlsl
// Engine/Shaders/Private/BasePassPixelShader.usf
// Output 定义在 FPixelShaderOut (ShaderOutputCommon.ush) 中
struct FPixelShaderOut
{
    float4 MRT[MaxSimultaneousRenderTargets];
    // ... Substrate outputs, Coverage, Depth, etc.
};
```

### 7.2 Nanite：UAV + ComputeShadingOutputs

Nanite 使用一个统一的 UniformBuffer `FComputeShadingOutputs` 来管理所有 UAV 输出：

```cpp
// Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShading.cpp:424
BEGIN_SHADER_PARAMETER_STRUCT(FNaniteShadingPassParameters, )
    // ...
    SHADER_PARAMETER_RDG_UNIFORM_BUFFER(FComputeShadingOutputs, ComputeShadingOutputs)
END_SHADER_PARAMETER_STRUCT()
```

在 `CreateNaniteShadingPassParams()` 中，根据 BasePassRenderTargets 动态绑定 UAV：

```cpp
// Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShading.cpp:1096
FComputeShadingOutputs* ShadingOutputs = GraphBuilder.AllocParameters<FComputeShadingOutputs>();

for (uint32 TargetIndex = 0; TargetIndex < MaxSimultaneousRenderTargets; ++TargetIndex)
{
    if (FRDGTexture* TargetTexture = BasePassRenderTargets.Output[TargetIndex].GetTexture())
    {
        if ((BoundTargetMask & (1u << TargetIndex)) == 0u)
        {
            *OutTargets[TargetIndex] = GetDummyUAV();  // 未使用的 Target 绑定 Dummy
        }
        else if (bMaintainCompression)
        {
            *OutTargets[TargetIndex] = GraphBuilder.CreateUAV(
                FRDGTextureUAVDesc::CreateForMetaData(TargetTexture, ERDGTextureMetaDataAccess::PrimaryCompressed));
        }
        else
        {
            *OutTargets[TargetIndex] = GraphBuilder.CreateUAV(TargetTexture);
        }
    }
}
```

---

## 8. LOD 系统

### 8.1 传统渲染：离散 LOD

传统渲染依赖美术制作的离散 LOD（LOD0 ~ LODn），通过 `FStaticMeshRenderData::LODResources` 存储。运行时根据屏幕尺寸选择单个 LOD 级别，CPU 侧切换 IndexBuffer/VertexBuffer。

### 8.2 Nanite：连续 LOD（Cluster Hierarchy）

Nanite 在 Cook 时构建**层次化的 Cluster Group Tree**。每个 Cluster Group 的父节点是更粗略的 Cluster 集合。运行时，GPU 遍历这棵树，根据屏幕像素误差动态决定切到哪个层级。

**关键源码位置（`[每帧]` 每视图更新一次，驱动运行时 LOD 选择）：**
```cpp
// Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShared.cpp:90
void FPackedView::UpdateLODScales(const float NaniteMaxPixelsPerEdge, const float MinPixelsPerEdgeHW)
{
    const float ViewToPixels = 0.5f * ViewToClip.M[1][1] * ViewSizeAndInvSize.Y;
    const float LODScale = ViewToPixels / NaniteMaxPixelsPerEdge;
    const float LODScaleHW = ViewToPixels / MinPixelsPerEdgeHW;
    LODScales = FVector2f(LODScale, LODScaleHW);
}
```

`r.Nanite.MaxPixelsPerEdge` 控制目标三角形边长（默认 1.0 像素）。裁剪遍历时，每个节点/集群根据 `LODError` 和 `EdgeLength` 与 `LODScale` 比较，决定是否继续遍历子节点。

---

## 9. DrawCall 与调度模型

### 9.1 传统渲染：FMeshDrawCommand

传统渲染中，`FMeshPassProcessor` 为每个 `FMeshBatch` 创建 `FMeshDrawCommand`，包含完整的 PSO、ShaderBindings、顶点流设置。这些命令在 CPU 端排序、合并，最终通过 `FRHICOMMANDLIST` 提交。

**关键源码位置（`[每帧]` 每个 DrawCommand 提交前执行）：**
```cpp
// Engine/Source/Runtime/Renderer/Private/MeshPassProcessor.cpp
void FReadOnlyMeshDrawSingleShaderBindings::SetShaderBindings(
    FRHIBatchedShaderParameters& BatchedParameters,
    const FReadOnlyMeshDrawSingleShaderBindings& RESTRICT SingleShaderBindings)
{
    // 绑定 UniformBuffer、Texture、Sampler、SRV、LooseParameters
}
```

### 9.2 Nanite：Indirect Dispatch + Shader Bundle

Nanite 几乎完全避免了 CPU 端的 DrawCall 生成：

1. **Rasterization 阶段**：使用 `DispatchIndirect` 调用软件/硬件光栅化器。
2. **Shading 阶段**：对每个 ShadingBin 执行 `DispatchIndirectComputeShader`。

**Shader Bundle 优化（可选）：**
```cpp
// Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShading.cpp:936
static void DispatchComputeShaderBundle(
    FRHIComputeCommandList& RHICmdList,
    FNaniteShadingCommands& ShadingCommands,
    ...)
{
    RHICmdList.DispatchComputeShaderBundle([&](FRHICommandDispatchComputeShaderBundle& Command)
    {
        Command.ShaderBundle = ShaderBundle;
        Command.RecordArgBuffer = Intermediates.IndirectArgsBuffer;
        // 并行记录所有 ShadingBin 的 Dispatch 参数
    });
}
```

Shader Bundle 允许在一次 GPU 调用中执行多个不同 Compute Shader 的 Dispatch，减少命令列表开销。

---

## 10. PSO（Pipeline State Object）与状态管理

### 10.1 什么是 PSO

**PSO = Pipeline State Object（管线状态对象）**。在现代图形 API（DX12 / Vulkan）中，GPU 渲染管线的所有状态——顶点格式、着色器组合、深度模板配置、混合模式、光栅化参数等——被捆绑成一个**不可变对象**。调用方必须先创建 PSO，然后才能提交绘制或 Dispatch。

这与 DX11 的逐个状态切换模型有本质区别：在 DX12/Vulkan 中，驱动需要提前知道完整的管线状态以生成底层的 GPU 微码。**运行时创建或切换 PSO 是昂贵的操作**，会导致明显的卡顿（hitch）。

### 10.2 UE 的 PSO Precaching（预缓存）

UE 为此实现了 **PSO Precaching** 系统，在后台异步编译渲染所需的 PSO，避免运行时阻塞：

```cpp
// Engine/Source/Runtime/Renderer/Private/Nanite/NaniteShading.cpp:834
inline bool PrepareShadingCommand(FNaniteShadingCommand& ShadingCommand)
{
    EPSOPrecacheResult PSOPrecacheResult = ShadingCommand.PSOPrecacheState;

    // 如果 PSO 仍在后台编译，可选择跳过该 Dispatch
    if (GSkipDrawOnPSOPrecaching && PSOPrecacheResult == EPSOPrecacheResult::Active)
    {
        return false;  // Skip draw until PSO is ready
    }
    return true;
}
```

Nanite 的 `DispatchBasePass` 会检查每个 ShadingBin 对应的 Compute PSO 是否已就绪。若 PSO 仍在 `Active`（编译中），可以选择跳过该 Bin 的 Dispatch，等下一帧 PSO 就绪后再执行，从而避免 stalls。

### 10.3 传统渲染 vs Nanite 的 PSO 差异

| 维度 | 传统渲染 | Nanite |
|------|---------|--------|
| **PSO 数量** | 极多（每材质 × 每顶点工厂 × 每渲染Pass） | 较少（每 ShadingBin 一个 Compute PSO） |
| **切换开销** | 高频切换，CPU 排序优化 | 几乎无切换（CS 批量执行） |
| **Precache 关键度** | 高（漏缓存会导致运行时 hitch） | 中等（Compute PSO 编译通常比 Graphics PSO 快） |
| **运行时创建** | 可能（Fallback） | 尽量避免（通过 `PrepareShadingCommand` 跳过） |

### 10.4 源码中的 PSO 相关路径

```cpp
// Engine/Source/Runtime/Renderer/Private/PSOPrecacheMaterial.cpp
// Engine/Source/Runtime/Renderer/Private/PSOPrecacheValidation.cpp
// Engine/Source/Runtime/RHI/Public/PipelineStateCache.h
```

---

## 11. 关键源码文件索引

### Nanite 核心（C++）

| 文件 | 路径 | 说明 |
|------|------|------|
| `DeferredShadingRenderer.cpp` | `Engine/Source/Runtime/Renderer/Private/` | 顶层渲染调度，`RenderNanite()` 入口 |
| `NaniteCullRaster.cpp/.h` | `Engine/Source/Runtime/Renderer/Private/Nanite/` | GPU 裁剪与光栅化核心 |
| `NaniteShading.cpp/.h` | `Engine/Source/Runtime/Renderer/Private/Nanite/` | Shading Binning、DispatchBasePass |
| `NaniteShared.cpp/.h` | `Engine/Source/Runtime/Renderer/Private/Nanite/` | 全局资源、UniformBuffer、View Packing |
| `NaniteVisibility.cpp/.h` | `Engine/Source/Runtime/Renderer/Private/Nanite/` | Visibility Query 系统 |
| `NaniteMaterials.cpp/.h` | `Engine/Source/Runtime/Renderer/Private/Nanite/` | 材质管线与 Shading Pipeline 管理 |

### Nanite 核心（Shader）

| 文件 | 路径 | 说明 |
|------|------|------|
| `NaniteRasterizer.ush` | `Engine/Shaders/Private/Nanite/` | 软件光栅化三角形 Setup 与遍历 |
| `NaniteWritePixel.ush` | `Engine/Shaders/Private/Nanite/` | Visibility Buffer 原子写入 |
| `NaniteDataDecode.ush` | `Engine/Shaders/Private/Nanite/` | Cluster/Page 数据结构解码 |
| `NaniteShadeCommon.ush` | `Engine/Shaders/Private/Nanite/` | Shading 阶段的公共定义与 Helper |
| `NaniteShadeBinning.usf` | `Engine/Shaders/Private/Nanite/` | Shading Binning 的 Compute Shader |
| `ComputeShaderOutputCommon.ush` | `Engine/Shaders/Engine/Private/` | CS 版 BasePass 入口与 ExportPixel |
| `NaniteDefinitions.h` | `Engine/Shaders/Shared/` | Nanite 常量与位域定义（C++/Shader 共享） |

### 传统渲染核心（C++）

| 文件 | 路径 | 说明 |
|------|------|------|
| `BasePassRendering.cpp/.h/.inl` | `Engine/Source/Runtime/Renderer/Private/` | 传统 BasePass MeshProcessor 与 Shader 模板 |
| `MeshPassProcessor.cpp/.h` | `Engine/Source/Runtime/Renderer/Private/` | MeshPass 调度与 DrawCommand 生成 |
| `MeshDrawCommands.cpp/.h` | `Engine/Source/Runtime/Renderer/Private/` | DrawCommand 执行与 ShaderBindings |

### 传统渲染核心（Shader）

| 文件 | 路径 | 说明 |
|------|------|------|
| `BasePassVertexShader.usf` | `Engine/Shaders/Private/` | 传统 BasePass VS 入口 |
| `BasePassPixelShader.usf` | `Engine/Shaders/Private/` | 传统 BasePass PS 入口 |
| `LocalVertexFactory.ush` | `Engine/Shaders/Private/` | 传统顶点工厂输入定义 |
| `ShaderOutputCommon.ush` | `Engine/Shaders/Private/` | `FPixelShaderIn` / `FPixelShaderOut` 定义 |

---

## 12. RenderDoc 管线视角分析

从 **RenderDoc（RDC）** 的 Event Browser 观察，Nanite 与传统渲染的 GPU 调用序列差异极其明显。以下是在延迟渲染管线中捕获的典型事件树对比。

### 11.1 传统渲染在 RDC 中的样子

传统渲染的事件树以 **Draw Call** 为核心，每个 `FMeshDrawCommand` 对应一条 `DrawIndexedInstanced` 或 `DrawIndexedPrimitive`：

```
Scene
├── VisibilityCommands          // [每帧] CPU Culling
├── DepthPrePass
│   ├── DrawIndexedInstanced    // Mesh A (VS -> RS -> PS: DepthOnly)
│   ├── DrawIndexedInstanced    // Mesh B
│   └── ... (数百到数千个 DrawCall)
├── BasePass
│   ├── SetRenderTargets(GBuffer0~N, DepthStencil)
│   ├── DrawIndexedInstanced    // Mesh A (VS -> RS -> PS: BasePass)
│   ├── DrawIndexedInstanced    // Mesh B
│   └── ... (PSO 切换频繁，按材质排序)
└── Lighting
    └── ... (Deferred Lighting Compute Passes)
```

**RDC 中可观察到的特征：**
- **大量 DrawCall**：每个 StaticMesh 组件至少一个 DrawCall。
- **IA/VS 活跃**：Vertex Input Assembler 和 Vertex Shader 有实际工作量。
- **PS 按材质分组**：同一材质的不同 Mesh 通常被排序到一起，减少 PSO 切换。
- **无 Compute Culling**：裁剪结果在 CPU 端决定，GPU 事件树直接从 DrawCall 开始。

### 11.2 Nanite 在 RDC 中的样子（真实抓帧事件树）

Nanite 的事件树以 **Compute Dispatch** 为主，DrawCall（如果有）仅出现在硬件光栅化路径。以下是基于真实 GPU Profiler 捕获的 UE5 Nanite 事件树：

```
Scene
├── VisibilityCommands            // [每帧] CPU Culling (传统部分)
├── PrePass DDM_AllOpaqueNoVelocity // [每帧] 强制 Depth Prepass (Nanite 需要)
├── Nanite::VisBuffer             // [每帧] Nanite 核心管线
│   ├── Nanite::InitContext       // [每帧] 初始化 Raster Context
│   ├── Nanite::DrawGeometry      // [每帧] 主绘制入口
│   │   ├── InitArgs              // [每帧] 初始化 Indirect Dispatch Args
│   │   ├── ClearBuffer           // [每帧] 清除 SplitWorkQueue / OccludedPatches
│   │   ├── MainPass              // [每帧] === Two-Pass Occlusion: 第一 Pass (可见物渲染) ===
│   │   │   ├── InstanceCulling   // [每帧] CS: GPU Instance Culling
│   │   │   ├── NodeAndClusterCull// [每帧] CS: BVH 遍历 + 视锥裁剪 + LOD 选择
│   │   │   ├── CalculateSafeRasterizerArgs // [每帧] CS: 计算光栅化参数
│   │   │   ├── RasterBinInit     // [每帧] CS: 初始化 Raster Bin
│   │   │   ├── RasterBinCount    // [每帧] CS: 统计每个 Raster Bin 的三角形数
│   │   │   ├── ClearBuffer(Nanite.RangeAllocatorBuffer) // [每帧]
│   │   │   ├── RasterBinReserve  // [每帧] CS: Prefix Sum 分配偏移
│   │   │   ├── RasterBinScatter  // [每帧] CS: 将三角形 Scatter 到 Bin
│   │   │   ├── RasterBinFinalize // [每帧] CS: 最终化 Bin 参数
│   │   │   ├── SW Rasterize (Tessellated) // [每帧] CS: 软件光栅化 (细分后微片)
│   │   │   ├── HW Rasterize (Triangles)   // [每帧] DrawMesh/MS: 硬件光栅化 (大三角形)
│   │   │   ├── SW Rasterize (Triangles)   // [每帧] CS: 软件光栅化 (普通小三角形)
│   │   │   ├── ClearVisiblePatchesArgs    // [每帧]
│   │   │   ├── PatchSplit        // [每帧] CS: Patch 细分 (Tessellation)
│   │   │   ├── InitVisiblePatchesArgs // [每帧]
│   │   │   ├── (RasterBinInit/Count/Reserve/Scatter 再次执行，针对 Patches)
│   │   │   └── SW Rasterize (Patches)     // [每帧] CS: 软件光栅化 (细分后的 Patch)
│   │   ├── BuildPreviousOccluderHZB // [每帧] 从 MainPass 深度构建 HZB
│   │   └── PostPass              // [每帧] === Two-Pass Occlusion: 第二 Pass (遮挡补全) ===
│   │       ├── InstanceCulling   // [每帧] CS: 再次 Instance Culling
│   │       ├── NodeAndClusterCull// [每帧] CS: 再次 Cluster Culling (利用上一帧 HZB)
│   │       ├── (同样的 RasterBin -> SW/HW Rasterize 流程)
│   │       └── SW Rasterize (Patches)
│   └── NaniteFeedbackStatus      // [每帧] 反馈流送状态
├── Nanite::EmitDepth             // [每帧] 从 VisBuffer 解码深度
│   └── EmitDepthTargetsCS        // [每帧] CS: VisBuffer64 -> Depth.Target
├── Nanite::ShadeBinning          // [每帧] 像素按材质分类
│   ├── ShadingBinBuildCS_COUNT   // [每帧] CS: 统计每个 Bin 的像素数
│   ├── ShadingBinReserveCS       // [每帧] CS: 分配 Buffer 偏移
│   └── ShadingBinBuildCS_SCATTER // [每帧] CS: 像素坐标 Scatter 到 Buffer
├── NaniteBasePass                // [每帧] Compute Shading (即 Nanite::BasePass)
│   ├── ShadeGBufferCS_MaterialA  // [每帧] DispatchIndirect (Bin 0)
│   ├── ShadeGBufferCS_MaterialB  // [每帧] DispatchIndirect (Bin 1)
│   └── ... (每个可见 ShadingBin 一次 Indirect Dispatch)
└── Lighting
    └── ... (与传统管线完全一致)
```

**RDC 中可观察到的特征：**
- **极少 DrawCall**：仅 `HW Rasterize (Triangles)` 出现少量 `DrawMesh`/`DispatchMesh`，其余全是 `Dispatch`。
- **RasterBin 五部曲**：每个光栅化批次都遵循 `Init -> Count -> Reserve -> Scatter -> Finalize` 的固定节奏。
- **Two-Pass 结构清晰**：`MainPass`（渲染可见物并生成深度）与 `PostPass`（用新生成的深度测试上一帧被遮挡的集群）成对出现，中间夹着 `BuildPreviousOccluderHZB`。
- **无传统 IA/VS**：Nanite 没有 Vertex Shader，顶点数据由 Compute Shader 手动从 `ClusterPageData` 解码。
- **UAV 原子操作密集**：`ImageInterlockedMaxUInt64` 在 `SW Rasterize` 阶段高度集中。

### 11.3 如何在 RDC 中区分 Software / Hardware Rasterizer

在 `Nanite::VisBuffer` 事件组下，可以通过以下特征区分两条路径：

| 特征 | Software Rasterizer | Hardware Rasterizer |
|------|---------------------|---------------------|
| **RDC 事件类型** | `Dispatch` / `DispatchIndirect` | `DrawMesh` / `DispatchMesh` / `DrawIndexedInstanced` |
| **Shader 类型** | Compute Shader (`NaniteRasterizer.usf`) | Mesh Shader / Primitive Shader / Vertex Shader |
| **目标 Buffer** | `RWTexture2D<UlongType> OutVisBuffer64` | `SV_Target` / `SV_Depth` (如果启用 HW 路径) |
| **原子操作** | `ImageInterlockedMaxUInt64` | 无（硬件光栅化器内置深度测试） |
| **三角形大小** | 小三角形（< 32 像素边长） | 大三角形（>= 32 像素边长） |

**RDC 调试技巧：**
- 在 `NaniteRasterizer.usf` 的 `WritePixel` 处打 Pixel Shader 断点（实际为 CS 断点），可观察每个像素写入的 `PixelValue`（Packed ClusterID + TriangleID）。
- 在 `EmitDepthTargetsCS` 之后，深度纹理应与 Hardware Rasterizer 产生的深度一致。若出现 Z-fighting，通常是 SW/HW 边界处的 fill-rule 差异导致。

### 11.4 Shading Binning 在 RDC 中的三阶段

`Nanite::ShadeBinning` 在 RDC 中表现为三个连续的 Compute Pass，可通过 Buffer 读写依赖关系观察：

1. **COUNT Pass**：读取 `ShadingMask`（Raster 阶段输出的材质 ID 纹理），向 `OutShadingBinScatterCounters` 执行 `InterlockedAdd`。
   - RDC 中观察：大量 `RWStructuredBuffer` 的原子加。

2. **RESERVE Pass**：对 `OutShadingBinAllocator` 执行 Prefix Sum（Scan），为每个 Bin 计算全局 Buffer 偏移。
   - RDC 中观察：通常是单个 `Dispatch(1,1,1)` 或少量线程组。

3. **SCATTER Pass**：再次遍历 `ShadingMask`，根据 Bin ID 和 Prefix Sum 结果，将像素坐标写入 `OutShadingBinData`。
   - RDC 中观察：`OutShadingBinData` 的写入量与可见像素数成正比。

**验证技巧**：在 SCATTER Pass 之后，用 RDC 的 Buffer Viewer 查看 `ShadingBinData`，可以看到按 Bin 分组的像素坐标列表。若某个 Bin 的像素数为 0，则该材质在该视图中完全不可见，对应 Shading Dispatch 会被跳过。

### 11.5 传统与 Nanite 的合并点

虽然 Nanite 的几何管线完全独立，但它最终必须与传统管线的结果合并：

1. **深度合并**：`Nanite::EmitDepthTargets` 将 VisBuffer 解码为 `SceneTextures.Depth.Target`。此后，传统渲染的后续 Pass（如 Lighting、Translucency）可以直接读取这张深度图，无需关心深度来源是 Nanite 还是传统。

2. **GBuffer 合并**：Nanite 的 `DispatchBasePass` 与传统 BasePass 写入**同一张 GBuffer**（通过 UAV）。在 RDC 中，你会看到：
   - 传统 BasePass：绑定 RTV，PS 输出 `SV_TargetN`。
   - Nanite BasePass：不绑定 RTV，CS 通过 UAV 写入同一纹理。
   - 两者无显式同步，依赖 RDG 的 Pass 依赖图（DAG）保证执行顺序。

3. **Sky/Translucency 统一**：在 `BasePass` 之后，SkyAtmosphere、Translucency、PostProcess 等 Pass 对传统和 Nanite 几何一视同仁。

---

## 13. 总结

Nanite 并非简单地"用 Compute Shader 替换了 Pixel Shader"，而是在**整个几何管线**上进行了重构：

1. **数据层**：从标准 Vertex/Index Buffer 变为虚拟化的 Cluster Page + Hierarchy Buffer。
2. **裁剪层**：从 CPU Frustum/HZB Culling 变为 GPU-driven Two-Pass Occlusion + Cluster Culling。
3. **光栅化层**：从纯硬件光栅化变为 Software Rasterizer (Compute) + Hardware Rasterizer (Mesh Shader) 混合。
4. **着色层**：从 Pixel Shader (`SV_Position`->`SV_Target`) 变为 Compute Shader (`ShadeBinning`->`UAV`)。
5. **调度层**：从 `FMeshDrawCommand` (CPU 排序、状态切换) 变为 `DispatchIndirect` + `ShaderBundle` (GPU 驱动、批量执行)。

**最重要的设计原则**体现在 `ComputeShaderOutputCommon.ush` 中：Nanite 重用了传统管线的**材质评估代码**（`FPixelShaderInOut_MainPS`），但把其执行环境从 Pixel Shader 搬到了 Compute Shader。这意味着现有材质系统无需重写，却能享受 Compute-based deferred shading 带来的灵活性和性能优势。
