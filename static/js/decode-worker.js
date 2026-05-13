// =============================================================================
// decode-worker.js — Web Worker（离主线程解码 DDS/EXR）
// =============================================================================
// 由 image-viewer.js 以 new Worker(url) 启动，URL 从 image-viewer 自身路径推导。
// 通过 importScripts() 加载 worker-shared.js + exr-parser.js。
//
// 本文件负责：
//   - DDS：worker-safe 格式（未压缩 + BC1-5），BC6H/BC7 返回失败由主线程兜底
//   - EXR：全部流程（parse + toRGBA8），复用 exr-parser.js
//
// 新增功能的正确姿势：
//   1. 新 DDS 格式 → 在 decodeDDS() 加分支，格式检测在 worker-shared.js
//   2. 新 BCx 压缩 → 先在 worker-shared.js 加 decodeBC，这里自动可用
//   3. 新图片格式（如 KTX/HDR）→ 在 onmessage 加 type 分支，解析逻辑放独立文件
//   4. 不要往 extend_footer.html 里加 JS 代码
// =============================================================================
(function(){
  var base = self.location.href.replace(/[^/]+$/, '');
  importScripts(base + 'worker-shared.js?v=11', base + 'exr-parser.js');

  var S = self.ImageCodecShared;
  if (!S) throw new Error('ImageCodecShared not available in worker');

  // ---- Worker-safe DDS: header parse + mip 0 decode (no WebGL, no BC6H/BC7) ----
  function parseDDS(buf) {
    var view = new Uint8Array(buf);
    if (S.str4(view,0) !== 'DDS ') return null;
    var w = S.r32(view,16), h = S.r32(view,12);
    var fmt = S.detectFmt(view);
    var dataOff = fmt.fourCC === 'DX10' ? 148 : 128;

    var mip0_size;
    if (fmt.isComp) {
      var bs = (fmt.family==='BC1'||fmt.family==='BC4') ? 8 : 16;
      mip0_size = Math.max(1,(w+3)/4|0) * Math.max(1,(h+3)/4|0) * bs;
    } else {
      mip0_size = w * h * (fmt.bpp / 8);
    }
    // Some DDS exporters write DX10 fourCC but omit the 20-byte DX10 extension
    if (dataOff + mip0_size > buf.byteLength) dataOff = 128;
    mip0_size = Math.min(mip0_size, buf.byteLength - dataOff);
    if (mip0_size <= 0) return null;
    var mip0_data = new Uint8Array(buf, dataOff, mip0_size);
    return { w:w, h:h, fmt:fmt, data:mip0_data };
  }

  function decodeDDS(dds, step) {
    var w = dds.w, h = dds.h, data = dds.data, fam = dds.fmt.family;
    step = step || 1;
    var outW = step > 1 ? Math.ceil(w / step) : w;
    var outH = step > 1 ? Math.ceil(h / step) : h;
    var px = new Uint8ClampedArray(outW * outH * 4);

    if (step === 1) {
    if (fam==='RGBG') {
      for (var j=0;j<w*h;j+=2) {
        var si=j*2, r0=data[si], g0=data[si+1], b1=data[si+2], g1=data[si+3];
        px[j*4]=r0; px[j*4+1]=g0; px[j*4+2]=b1; px[j*4+3]=255;
        if (j+1<w*h) { px[(j+1)*4]=r0; px[(j+1)*4+1]=g1; px[(j+1)*4+2]=b1; px[(j+1)*4+3]=255; }
      } return px;
    }
    if (fam==='GRGB') {
      for (var j=0;j<w*h;j+=2) {
        var si=j*2, g0=data[si], r0=data[si+1], g1=data[si+2], b1=data[si+3];
        px[j*4]=r0; px[j*4+1]=g0; px[j*4+2]=b1; px[j*4+3]=255;
        if (j+1<w*h) { px[(j+1)*4]=r0; px[(j+1)*4+1]=g1; px[(j+1)*4+2]=b1; px[(j+1)*4+3]=255; }
      } return px;
    }
    if (fam==='RGBA8') { for (var j=0;j<px.length;j++) px[j]=data[j]; return px; }
    if (fam==='BGRA8') {
      var sw = dds.fmt.swizzle || 'bgra';
      for (var j=0;j<px.length;j+=4) {
        if (sw==='argb') { px[j]=data[j+1]; px[j+1]=data[j+2]; px[j+2]=data[j+3]; px[j+3]=data[j]; }
        else if (sw==='abgr') { px[j]=data[j+3]; px[j+1]=data[j+2]; px[j+2]=data[j+1]; px[j+3]=data[j]; }
        else { px[j]=data[j+2]; px[j+1]=data[j+1]; px[j+2]=data[j]; px[j+3]=data[j+3]; }
      }
      return px;
    }
    if (fam==='R10G10B10A2') {
      var s32 = new Uint32Array(data.buffer, data.byteOffset, w*h);
      for (var j=0;j<w*h;j++) { var p=s32[j]; px[j*4]=(p&0x3FF)*255/1023|0; px[j*4+1]=((p>>>10)&0x3FF)*255/1023|0; px[j*4+2]=((p>>>20)&0x3FF)*255/1023|0; px[j*4+3]=(p>>>30)*255/3|0; }
      return px;
    }
    if (fam==='R11G11B10') {
      var s32b = new Uint32Array(data.buffer, data.byteOffset, w*h);
      for (var j=0;j<w*h;j++) {
        var p = s32b[j];
        var r = S.h2f_r11g11b10(p & 0x7FF);
        var g = S.h2f_r11g11b10((p >>> 11) & 0x7FF);
        var b = S.h2f_r10((p >>> 22) & 0x3FF);
        px[j*4]=Math.min(255,Math.max(0,r*255|0));
        px[j*4+1]=Math.min(255,Math.max(0,g*255|0));
        px[j*4+2]=Math.min(255,Math.max(0,b*255|0));
        px[j*4+3]=255;
      }
      return px;
    }
    if (fam==='R8G8') { for (var j=0;j<w*h;j++) { px[j*4]=data[j*2]; px[j*4+1]=data[j*2+1]; px[j*4+2]=0; px[j*4+3]=255; } return px; }
    if (fam==='R8G8S') {
      var fminR=1e9, fmaxR=-1e9, fminG=1e9, fmaxG=-1e9, n=w*h;
      for (var j=0;j<n;j++) {
        var sr = data[j*2] > 127 ? (data[j*2] - 256) / 127.0 : data[j*2] / 127.0;
        var sg = data[j*2+1] > 127 ? (data[j*2+1] - 256) / 127.0 : data[j*2+1] / 127.0;
        if (sr<fminR) fminR=sr; if (sr>fmaxR) fmaxR=sr;
        if (sg<fminG) fminG=sg; if (sg>fmaxG) fmaxG=sg;
      }
      var frR = fmaxR>fminR ? 255/(fmaxR-fminR) : 1;
      var frG = fmaxG>fminG ? 255/(fmaxG-fminG) : 1;
      for (var j=0;j<n;j++) {
        var sr = data[j*2] > 127 ? (data[j*2] - 256) / 127.0 : data[j*2] / 127.0;
        var sg = data[j*2+1] > 127 ? (data[j*2+1] - 256) / 127.0 : data[j*2+1] / 127.0;
        px[j*4]=(sr-fminR)*frR|0; px[j*4+1]=(sg-fminG)*frG|0; px[j*4+2]=0; px[j*4+3]=255;
      }
      return px;
    }
    if (fam==='R8') { for (var j=0;j<w*h;j++) { var v=data[j]; px[j*4]=v; px[j*4+1]=v; px[j*4+2]=v; px[j*4+3]=255; } return px; }
    if (fam==='R8S') {
      var fmin=1e9, fmax=-1e9, n=w*h;
      for (var j=0;j<n;j++) {
        var sv = data[j] > 127 ? (data[j] - 256) / 127.0 : data[j] / 127.0;
        if (sv<fmin) fmin=sv; if (sv>fmax) fmax=sv;
      }
      var fr = fmax>fmin ? 255/(fmax-fmin) : 1;
      for (var j=0;j<n;j++) {
        var sv = data[j] > 127 ? (data[j] - 256) / 127.0 : data[j] / 127.0;
        var vv = (sv-fmin)*fr|0;
        px[j*4]=vv; px[j*4+1]=vv; px[j*4+2]=vv; px[j*4+3]=255;
      }
      return px;
    }
    if (fam==='R16G16') {
      var s16 = new Uint16Array(data.buffer, data.byteOffset, w*h*2);
      for (var j=0;j<w*h;j++) { px[j*4]=s16[j*2]*255/65535|0; px[j*4+1]=s16[j*2+1]*255/65535|0; px[j*4+2]=0; px[j*4+3]=255; }
      return px;
    }
    if (fam==='R16G16F') {
      var s16f = new Uint16Array(data.buffer, data.byteOffset, w*h*2);
      var fminR=1e9, fmaxR=-1e9, fminG=1e9, fmaxG=-1e9;
      for (var j=0;j<w*h;j++) {
        var fr = S.halfToFloat(s16f[j*2]), fg = S.halfToFloat(s16f[j*2+1]);
        if (isFinite(fr)) { if (fr<fminR)fminR=fr; if (fr>fmaxR)fmaxR=fr; }
        if (isFinite(fg)) { if (fg<fminG)fminG=fg; if (fg>fmaxG)fmaxG=fg; }
      }
      var frR = fmaxR>fminR ? 255/(fmaxR-fminR) : 1;
      var frG = fmaxG>fminG ? 255/(fmaxG-fminG) : 1;
      for (var j=0;j<w*h;j++) {
        px[j*4]   = (S.halfToFloat(s16f[j*2])-fminR)*frR|0;
        px[j*4+1] = (S.halfToFloat(s16f[j*2+1])-fminG)*frG|0;
        px[j*4+2] = 0; px[j*4+3] = 255;
      }
      return px;
    }
    if (fam==='R16') {
      var su = new Uint16Array(data.buffer, data.byteOffset, w*h);
      var mn=65535, mx=0;
      for (var j=0;j<su.length;j++) { if(su[j]<mn)mn=su[j]; if(su[j]>mx)mx=su[j]; }
      var rng = mx>mn ? 255/(mx-mn) : 1;
      for (var j=0;j<w*h;j++) { var vv=(su[j]-mn)*rng|0; px[j*4]=vv; px[j*4+1]=vv; px[j*4+2]=vv; px[j*4+3]=255; }
      return px;
    }
    if (fam==='R16F') {
      var su = new Uint16Array(data.buffer, data.byteOffset, w*h);
      var fmn=1e9, fmx=-1e9;
      for (var j=0;j<su.length;j++) { var f=S.halfToFloat(su[j]); if(isFinite(f)) { if(f<fmn)fmn=f; if(f>fmx)fmx=f; } }
      var fr = fmx>fmn ? 255/(fmx-fmn) : 1;
      for (var j=0;j<w*h;j++) { var vv=(S.halfToFloat(su[j])-fmn)*fr|0; px[j*4]=vv; px[j*4+1]=vv; px[j*4+2]=vv; px[j*4+3]=255; }
      return px;
    }
    if (fam==='D32S8') {
      var allF = new Float32Array(data.buffer, data.byteOffset, w*h*2);
      var dmn=1e9, dmx=-1e9, n=w*h;
      for (var j=0;j<n;j++) { var dv=allF[j*2]; if(isFinite(dv)) { if(dv<dmn)dmn=dv; if(dv>dmx)dmx=dv; } }
      var dr = dmx>dmn ? 255/(dmx-dmn) : 1;
      for (var j=0;j<n;j++) { var dv=isFinite(allF[j*2]) ? (allF[j*2]-dmn)*dr|0 : 0; px[j*4]=dv; px[j*4+1]=dv; px[j*4+2]=dv; px[j*4+3]=255; }
      return px;
    }
    if (fam==='R32F') {
      var f32w = new Float32Array(data.buffer, data.byteOffset, w*h);
      var mn32=1e9, mx32=-1e9;
      for (var j=0;j<f32w.length;j++) { var v=f32w[j]; if(isFinite(v)) { if(v<mn32)mn32=v; if(v>mx32)mx32=v; } }
      var rng32 = mx32>mn32 ? 255/(mx32-mn32) : 1;
      for (var j=0;j<f32w.length;j++) { var v=isFinite(f32w[j]) ? (f32w[j]-mn32)*rng32|0 : 0; px[j*4]=v; px[j*4+1]=v; px[j*4+2]=v; px[j*4+3]=255; }
      return px;
    }
    if (fam==='RGBA16') {
      var u16w = new Uint16Array(data.buffer, data.byteOffset, w*h*4);
      for (var j=0;j<w*h;j++) { px[j*4]=u16w[j*4]*255/65535|0; px[j*4+1]=u16w[j*4+1]*255/65535|0; px[j*4+2]=u16w[j*4+2]*255/65535|0; px[j*4+3]=u16w[j*4+3]*255/65535|0; }
      return px;
    }
    if (fam==='RGBA64F') {
      var u16hw = new Uint16Array(data.buffer, data.byteOffset, w*h*4);
      var fmnw=1e9, fmxw=-1e9;
      for (var j=0;j<u16hw.length;j++) { var f=S.halfToFloat(u16hw[j]); if(isFinite(f)) { if(f<fmnw)fmnw=f; if(f>fmxw)fmxw=f; } }
      var frw = fmxw>fmnw ? 255/(fmxw-fmnw) : 1;
      for (var j=0;j<w*h;j++) { px[j*4]=(S.halfToFloat(u16hw[j*4])-fmnw)*frw|0; px[j*4+1]=(S.halfToFloat(u16hw[j*4+1])-fmnw)*frw|0; px[j*4+2]=(S.halfToFloat(u16hw[j*4+2])-fmnw)*frw|0; px[j*4+3]=255; }
      return px;
    }

    // BC1-5 software decode (worker-safe)
    if (fam==='BC1'||fam==='BC3'||fam==='BC4'||fam==='BC5') {
      return S.decodeBC(data, w, h, dds.fmt);
    }

    // BC6H/BC7: no WebGL in worker → return null
    if (fam==='BC6H'||fam==='BC7') return null;

    // Fallback: raw copy for unrecognized uncompressed formats (e.g. R32_UINT)
    for (var j=0;j<Math.min(px.length,data.length);j++) px[j]=data[j];
    return px;
    } // end if (step === 1)

    // === step > 1: subsampled decode ===

    if (fam==='RGBA8') {
      for (var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=(oy*step*w+ox*step)*4,di=(oy*outW+ox)*4;
        px[di]=data[si];px[di+1]=data[si+1];px[di+2]=data[si+2];px[di+3]=data[si+3];
      } return px;
    }
    if (fam==='BGRA8') {
      var sw=dds.fmt.swizzle||'bgra';
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=(oy*step*w+ox*step)*4,di=(oy*outW+ox)*4;
        if(sw==='argb'){px[di]=data[si+1];px[di+1]=data[si+2];px[di+2]=data[si+3];px[di+3]=data[si];}
        else if(sw==='abgr'){px[di]=data[si+3];px[di+1]=data[si+2];px[di+2]=data[si+1];px[di+3]=data[si];}
        else{px[di]=data[si+2];px[di+1]=data[si+1];px[di+2]=data[si];px[di+3]=data[si+3];}
      } return px;
    }
    if (fam==='R10G10B10A2') {
      var s32=new Uint32Array(data.buffer,data.byteOffset,w*h);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,p=s32[si];
        px[di]=(p&0x3FF)*255/1023|0;px[di+1]=((p>>>10)&0x3FF)*255/1023|0;
        px[di+2]=((p>>>20)&0x3FF)*255/1023|0;px[di+3]=(p>>>30)*255/3|0;
      } return px;
    }
    if (fam==='R11G11B10') {
      var s32b=new Uint32Array(data.buffer,data.byteOffset,w*h);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,p=s32b[si];
        var r=S.h2f_r11g11b10(p&0x7FF),g=S.h2f_r11g11b10((p>>>11)&0x7FF),b=S.h2f_r10((p>>>22)&0x3FF);
        px[di]=Math.min(255,Math.max(0,r*255|0));px[di+1]=Math.min(255,Math.max(0,g*255|0));
        px[di+2]=Math.min(255,Math.max(0,b*255|0));px[di+3]=255;
      } return px;
    }
    if (fam==='R8G8') {
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4;
        px[di]=data[si*2];px[di+1]=data[si*2+1];px[di+2]=0;px[di+3]=255;
      } return px;
    }
    if (fam==='R8G8S') {
      var n=w*h,fminR=1e9,fmaxR=-1e9,fminG=1e9,fmaxG=-1e9;
      for(var j=0;j<n;j++){var sr=data[j*2]>127?(data[j*2]-256)/127.0:data[j*2]/127.0,sg=data[j*2+1]>127?(data[j*2+1]-256)/127.0:data[j*2+1]/127.0;if(sr<fminR)fminR=sr;if(sr>fmaxR)fmaxR=sr;if(sg<fminG)fminG=sg;if(sg>fmaxG)fmaxG=sg;}
      var frR=fmaxR>fminR?255/(fmaxR-fminR):1,frG=fmaxG>fminG?255/(fmaxG-fminG):1;
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4;
        var sr=data[si*2]>127?(data[si*2]-256)/127.0:data[si*2]/127.0,sg=data[si*2+1]>127?(data[si*2+1]-256)/127.0:data[si*2+1]/127.0;
        px[di]=(sr-fminR)*frR|0;px[di+1]=(sg-fminG)*frG|0;px[di+2]=0;px[di+3]=255;
      } return px;
    }
    if (fam==='R8') {
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,v=data[si];
        px[di]=v;px[di+1]=v;px[di+2]=v;px[di+3]=255;
      } return px;
    }
    if (fam==='R8S') {
      var n=w*h,fmin=1e9,fmax=-1e9;
      for(var j=0;j<n;j++){var sv=data[j]>127?(data[j]-256)/127.0:data[j]/127.0;if(sv<fmin)fmin=sv;if(sv>fmax)fmax=sv;}
      var fr=fmax>fmin?255/(fmax-fmin):1;
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,sv=data[si]>127?(data[si]-256)/127.0:data[si]/127.0;
        var vv=(sv-fmin)*fr|0;px[di]=vv;px[di+1]=vv;px[di+2]=vv;px[di+3]=255;
      } return px;
    }
    if (fam==='R16G16') {
      var s16=new Uint16Array(data.buffer,data.byteOffset,w*h*2);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4;
        px[di]=s16[si*2]*255/65535|0;px[di+1]=s16[si*2+1]*255/65535|0;px[di+2]=0;px[di+3]=255;
      } return px;
    }
    if (fam==='R16G16F') {
      var s16f=new Uint16Array(data.buffer,data.byteOffset,w*h*2),fminR=1e9,fmaxR=-1e9,fminG=1e9,fmaxG=-1e9;
      for(var j=0;j<w*h;j++){var fr=S.halfToFloat(s16f[j*2]),fg=S.halfToFloat(s16f[j*2+1]);if(isFinite(fr)){if(fr<fminR)fminR=fr;if(fr>fmaxR)fmaxR=fr;}if(isFinite(fg)){if(fg<fminG)fminG=fg;if(fg>fmaxG)fmaxG=fg;}}
      var frR=fmaxR>fminR?255/(fmaxR-fminR):1,frG=fmaxG>fminG?255/(fmaxG-fminG):1;
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4;
        px[di]=(S.halfToFloat(s16f[si*2])-fminR)*frR|0;px[di+1]=(S.halfToFloat(s16f[si*2+1])-fminG)*frG|0;px[di+2]=0;px[di+3]=255;
      } return px;
    }
    if (fam==='R16') {
      var su=new Uint16Array(data.buffer,data.byteOffset,w*h),mn=65535,mx=0;
      for(var j=0;j<su.length;j++){if(su[j]<mn)mn=su[j];if(su[j]>mx)mx=su[j];}
      var rng=mx>mn?255/(mx-mn):1;
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,vv=(su[si]-mn)*rng|0;
        px[di]=vv;px[di+1]=vv;px[di+2]=vv;px[di+3]=255;
      } return px;
    }
    if (fam==='R16F') {
      var su=new Uint16Array(data.buffer,data.byteOffset,w*h),fmn=1e9,fmx=-1e9;
      for(var j=0;j<su.length;j++){var f=S.halfToFloat(su[j]);if(isFinite(f)){if(f<fmn)fmn=f;if(f>fmx)fmx=f;}}
      var fr=fmx>fmn?255/(fmx-fmn):1;
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,vv=(S.halfToFloat(su[si])-fmn)*fr|0;
        px[di]=vv;px[di+1]=vv;px[di+2]=vv;px[di+3]=255;
      } return px;
    }
    if (fam==='D32S8') {
      var allF=new Float32Array(data.buffer,data.byteOffset,w*h*2),dmn=1e9,dmx=-1e9,n=w*h;
      for(var j=0;j<n;j++){var dv=allF[j*2];if(isFinite(dv)){if(dv<dmn)dmn=dv;if(dv>dmx)dmx=dv;}}
      var dr=dmx>dmn?255/(dmx-dmn):1;
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,dv=isFinite(allF[si*2])?(allF[si*2]-dmn)*dr|0:0;
        px[di]=dv;px[di+1]=dv;px[di+2]=dv;px[di+3]=255;
      } return px;
    }
    if (fam==='R32F') {
      var f32w=new Float32Array(data.buffer,data.byteOffset,w*h),mn32=1e9,mx32=-1e9;
      for(var j=0;j<f32w.length;j++){var v=f32w[j];if(isFinite(v)){if(v<mn32)mn32=v;if(v>mx32)mx32=v;}}
      var rng32=mx32>mn32?255/(mx32-mn32):1;
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4,v=isFinite(f32w[si])?(f32w[si]-mn32)*rng32|0:0;
        px[di]=v;px[di+1]=v;px[di+2]=v;px[di+3]=255;
      } return px;
    }
    if (fam==='RGBA16') {
      var u16w=new Uint16Array(data.buffer,data.byteOffset,w*h*4);
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4;
        px[di]=u16w[si*4]*255/65535|0;px[di+1]=u16w[si*4+1]*255/65535|0;
        px[di+2]=u16w[si*4+2]*255/65535|0;px[di+3]=u16w[si*4+3]*255/65535|0;
      } return px;
    }
    if (fam==='RGBA64F') {
      var u16hw=new Uint16Array(data.buffer,data.byteOffset,w*h*4),fmnw=1e9,fmxw=-1e9;
      for(var j=0;j<u16hw.length;j++){var f=S.halfToFloat(u16hw[j]);if(isFinite(f)){if(f<fmnw)fmnw=f;if(f>fmxw)fmxw=f;}}
      var frw=fmxw>fmnw?255/(fmxw-fmnw):1;
      for(var oy=0;oy<outH;oy++) for(var ox=0;ox<outW;ox++) {
        var si=oy*step*w+ox*step,di=(oy*outW+ox)*4;
        px[di]=(S.halfToFloat(u16hw[si*4])-fmnw)*frw|0;px[di+1]=(S.halfToFloat(u16hw[si*4+1])-fmnw)*frw|0;
        px[di+2]=(S.halfToFloat(u16hw[si*4+2])-fmnw)*frw|0;px[di+3]=255;
      } return px;
    }

    // BC1-5 with step>1: block-level skip sampling
    if (fam==='BC1'||fam==='BC3'||fam==='BC4'||fam==='BC5') {
      return S.decodeBC(data, w, h, dds.fmt, step);
    }

    return null;
  }

  // ---- Message handler ----
  self.onmessage = function(e) {
    var msg = e.data;
    var result = null;
    if (msg.type === 'dds') {
      var dds = parseDDS(msg.buffer);
      if (dds) {
        if (msg.typeOverride) dds.fmt.type = msg.typeOverride;
        var step = 1;
        if (msg.targetDim && !/UINT|INT|SINT/i.test(dds.fmt.type)) {
          var maxDim = Math.max(dds.w, dds.h);
          if (maxDim > 1024) step = Math.ceil(maxDim / msg.targetDim);
        }
        var px = decodeDDS(dds, step);
        if (px) {
          var rw = step > 1 ? Math.ceil(dds.w / step) : dds.w;
          var rh = step > 1 ? Math.ceil(dds.h / step) : dds.h;
          result = {w: rw, h: rh, pixels: px};
        }
      }
    } else if (msg.type === 'exr') {
      var exr = EXR.parse(msg.buffer);
      if (exr) {
        var px = EXR.toRGBA8(exr);
        if (px) result = {w:exr.w, h:exr.h, pixels:px};
      }
    }
    if (result) {
      self.postMessage({id:msg.id, ok:true, w:result.w, h:result.h, pixels:result.pixels}, [result.pixels.buffer]);
    } else {
      self.postMessage({id:msg.id, ok:false});
    }
  };
})();
