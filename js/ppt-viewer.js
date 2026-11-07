// source/js/ppt-viewer.js
// 为 {% ppt %} 标签提供：① 折叠 / 展开  ② 懒加载解析库并渲染  ③ 翻页 / 缩略图 / 全屏 / 键盘 / 滑动
// 由 _config.stellar.yml 的 inject.head_end 注入，全局只执行一次（事件委托）。
// 样式见 source/css/ppt-viewer.css。
//
// 性能约定：jszip + chart.js + PptxViewJS（约 900KB）只在用户第一次展开某个 PPT 时按需下载，
// 因此未展开的 PPT 与不含 PPT 的页面都不会产生这部分流量。
(function () {
  if (window.__pptViewerReady) return;
  window.__pptViewerReady = true;

  var VENDORS = [
    '/js/vendor/jszip.min.js',
    '/js/vendor/chart.umd.min.js',
    '/js/vendor/PptxViewJS.min.js'
  ];
  var FONT_BASE = '/fonts/';       // Carlito（Calibri 等宽替代字体）本地自托管，不走 CDN
  var libsPromise = null;

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

  function ensureLibs() {
    if (libsPromise) return libsPromise;
    libsPromise = loadScript(VENDORS[0])
      .then(function () { return loadScript(VENDORS[1]); })
      .then(function () { return loadScript(VENDORS[2]); })
      .then(function () {
        if (!window.PptxViewJS || !window.PptxViewJS.PPTXViewer) {
          throw new Error('PptxViewJS 未正确加载');
        }
      })
      .catch(function (err) {
        libsPromise = null;   // 失败后允许重试
        throw err;
      });
    return libsPromise;
  }

  // ---------- 小工具 ----------
  function q(box, sel) { return box.querySelector(sel); }
  function setState(box, text, isError) {
    var el = q(box, '.ppt-view__state');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle('is-error', !!isError);
  }
  function setCollapsed(box, collapsed) {
    var body = q(box, '.ppt-view__body');
    var btn = q(box, '.ppt-view__collapse');
    if (body) body.hidden = !!collapsed;
    box.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
    if (btn) {
      btn.textContent = collapsed ? '展开' : '折叠';
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    if (!collapsed) init(box);
  }

  function updateUI(box) {
    var st = box.__ppt;
    if (!st) return;
    var num = q(box, '.ppt-view__num');
    if (num) num.textContent = st.count ? (st.idx + 1) + ' / ' + st.count : '– / –';
    var navs = box.querySelectorAll('.ppt-view__nav');
    for (var i = 0; i < navs.length; i++) {
      var dir = Number(navs[i].getAttribute('data-dir'));
      navs[i].disabled = st.count <= 1 || (dir < 0 ? st.idx <= 0 : st.idx >= st.count - 1);
    }
    var meta = q(box, '.ppt-view__meta');
    if (meta && st.count) meta.textContent = st.count + ' 页';
    var thumbs = box.querySelectorAll('.ppt-view__thumb');
    for (var j = 0; j < thumbs.length; j++) {
      thumbs[j].classList.toggle('is-active', Number(thumbs[j].getAttribute('data-index')) === st.idx);
    }
  }

  // ---------- 加载并渲染 ----------
  function init(box) {
    if (!box) return;
    var st = box.__ppt;
    if (st && (st.loading || st.ready)) return;

    box.__ppt = { loading: true, ready: false, idx: 0, count: 0, viewer: null, canvas: q(box, '.ppt-view__canvas') };
    st = box.__ppt;
    // 供朗读功能调用：翻到第 i 页（0 基）
    st.goTo = function (i) {
      if (!st.viewer || i < 0 || i >= st.count) return Promise.resolve();
      st.idx = i;
      updateUI(box);
      return st.viewer.goToSlide(i)
        .then(function () { return st.viewer.render(st.canvas); })
        .catch(function () {});
    };
    setState(box, '正在加载演示文稿…', false);
    lastActive = box;

    ensureLibs()
      .then(function () {
        var viewer = new window.PptxViewJS.PPTXViewer({
          canvas: st.canvas,
          fontBaseUrl: FONT_BASE,
          slideSizeMode: 'fit',
          // 库默认会在 load 后 200ms 自行重渲染一次（为兜住晚解析的图表），
          // 但它会顺手把当前页索引重置回第 0 页 —— 用户若刚好在这时翻页，
          // 画面会被拉回第一页。这里关掉，改由下面我们自己按「当前页」补一次重绘。
          autoChartRerenderDelayMs: 0
        });
        st.viewer = viewer;
        return viewer.loadFromUrl(encodeURI(box.getAttribute('data-src')));
      })
      .then(function () {
        st.count = st.viewer.getSlideCount() || 0;
        if (!st.count) throw new Error('这个 PPT 里没有可显示的页面');
        st.idx = 0;
        updateUI(box);
        return st.viewer.render(st.canvas);
      })
      .then(function () {
        st.ready = true;
        st.loading = false;
        setState(box, '', false);
        updateUI(box);
        // 替代库自带的延迟重渲染：晚一点再按「当前页」补画一次，兜住晚解析的图表。
        // 用当前页而不是第 0 页，所以即使用户已经翻页也不会被拉回去。
        setTimeout(function () { reRender(box); }, 250);
        // 缩略图不在这里生成：容器此时还是隐藏的，量不到尺寸会渲染成默认的 300×150。
        // 改为用户第一次点「缩略图」按钮时再生成（见下方点击委托）。
      })
      .catch(function (err) {
        st.loading = false;
        st.ready = false;
        setState(box, '加载失败：' + (err && err.message ? err.message : err), true);
      });
  }

  // 缩略图：逐页渲染到小 canvas，渲染完把主画布恢复到当前页
  function buildThumbs(box) {
    var wrap = q(box, '.ppt-view__thumbs');
    var st = box.__ppt;
    if (!wrap || !st || !st.ready) return;
    wrap.innerHTML = '';
    var i = 0;
    function next() {
      if (!box.__ppt || box.__ppt !== st) return;   // 已被销毁 / 重新加载
      if (i >= st.count) {
        // 缩略图渲染会改变当前页指针，渲染完回到原来那一页并同步高亮
        return st.viewer.goToSlide(st.idx)
          .then(function () { return st.viewer.render(st.canvas); })
          .then(function () { updateUI(box); })
          .catch(function () {});
      }
      var btn = document.createElement('button');
      btn.className = 'ppt-view__thumb';
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
      // 单页渲染失败不应中断整个缩略图生成
      return st.viewer.renderSlide(idx, c).catch(function () {}).then(next);
    }
    next();
  }

  // 容器尺寸变化（窗口缩放 / 横竖屏切换 / 进出全屏）后按新尺寸重绘。
  // 渲染引擎会把 canvas 的 style.width/height 写成固定 px，所以重绘前先清掉。
  function reRender(box) {
    var st = box.__ppt;
    if (!st || !st.ready || !st.canvas) return;
    var body = q(box, '.ppt-view__body');
    if (body && body.hidden) return;
    st.canvas.style.width = '';
    st.canvas.style.height = '';
    st.viewer.render(st.canvas)
      .then(function () { updateUI(box); })
      .catch(function () {});
  }

  function goTo(box, index) {
    var st = box.__ppt;
    if (!st || !st.ready) return;
    index = Math.max(0, Math.min(st.count - 1, index));
    if (index === st.idx) return;
    st.idx = index;
    updateUI(box);
    st.viewer.goToSlide(index)
      .then(function () { return st.viewer.render(st.canvas); })
      .then(function () { updateUI(box); })
      .catch(function () { setState(box, '渲染第 ' + (index + 1) + ' 页失败', true); });
  }

  function step(box, dir) {
    var st = box.__ppt;
    if (!st || !st.ready) return;
    goTo(box, st.idx + dir);
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
    var player = q(box, '.ppt-view__player');
    var btn = q(box, '.ppt-view__fs');
    if (!player) return;
    if (isFS(player)) {
      exitFS().catch(function () {});
    } else {
      requestFS(player).catch(function () { setState(box, '当前浏览器不允许进入全屏', true); });
    }
    if (btn) btn.textContent = isFS(player) ? '全屏' : '退出全屏';
  }

  // ---------- 键盘：作用于最后交互过的（或全屏中的）观看器 ----------
  var lastActive = null;
  function activeBox() {
    var cur = document.fullscreenElement || document.webkitFullscreenElement;
    if (cur) {
      var inFs = cur.querySelector ? cur.querySelector('.ppt-view') : null;
      if (inFs) return inFs;
    }
    if (lastActive && document.body.contains(lastActive)) return lastActive;
    var list = document.querySelectorAll('.ppt-view[data-collapsed="false"]');
    return list.length === 1 ? list[0] : null;
  }

  document.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'PageUp' && k !== 'PageDown') return;
    var t = e.target;
    var tag = (t && t.tagName ? t.tagName : '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return;
    var box = activeBox();
    if (!box || !box.__ppt || !box.__ppt.ready) return;
    e.preventDefault();
    step(box, (k === 'ArrowRight' || k === 'PageDown') ? 1 : -1);
  });

  document.addEventListener('fullscreenchange', function () {
    var list = document.querySelectorAll('.ppt-view');
    for (var i = 0; i < list.length; i++) {
      var player = q(list[i], '.ppt-view__player');
      var btn = q(list[i], '.ppt-view__fs');
      if (player && btn) btn.textContent = isFS(player) ? '退出全屏' : '全屏';
      if (player && isFS(player)) {
        // 全屏后画布尺寸变了，重新按新尺寸渲染一次
        setTimeout(function (box) { return function () { reRender(box); }; }(list[i]), 120);
      }
    }
  });

  // 窗口尺寸变化（含手机横竖屏切换）后重绘，避免画布停留在旧的固定像素尺寸
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var list = document.querySelectorAll('.ppt-view');
      for (var i = 0; i < list.length; i++) reRender(list[i]);
    }, 300);
  });
  window.addEventListener('orientationchange', function () {
    setTimeout(function () {
      var list = document.querySelectorAll('.ppt-view');
      for (var i = 0; i < list.length; i++) reRender(list[i]);
    }, 400);
  });

  // ---------- 移动端左右滑动翻页 ----------
  var touch = null;
  document.addEventListener('touchstart', function (e) {
    var stage = e.target.closest ? e.target.closest('.ppt-view__stage') : null;
    if (!stage) return;
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, box: stage.closest('.ppt-view') };
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

    // 翻页
    var nav = t.closest && t.closest('.ppt-view__nav');
    if (nav) {
      var nb = nav.closest('.ppt-view');
      lastActive = nb;
      step(nb, Number(nav.getAttribute('data-dir')));
      return;
    }

    // 缩略图开关
    var thBtn = t.closest && t.closest('.ppt-view__thumbs-btn');
    if (thBtn) {
      var tb = thBtn.closest('.ppt-view');
      var wrap = q(tb, '.ppt-view__thumbs');
      if (wrap) {
        wrap.hidden = !wrap.hidden;
        thBtn.textContent = wrap.hidden ? '缩略图' : '收起';
        // 第一次展开时才生成：容器可见，库才能量到正确尺寸（否则会渲染成 300×150）
        var tst = tb.__ppt;
        if (!wrap.hidden && tst && tst.ready && !tst.thumbsBuilt) {
          tst.thumbsBuilt = true;
          buildThumbs(tb);
        }
      }
      lastActive = tb;
      return;
    }

    // 点缩略图跳页
    var th = t.closest && t.closest('.ppt-view__thumb');
    if (th) {
      var hb = th.closest('.ppt-view');
      lastActive = hb;
      goTo(hb, Number(th.getAttribute('data-index')));
      return;
    }

    // 全屏
    var fs = t.closest && t.closest('.ppt-view__fs');
    if (fs) {
      lastActive = fs.closest('.ppt-view');
      toggleFS(lastActive);
      return;
    }

    // 展开 / 折叠按钮
    var col = t.closest && t.closest('.ppt-view__collapse');
    if (col) {
      var cb = col.closest('.ppt-view');
      lastActive = cb;
      setCollapsed(cb, cb.getAttribute('data-collapsed') !== 'true');
      return;
    }

    // 标题栏空白处（下载链接除外）
    var header = t.closest && t.closest('.ppt-view__header');
    if (header) {
      if (t.closest && t.closest('a')) return;       // 点「下载」只下载，不折叠
      var hbx = header.closest('.ppt-view');
      lastActive = hbx;
      setCollapsed(hbx, hbx.getAttribute('data-collapsed') !== 'true');
    }
  });

  // 若标签带了 open:true，页面加载后自动初始化
  window.addEventListener('load', function () {
    var list = document.querySelectorAll('.ppt-view[data-collapsed="false"]');
    for (var i = 0; i < list.length; i++) init(list[i]);
  });
})();
