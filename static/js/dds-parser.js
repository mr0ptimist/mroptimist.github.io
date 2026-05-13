// =============================================================================
// dds-parser.js — DDS 解析器（主线程）
// =============================================================================
// 暴露 window.DDS = { parse }。依赖 worker-shared.js。
//
// 本文件负责：
//   - DDS header 解析、mip/array/cubemap 检测
//   - BC6H/BC7 WebGL 硬件解码（需要 document，不进 Worker）
//   - 未压缩格式和 BC1-5 通过 ImageCodecShared.decodeBC / 内联循环处理
//
// 新增功能的正确姿势：
//   1. 新 DDS 格式解码 → 加在 getMip() 里，按 format family 新增分支
//   2. 新的 BCx 压缩格式 → 如果纯 CPU 可解，加到 worker-shared.js 的 decodeBC
//   3. 新的 GPU 解码格式 → 在本文件仿照 _decodeBC7_WebGL 写，BC6H/BC7 也在这里
//   4. UI 交互 → 去 image-viewer.js
//   5. 不要往 extend_footer.html 里加 JS 代码
// =============================================================================
var DDS = (function(){
  var S = self.ImageCodecShared;
  if (!S) throw new Error('ImageCodecShared not loaded — ensure worker-shared.js loads first');

  // ---- WebGL context for BC6H/BC7 hardware decode ----
  var _glCtx = null;
  function _getGL() {
    if (_glCtx && !_glCtx.isContextLost()) return _glCtx;
    var c = document.createElement('canvas');
    _glCtx = c.getContext('webgl2', {preserveDrawingBuffer: true})
          || c.getContext('webgl', {preserveDrawingBuffer: true});
    return _glCtx;
  }

  function _decodeBC7_WebGL(data, w, h, fmt) {
    var gl = _getGL();
    if (!gl) return null;
    var ext = gl.getExtension('EXT_texture_compression_bptc');
    if (!ext) return null;
    var internalFmt;
    if (fmt.family==='BC7') internalFmt = (fmt.dxgi===99) ? ext.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT : ext.COMPRESSED_RGBA_BPTC_UNORM_EXT;
    else if (fmt.family==='BC6H') internalFmt = (fmt.dxgi===96) ? ext.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT : ext.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT;
    else return null;
    var copy = new Uint8Array(data);
    if (!gl._bcProg) {
      var vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, 'attribute vec2 p;varying vec2 t;void main(){gl_Position=vec4(p,0,1);t=p*0.5+0.5;}');
      gl.compileShader(vs);
      var fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, 'precision highp float;varying vec2 t;uniform sampler2D s;void main(){gl_FragColor=texture2D(s,t);}');
      gl.compileShader(fs);
      var prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs);
      gl.bindAttribLocation(prog, 0, 'p');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { return null; }
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      gl._bcProg = prog;
      gl._bcProg._buf = buf;
    }
    try {
      var tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.compressedTexImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, copy);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.canvas.width = w; gl.canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.useProgram(gl._bcProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl._bcProg._buf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.deleteTexture(tex);
      var cv2 = document.createElement('canvas'); cv2.width = w; cv2.height = h;
      var ctx2d = cv2.getContext('2d');
      ctx2d.drawImage(gl.canvas, 0, 0);
      var imgData = ctx2d.getImageData(0, 0, w, h);
      return imgData.data;
    } catch(e) { return null; }
  }

  // ---- DDS Parse (header + mip table) ----
  function parse(buf) {
    var view = new Uint8Array(buf);
    if (S.str4(view,0) !== 'DDS ') return null;
    if (S.r32(view, 4) !== 124) return null;
    if (S.r32(view, 76) !== 32) return null;
    var w = S.r32(view,16), h = S.r32(view,12), mips, flags = S.r32(view,8);
    var ddsDepth = Math.max(S.r32(view, 24), 1);
    var caps2 = S.r32(view, 112);
    mips = S.r32(view, 28);
    if (mips === 0) mips = 1;
    var fmt = S.detectFmt(view);
    var dataOff = fmt.fourCC === 'DX10' ? 148 : 128;

    var dx10Misc = 0, dx10Array = 1, resDim = 3, alphaMode = 0;
    if (fmt.fourCC === 'DX10') {
      resDim = S.r32(view, 132);
      dx10Misc = S.r32(view, 136);
      dx10Array = Math.max(S.r32(view, 140), 1);
      alphaMode = S.r32(view, 144) & 0x7;
    } else {
      if (flags & 0x800000 || caps2 & 0x200000) resDim = 4;
    }
    var depth = (resDim === 4) ? ddsDepth : 1;
    var maxPossibleMips = Math.floor(Math.log2(Math.max(w, h, depth))) + 1;
    if (mips > maxPossibleMips) mips = maxPossibleMips;

    var mipOff = dataOff, mipList = [];
    for (var i = 0; i < mips; i++) {
      var mw = Math.max(1, w>>i), mh = Math.max(1, h>>i);
      var mipDepth = (resDim === 4) ? Math.max(1, depth >> i) : 1;
      var sliceSize;
      if (fmt.isComp) {
        var bs = (fmt.family==='BC1'||fmt.family==='BC4') ? 8 : 16;
        sliceSize = Math.max(1,(mw+3)/4|0) * Math.max(1,(mh+3)/4|0) * bs;
      } else {
        sliceSize = mw * mh * (fmt.bpp / 8);
      }
      var size = sliceSize * mipDepth;
      if (mipOff + size > buf.byteLength) {
        if (i === 0) size = buf.byteLength - mipOff;
        else break;
      }
      if (size <= 0) break;
      mipList.push({off:mipOff, size:size, w:mw, h:mh, depth:mipDepth, sliceSize:sliceSize});
      mipOff += size;
    }
    mips = mipList.length;
    var faceByteSize = mipOff - dataOff;
    var arraySize = 1;
    if (resDim === 4) {
      arraySize = 1;
    } else if (dx10Misc & 0x4) {
      arraySize = dx10Array * 6;
    } else if (fmt.fourCC === 'DX10') {
      arraySize = dx10Array;
    } else if (caps2 & 0x200) {
      arraySize = 0;
      for (var bit = 0; bit < 6; bit++) { if (caps2 & (0x400 << bit)) arraySize++; }
      if (!arraySize) arraySize = 6;
    }

    function getMip(n, slice) {
      if (n < 0 || n >= mips) return null;
      slice = slice || 0;
      var m = mipList[n];
      var off;
      if (resDim === 4) {
        if (slice < 0 || slice >= m.depth) return null;
        off = m.off + slice * m.sliceSize;
      } else {
        if (slice < 0 || slice >= arraySize) return null;
        off = m.off + slice * faceByteSize;
      }
      if (off + m.sliceSize > view.byteLength) return null;
      var px = new Uint8ClampedArray(m.w * m.h * 4);
      var data = new Uint8Array(buf, off, m.sliceSize);
      var fam = fmt.family;

      if (fmt.isComp) {
        if (fam==='BC1'||fam==='BC3'||fam==='BC4'||fam==='BC5')
          return S.decodeBC(data, m.w, m.h, fmt);
        var glDec = _decodeBC7_WebGL(data, m.w, m.h, fmt);
        if (glDec) return glDec;
        for (var j=0;j<px.length;j+=4){px[j]=255;px[j+1]=0;px[j+2]=255;px[j+3]=255;}
        return px;
      }

      // -- Uncompressed formats --
      if (fam==='RGBG') {
        for (var j=0;j<m.w*m.h;j+=2) {
          var si=j*2, r0=data[si], g0=data[si+1], b1=data[si+2], g1=data[si+3];
          px[j*4]=r0; px[j*4+1]=g0; px[j*4+2]=b1; px[j*4+3]=255;
          if (j+1<m.w*m.h) { px[(j+1)*4]=r0; px[(j+1)*4+1]=g1; px[(j+1)*4+2]=b1; px[(j+1)*4+3]=255; }
        }
        return px;
      }
      if (fam==='GRGB') {
        for (var j=0;j<m.w*m.h;j+=2) {
          var si=j*2, g0=data[si], r0=data[si+1], g1=data[si+2], b1=data[si+3];
          px[j*4]=r0; px[j*4+1]=g0; px[j*4+2]=b1; px[j*4+3]=255;
          if (j+1<m.w*m.h) { px[(j+1)*4]=r0; px[(j+1)*4+1]=g1; px[(j+1)*4+2]=b1; px[(j+1)*4+3]=255; }
        }
        return px;
      }
      if (fam==='RGBA8') {
        for (var j=0;j<px.length;j++) px[j]=data[j];
        return px;
      }
      if (fam==='BGRA8') {
        var sw = fmt.swizzle || 'bgra';
        for (var j=0;j<px.length;j+=4) {
          if (sw==='argb')  { px[j]=data[j+1]; px[j+1]=data[j+2]; px[j+2]=data[j+3]; px[j+3]=data[j]; }
          else if (sw==='abgr') { px[j]=data[j+3]; px[j+1]=data[j+2]; px[j+2]=data[j+1]; px[j+3]=data[j]; }
          else { px[j]=data[j+2]; px[j+1]=data[j+1]; px[j+2]=data[j]; px[j+3]=data[j+3]; }
        }
        return px;
      }
      if (fam==='R10G10B10A2') {
        var src32 = new Uint32Array(buf, off, m.w*m.h);
        for (var j=0;j<m.w*m.h;j++) {
          var p = src32[j];
          px[j*4]   = (p & 0x3FF) * 255 / 1023 | 0;
          px[j*4+1] = ((p>>>10) & 0x3FF) * 255 / 1023 | 0;
          px[j*4+2] = ((p>>>20) & 0x3FF) * 255 / 1023 | 0;
          px[j*4+3] = (p>>>30) * 255 / 3 | 0;
        }
        return px;
      }
      if (fam==='R11G11B10') {
        var src32 = new Uint32Array(buf, off, m.w*m.h);
        for (var j=0;j<m.w*m.h;j++) {
          var p = src32[j];
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
      if (fam==='R8G8') {
        for (var j=0;j<m.w*m.h;j++) {
          px[j*4]=data[j*2]; px[j*4+1]=data[j*2+1]; px[j*4+2]=0; px[j*4+3]=255;
        }
        return px;
      }
      // R8G8_SNORM: 2×signed byte [-1,1], auto-level per channel
      if (fam==='R8G8S') {
        var fminR=1e9, fmaxR=-1e9, fminG=1e9, fmaxG=-1e9, n=m.w*m.h;
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
          px[j*4]=(sr-fminR)*frR|0; px[j*4+1]=(sg-fminG)*frG|0;
          px[j*4+2]=0; px[j*4+3]=255;
        }
        return px;
      }
      if (fam==='R8') {
        for (var j=0;j<m.w*m.h;j++) {
          var v=data[j]; px[j*4]=v; px[j*4+1]=v; px[j*4+2]=v; px[j*4+3]=255;
        }
        return px;
      }
      // R8_SNORM: signed [-1,1], auto-level + remap to [0,255]
      if (fam==='R8S') {
        var fmin=1e9, fmax=-1e9, n=m.w*m.h;
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
        var src16 = new Uint16Array(buf, off, m.w*m.h*2);
        for (var j=0;j<m.w*m.h;j++) {
          px[j*4]   = src16[j*2] * 255 / 65535 | 0;
          px[j*4+1] = src16[j*2+1] * 255 / 65535 | 0;
          px[j*4+2] = 0; px[j*4+3] = 255;
        }
        return px;
      }
      // R16G16_FLOAT: 2×half per pixel, auto-level
      if (fam==='R16G16F') {
        var su16 = new Uint16Array(buf, off, m.w*m.h*2);
        var fminR=1e9, fmaxR=-1e9, fminG=1e9, fmaxG=-1e9;
        for (var j=0;j<m.w*m.h;j++) {
          var fr = S.halfToFloat(su16[j*2]), fg = S.halfToFloat(su16[j*2+1]);
          if (isFinite(fr)) { if (fr<fminR)fminR=fr; if (fr>fmaxR)fmaxR=fr; }
          if (isFinite(fg)) { if (fg<fminG)fminG=fg; if (fg>fmaxG)fmaxG=fg; }
        }
        var frangeR = fmaxR>fminR ? 255/(fmaxR-fminR) : 1;
        var frangeG = fmaxG>fminG ? 255/(fmaxG-fminG) : 1;
        for (var j=0;j<m.w*m.h;j++) {
          px[j*4]   = (S.halfToFloat(su16[j*2])-fminR)*frangeR|0;
          px[j*4+1] = (S.halfToFloat(su16[j*2+1])-fminG)*frangeG|0;
          px[j*4+2] = 0; px[j*4+3] = 255;
        }
        return px;
      }
      if (fam==='R16') {
        var su16 = new Uint16Array(buf, off, m.w*m.h);
        var vmin=65535, vmax=0;
        for (var j=0;j<su16.length;j++) { if(su16[j]<vmin)vmin=su16[j]; if(su16[j]>vmax)vmax=su16[j]; }
        var range = vmax>vmin ? 255/(vmax-vmin) : 1;
        for (var j=0;j<m.w*m.h;j++) {
          var vv = (su16[j]-vmin)*range|0;
          px[j*4]=vv; px[j*4+1]=vv; px[j*4+2]=vv; px[j*4+3]=255;
        }
        return px;
      }
      if (fam==='R16F') {
        var su16 = new Uint16Array(buf, off, m.w*m.h);
        var fmin=1e9, fmax=-1e9;
        for (var j=0;j<su16.length;j++) {
          var f = S.halfToFloat(su16[j]);
          if (isFinite(f)) { if (f<fmin)fmin=f; if (f>fmax)fmax=f; }
        }
        var frange = fmax>fmin ? 255/(fmax-fmin) : 1;
        for (var j=0;j<m.w*m.h;j++) {
          var vv = (S.halfToFloat(su16[j])-fmin)*frange|0;
          px[j*4]=vv; px[j*4+1]=vv; px[j*4+2]=vv; px[j*4+3]=255;
        }
        return px;
      }
      if (fam==='D32S8') {
        var allF = new Float32Array(buf, off, m.w*m.h*2);
        var dmin=1e9, dmax=-1e9, n=m.w*m.h;
        for (var j=0;j<n;j++) { var dv=allF[j*2]; if(isFinite(dv)){if(dv<dmin)dmin=dv;if(dv>dmax)dmax=dv;} }
        var dr=dmax>dmin?255/(dmax-dmin):1;
        for (var j=0;j<n;j++) { var dv=isFinite(allF[j*2])?(allF[j*2]-dmin)*dr|0:0; px[j*4]=dv;px[j*4+1]=dv;px[j*4+2]=dv;px[j*4+3]=255; }
        return px;
      }
      if (fam==='R32F') {
        var f32 = new Float32Array(buf, off, m.w*m.h);
        var mn=1e9, mx=-1e9;
        for (var j=0;j<f32.length;j++) { var v=f32[j]; if(isFinite(v)){if(v<mn)mn=v;if(v>mx)mx=v;} }
        var rng=mx>mn?255/(mx-mn):1;
        for (var j=0;j<f32.length;j++) { var v=isFinite(f32[j])?(f32[j]-mn)*rng|0:0; px[j*4]=v;px[j*4+1]=v;px[j*4+2]=v;px[j*4+3]=255; }
        return px;
      }
      if (fam==='RGBA16') {
        var u16 = new Uint16Array(buf, off, m.w*m.h*4);
        for (var j=0;j<m.w*m.h;j++) { px[j*4]=u16[j*4]*255/65535|0; px[j*4+1]=u16[j*4+1]*255/65535|0; px[j*4+2]=u16[j*4+2]*255/65535|0; px[j*4+3]=u16[j*4+3]*255/65535|0; }
        return px;
      }
      if (fam==='RGBA64F') {
        var u16h = new Uint16Array(buf, off, m.w*m.h*4);
        var fmn=1e9, fmx=-1e9;
        for (var j=0;j<u16h.length;j++) { var f=S.halfToFloat(u16h[j]); if(isFinite(f)){if(f<fmn)fmn=f;if(f>fmx)fmx=f;} }
        var fr=fmx>fmn?255/(fmx-fmn):1;
        for (var j=0;j<m.w*m.h;j++) { px[j*4]=(S.halfToFloat(u16h[j*4])-fmn)*fr|0; px[j*4+1]=(S.halfToFloat(u16h[j*4+1])-fmn)*fr|0; px[j*4+2]=(S.halfToFloat(u16h[j*4+2])-fmn)*fr|0; px[j*4+3]=255; }
        return px;
      }
      if (fam==='RGB9E5') {
        var s32e = new Uint32Array(buf, off, m.w*m.h);
        var emnR=1e9,emxR=-1e9,emnG=1e9,emxG=-1e9,emnB=1e9,emxB=-1e9;
        for (var j=0;j<m.w*m.h;j++) {
          var p=s32e[j], exp=(p>>>27)&0x1F, sc=Math.pow(2,exp-15);
          var r=(p&0x1FF)*sc, g=((p>>>9)&0x1FF)*sc, b=((p>>>18)&0x1FF)*sc;
          if(isFinite(r)){if(r<emnR)emnR=r;if(r>emxR)emxR=r;} if(isFinite(g)){if(g<emnG)emnG=g;if(g>emxG)emxG=g;} if(isFinite(b)){if(b<emnB)emnB=b;if(b>emxB)emxB=b;}
        }
        var erR=emxR>emnR?255/(emxR-emnR):1, erG=emxG>emnG?255/(emxG-emnG):1, erB=emxB>emnB?255/(emxB-emnB):1;
        for (var j=0;j<m.w*m.h;j++) {
          var p=s32e[j], exp=(p>>>27)&0x1F, sc=Math.pow(2,exp-15);
          px[j*4]=Math.min(255,Math.max(0,((p&0x1FF)*sc-emnR)*erR|0)); px[j*4+1]=Math.min(255,Math.max(0,(((p>>>9)&0x1FF)*sc-emnG)*erG|0)); px[j*4+2]=Math.min(255,Math.max(0,(((p>>>18)&0x1FF)*sc-emnB)*erB|0)); px[j*4+3]=255;
        }
        return px;
      }
      if (fam==='RGBA128F') {
        var f128 = new Float32Array(buf, off, m.w*m.h*4);
        var fmn=1e9, fmx=-1e9;
        for (var j=0;j<f128.length;j++) { var v=f128[j]; if(isFinite(v)){if(v<fmn)fmn=v;if(v>fmx)fmx=v;} }
        var fr=fmx>fmn?255/(fmx-fmn):1;
        for (var j=0;j<m.w*m.h;j++) { px[j*4]=Math.min(255,Math.max(0,(f128[j*4]-fmn)*fr|0)); px[j*4+1]=Math.min(255,Math.max(0,(f128[j*4+1]-fmn)*fr|0)); px[j*4+2]=Math.min(255,Math.max(0,(f128[j*4+2]-fmn)*fr|0)); px[j*4+3]=255; }
        return px;
      }
      if (fam==='RGB96F') {
        var f96 = new Float32Array(buf, off, m.w*m.h*3);
        var fmn=1e9, fmx=-1e9;
        for (var j=0;j<f96.length;j++) { var v=f96[j]; if(isFinite(v)){if(v<fmn)fmn=v;if(v>fmx)fmx=v;} }
        var fr=fmx>fmn?255/(fmx-fmn):1;
        for (var j=0;j<m.w*m.h;j++) { px[j*4]=Math.min(255,Math.max(0,(f96[j*3]-fmn)*fr|0)); px[j*4+1]=Math.min(255,Math.max(0,(f96[j*3+1]-fmn)*fr|0)); px[j*4+2]=Math.min(255,Math.max(0,(f96[j*3+2]-fmn)*fr|0)); px[j*4+3]=255; }
        return px;
      }
      if (fam==='R32G32F') {
        var f32g = new Float32Array(buf, off, m.w*m.h*2);
        var fmnR=1e9,fmxR=-1e9,fmnG=1e9,fmxG=-1e9;
        for (var j=0;j<m.w*m.h;j++) { var fr=f32g[j*2],fg=f32g[j*2+1]; if(isFinite(fr)){if(fr<fmnR)fmnR=fr;if(fr>fmxR)fmxR=fr;} if(isFinite(fg)){if(fg<fmnG)fmnG=fg;if(fg>fmxG)fmxG=fg;} }
        var frR=fmxR>fmnR?255/(fmxR-fmnR):1, frG=fmxG>fmnG?255/(fmxG-fmnG):1;
        for (var j=0;j<m.w*m.h;j++) { px[j*4]=Math.min(255,Math.max(0,(f32g[j*2]-fmnR)*frR|0)); px[j*4+1]=Math.min(255,Math.max(0,(f32g[j*2+1]-fmnG)*frG|0)); px[j*4+2]=0; px[j*4+3]=255; }
        return px;
      }
      if (fam==='D24S8') {
        var s32d = new Uint32Array(buf, off, m.w*m.h);
        for (var j=0;j<m.w*m.h;j++) { var d=(s32d[j]&0xFFFFFF)/0xFFFFFF*255|0; px[j*4]=d; px[j*4+1]=d; px[j*4+2]=d; px[j*4+3]=255; }
        return px;
      }
      for (var j=0;j<Math.min(px.length,data.length);j++) px[j]=data[j];
      return px;
    }

    return {
      w:w, h:h, mips:mips, fmt:fmt, raw: new Uint8Array(buf), mipList:mipList,
      arraySize: arraySize, faceByteSize: faceByteSize,
      resDim: resDim, depth: depth, alphaMode: alphaMode,
      getMip: getMip
    };
  }

  return { parse: parse };
})();
