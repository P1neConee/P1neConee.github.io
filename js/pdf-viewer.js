// source/js/pdf-viewer.js
// 为 {% pdf %} 标签提供：① 折叠 / 展开  ② 懒加载 pdf.js 并渲染  ③ 翻页 / 缩放 / 缩略图 / 全屏 / 键盘 / 滑动
// 由 _config.stellar.yml 的 inject.head_end 注入，全局只执行一次（事件委托）。
// 样式见 source/css/pdf-viewer.css。
//
// 性能约定：pdf.min.js + pdf.worker.min.js（约 1.4MB）只在用户第一次展开某个 PDF 时按需下载，
// 因此未展开的 PDF 与不含 PDF 的页面都不会产生这部分流量。全部资源本地自托管，不走 CDN。
//
// 与 PPT 观看器的差异：PDF 各页比例可能不同，这里不做全局比例锁定，
// 而是每页按自身比例算出「适应容器的基准缩放」，再乘以用户选择的缩放系数。
(function () {
  if (window.__pdfViewerReady) return;
  window.__pdfViewerReady = true;

  var LIB = '/js/vendor/pdf.min.js';
  var WORKER = '/js/vendor/pdf.worker.min.js';
  var ZOOMS = [0.75, 1, 1.25, 1.5, 2, 3];   // 1 = 适应容器
  var THUMB_W = 112;                         // 缩略图目标宽度（px）
  var libPromise = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('无法加载 ' + src)); };
      document.head.appendChild(s);
    });
  }

  function ensureLib() {
    if (libPromise) return libPromise;
    libPromise = loadScript(LIB)
      .then(function () {
        if (!window.pdfjsLib) throw new Error('pdf.js 未正确加载');
        // worker 也必须本地化，否则 pdf.js 会退回从 CDN 取（离线/内网会失败）
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;
      })
      .catch(function (err) {
        libPromise = null;   // 失败后允许重试
        throw err;
      });
    return libPromise;
  }

  // ---------- 小工具 ----------
  function q(box, sel) { return box.querySelector(sel); }
  function setState(box, text, isError) {
    var el = q(box, '.pdf-view__state');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle('is-error', !!isError);
  }
  function setCollapsed(box, collapsed) {
    var body = q(box, '.pdf-view__body');
    var btn = q(box, '.pdf-view__collapse');
    if (body) body.hidden = !!collapsed;
    box.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
    if (btn) {
      btn.textContent = collapsed ? '展开' : '折叠';
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    if (!collapsed) init(box);
  }

  function updateUI(box) {
    var st = box.__pdf;
    if (!st) return;
    var num = q(box, '.pdf-view__num');
    if (num) num.textContent = st.count ? (st.idx + 1) + ' / ' + st.count : '– / –';
    var navs = box.querySelectorAll('.pdf-view__nav');
    for (var i = 0; i < navs.length; i++) {
      var dir = Number(navs[i].getAttribute('data-dir'));
      navs[i].disabled = st.count <= 1 || (dir < 0 ? st.idx <= 0 : st.idx >= st.count - 1);
    }
    var meta = q(box, '.pdf-view__meta');
    if (meta && st.count) meta.textContent = st.count + ' 页';
    var scale = q(box, '.pdf-view__scale');
    if (scale) {
      var z = ZOOMS[st.zoom];
      scale.textContent = (z === 1 ? '适应' : Math.round(z * 100) + '%');
    }
    var outs = box.querySelectorAll('.pdf-view__zoom');
    for (var k = 0; k < outs.length; k++) {
      var act = outs[k].getAttribute('data-act');
      outs[k].disabled = act === 'out' ? st.zoom <= 0 : st.zoom >= ZOOMS.length - 1;
    }
    var thumbs = box.querySelectorAll('.pdf-view__thumb');
    for (var j = 0; j < thumbs.length; j++) {
      thumbs[j].classList.toggle('is-active', Number(thumbs[j].getAttribute('data-index')) === st.idx);
    }
  }

  // ---------- 加载文档 ----------
  function init(box) {
    if (!box) return;
    var st = box.__pdf;
    if (st && (st.loading || st.ready)) return;

    box.__pdf = {
      loading: true, ready: false, idx: 0, count: 0, zoom: 1,
      doc: null, canvas: q(box, '.pdf-view__canvas'),
      baseSize: null,      // 当前页在 scale=1 时的尺寸（px）
      renderTask: null
    };
    st = box.__pdf;
    // 供朗读功能调用：翻到第 i 页（0 基）
    st.goTo = function (i) {
      if (!st.doc || i < 0 || i >= st.count) return Promise.resolve();
      st.idx = i;
      updateUI(box);
      return render(box);
    };
    setState(box, '正在加载文档…', false);
    lastActive = box;

    ensureLib()
      .then(function () {
        return window.pdfjsLib.getDocument({
          url: encodeURI(box.getAttribute('data-src')),
          // 关闭 worker 里的字体/CDN 拉取，保证纯本地运行
          disableAutoFetch: true,
          isEvalSupported: false
        }).promise;
      })
      .then(function (doc) {
        st.doc = doc;
        st.count = doc.numPages || 0;
        if (!st.count) throw new Error('这个 PDF 里没有可显示的页面');
        updateUI(box);
        return render(box);
      })
      .then(function () {
        st.ready = true;
        st.loading = false;
        setState(box, '', false);
        updateUI(box);
        // 缩略图不在这里生成：容器此时还是隐藏的，量不到尺寸会渲染成默认的 300×150。
        // 改为用户第一次点「缩略图」按钮时再生成（见下方点击委托）。
      })
      .catch(function (err) {
        st.loading = false;
        st.ready = false;
        // pdf.js 的原始报错是英文，这里换成能看懂的说法
        var raw = err && err.message ? err.message : String(err);
        var msg;
        if (/Missing PDF/i.test(raw)) msg = '找不到这个 PDF（路径可能已变动）';
        else if (/Invalid PDF/i.test(raw)) msg = '这个文件不是有效的 PDF';
        else if (/password/i.test(raw)) msg = '这个 PDF 已加密，需要密码才能打开';
        else msg = raw;
        setState(box, '加载失败：' + msg, true);
      });
  }

  // ---------- 渲染当前页 ----------
  // 1) 用 scale=1 拿到页面原始尺寸  2) 算出「适应容器」的基准缩放  3) 乘以用户缩放系数
  function render(box) {
    var st = box.__pdf;
    if (!st || !st.doc) return Promise.resolve();
    var stage = q(box, '.pdf-view__stage');
    var canvas = st.canvas;
    if (!stage || !canvas) return Promise.resolve();
    if (st.renderTask) { try { st.renderTask.cancel(); } catch (e) {} st.renderTask = null; }

    return st.doc.getPage(st.idx + 1).then(function (page) {
      var base = page.getViewport({ scale: 1 });
      st.baseSize = { w: base.width, h: base.height };
      // 用真实页比例覆盖构建期的占位比例：构建期读不到 MediaBox（对象流压缩）时会退化成 A4，
      // 而占位比例只影响缩略图的 CSS aspect-ratio，不修正就会把横向 PDF 的缩略图压扁。
      if (base.width > 0 && base.height > 0) {
        box.style.setProperty('--pdf-ratio', (base.width / base.height).toFixed(5));
      }
      var availW = stage.clientWidth - 2;
      var availH = stage.clientHeight - 2;
      var fit = Math.min(availW / base.width, availH / base.height);
      var scale = fit * ZOOMS[st.zoom];

      var viewport = page.getViewport({ scale: scale });
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';

      // 放大到超出容器时改左上角对齐，否则居中的溢出部分会滚不到
      stage.classList.toggle(
        'is-overflow',
        viewport.width > stage.clientWidth || viewport.height > stage.clientHeight
      );

      var ctx = canvas.getContext('2d');
      var task = page.render({
        canvasContext: ctx,
        viewport: viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
      });
      st.renderTask = task;
      return task.promise.then(function () { st.renderTask = null; });
    });
  }

  function goTo(box, index) {
    var st = box.__pdf;
    if (!st || !st.ready) return;
    index = Math.max(0, Math.min(st.count - 1, index));
    st.idx = index;
    updateUI(box);
    var stage = q(box, '.pdf-view__stage');
    if (stage) { stage.scrollTop = 0; stage.scrollLeft = 0; }
    render(box).catch(function () { setState(box, '渲染第 ' + (index + 1) + ' 页失败', true); });
  }

  function step(box, dir) {
    var st = box.__pdf;
    if (!st || !st.ready) return;
    goTo(box, st.idx + dir);
  }

  // 缩放：以「适应容器」为 1，按 ZOOMS 档位切换后重绘
  function zoom(box, act) {
    var st = box.__pdf;
    if (!st || !st.ready) return;
    var next = st.zoom + (act === 'in' ? 1 : -1);
    if (next < 0 || next >= ZOOMS.length) return;
    st.zoom = next;
    updateUI(box);
    render(box).catch(function () {});
  }

  // ---------- 缩略图 ----------
  function buildThumbs(box) {
    var wrap = q(box, '.pdf-view__thumbs');
    var st = box.__pdf;
    if (!wrap || !st || !st.ready) return;
    wrap.innerHTML = '';
    var i = 0;
    function next() {
      if (!box.__pdf || box.__pdf !== st) return;   // 已被销毁 / 重新加载
      if (i >= st.count) return;
      var btn = document.createElement('button');
      btn.className = 'pdf-view__thumb';
      btn.type = 'button';
      btn.setAttribute('data-index', String(i));
      btn.title = '第 ' + (i + 1) + ' 页';
      var c = document.createElement('canvas');
      var num = document.createElement('span');
      num.textContent = String(i + 1);
      btn.appendChild(c);
      btn.appendChild(num);
      wrap.appendChild(btn);
      var idx = i;
      i++;
      return st.doc.getPage(idx + 1)
        .then(function (page) {
          var base = page.getViewport({ scale: 1 });
          var vp = page.getViewport({ scale: THUMB_W / base.width });
          var dpr = Math.min(window.devicePixelRatio || 1, 2);
          c.width = Math.floor(vp.width * dpr);
          c.height = Math.floor(vp.height * dpr);
          return page.render({
            canvasContext: c.getContext('2d'),
            viewport: vp,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
          }).promise;
        })
        .catch(function () {})     // 单页失败不应中断整个缩略图生成
        .then(next);
    }
    next();
  }

  // ---------- 全屏 ----------
  function requestFS(el) {
    var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (fn) return fn.call(el);
    return Promise.reject(new Error('浏览器不支持全屏'));
  }
  function exitFS() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (fn) return fn.call(document);
    return Promise.resolve();
  }
  function isFS(el) {
    var cur = document.fullscreenElement || document.webkitFullscreenElement;
    return !!cur && cur === el;
  }
  function toggleFS(box) {
    var player = q(box, '.pdf-view__player');
    var btn = q(box, '.pdf-view__fs');
    if (!player) return;
    if (isFS(player)) {
      exitFS().catch(function () {});
    } else {
      requestFS(player).catch(function () { setState(box, '当前浏览器不允许进入全屏', true); });
    }
    if (btn) btn.textContent = isFS(player) ? '全屏' : '退出全屏';
  }

  // ---------- 键盘：作用于最后交互过的（或全屏中的）阅读器 ----------
  var lastActive = null;
  function activeBox() {
    var cur = document.fullscreenElement || document.webkitFullscreenElement;
    if (cur) {
      var inFs = cur.querySelector ? cur.querySelector('.pdf-view') : null;
      if (inFs) return inFs;
    }
    if (lastActive && document.body.contains(lastActive)) return lastActive;
    var list = document.querySelectorAll('.pdf-view[data-collapsed="false"]');
    return list.length === 1 ? list[0] : null;
  }

  document.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'PageUp' && k !== 'PageDown') return;
    var t = e.target;
    var tag = (t && t.tagName ? t.tagName : '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
    var box = activeBox();
    if (!box || !box.__pdf || !box.__pdf.ready) return;
    // 放大后方向键需要用来滚动页面，此时不劫持
    var stage = q(box, '.pdf-view__stage');
    if (stage && (stage.scrollWidth > stage.clientWidth + 4 || stage.scrollHeight > stage.clientHeight + 4)) return;
    e.preventDefault();
    step(box, (k === 'ArrowRight' || k === 'PageDown') ? 1 : -1);
  });

  document.addEventListener('fullscreenchange', function () {
    var list = document.querySelectorAll('.pdf-view');
    for (var i = 0; i < list.length; i++) {
      var player = q(list[i], '.pdf-view__player');
      var btn = q(list[i], '.pdf-view__fs');
      if (player && btn) btn.textContent = isFS(player) ? '退出全屏' : '全屏';
      if (player && isFS(player)) {
        // 全屏后容器尺寸变了，按新尺寸重新渲染
        setTimeout(function (box) { return function () {
          var st = box.__pdf;
          if (st && st.ready) render(box);
        }; }(list[i]), 120);
      }
    }
  });

  // 窗口尺寸变化（含手机横竖屏切换）后重绘，避免画布停留在旧尺寸
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var list = document.querySelectorAll('.pdf-view');
      for (var i = 0; i < list.length; i++) {
        var box = list[i];
        if (box.__pdf && box.__pdf.ready && box.getAttribute('data-collapsed') === 'false') render(box);
      }
    }, 300);
  });
  window.addEventListener('orientationchange', function () {
    setTimeout(function () {
      var list = document.querySelectorAll('.pdf-view');
      for (var i = 0; i < list.length; i++) {
        var box = list[i];
        if (box.__pdf && box.__pdf.ready) render(box);
      }
    }, 400);
  });

  // ---------- 移动端左右滑动翻页 ----------
  var touch = null;
  document.addEventListener('touchstart', function (e) {
    var stage = e.target.closest ? e.target.closest('.pdf-view__stage') : null;
    if (!stage) return;
    // 已放大时滑动应留给内容滚动，不翻页
    if (stage.scrollWidth > stage.clientWidth + 4) { touch = null; return; }
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, box: stage.closest('.pdf-view') };
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!touch || !touch.box) return;
    var t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    var dx = t.clientX - touch.x;
    var dy = t.clientY - touch.y;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      step(touch.box, dx < 0 ? 1 : -1);
    }
    touch = null;
  }, { passive: true });

  // ---------- 点击委托 ----------
  document.addEventListener('click', function (e) {
    var t = e.target;

    var nav = t.closest && t.closest('.pdf-view__nav');
    if (nav) {
      var nb = nav.closest('.pdf-view');
      lastActive = nb;
      step(nb, Number(nav.getAttribute('data-dir')));
      return;
    }

    var zb = t.closest && t.closest('.pdf-view__zoom');
    if (zb) {
      var zbBox = zb.closest('.pdf-view');
      lastActive = zbBox;
      zoom(zbBox, zb.getAttribute('data-act'));
      return;
    }

    var thBtn = t.closest && t.closest('.pdf-view__thumbs-btn');
    if (thBtn) {
      var tb = thBtn.closest('.pdf-view');
      var wrap = q(tb, '.pdf-view__thumbs');
      if (wrap) {
        wrap.hidden = !wrap.hidden;
        thBtn.textContent = wrap.hidden ? '缩略图' : '收起';
        // 第一次展开时才生成：容器可见，才能量到正确尺寸
        var tst = tb.__pdf;
        if (!wrap.hidden && tst && tst.ready && !tst.thumbsBuilt) {
          tst.thumbsBuilt = true;
          buildThumbs(tb);
        }
      }
      lastActive = tb;
      return;
    }

    var th = t.closest && t.closest('.pdf-view__thumb');
    if (th) {
      var hb = th.closest('.pdf-view');
      lastActive = hb;
      goTo(hb, Number(th.getAttribute('data-index')));
      return;
    }

    var fs = t.closest && t.closest('.pdf-view__fs');
    if (fs) {
      lastActive = fs.closest('.pdf-view');
      toggleFS(lastActive);
      return;
    }

    var col = t.closest && t.closest('.pdf-view__collapse');
    if (col) {
      var cb = col.closest('.pdf-view');
      lastActive = cb;
      setCollapsed(cb, cb.getAttribute('data-collapsed') !== 'true');
      return;
    }

    var header = t.closest && t.closest('.pdf-view__header');
    if (header) {
      if (t.closest && t.closest('a')) return;       // 点「下载」只下载，不折叠
      var hbx = header.closest('.pdf-view');
      lastActive = hbx;
      setCollapsed(hbx, hbx.getAttribute('data-collapsed') !== 'true');
    }
  });

  // 若标签带了 open:true，页面加载后自动初始化
  window.addEventListener('load', function () {
    var list = document.querySelectorAll('.pdf-view[data-collapsed="false"]');
    for (var i = 0; i < list.length; i++) init(list[i]);
  });
})();
