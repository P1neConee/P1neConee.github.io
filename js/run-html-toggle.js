// source/js/run-html-toggle.js
// 为 {% run_html %} 运行框提供：① 折叠 / 展开  ② 「源码 / 运行」切换。
// 由 _config.stellar.yml 的 inject.head_end 注入，全局只执行一次（事件委托）。
// 样式见 source/css/run-html.css。
(function () {
  if (window.__htmlDemoToggleReady) return;
  window.__htmlDemoToggleReady = true;

  // ---------- 折叠 / 展开 ----------
  function setCollapsed(box, collapsed) {
    if (!box) return;
    var body = box.querySelector('.html-demo__body');
    var btn = box.querySelector('.html-demo__collapse');
    if (body) body.hidden = !!collapsed;
    box.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
    if (btn) {
      btn.textContent = collapsed ? '展开' : '折叠';
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
  }

  function toggleCollapse(box) {
    if (!box) return;
    setCollapsed(box, box.getAttribute('data-collapsed') !== 'true');
  }

  // ---------- 源码 / 运行 ----------
  // 拉取同源 demo 文件内容并填入 <pre>（textContent 自动转义，避免 HTML 被执行）
  function loadSource(btn) {
    var box = btn.closest('.html-demo');
    if (!box) return Promise.resolve();
    var pre = box.querySelector('.html-demo__code');
    var code = pre && pre.querySelector('code');
    if (!pre || !code) return Promise.resolve();
    if (code.dataset.loaded) return Promise.resolve();
    return fetch(btn.getAttribute('data-src'))
      .then(function (r) { return r.text(); })
      .then(function (t) {
        code.textContent = t;
        code.dataset.loaded = '1';
      })
      .catch(function () {
        code.textContent = '// 无法加载源码：' + btn.getAttribute('data-src');
        code.dataset.loaded = '1';
      });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;

    // 1) 点「源码 / 运行」按钮：只切视图，不改变折叠状态
    var btn = t.closest && t.closest('.html-demo__toggle');
    if (btn) {
      var box = btn.closest('.html-demo');
      if (!box) return;
      var frame = box.querySelector('.html-demo__frame');
      var pre = box.querySelector('.html-demo__code');

      if (btn.getAttribute('data-mode') === 'code') {
        if (pre) pre.hidden = true;
        if (frame) frame.style.display = '';
        btn.textContent = '源码';
        btn.setAttribute('data-mode', 'run');
      } else {
        loadSource(btn).finally(function () {
          if (frame) frame.style.display = 'none';
          if (pre) pre.hidden = false;
          btn.textContent = '运行';
          btn.setAttribute('data-mode', 'code');
        });
      }
      return;
    }

    // 2) 点「展开 / 折叠」按钮
    var colBtn = t.closest && t.closest('.html-demo__collapse');
    if (colBtn) {
      toggleCollapse(colBtn.closest('.html-demo'));
      return;
    }

    // 3) 点标题条空白处（dot / 标题文字）也切换折叠
    var header = t.closest && t.closest('.html-demo__header');
    if (header) {
      toggleCollapse(header.closest('.html-demo'));
    }
  });
})();
