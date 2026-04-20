---
title: "UE 纹理流送池与 Shader 调试 CVar 速查"
date: 2026-04-20
tags: [UE, RenderDoc, Shader Debug]
---

## 纹理流送池

UE 根据流送池预算决定纹理加载哪些 mip level，超出预算时低优先级纹理只加载低分辨率 mip，控制台输出 `Texture streaming pool over X MB` 警告。

### 查询与调整

```cpp
// 运行时查询当前值
r.Streaming.PoolSize

// 运行时修改（单位 MiB）
r.Streaming.PoolSize 3000
```

### 永久设置

在 `DefaultEngine.ini` 中：

```ini
[/Script/Engine.RendererSettings]
r.Streaming.PoolSize=3000
```

### 诊断命令

| 命令 | 用途 |
|------|------|
| `stat streaming` | 查看池使用量、各纹理流送状态 |
| `ListStreamingTextures` | 列出所有流送纹理及占用 |
| `r.Streaming.MaxTempMemoryAllowed` | 临时内存上限，过小也会导致流送卡顿 |

### 常见原因与对策

| 原因 | 对策 |
|------|------|
| 纹理分辨率过高 / mip 过多 | 降低 TextureGroup 的 MaxLOD 或分辨率 |
| UDIM / 大量贴图同时可见 | 拆分 LOD、降低远处 mip |
| 预算本身设太小 | 合理提高 PoolSize（需匹配目标显存） |
| 纹理未设 Streaming | 确认 Texture → Never Stream 未勾选 |

---

## Shader 调试 CVar

在 RenderDoc 中查看 Compute Shader 源码，需在 `ConsoleVariables.ini` 的 `[Startup]` 段配置以下 CVar：

```ini
[Startup]
r.ShaderDevelopmentMode=1
r.Shaders.Optimize=0
r.Shaders.Symbols=1
r.DumpShaderDebugInfo=1
r.D3D12.ShaderModel=6
```

### 各 CVar 说明

| CVar | 作用 |
|------|------|
| `r.ShaderDevelopmentMode=1` | 总开关——禁用驱动优化注册、启用调试符号路径、显示 shader 编译警告/错误详情，让图形调试器能关联源码 |
| `r.Shaders.Optimize=0` | 编译 shader 时跳过优化，生成的 HLSL/字节码保持原始结构，方便在 RenderDoc 里单步调试 |
| `r.Shaders.Symbols=1` | 生成 .pdb 调试符号文件，RenderDoc 靠它把 GPU 字节码映射回源文件行号 |
| `r.DumpShaderDebugInfo=1` | 把编译中间产物（USF 源码、预处理结果、入口信息）dump 到 `Saved/ShaderDebugInfo/` |
| `r.D3D12.ShaderModel=6` | 指定 D3D12 使用 SM 6.0+，SM 6 才原生支持 DXIL 调试信息，SM 5 的 DXBC 调试信息有限 |

### 配置后必做

删 shader cache 重新编译，否则旧的无符号 shader 仍会被使用：

```
删除项目下 Intermediate/ShaderFormat* 和 DerivedDataCache
```

然后重启 UE，在 RenderDoc 里捕获即可看到 Compute Shader 源码。
