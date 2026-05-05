// =============================================================================
// worker-shared.js — 公共解码工具（主线程 & Worker 复用）
// =============================================================================
// 暴露 self.ImageCodecShared，所有 DDS/EXR 解析器共享这一份实现。
//
// 新增功能的正确姿势：
//   1. 这种底层工具（读取器、half-float、BC解码、DXGI表）→ 加在本文件
//   2. 加完后在末尾 S.xxx = xxx 暴露出去，主线程和 Worker 自动可用
//   3. DDS/EXR 解析逻辑 → 去 dds-parser.js / exr-parser.js
//   4. UI 交互 → 去 image-viewer.js
//   5. 不要往 extend_footer.html 里加 JS 代码
// =============================================================================
(function(){
  var S = {};

  // ---- Binary readers ----
  function r8(buf, off) { return buf[off]; }
  function r32(buf, off) { return (buf[off])|(buf[off+1]<<8)|(buf[off+2]<<16)|(buf[off+3]<<24); }
  function r32s(buf, off) { var v = r32(buf,off); return v > 0x7FFFFFFF ? v - 0x100000000 : v; }
  function r64(buf, off) { var lo = r32(buf,off), hi = r32(buf,off+4); return hi * 0x100000000 + lo; }
  function str4(buf, off) { return String.fromCharCode(r8(buf,off),r8(buf,off+1),r8(buf,off+2),r8(buf,off+3)); }

  // ---- Half-float (IEEE 754 float16 → float32) ----
  function halfToFloat(h) {
    var s = (h>>15)&1, e = (h>>10)&31, m = h&1023;
    if (e===0) return (s?-1:1)*Math.pow(2,-14)*(m/1024);
    if (e===31) return m===0 ? (s?-Infinity:Infinity) : NaN;
    return (s?-1:1)*Math.pow(2,e-15)*(1+m/1024);
  }

  // R11G11B10_FLOAT: 11-bit (6e5m) packed float
  function h2f_r11g11b10(v) {
    if (v===0) return 0;
    var e = (v>>6)&0x1F, m = v&0x3F;
    if (e===0) return m/64*Math.pow(2,-14);
    if (e===31) return m ? NaN : Infinity;
    return (1+m/64)*Math.pow(2,e-15);
  }

  // R10_FLOAT: 10-bit (5e5m) packed float
  function h2f_r10(v) {
    if (v===0) return 0;
    var e = (v>>5)&0x1F, m = v&0x1F;
    if (e===0) return m/32*Math.pow(2,-14);
    if (e===31) return m ? NaN : Infinity;
    return (1+m/32)*Math.pow(2,e-15);
  }

  // ---- RGB565 decode ----
  function c565(c) {
    return [((c>>11)&31)*255/31|0, ((c>>5)&63)*255/63|0, (c&31)*255/31|0];
  }

  // =============================================================================
  // DXGI_FORMAT 完整表 — 唯一真理，不要随便改
  // =============================================================================
  // 数据来源：Microsoft Docs — DXGI_FORMAT enumeration (dxgiformat.h)
  // https://learn.microsoft.com/en-us/windows/win32/api/dxgiformat/ne-dxgiformat-dxgi_format
  // 每一个序号、每一个名字都来自官方头文件。
  // 注释仅用于标注解码状态，不要改序号和名字。
  // =============================================================================
  var DXGI_MAP = {
    // 0: UNKNOWN
    1:'R32G32B32A32_TYPELESS', 2:'R32G32B32A32_FLOAT', 3:'R32G32B32A32_UINT', 4:'R32G32B32A32_SINT',
    5:'R32G32B32_TYPELESS', 6:'R32G32B32_FLOAT', 7:'R32G32B32_UINT', 8:'R32G32B32_SINT',
    9:'R16G16B16A16_TYPELESS', 10:'R16G16B16A16_FLOAT', 11:'R16G16B16A16_UNORM', 12:'R16G16B16A16_UINT',
    13:'R16G16B16A16_SNORM', 14:'R16G16B16A16_SINT',
    15:'R32G32_TYPELESS', 16:'R32G32_FLOAT', 17:'R32G32_UINT', 18:'R32G32_SINT',
    19:'R32G8X24_TYPELESS', 20:'D32_FLOAT_S8X24_UINT', 21:'R32_FLOAT_X8X24_TYPELESS', 22:'X32_TYPELESS_G8X24_UINT',
    23:'R10G10B10A2_TYPELESS', 24:'R10G10B10A2_UNORM', 25:'R10G10B10A2_UINT',
    26:'R11G11B10_FLOAT',
    27:'R8G8B8A8_TYPELESS', 28:'R8G8B8A8_UNORM', 29:'R8G8B8A8_UNORM_SRGB', 30:'R8G8B8A8_UINT',
    31:'R8G8B8A8_SNORM', 32:'R8G8B8A8_SINT',
    33:'R16G16_TYPELESS', 34:'R16G16_FLOAT', 35:'R16G16_UNORM', 36:'R16G16_UINT',
    37:'R16G16_SNORM', 38:'R16G16_SINT',
    39:'R32_TYPELESS', 40:'D32_FLOAT', 41:'R32_FLOAT', 42:'R32_UINT', 43:'R32_SINT',
    44:'R24G8_TYPELESS', 45:'D24_UNORM_S8_UINT', 46:'R24_UNORM_X8_TYPELESS', 47:'X24_TYPELESS_G8_UINT',
    48:'R8G8_TYPELESS', 49:'R8G8_UNORM', 50:'R8G8_UINT', 51:'R8G8_SNORM', 52:'R8G8_SINT',
    53:'R16_TYPELESS', 54:'R16_FLOAT', 55:'D16_UNORM', 56:'R16_UNORM', 57:'R16_UINT',
    58:'R16_SNORM', 59:'R16_SINT',
    60:'R8_TYPELESS', 61:'R8_UNORM', 62:'R8_UINT', 63:'R8_SNORM', 64:'R8_SINT',
    65:'A8_UNORM', 66:'R1_UNORM',
    67:'R9G9B9E5_SHAREDEXP', 68:'R8G8_B8G8_UNORM', 69:'G8R8_G8B8_UNORM',
    70:'BC1_TYPELESS', 71:'BC1_UNORM', 72:'BC1_UNORM_SRGB',
    73:'BC2_TYPELESS', 74:'BC2_UNORM', 75:'BC2_UNORM_SRGB',
    76:'BC3_TYPELESS', 77:'BC3_UNORM', 78:'BC3_UNORM_SRGB',
    79:'BC4_TYPELESS', 80:'BC4_UNORM', 81:'BC4_SNORM',
    82:'BC5_TYPELESS', 83:'BC5_UNORM', 84:'BC5_SNORM',
    85:'B5G6R5_UNORM', 86:'B5G5R5A1_UNORM',
    87:'B8G8R8A8_UNORM', 88:'B8G8R8X8_UNORM',
    89:'R10G10B10_XR_BIAS_A2_UNORM',
    90:'B8G8R8A8_TYPELESS', 91:'B8G8R8A8_UNORM_SRGB', 92:'B8G8R8X8_TYPELESS', 93:'B8G8R8X8_UNORM_SRGB',
    94:'BC6H_TYPELESS', 95:'BC6H_UF16', 96:'BC6H_SF16',
    97:'BC7_TYPELESS', 98:'BC7_UNORM', 99:'BC7_UNORM_SRGB'
    // 100-115: video formats (AYUV, NV12, YUY2, etc.) — 不在 DDS 中出现
  };
  // =============================================================================
  // DXGI_BPP — bits per pixel（未压缩格式，用于 DDS mip 大小计算）
  // 数据来源同上。TYPELESS 的 bpp 与同名 typed 格式一致。
  // 压缩格式不在此表，mip 大小走 block-compressed 公式。
  // =============================================================================
  var DXGI_BPP = {
    1:128, 2:128, 3:128, 4:128,
    5:96,  6:96,  7:96,  8:96,
    9:64,  10:64, 11:64, 12:64, 13:64, 14:64,
    15:64, 16:64, 17:64, 18:64,
    19:64, 20:64, 21:64, 22:64,
    23:32, 24:32, 25:32,
    26:32,
    27:32, 28:32, 29:32, 30:32, 31:32, 32:32,
    33:32, 34:32, 35:32, 36:32, 37:32, 38:32,
    39:32, 40:32, 41:32, 42:32, 43:32,
    44:32, 45:32, 46:32, 47:32,
    48:16, 49:16, 50:16, 51:16, 52:16,
    53:16, 54:16, 55:16, 56:16, 57:16, 58:16, 59:16,
    60:8,  61:8,  62:8,  63:8,  64:8,
    65:8, 66:1, 67:32, 68:16, 69:16,
    85:16, 86:16,
    87:32, 88:32, 89:32,
    90:32, 91:32, 92:32, 93:32
  };

  // ---- Format family classifier ----
  function fmtFamily(type) {
    if (!type) return '';
    if (type.startsWith('BC1')) return 'BC1';
    if (type.startsWith('BC2')||type.startsWith('BC3')) return 'BC3';
    if (type.startsWith('BC4')) return 'BC4';
    if (type.startsWith('BC5')) return 'BC5';
    if (type.startsWith('BC6H')) return 'BC6H';
    if (type.startsWith('BC7')) return 'BC7';
    if (type.startsWith('R8G8B8A8')) return 'RGBA8';
    if (type.startsWith('B8G8R8')) return 'BGRA8';
    if (type.startsWith('R10G10B10A2')) return 'R10G10B10A2';
    if (type.startsWith('R11G11B10')) return 'R11G11B10';
    if (type.startsWith('R16G16B16A16')&&type.indexOf('FLOAT')>=0) return 'RGBA64F';
    if (type.startsWith('R16G16B16A16')) return 'RGBA16';
    if (type.startsWith('R16G16')&&type.indexOf('FLOAT')>=0) return 'R16G16F';
    if (type.startsWith('R16G16')) return 'R16G16';
    if (type.startsWith('R8G8')) return type.indexOf('SNORM')>=0 ? 'R8G8S' : 'R8G8';
    if (type.startsWith('B8G8R8')) return 'BGRA8';
    if (type.startsWith('R16_FLOAT')) return 'R16F';
    if ((type.startsWith('R16_')||type.startsWith('D16_'))&&type.indexOf('FLOAT')<0) return 'R16';
    if (type.startsWith('R8_')||type==='A8_UNORM') return type.indexOf('SNORM')>=0 ? 'R8S' : 'R8';
    if (type.startsWith('R32_FLOAT')||type==='D32_FLOAT') return 'R32F';
    if (type.startsWith('D32_FLOAT_S8')) return 'D32S8';
    if (type.startsWith('R9G9B9E5')) return 'RGB9E5';
    if (type.startsWith('R32G32B32A32')) return 'RGBA128F';
    if (type.startsWith('R32G32B32')) return 'RGB96F';
    return type;
  }

  // ---- DDS format detector (from FourCC / pixel-format masks) ----
  function detectFmt(view) {
    var fourCC = str4(view,84);
    if (fourCC === 'DX10') {
      var dxgi = r32(view,128);
      var t = DXGI_MAP[dxgi]||('DXGI_'+dxgi);
      var fam = fmtFamily(t);
      return { fourCC:fourCC, dxgi:dxgi, type:t, family:fam, isComp: fam.startsWith('BC'), bpp:DXGI_BPP[dxgi]||0 };
    }
    if (fourCC === 'DXT1') { var lt='BC1_UNORM'; return { fourCC:fourCC, dxgi:71, type:lt, family:fmtFamily(lt), isComp:true, bpp:8 }; }
    if (fourCC === 'DXT3') { var lt='BC2_UNORM'; return { fourCC:fourCC, dxgi:74, type:lt, family:fmtFamily(lt), isComp:true, bpp:16 }; }
    if (fourCC === 'DXT5') { var lt='BC3_UNORM'; return { fourCC:fourCC, dxgi:77, type:lt, family:fmtFamily(lt), isComp:true, bpp:16 }; }
    if (fourCC === 'ATI1')  { var lt='BC4_UNORM'; return { fourCC:fourCC, dxgi:80, type:lt, family:fmtFamily(lt), isComp:true, bpp:8 }; }
    if (fourCC === 'ATI2')  { var lt='BC5_UNORM'; return { fourCC:fourCC, dxgi:83, type:lt, family:fmtFamily(lt), isComp:true, bpp:16 }; }
    var bc = r32(view,88), rmask = r32(view,92), gmask = r32(view,96), bmask = r32(view,100), amask = r32(view,104);
    if (bc===32 && rmask===0xFF && gmask===0xFF00 && bmask===0xFF0000 && amask===0xFF000000)
      return { fourCC:fourCC, dxgi:28, type:'R8G8B8A8_UNORM', family:'RGBA8', isComp:false, bpp:32 };
    if (bc===32 && rmask===0x3FF && gmask===0xFFC00 && bmask===0x3FF00000)
      return { fourCC:fourCC, dxgi:24, type:'R10G10B10A2_UNORM', family:'R10G10B10A2', isComp:false, bpp:32 };
    if (bc===32 && (rmask===0xFFFF||rmask===0x0000FFFF) && (gmask===0xFFFF0000||gmask===0xFFFF0000))
      return { fourCC:fourCC, dxgi:35, type:'R16G16_UNORM', family:'R16G16', isComp:false, bpp:32 };
    if (bc===16 && rmask===0xFF && gmask===0xFF00)
      return { fourCC:fourCC, dxgi:49, type:'R8G8_UNORM', family:'R8G8', isComp:false, bpp:16 };
    if (bc===8 && rmask===0xFF)
      return { fourCC:fourCC, dxgi:61, type:'R8_UNORM', family:'R8', isComp:false, bpp:8 };
    if (bc===32 && amask===0xFF && rmask===0xFF00 && gmask===0xFF0000 && bmask===0xFF000000)
      return { fourCC:fourCC, dxgi:87, type:'B8G8R8A8_UNORM', family:'BGRA8', isComp:false, bpp:32, swizzle:'argb' };
    if (bc===32 && bmask===0xFF && gmask===0xFF00 && rmask===0xFF0000 && amask===0xFF000000)
      return { fourCC:fourCC, dxgi:87, type:'B8G8R8A8_UNORM', family:'BGRA8', isComp:false, bpp:32, swizzle:'bgra' };
    if (bc===32 && amask===0xFF && bmask===0xFF00 && gmask===0xFF0000 && rmask===0xFF000000)
      return { fourCC:fourCC, dxgi:87, type:'B8G8R8A8_UNORM', family:'BGRA8', isComp:false, bpp:32, swizzle:'abgr' };
    if (bc===32) return { fourCC:fourCC, dxgi:28, type:'R8G8B8A8_UNORM', family:'RGBA8', isComp:false, bpp:32 };
    return { fourCC:fourCC, dxgi:28, type:'R8G8B8A8_UNORM', family:'RGBA8', isComp:false, bpp:32 };
  }

  // ---- BC1 block decode (4×4 → RGBA8) ----
  function bc1Block(src, off, dst) {
    var c0 = src[off]|(src[off+1]<<8), c1 = src[off+2]|(src[off+3]<<8);
    var col = [c565(c0), c565(c1)];
    var bits = (src[off+4])|(src[off+5]<<8)|(src[off+6]<<16)|(src[off+7]<<24);
    for (var y=0;y<4;y++) for(var x=0;x<4;x++) {
      var idx=(bits>>(2*(y*4+x)))&3, p=(y*4+x)*4;
      if (c0>c1) {
        if (idx<2) { dst[p]=col[idx][0];dst[p+1]=col[idx][1];dst[p+2]=col[idx][2];dst[p+3]=255; }
        else if (idx<3) { dst[p]=(2*col[0][0]+col[1][0])/3|0;dst[p+1]=(2*col[0][1]+col[1][1])/3|0;dst[p+2]=(2*col[0][2]+col[1][2])/3|0;dst[p+3]=255; }
        else { dst[p]=(col[0][0]+2*col[1][0])/3|0;dst[p+1]=(col[0][1]+2*col[1][1])/3|0;dst[p+2]=(col[0][2]+2*col[1][2])/3|0;dst[p+3]=255; }
      } else {
        if (idx<2) { dst[p]=col[idx][0];dst[p+1]=col[idx][1];dst[p+2]=col[idx][2];dst[p+3]=255; }
        else if (idx<3) { dst[p]=(col[0][0]+col[1][0])/2|0;dst[p+1]=(col[0][1]+col[1][1])/2|0;dst[p+2]=(col[0][2]+col[1][2])/2|0;dst[p+3]=255; }
        else { dst[p]=0;dst[p+1]=0;dst[p+2]=0;dst[p+3]=0; }
      }
    }
  }

  // ---- BC4 block decode (4×4 → grayscale RGBA8) ----
  function bc4Block(src, off, dst) {
    var r0=src[off], r1=src[off+1];
    var bits=0; for(var k=0;k<6;k++) bits|=src[off+2+k]<<(k*8);
    for(var y=0;y<4;y++) for(var x=0;x<4;x++) {
      var idx=(bits>>(3*(y*4+x)))&7, p=(y*4+x)*4, v;
      if (idx===0) v=r0; else if (idx===1) v=r1;
      else if (r0>r1) v=((8-idx)*r0+(idx-1)*r1)/7|0;
      else if (idx<6) v=((6-idx)*r0+(idx-1)*r1)/5|0;
      else v=idx===6?0:255;
      dst[p]=v;dst[p+1]=v;dst[p+2]=v;dst[p+3]=255;
    }
  }

  // BC4 single-channel variant: writes to dst[p+ch]
  function bc4Chan(src, off, dst, ch) {
    var r0=src[off], r1=src[off+1];
    var bits=0; for(var k=0;k<6;k++) bits|=src[off+2+k]<<(k*8);
    for(var y=0;y<4;y++) for(var x=0;x<4;x++) {
      var idx=(bits>>(3*(y*4+x)))&7, p=(y*4+x)*4;
      if (idx===0) dst[p+ch]=r0; else if (idx===1) dst[p+ch]=r1;
      else if(r0>r1) dst[p+ch]=((8-idx)*r0+(idx-1)*r1)/7|0;
      else if(idx<6) dst[p+ch]=((6-idx)*r0+(idx-1)*r1)/5|0;
      else dst[p+ch]=idx===6?0:255;
    }
  }

  // ---- BC5 block decode (two BC4 blocks: R + G) ----
  function bc5Block(src, off, dst) { bc4Chan(src, off, dst, 0); bc4Chan(src, off+8, dst, 1); }

  // ---- Dispatch BC1-BC5 software decode ----
  function decodeBC(data, w, h, fmt) {
    var out = new Uint8ClampedArray(w*h*4);
    var nbw = Math.max(1,(w+3)/4|0), nbh = Math.max(1,(h+3)/4|0);
    var fc = fmt.fourCC, dx = fmt.dxgi;
    for (var by=0;by<nbh;by++) for(var bx=0;bx<nbw;bx++) {
      var bo = (by*nbw+bx)*(fc==='DXT1'||dx===70||dx===71?8:16);
      var block = new Uint8Array(64);
      if (fc==='DXT1'||dx===70||dx===71) bc1Block(data, bo, block);
      else if (fc==='DXT5'||dx===77||dx===78) { bc4Block(data, bo, block); bc1Block(data, bo+8, block); }
      else if (fc==='DXT3'||dx===74||dx===75) { for(var i=0;i<16;i++) block[i*4+3]=((data[bo+(i>>1)]>>((i&1)*4))&15)*17; bc1Block(data, bo+8, block); }
      else if (fc==='ATI1'||dx===80||dx===81) bc4Block(data, bo, block);
      else if (fc==='ATI2'||dx===83||dx===84) bc5Block(data, bo, block);
      if (!(fc==='DXT3'||fc==='DXT5'||dx===74||dx===75||dx===77||dx===78)) { for(var i=3;i<64;i+=4) block[i]=255; }
      for (var py=0;py<4;py++) for(var px=0;px<4;px++) {
        var gx=bx*4+px, gy=by*4+py;
        if(gx>=w||gy>=h) continue;
        var doff=(gy*w+gx)*4, soff=(py*4+px)*4;
        out[doff]=block[soff];out[doff+1]=block[soff+1];out[doff+2]=block[soff+2];out[doff+3]=block[soff+3];
      }
    }
    return out;
  }

  // ---- Assemble shared object ----
  S.r8 = r8;
  S.r32 = r32;
  S.r32s = r32s;
  S.r64 = r64;
  S.str4 = str4;
  S.halfToFloat = halfToFloat;
  S.h2f_r11g11b10 = h2f_r11g11b10;
  S.h2f_r10 = h2f_r10;
  S.c565 = c565;
  S.DXGI_MAP = DXGI_MAP;
  S.DXGI_BPP = DXGI_BPP;
  S.fmtFamily = fmtFamily;
  S.detectFmt = detectFmt;
  S.bc1Block = bc1Block;
  S.bc4Block = bc4Block;
  S.bc4Chan = bc4Chan;
  S.bc5Block = bc5Block;
  S.decodeBC = decodeBC;

  self.ImageCodecShared = S;
})();
