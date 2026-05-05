// =============================================================================
// image-viewer.js — 图片查看器 UI 入口
// =============================================================================
// 最后加载的 JS 文件，初始化所有图片交互功能。
// 依赖：worker-shared.js > dds-parser.js > exr-parser.js > decode-worker.js
//
// 本文件负责：
//   - Worker 池管理（4 个 Worker，round-robin 调度）
//   - 图片懒加载（IntersectionObserver，800px rootMargin）
//   - Channel viewer 工具栏（R/G/B/A/RGB/RGBA 按钮）
//   - Pixel inspector（中键点击固定像素值、右键拖拽浮动查看）
//   - Mip level / Array slice 滑杆（从 DDS header + JSON sidecar 读取）
//   - 本地路径复制按钮（依赖 window.ImageViewerConfig.workingDir）
//   - 缓存管理（ddsCache / exrCache / pxCache / jsonCache）
//
// 新增功能的正确姿势：
//   1. 新 UI 控件 → 在 processImage() 里仿照 toolbar/meta 模式添加
//   2. 新图片格式（如 KTX/HDR）→ 在 loadImage() 加扩展名分支，解析器放独立 JS 文件
//   3. 新工具栏按钮 → 在 channels.forEach 之后加，参考 flipBtn 的写法
//   4. 新缓存策略 → 修改 ddsCache/exrCache/pxCache/jsonCache 的使用方式
//   5. 配置项 → 通过 window.ImageViewerConfig 传入（在 extend_footer.html 注入）
//   6. 不要往 extend_footer.html 里加 JS 代码，只通过 ImageViewerConfig 传配置
// =============================================================================
(function(){
  var c = document.querySelector('.post-content');
  var listThumbs = document.querySelectorAll('.entry-thumb img');

  // Simple thumbnail render — just a canvas, no channel UI
  function renderThumb(img, w, h, pixels) {
    // Strip alpha: force RGB view
    for (var i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    var maxDim = Math.max(w, h);
    var cap = 200;
    var dw = w, dh = h;
    if (maxDim > cap) { var s = cap / maxDim; dw = Math.round(w * s); dh = Math.round(h * s); }
    var cv = document.createElement('canvas');
    cv.className = 'thumb-canvas'; cv.width = w; cv.height = h;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), 0, 0);
    cv.style.width = dw + 'px'; cv.style.height = dh + 'px';
    cv.style.borderRadius = '4px';
    img.parentNode.insertBefore(cv, img);
    img.style.display = 'none';
    return cv;
  }

  // Process list-page thumbnails (lightweight, no channel UI)
  listThumbs.forEach(function(img) {
    var jsonUrl = img.src.replace(/\.[^.]+$/, '.json');
    var flipY = false;
    var done = false;

    function doThumb(pixels, w, h) {
      if (done) return; done = true;
      if (flipY) {
        // Flip vertically in-place
        var row = new Uint8ClampedArray(w * 4);
        for (var y = 0; y < h / 2; y++) {
          var top = y * w * 4, bot = (h - 1 - y) * w * 4;
          row.set(new Uint8ClampedArray(pixels.buffer, top, w * 4));
          new Uint8ClampedArray(pixels.buffer, top, w * 4).set(new Uint8ClampedArray(pixels.buffer, bot, w * 4));
          new Uint8ClampedArray(pixels.buffer, bot, w * 4).set(row);
        }
        var cv = renderThumb(img, w, h, pixels);
        cv.style.transform = 'scaleY(-1)';
      } else {
        renderThumb(img, w, h, pixels);
      }
    }

    // Check JSON sidecar for flip_y
    fetch(jsonUrl).then(function(r) { if (r.ok) return r.json(); }).then(function(d) {
      if (d && d.flip_y) flipY = true;
    }).catch(function(){});

    if (/\.dds$/i.test(img.src)) {
      fetch(img.src).then(function(r) { if (!r.ok) return; return r.arrayBuffer(); }).then(function(buf) {
        if (!buf) return;
        var dds = DDS.parse(buf);
        if (!dds) return;
        var mip0 = dds.getMip(0);
        if (!mip0) return;
        // Wait a tick for JSON to arrive
        setTimeout(function(){ doThumb(mip0, dds.w, dds.h); }, 50);
      }).catch(function(){});
    } else if (/\.exr$/i.test(img.src)) {
      fetch(img.src).then(function(r) { if (!r.ok) return; return r.arrayBuffer(); }).then(function(buf) {
        if (!buf) return;
        var exr = EXR.parse(buf);
        if (!exr) return;
        var rgba8 = EXR.toRGBA8(exr);
        if (!rgba8) return;
        setTimeout(function(){ doThumb(rgba8, exr.w, exr.h); }, 50);
      }).catch(function(){});
    }
  });

  if (!c) return;

  // ---- Worker pool (off-main-thread DDS/EXR decode) ----
  var decodeWorker = (function(){
    var NUM_WORKERS = 4;
    var workers = [];
    var callbacks = {};
    var nextId = 0;
    var nextWorker = 0;

    var myScript = document.querySelector('script[src*="image-viewer.js"]');
    var workerUrl = myScript ? myScript.src.replace(/image-viewer\.js$/, 'decode-worker.js') : '/js/decode-worker.js';

    for (var i = 0; i < NUM_WORKERS; i++) {
      var w = new Worker(workerUrl);
      w.onmessage = function(e) {
        var cb = callbacks[e.data.id];
        if (cb) { delete callbacks[e.data.id]; cb(e.data); }
      };
      workers.push(w);
    }

    return {
      decode: function(type, buffer, callback, transfer, typeOverride) {
        var id = ++nextId;
        callbacks[id] = callback;
        var w = workers[nextWorker % NUM_WORKERS];
        nextWorker++;
        var msg = {id:id, type:type, buffer:buffer};
        if (typeOverride) msg.typeOverride = typeOverride;
        if (transfer) w.postMessage(msg, [buffer]);
        else w.postMessage(msg);
      }
    };
  })();

  // ---- Decode Cache ----
  var ddsCache = new Map();
  var exrCache = new Map();
  var pxCache = new Map();
  var jsonCache = new Map();

  // Fast pixel read via Canvas 2D
  function readPixels2D(img, w, h) {
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, w, h).data;
  }

  // Channel map from DXGI format code
  var DXGI_CHANNELS = {
    2:'RGBA', 6:'RGB', 10:'RGBA', 11:'RGBA',
    20:'R', 24:'RGBA', 26:'RGB', 27:'RGBA', 28:'RGBA', 29:'RGBA', 87:'RGBA',
    34:'RG', 35:'RG', 36:'RG',
    40:'R', 41:'R',
    49:'RG',
    53:'R', 54:'R', 55:'R', 56:'R', 57:'R',
    61:'R', 65:'R', 67:'RGB',
    70:'RGB', 71:'RGB', 72:'RGB',
    73:'RGBA', 74:'RGBA', 75:'RGBA', 76:'RGBA', 77:'RGBA', 78:'RGBA', 79:'RGBA',
    80:'R', 81:'R', 82:'RG', 83:'RG', 84:'RG',
    94:'RGB', 95:'RGB', 96:'RGB',
    97:'RGBA', 98:'RGBA', 99:'RGBA'
  };
  function chMapFromDxgi(dxgi) {
    var ch = DXGI_CHANNELS[dxgi] || '';
    return {R:ch.indexOf('R')>=0, G:ch.indexOf('G')>=0, B:ch.indexOf('B')>=0, A:ch.indexOf('A')>=0};
  }

  // ---- Process single image ----
  function processImage(img, w, h, ddsPixels) {
    var straight = ddsPixels || null;
    var curW = w, curH = h;
    var wrapper = document.createElement('div');
    wrapper.className = 'channel-container';

    var displayW = w, displayH = h;
    var minDim = Math.min(w, h), maxDim = Math.max(w, h);
    var tinyDim = Math.min(w, h) <= 4;
    var inTable = img.closest('td');
    var maxPx = inTable ? 800 : 1000;
    if (maxDim > maxPx) {
      var ds = maxPx / maxDim;
      displayW = Math.round(w * ds); displayH = Math.round(h * ds);
    } else if (maxDim < 540) {
      var us = 540 / maxDim;
      displayW = Math.round(w * us); displayH = Math.round(h * us);
      wrapper.classList.add('channel-small');
    }
    if (tinyDim) {
      if (displayW < 20) displayW = 20;
      if (displayH < 20) displayH = 20;
    }
    if (displayW !== w && !ddsPixels) {
      img.style.width = displayW + 'px';
    }

    var tb = document.createElement('div');
    tb.className = 'channel-toolbar';

    var channels = ['RGB','R','G','B','A','RGBA'];
    channels.forEach(function(ch) {
      var b = document.createElement('button');
      b.className = 'channel-btn'; b.textContent = ch; b.dataset.ch = ch;
      if (ch === 'RGB') b.classList.add('active');

      b.addEventListener('click', function() {
        tb.querySelectorAll('.channel-btn').forEach(function(x) { x.classList.remove('active'); });
        b.classList.add('active');
        if (!straight) {
          straight = pxCache.get(img.src);
          if (!straight) {
            straight = readPixels2D(img, w, h);
            pxCache.set(img.src, straight);
          }
        }
        var px = new Uint8ClampedArray(straight);
        if (ch === 'RGB') {
          for (var i = 3; i < px.length; i += 4) px[i] = 255;
          tb.classList.remove('pinned');
        } else if (ch === 'A') {
          for (var i = 0; i < px.length; i += 4) { var a = px[i+3]; px[i]=a; px[i+1]=a; px[i+2]=a; px[i+3]=255; }
          tb.classList.add('pinned');
        } else if (ch === 'RGBA') {
          for (var i = 0; i < px.length; i += 4) { var a = px[i+3]/255; px[i]=px[i]*a; px[i+1]=px[i+1]*a; px[i+2]=px[i+2]*a; }
          tb.classList.add('pinned');
        } else {
          var ci = {'R':0,'G':1,'B':2}[ch];
          for (var i = 0; i < px.length; i += 4) { var v = px[i+ci]; px[i]=ci===0?v:0; px[i+1]=ci===1?v:0; px[i+2]=ci===2?v:0; px[i+3]=255; }
          tb.classList.add('pinned');
        }
        if (!ddsPixels) img.style.display = 'none';
        var cv = wrapper.querySelector('canvas');
        if (!cv) { cv = document.createElement('canvas'); cv.className = 'channel-canvas'; wrapper.appendChild(cv); }
        cv.width = curW; cv.height = curH;
        if (displayW !== w) { cv.style.width = displayW + 'px'; }
        cv.getContext('2d').putImageData(new ImageData(px, curW, curH), 0, 0);
      });
      tb.appendChild(b);
    });

    // Flip Y button
    var flipBtn = document.createElement('button');
    flipBtn.className = 'channel-btn flip-btn';
    flipBtn.textContent = '\u2195';
    flipBtn.title = '\u5782\u76f4\u7ffb\u8f6c';
    flipBtn.addEventListener('click', function() {
      var el = wrapper.querySelector('canvas') || wrapper.querySelector('img');
      if (!el) return;
      var flipped = el.style.transform === 'scaleY(-1)';
      el.style.transform = flipped ? '' : 'scaleY(-1)';
      flipBtn.classList.toggle('active', !flipped);
    });
    tb.appendChild(flipBtn);

    // DDS/EXR: create canvas immediately
    if (ddsPixels) {
      var cv = document.createElement('canvas');
      cv.className = 'channel-canvas'; cv.width = w; cv.height = h;
      cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(straight), w, h), 0, 0);
      if (displayW !== w || displayH !== h) {
        cv.style.width = displayW + 'px';
        if (tinyDim) cv.style.height = displayH + 'px';
      }
      var parent = img.parentNode;
      if (parent.tagName === 'P') {
        parent.parentNode.insertBefore(wrapper, parent);
        wrapper.appendChild(cv);
        if (!parent.textContent.trim() && parent.children.length === 0) parent.remove();
      } else {
        img.parentNode.insertBefore(wrapper, img);
        wrapper.appendChild(cv);
      }
      img.style.display = 'none';
    } else {
      var parent = img.parentNode;
      if (parent.tagName === 'P') {
        parent.parentNode.insertBefore(wrapper, parent);
        wrapper.appendChild(img);
        if (!parent.textContent.trim() && parent.children.length === 0) parent.remove();
      } else {
        img.parentNode.insertBefore(wrapper, img);
        wrapper.appendChild(img);
      }
    }
    wrapper.appendChild(tb);

    // Display size badge (bottom-right corner)
    var sizeBadge = document.createElement('div');
    sizeBadge.className = 'channel-size-badge';
    sizeBadge.textContent = displayW + '\u00d7' + displayH + (displayW !== w || displayH !== h ? '  (' + w + '\u00d7' + h + ')' : '');
    wrapper.appendChild(sizeBadge);

    // Range badge (top-right, below toolbar)
    var ddsInfo = ddsCache.get(img.src);
    var fam = ddsInfo && ddsInfo.dds ? ddsInfo.dds.fmt.family : '';
    var rangeText = '';
    if (fam==='R8S'||fam==='R8G8S'||fam.indexOf('SNORM')>=0) rangeText = '[-1, 1]';
    else if (fam==='R16F'||fam==='R32F'||fam==='R11G11B10'||fam==='RGBA64F'||fam==='RGBA128F'||fam==='RGB96F'||fam==='BC6H'||fam==='R16G16F') rangeText = '[0, \u221E)';
    else if (fam==='R8_UINT'||fam.indexOf('UINT')>=0) rangeText = '[0, 255]';
    else if (fam.indexOf('BC')===0||fam.indexOf('R8')===0||fam.indexOf('R16')===0||fam.indexOf('RGBA')===0||fam.indexOf('BGRA')===0||fam==='R10G10B10A2'||fam==='D32S8') rangeText = '[0, 1]';
    else if (fam) rangeText = '[0, 1]';
    if (rangeText) {
      var rangeBadge = document.createElement('div');
      rangeBadge.className = 'channel-range-badge';
      rangeBadge.textContent = rangeText;
      wrapper.appendChild(rangeBadge);
    }

    // Pixel inspector
    var pxPinnedList = [];
    var pxFloat = document.createElement('div');
    pxFloat.style.cssText = 'display:none;position:fixed;z-index:999;background:rgba(0,0,0,0.85);color:#e8eaed;font-size:11px;padding:4px 8px;border-radius:3px;pointer-events:none;white-space:nowrap;font-family:monospace';
    document.body.appendChild(pxFloat);
    var pxTracking = false;
    var _img = img;
    function readPixel(e, el) {
      var cv = wrapper.querySelector('canvas');
      var wImg = wrapper.querySelector('img');
      var src = cv || wImg; if (!src) return null;
      var rect = src.getBoundingClientRect();
      var sx = src.width / rect.width;
      var sy = src.height / rect.height;
      var px = Math.floor((e.clientX - rect.left) * sx);
      var py = Math.floor((e.clientY - rect.top) * sy);
      var ctx = (cv || document.createElement('canvas')).getContext('2d');
      if (!ctx) return null;
      if (wImg && !cv) { ctx.canvas.width = wImg.naturalWidth; ctx.canvas.height = wImg.naturalHeight; ctx.drawImage(wImg, 0, 0); }
      try {
        var d = ctx.getImageData(Math.min(px, src.width-1), Math.min(py, src.height-1), 1, 1).data;
        var isFloat = false;
        var ddsC = ddsCache.get(_img.src);
        var exrC = exrCache.get(_img.src);
        if (ddsC && ddsC.dds) {
          var fam = ddsC.dds.fmt.family;
          isFloat = fam==='R16F'||fam==='R32F'||fam==='BC6H'||fam==='R11G11B10'||fam==='R16G16F'||fam==='RGB9E5'||fam==='RGBA128F'||fam==='RGB96F'||fam==='RGBA64F';
        } else if (exrC) {
          isFloat = true;
        }
        var txt;
        if (isFloat) {
          txt = 'R:' + (d[0]/255).toFixed(3) + ' G:' + (d[1]/255).toFixed(3) + ' B:' + (d[2]/255).toFixed(3) + ' A:' + (d[3]/255).toFixed(3) + ' @' + px + ',' + py;
        } else {
          txt = 'R:' + d[0] + ' G:' + d[1] + ' B:' + d[2] + ' A:' + d[3] + ' @' + px + ',' + py;
        }
        el.textContent = txt; el.style.display = 'block';
        el.style.left = (e.clientX + 12) + 'px';
        el.style.top = (e.clientY - 10) + 'px';
        return txt;
      } catch(ex) { return null; }
    }
    function makePxPin(x, y, txt) {
      var pin = document.createElement('div');
      pin.style.cssText = 'position:fixed;z-index:998;background:rgba(0,0,0,0.82);color:#8ab4f8;font-size:11px;padding:3px 7px;border-radius:3px;border:1px solid rgba(74,158,255,0.3);pointer-events:none;white-space:nowrap;font-family:monospace';
      pin.textContent = txt;
      pin.style.left = (x + 12) + 'px';
      pin.style.top = (y - 10) + 'px';
      document.body.appendChild(pin);
      pxPinnedList.push(pin);
      pin.addEventListener('dblclick', function() { pin.remove(); pxPinnedList = pxPinnedList.filter(function(p) { return p !== pin; }); });
    }
    function clearAllPins() { pxPinnedList.forEach(function(p) { p.remove(); }); pxPinnedList = []; }
    wrapper.addEventListener('contextmenu', function(e) { e.preventDefault(); });
    wrapper.addEventListener('mousedown', function(e) {
      if (e.button !== 2) return;
      e.preventDefault(); e.stopPropagation();
      pxTracking = true; pxFloat.style.display = 'block';
      readPixel(e, pxFloat);
      wrapper._pxStartX = e.clientX; wrapper._pxStartY = e.clientY;
    });
    document.addEventListener('mousemove', function(e) {
      if (!pxTracking) return;
      readPixel(e, pxFloat);
    });
    document.addEventListener('mouseup', function(e) {
      if (!pxTracking || e.button !== 2) return;
      var dx = e.clientX - (wrapper._pxStartX || 0);
      var dy = e.clientY - (wrapper._pxStartY || 0);
      var txt = pxFloat.textContent;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5 && txt) {
        makePxPin(e.clientX, e.clientY, txt);
      }
      pxFloat.style.display = 'none';
      pxTracking = false;
    });
    wrapper.addEventListener('click', function(e) {
      if (e.target && (e.target.closest('.channel-toolbar') || e.target.closest('.channel-meta'))) clearAllPins();
    });
    document.addEventListener('scroll', function() { clearAllPins(); });

    // Auto-detect channels from DDS DXGI header
    var cachedForCh = ddsCache.get(img.src);
    if (cachedForCh && cachedForCh.dds && cachedForCh.dds.fmt.dxgi) {
      var chMap = chMapFromDxgi(cachedForCh.dds.fmt.dxgi);
      tb.querySelectorAll('.channel-btn').forEach(function(btn) {
        var ch = btn.textContent;
        if (ch === 'RGB' || btn.classList.contains('flip-btn')) return;
        if (!(ch === 'RGBA' ? chMap.A : chMap[ch])) btn.style.display = 'none';
      });
      var onlyR = chMap.R && !chMap.G && !chMap.B;
      var defBtn = tb.querySelector(onlyR ? '[data-ch=R]' : '[data-ch=RGB]');
      if (defBtn) defBtn.click();
    } else {
      var defBtn = tb.querySelector('[data-ch=RGB]');
      if (defBtn) defBtn.click();
    }

    // Fetch JSON sidecar for metadata overlay
    var jsonUrl2 = img.src.replace(/\.[^.]+$/, '.json');
    var jsonPromise;
    if (jsonCache.has(jsonUrl2)) {
      jsonPromise = Promise.resolve(jsonCache.get(jsonUrl2));
    } else {
      jsonPromise = fetch(jsonUrl2).then(function(r) { if (!r.ok) throw r.status; return r.json(); });
    }
    jsonPromise.then(function(data) {
      if (!data) return;
      var rd = data.renderdoc || {}, ai = data.ai || {};

      if (data.flip_y) {
        var el = wrapper.querySelector('canvas') || wrapper.querySelector('img');
        if (el) { el.style.transform = 'scaleY(-1)'; }
        var fb = tb.querySelector('.flip-btn');
        if (fb) fb.classList.add('active');
      }
      var lines = [];
      var fname = img.src.split('/').pop();
      if (fname) lines.unshift(fname);
      ['event_id','file_type'].forEach(function(k) { if (data[k] !== undefined) lines.push(k + ': ' + data[k]); });
      var cachedFmt = ddsCache.get(img.src);
      var ddsFmt = cachedFmt && cachedFmt.dds ? cachedFmt.dds.fmt : null;
      if (rd.format) lines.push('format: ' + rd.format);
      else if (ddsFmt) lines.push('format: ' + (ddsFmt.type || '') + ' (DXGI ' + ddsFmt.dxgi + ')');
      if (rd.size) lines.push('size: ' + rd.size);
      else lines.push('size: ' + w + 'x' + h);
      if (rd.mips !== undefined) lines.push('mips: ' + rd.mips);
      else if (cachedFmt && cachedFmt.dds) lines.push('mips: ' + cachedFmt.dds.mips);
      var cachedDds = ddsCache.get(img.src);
      if (cachedDds && cachedDds.dds && cachedDds.dds.mipList) {
        cachedDds.dds.mipList.forEach(function(m, i) {
          var sizeKB = (m.size / 1024).toFixed(1);
          lines.push('  Lv' + i + ': ' + m.w + '\u00d7' + m.h + '  ' + (m.size >= 1048576 ? (m.size / 1048576).toFixed(1) + ' MB' : sizeKB + ' KB'));
        });
      }
      if (rd.array_size !== undefined) lines.push('array_size: ' + rd.array_size);
      var totalMips;
      var cachedM = ddsCache.get(img.src);
      var ddsMips = cachedM && cachedM.dds ? cachedM.dds.mips : 1;
      if (data.mip === -1) {
        totalMips = ddsMips;
      } else {
        totalMips = parseInt(rd.mips) || ddsMips;
      }
      var maxMip = Math.max(0, totalMips - 1);
      var curMipTop = (data.mip === -1 || parseInt(data.mip) >= totalMips) ? 0 : Math.max(0, Math.min(parseInt(data.mip) || 0, maxMip));
      lines.push('mip: ' + curMipTop);
      if (ai.content || ai.pipeline_stage) {
        if (ai.pipeline_stage) lines.push('[AI] stage: ' + ai.pipeline_stage);
        if (ai.content) lines.push('[AI] ' + ai.content);
      }
      if (!lines.length) return;
      var meta = document.createElement('div'); meta.className = 'channel-meta';
      var inner = document.createElement('div'); inner.className = 'channel-meta-inner';
      inner.textContent = lines.join('\n');
      var cachedDdsArr = ddsCache.get(img.src);
      var totalArray = cachedDdsArr && cachedDdsArr.dds ? cachedDdsArr.dds.arraySize : 1;
      if (totalArray <= 1) totalArray = parseInt(rd.array_size) || 0;
      var curSlice = 0;

      var renderSliceMip = function(s, n) {
        if (s !== undefined) curSlice = s;
        if (n !== undefined) curMip = n;
        var cached = ddsCache.get(img.src);
        if (cached && cached.dds) {
          var px = cached.dds.getMip(curMip, curSlice); if (!px) return;
          var mw = Math.max(1, cached.dds.w >> curMip);
          var mh = Math.max(1, cached.dds.h >> curMip);
          var cv = wrapper.querySelector('canvas');
          if (!cv) { cv = document.createElement('canvas'); cv.className = 'channel-canvas'; wrapper.appendChild(cv); }
          cv.width = mw; cv.height = mh;
          cv.getContext('2d').putImageData(new ImageData(px, mw, mh), 0, 0);
          cv.style.width = displayW + 'px';
          cv.style.height = tinyDim ? displayH + 'px' : 'auto';
          straight = px;
          pxCache.set(img.src, px);
          curW = mw; curH = mh;
          var activeBtn = tb.querySelector('.channel-btn.active');
          if (activeBtn) activeBtn.click();
        }
      };
      var curMip = curMipTop;

      var rowStyle = 'display:flex;align-items:center;justify-content:flex-end;gap:4px;padding:2px 3px;background:rgba(0,0,0,0.45);border-radius:3px;margin:1px 0;width:100%';
      if (totalMips > 1) {
        var mipRow = document.createElement('div');
        mipRow.style.cssText = rowStyle;
        var mipLabel = document.createElement('span');
        mipLabel.style.cssText = 'color:#e8eaed;font-size:10px;min-width:32px;text-align:center';
        mipLabel.textContent = 'Lv.' + curMip + ' / ' + (totalMips-1);
        var mipSlider = document.createElement('input');
        mipSlider.type = 'range'; mipSlider.min = 0; mipSlider.max = totalMips - 1; mipSlider.value = curMip;
        mipSlider.style.cssText = 'width:60px;height:10px;cursor:pointer;accent-color:#4a9eff';
        mipSlider.addEventListener('input', function(e) { e.stopPropagation(); renderSliceMip(undefined, parseInt(mipSlider.value)); mipLabel.textContent = 'Lv.' + mipSlider.value + ' / ' + (totalMips-1); });
        mipRow.appendChild(mipLabel);
        mipRow.appendChild(mipSlider);
        tb.appendChild(mipRow);
      }
      if (totalArray > 1) {
        var arrRow = document.createElement('div');
        arrRow.style.cssText = rowStyle;
        var arrLabel = document.createElement('span');
        arrLabel.style.cssText = 'color:#e8eaed;font-size:10px;min-width:28px;text-align:center';
        arrLabel.textContent = 'F.' + curSlice + '/' + (totalArray-1);
        var arrSlider = document.createElement('input');
        arrSlider.type = 'range'; arrSlider.min = 0; arrSlider.max = totalArray - 1; arrSlider.value = 0;
        arrSlider.style.cssText = 'width:60px;height:10px;cursor:pointer;accent-color:#f0a030';
        arrSlider.addEventListener('input', function(e) { e.stopPropagation(); renderSliceMip(parseInt(arrSlider.value), undefined); arrLabel.textContent = 'F.' + arrSlider.value + '/' + (totalArray-1); });
        arrRow.appendChild(arrLabel);
        arrRow.appendChild(arrSlider);
        tb.appendChild(arrRow);
      }
      meta.appendChild(inner);
      var btnRow = document.createElement('div');
      btnRow.className = 'channel-meta-btns';
      var browserBtn = document.createElement('button');
      browserBtn.className = 'channel-meta-copy';
      browserBtn.textContent = '\u590d\u5236\u94fe\u63a5';
      browserBtn.addEventListener('click', function(e) {
        e.stopPropagation(); e.preventDefault();
        navigator.clipboard.writeText(img.src).then(function() {
          browserBtn.textContent = '\u5df2\u590d\u5236';
          browserBtn.classList.add('copied');
          setTimeout(function() { browserBtn.textContent = '\u590d\u5236\u94fe\u63a5'; browserBtn.classList.remove('copied'); }, 1500);
        });
      });
      var localBtn = document.createElement('button');
      localBtn.className = 'channel-meta-copy';
      localBtn.textContent = '\u672c\u5730\u8def\u5f84';
      localBtn.addEventListener('click', function(e) {
        e.stopPropagation(); e.preventDefault();
        var cfg = window.ImageViewerConfig || {};
        var workingDir = cfg.workingDir || '';
        var localPath = (workingDir + '/content' + decodeURI(new URL(img.src).pathname)).replace(/\//g, '\\');
        navigator.clipboard.writeText(localPath).then(function() {
          localBtn.textContent = '\u5df2\u590d\u5236';
          localBtn.classList.add('copied');
          setTimeout(function() { localBtn.textContent = '\u672c\u5730\u8def\u5f84'; localBtn.classList.remove('copied'); }, 1500);
        });
      });
      btnRow.appendChild(browserBtn);
      btnRow.appendChild(localBtn);
      meta.appendChild(btnRow);
      wrapper.appendChild(meta);
    }).catch(function(){});
  }

  // ---- Image loader ----
  function showErrorPlaceholder(img, w, h) {
    w = w || 64; h = h || 64;
    var cv = document.createElement('canvas');
    cv.className = 'channel-canvas'; cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('decode error', w/2, h/2);
    cv.style.width = Math.min(w, 400) + 'px';
    cv.style.height = Math.min(h, 400) + 'px';
    cv.style.opacity = '0.6';
    var parent = img.parentNode;
    if (parent.tagName === 'P') {
      parent.parentNode.insertBefore(cv, parent);
    } else {
      img.parentNode.insertBefore(cv, img);
    }
    img.style.display = 'none';
  }

  function loadImage(img) {
    if (img.closest('.channel-container') || img.closest('a')) return;
    img._processed = true;

    // DDS
    if (/\.dds$/i.test(img.src)) {
      var ddsCached = ddsCache.get(img.src);
      if (ddsCached) { processImage(img, ddsCached.dds.w, ddsCached.dds.h, ddsCached.mip0); return; }
      var jsonUrl = img.src.replace(/\.dds$/i, '.json');
      if (!jsonCache.has(jsonUrl)) {
        fetch(jsonUrl).then(function(r) { if (r.ok) return r.json(); }).then(function(d) { if (d) jsonCache.set(jsonUrl, d); }).catch(function(){});
      }
      img.style.outline = '1px dashed #555';
      fetch(img.src).then(function(r) { if (!r.ok) throw r.status; return r.arrayBuffer(); }).then(function(buf) {
        if (!buf) throw 'empty';
        var dds = DDS.parse(buf);
        if (!dds) throw 'parse';
        var dfam = dds.fmt.family;
        if (dds.fmt.isComp && dfam!=='BC1'&&dfam!=='BC3'&&dfam!=='BC4'&&dfam!=='BC5') {
          var mip0 = dds.getMip(0);
          if (!mip0) throw 'decode';
          ddsCache.set(img.src, {dds:dds, mip0:mip0});
          img.style.outline = '';
          processImage(img, dds.w, dds.h, mip0);
          return;
        }
        var typeOverride = null;
        var jsonData = jsonCache.get(jsonUrl);
        if (jsonData) {
          var rdFmt = (jsonData.renderdoc || {}).format || '';
          if (/TYPELESS/i.test(rdFmt) && dds.fmt.family === 'R16F') typeOverride = 'R16';
        }
        decodeWorker.decode('dds', buf, function(result) {
          img.style.outline = '';
          if (!result.ok) { showErrorPlaceholder(img, dds.w, dds.h); return; }
          ddsCache.set(img.src, {dds:dds, mip0:result.pixels});
          processImage(img, result.w, result.h, result.pixels);
        }, false, typeOverride);
      }).catch(function(e){ img.style.outline = ''; showErrorPlaceholder(img); });
      return;
    }

    // EXR
    if (/\.exr$/i.test(img.src)) {
      var exrCached = exrCache.get(img.src);
      if (exrCached) { processImage(img, exrCached.exr.w, exrCached.exr.h, exrCached.rgba8); return; }
      var jsonUrlExr = img.src.replace(/\.exr$/i, '.json');
      if (!jsonCache.has(jsonUrlExr)) {
        fetch(jsonUrlExr).then(function(r) { if (r.ok) return r.json(); }).then(function(d) { if (d) jsonCache.set(jsonUrlExr, d); }).catch(function(){});
      }
      img.style.outline = '1px dashed #555';
      fetch(img.src).then(function(r) { if (!r.ok) throw r.status; return r.arrayBuffer(); }).then(function(buf) {
        if (!buf) throw 'empty';
        decodeWorker.decode('exr', buf, function(result) {
          img.style.outline = '';
          if (!result.ok) { showErrorPlaceholder(img); return; }
          exrCache.set(img.src, {exr:{w:result.w,h:result.h}, rgba8:result.pixels});
          processImage(img, result.w, result.h, result.pixels);
        }, true);
      }).catch(function(){ img.style.outline = ''; showErrorPlaceholder(img); });
      return;
    }

    // Standard (PNG/JPEG/WebP)
    var onload = function() {
      if (img.closest('.channel-container')) return;
      img.removeEventListener('load', onload);
      processImage(img, img.naturalWidth, img.naturalHeight, null);
    };
    if (img.complete && img.naturalWidth > 0) { onload(); }
    else { img.addEventListener('load', onload); }
  }

  // ---- Lazy Loading via IntersectionObserver ----
  var imgs = c.querySelectorAll('img');
  if (!imgs.length) return;

  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          loadImage(entry.target);
        }
      });
    }, { rootMargin: '800px' });

    imgs.forEach(function(img) { observer.observe(img); });
  } else {
    imgs.forEach(function(img) { loadImage(img); });
  }
})();
