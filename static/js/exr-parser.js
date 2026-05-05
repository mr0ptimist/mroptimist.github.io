// =============================================================================
// exr-parser.js — OpenEXR 解析器（uncompressed, float32/half16）
// =============================================================================
// 暴露 window.EXR = { parse, toRGBA8 }。主线程和 Worker 复用同一文件。
// 依赖 worker-shared.js（binary readers + halfToFloat）。
//
// 新增功能的正确姿势：
//   1. 新 EXR 压缩格式（PIZ/ZIP/RLE 等）→ 在 parse() 的 compression 分支扩展
//   2. 新的像素类型（如 UINT 解码）→ 在 scanline 读取循环加分支
//   3. 新的 tone-mapping 算法 → 修改 toRGBA8()
//   4. 不要往 extend_footer.html 里加 JS 代码
// =============================================================================
var EXR = (function(){
  var S = self.ImageCodecShared;
  if (!S) throw new Error('ImageCodecShared not loaded — ensure worker-shared.js loads first');

  function parse(buf) {
    var view = new Uint8Array(buf);
    if (view[0]!==0x76 || view[1]!==0x2F || view[2]!==0x31 || view[3]!==0x01) return null;

    var pos = 8;
    var channels = [], dataWindow = [0,0,0,0], compression = 0, lineOrder = 0;
    var w=0, h=0;

    while (pos < view.length && view[pos] !== 0) {
      var nameEnd = pos;
      while (nameEnd < view.length && view[nameEnd] !== 0) nameEnd++;
      var name = '';
      for (var i = pos; i < nameEnd; i++) name += String.fromCharCode(view[i]);
      pos = nameEnd + 1;

      var typeEnd = pos;
      while (typeEnd < view.length && view[typeEnd] !== 0) typeEnd++;
      var type = '';
      for (var i = pos; i < typeEnd; i++) type += String.fromCharCode(view[i]);
      pos = typeEnd + 1;

      var size = S.r32(view, pos);
      pos += 4;

      if (name === 'channels' && type === 'chlist') {
        var chStart = pos;
        while (view[chStart] !== 0) {
          var chEnd = chStart;
          while (chEnd < pos+size && view[chEnd] !== 0) chEnd++;
          var chName = '';
          for (var i = chStart; i < chEnd; i++) chName += String.fromCharCode(view[i]);
          chStart = chEnd + 1;
          if (chName === '') break;
          var pxType = S.r32(view, chStart);
          channels.push({name:chName, type:pxType});
          chStart += 16;
        }
      } else if (name === 'dataWindow' && type === 'box2i') {
        dataWindow = [S.r32s(view,pos), S.r32s(view,pos+4), S.r32s(view,pos+8), S.r32s(view,pos+12)];
        w = dataWindow[2] - dataWindow[0] + 1;
        h = dataWindow[3] - dataWindow[1] + 1;
      } else if (name === 'compression' && type === 'compression') {
        compression = view[pos];
      } else if (name === 'lineOrder' && type === 'lineOrder') {
        lineOrder = view[pos];
      }
      pos += size;
    }

    if (!w || !h || channels.length < 1) return null;
    if (compression !== 0) return null;
    pos++;

    var numCh = Math.min(channels.length, 4);
    var chList = [], chBytes = 0;
    for (var i = 0; i < numCh; i++) {
      var bpp = channels[i].type === 2 ? 4 : 2;
      var chIdx = ({R:0,G:1,B:2,A:3})[channels[i].name];
      chList.push({name:channels[i].name, bpp:bpp, type:channels[i].type, idx: chIdx !== undefined ? chIdx : i});
      chBytes += bpp;
    }

    var pixels = new Float32Array(w * h * 4);
    var scanlinesFound = 0;
    while (pos + 8 <= view.length && scanlinesFound < h) {
      var y = S.r32s(view, pos);
      var scanSize = S.r32(view, pos+4);
      pos += 8;

      if (y >= dataWindow[1] && y <= dataWindow[3]) {
        var row = y - dataWindow[1];
        var srcOff = pos;
        for (var c = 0; c < chList.length && c < 4; c++) {
          if (chList[c].type === 2) {
            var rowFloats = new Float32Array(view.buffer.slice(srcOff, srcOff + w * 4));
            for (var x = 0; x < w && x < rowFloats.length; x++) {
              pixels[(row * w + x) * 4 + chList[c].idx] = rowFloats[x];
            }
            srcOff += w * 4;
          } else {
            for (var x = 0; x < w && srcOff + chList[c].bpp <= pos + scanSize; x++) {
              var dstOff = (row * w + x) * 4;
              if (chList[c].type === 1) {
                var hf = (view[srcOff])|(view[srcOff+1]<<8);
                pixels[dstOff + chList[c].idx] = S.halfToFloat(hf);
                srcOff += 2;
              } else {
                srcOff += chList[c].bpp;
              }
            }
          }
        }
        scanlinesFound++;
      }
      pos += scanSize;
    }

    if (numCh === 1) {
      for (var i = 0; i < w * h; i++) {
        var rv = pixels[i*4];
        pixels[i*4+1] = rv;
        pixels[i*4+2] = rv;
      }
    } else if (numCh === 2) {
      for (var i = 0; i < w * h; i++) {
        pixels[i*4+2] = pixels[i*4+1];
      }
    }
    return { w:w, h:h, pixels:pixels, channels:chList.length };
  }

  function toRGBA8(exr) {
    var rgba = exr.pixels;
    var w = exr.w, h = exr.h, n = w * h;
    var out = new Uint8ClampedArray(n * 4);
    for (var i = 0; i < n; i++) {
      for (var c = 0; c < 3; c++) {
        var v = rgba[i*4+c];
        if (!isFinite(v) || isNaN(v)) v = 0;
        v = Math.max(0, v);
        v = v / (v + 1.0);
        out[i*4+c] = Math.min(255, Math.max(0, Math.pow(v, 1.0/2.2) * 255 | 0));
      }
      var a = rgba[i*4+3];
      out[i*4+3] = isFinite(a) && !isNaN(a) ? Math.min(255, Math.max(0, Math.pow(Math.max(0,a)/(Math.max(0,a)+1),1.0/2.2)*255|0)) : 255;
    }
    return out;
  }

  return { parse: parse, toRGBA8: toRGBA8 };
})();
