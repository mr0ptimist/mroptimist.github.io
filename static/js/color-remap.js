// color-remap.js — 范围重映射工具（黑/白点滑条用）
// 暴露全局函数 window.ColorRemap
(function(){
  var C = {};

  // 浮点格式族：做过 min/max 自动归一化，反向量化重映射
  var FLOAT_FAMS = ['R16F','R32F','D32S8','R16G16F','R32G32F','RGBA64F','RGBA128F','RGB96F','BC6H','R11G11B10','RGB9E5'];
  // SNORM 格式族：[-1,1] 范围归一化
  var SNORM_FAMS = ['R8S','R8G8S','RGBA8S','RGBA16S','R16S','R16G16S'];
  // 深度格式族
  var DEPTH_FAMS = ['D32S8','D24S8'];
  // 高位深整数：做过 min/max 自动归一化（扫描 pixel 值范围）
  var AUTONORM_FAMS = ['R16','R16G16','RGBA16'];

  function isFloat(fam) { return FLOAT_FAMS.indexOf(fam) >= 0; }
  function isSNORM(fam) { return SNORM_FAMS.indexOf(fam) >= 0; }
  function isDepth(fam) { return DEPTH_FAMS.indexOf(fam) >= 0; }
  function isAutoNorm(fam) { return AUTONORM_FAMS.indexOf(fam) >= 0; }

  // 是否需要显示范围滑条（所有 DDS/EXR 都显示）
  C.needsRange = function(family, isExr) {
    return isFloat(family) || isSNORM(family) || isDepth(family) || isAutoNorm(family) || isExr || true;
  };

  // 从 RGBA8 bytes 扫描实际值范围（归一化空间）
  // nMin/nMax: 该格式的归一化参数（反向量化用）
  C.scanMinMax = function(px, nMin, nMax) {
    var bMin = 255, bMax = 0;
    for (var i = 0; i < px.length; i += 4) {
      for (var c = 0; c < 3; c++) {
        if (px[i + c] < bMin) bMin = px[i + c];
        if (px[i + c] > bMax) bMax = px[i + c];
      }
    }
    if (bMin === bMax) bMax = bMin + 1;
    var origRange = nMax - nMin;
    return {
      lo: bMin / 255 * origRange + nMin,
      hi: bMax / 255 * origRange + nMin
    };
  };

  // 从 Float32Array 扫描（EXR AutoFit）
  C.scanFloatMinMax = function(raw) {
    var lo = 1e9, hi = -1e9;
    for (var i = 0; i < raw.length; i++) {
      var v = raw[i];
      if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (lo >= hi) hi = lo + 1e-6;
    return {lo: lo, hi: hi};
  };

  // 反向量化 + 线性重映射
  // src: Uint8ClampedArray (RGBA8)
  // lo/hi: 新映射范围（归一化空间）
  // nMin/nMax: 原始归一化参数
  // rawFloat: Float32Array（可选, EXR 原始浮点）
  C.remapPixels = function(src, lo, hi, nMin, nMax, rawFloat) {
    var dst = new Uint8ClampedArray(src.length);
    var range = hi - lo;
    if (range <= 0) range = 1e-6;

    if (rawFloat) {
      for (var i = 0; i < src.length; i += 4) {
        for (var c = 0; c < 3; c++) {
          var v = rawFloat[i + c];
          var fv = isFinite(v) ? v : 0;
          dst[i + c] = Math.min(255, Math.max(0, Math.round((fv - lo) / range * 255)));
        }
        dst[i + 3] = 255;
      }
    } else if (nMin !== 0 || nMax !== 1) {
      var origRange = nMax - nMin;
      if (origRange <= 0) origRange = 1e-6;
      var scale = origRange / range;
      var offset = (nMin - lo) / range * 255;
      for (var i = 0; i < src.length; i += 4) {
        for (var c = 0; c < 3; c++) {
          dst[i + c] = Math.min(255, Math.max(0, Math.round(src[i + c] / 255 * scale * 255 + offset)));
        }
        dst[i + 3] = src[i + 3];
      }
    } else {
      var s2 = 255 / range, o2 = -lo * s2;
      for (var i = 0; i < src.length; i += 4) {
        for (var c = 0; c < 3; c++) {
          dst[i + c] = Math.min(255, Math.max(0, Math.round(src[i + c] / 255 * s2 + o2)));
        }
        dst[i + 3] = src[i + 3];
      }
    }
    return dst;
  };

  window.ColorRemap = C;
})();