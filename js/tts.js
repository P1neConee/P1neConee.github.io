/* source/js/tts.js
 * 文章朗读 —— 基于浏览器内置的 Web Speech API（完全免费、零依赖、离线可用）。
 *
 * 三个可朗读来源：
 *   1. 文章正文（默认）：按段落分块，朗读时高亮当前段
 *   2. 内嵌 PDF：用 pdf.js 的文本层提取文字（扫描版没有文字层，会提示）
 *   3. 内嵌 PPT：用 jszip 解开 pptx，按 presentation.xml 的真实页序抽 <a:t> 文本
 *
 * 关键实现取舍：
 *   - 必须分块朗读：Chrome 的 utterance 超过约 15 秒会被静默截断，
 *     所以每段再按标点切成 <= 50 字的小块，逐块 speak。
 *   - 高亮按「块」而非「块内字」：块 = 正文段落 / PDF 或 PPT 的一页。
 *     朗读 PDF/PPT 时会驱动查看器自动翻到对应页。
 */

(function () {
  'use strict';

  var ARTICLE_SEL = 'article.md-text.content';
  // 这些容器里的文字不该读（代码、表格、内嵌查看器的 UI 文字等）
  var SKIP_SEL = 'pre, .highlight, table, .ppt-view, .pdf-view, .html-demo, script, style, noscript, svg, .search-dialog, .tts-dock';
  var LS = { rate: 'tts:rate', voice: 'tts:voice', follow: 'tts:follow', source: 'tts:source' };
  var CHUNK_MAX = 50;   // 单块最大字数（中文约 250 字/分钟 → 50 字 ≈ 12 秒，安全）

  var synth = window.speechSynthesis;
  if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') return;

  var article = document.querySelector(ARTICLE_SEL);
  var pdfBoxes = document.querySelectorAll('.pdf-view');
  var pptBoxes = document.querySelectorAll('.ppt-view');
  if (!article && !pdfBoxes.length && !pptBoxes.length) return;

  // ---------------- 状态 ----------------
  var state = 'idle';        // idle | playing | paused
  var queue = [];            // [{text, blockIdx}]
  var qi = 0;
  var curSource = null;      // 当前选中的来源
  var curBlock = -1;
  var curUtter = null;
  var voices = [];
  var sources = [];          // 面板打开时重建

  // ---------------- 工具 ----------------
  function q(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  var ICON = {
    speaker: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>'
  };

  // ---------------- 文本切分 ----------------
  // 先按句末标点断句，再贪心合并到 <= CHUNK_MAX；单句过长则按逗号硬切
  function splitSentences(text) {
    var out = [], buf = '';
    for (var i = 0; i < text.length; i++) {
      buf += text.charAt(i);
      if (/[。！？!?；;]/.test(text.charAt(i)) && buf.length > 1) { out.push(buf); buf = ''; }
    }
    if (buf.trim()) out.push(buf);
    return out;
  }
  function hardSplit(s, max) {
    var out = [], buf = '';
    for (var i = 0; i < s.length; i++) {
      buf += s.charAt(i);
      if (/[，,、]/.test(s.charAt(i)) && buf.length >= max * 0.6) { out.push(buf); buf = ''; }
      else if (buf.length >= max) { out.push(buf); buf = ''; }
    }
    if (buf.trim()) out.push(buf);
    return out;
  }
  function toChunks(text, max) {
    max = max || CHUNK_MAX;
    var chunks = [], cur = '';
    var sents = splitSentences(text);
    for (var i = 0; i < sents.length; i++) {
      var s = sents[i];
      if (!s.trim()) continue;
      if (s.length > max) {
        if (cur.trim()) { chunks.push(cur); cur = ''; }
        hardSplit(s, max).forEach(function (t) { if (t.trim()) chunks.push(t); });
        continue;
      }
      if (cur.length + s.length > max && cur.trim()) { chunks.push(cur); cur = ''; }
      cur += s;
    }
    if (cur.trim()) chunks.push(cur);
    return chunks;
  }

  // ---------------- 正文分块 ----------------
  function collectBlocks(root) {
    var nodes = root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, figcaption');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      // li 内部若还套着 p，只保留 li，避免重读
      if (n.tagName === 'P' && n.parentElement && n.parentElement.tagName === 'LI') continue;
      if (n.closest && n.closest(SKIP_SEL)) continue;
      var t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2) continue;
      out.push({ el: n, text: t });
    }
    return out;
  }

  // ---------------- PDF / PPT 文本提取 ----------------
  function ensureLoaded(box, kind) {
    var st = kind === 'pdf' ? box.__pdf : box.__ppt;
    if (st && st.ready) return Promise.resolve(st);
    if (box.getAttribute('data-collapsed') === 'true') {
      var btn = q('.pdf-view__collapse, .ppt-view__collapse', box);
      if (btn) btn.click();      // 没加载过就先展开，触发 viewer 自己加载
    }
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function poll() {
        var s = kind === 'pdf' ? box.__pdf : box.__ppt;
        if (s && s.ready) return resolve(s);
        if (s && !s.loading) return reject(new Error('加载失败'));
        if (Date.now() - t0 > 90000) return reject(new Error('等待加载超时'));
        setTimeout(poll, 250);
      })();
    });
  }

  // PDF：用 pdf.js 的文本层。扫描件（图片）没有文字层，会返回空。
  function pdfBlocks(box) {
    return ensureLoaded(box, 'pdf').then(function (st) {
      var doc = st.doc, out = [], chain = Promise.resolve();
      for (var n = 1; n <= doc.numPages; n++) {
        (function (pageNo) {
          chain = chain.then(function () {
            return doc.getPage(pageNo).then(function (page) {
              return page.getTextContent().then(function (tc) {
                var s = '';
                (tc.items || []).forEach(function (it) {
                  s += it.str || '';
                  if (it.hasEOL) s += ' ';   // 行尾补空格，避免英文单词粘连
                });
                s = s.replace(/\s+/g, ' ').trim();
                out.push({ page: pageNo, text: s });
              });
            });
          });
        })(n);
      }
      return chain.then(function () {
        var hasText = out.filter(function (b) { return b.text; }).length;
        if (!hasText) throw new Error('这个 PDF 没有文字层（可能是扫描件/图片版），无法朗读');
        return out.filter(function (b) { return b.text.length >= 2; });
      });
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('依赖加载失败：' + src)); };
      document.head.appendChild(s);
    });
  }

  function unescapeXml(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); })
            .replace(/&amp;/g, '&');
  }

  // PPT：pptx 本质是 zip，读 presentation.xml 的 sldIdLst 拿到真实页序，
  // 再经 presentation.xml.rels 映射到 slide 文件名，最后抽所有 <a:t> 文本。
  function pptBlocks(box) {
    var src = box.getAttribute('data-src');
    // 先把查看器本身加载起来（和 PDF 一致）：这样朗读时能驱动它翻到对应页。
    return ensureLoaded(box, 'ppt')
      .then(function () { return loadScript('/js/vendor/jszip.min.js'); })
      .then(function () { return fetch(encodeURI(src)); })
      .then(function (r) {
        if (!r.ok) throw new Error('读取失败 ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) { return window.JSZip.loadAsync(buf); })
      .then(function (zip) {
        var pres = zip.file('ppt/presentation.xml');
        var rels = zip.file('ppt/_rels/presentation.xml.rels');
        if (!pres || !rels) throw new Error('这个 PPT 的结构无法解析');
        return Promise.all([pres.async('string'), rels.async('string')]).then(function (r) {
          var presXml = r[0], relsXml = r[1], idToTarget = {}, m;
          var reR = /<Relationship\b[^>]*>/g;
          while ((m = reR.exec(relsXml))) {
            var id = /Id="([^"]+)"/.exec(m[0]);
            var tg = /Target="([^"]+)"/.exec(m[0]);
            if (id && tg) idToTarget[id[1]] = tg[1];
          }
          var order = [], reS = /<p:sldId\b[^>]*>/g;
          while ((m = reS.exec(presXml))) {
            var rid = /r:id="([^"]+)"/.exec(m[0]);
            if (rid) order.push(rid[1]);
          }
          var names = [];
          order.forEach(function (rid) {
            var t = idToTarget[rid];
            if (!t) return;
            t = t.replace(/^\.\.\//, '').replace(/^\.\//, '').replace(/^\//, '');
            if (t.indexOf('ppt/') !== 0) t = 'ppt/' + t;
            if (zip.file(t)) names.push(t);
          });
          if (!names.length) {   // 兜底：按 slideN.xml 的数字排序
            names = Object.keys(zip.files).filter(function (n) {
              return /^ppt\/slides\/slide\d+\.xml$/.test(n);
            }).sort(function (a, b) {
              return (+/(\d+)/.exec(a)[1]) - (+/(\d+)/.exec(b)[1]);
            });
          }
          return Promise.all(names.map(function (n) { return zip.file(n).async('string'); }));
        });
      })
      .then(function (xmls) {
        var out = [];
        xmls.forEach(function (xml, i) {
          var parts = xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [];
          var s = parts.map(function (p) {
            return p.replace(/^<a:t>/, '').replace(/<\/a:t>$/, '');
          }).join(' ');
          s = unescapeXml(s).replace(/\s+/g, ' ').trim();
          if (s.length >= 2) out.push({ page: i + 1, text: s });
        });
        if (!out.length) throw new Error('这个 PPT 里没有可朗读的文字');
        return out;
      });
  }

  // ---------------- 来源列表 ----------------
  function boxTitle(box) {
    var t = q('.pdf-view__title, .ppt-view__title', box);
    return t ? t.textContent.trim() : (box.getAttribute('data-src') || '未命名').split('/').pop();
  }
  // 来源 = 阅读起点。分两组：
  //   「起点」：全文 + 每个二级标题（点标题旁的小喇叭也能直达对应起点）
  //   「内嵌文件」：页面里的 PDF / PPT
  function buildSources() {
    var list = [];
    if (article) {
      articleBlocks = collectBlocks(article);
      sections = [];
      if (articleBlocks.length) {
        list.push({
          id: 'article', kind: 'article', group: '起点',
          label: '全文 · 从头开始', sub: articleBlocks.length + ' 段',
          blocks: articleBlocks
        });
        articleBlocks.forEach(function (b, i) {
          if (!b.el || String(b.el.tagName) !== 'H2') return;
          sections.push({ idx: i, el: b.el, text: b.text });
          list.push({
            id: 'sec-' + i, kind: 'article', group: '起点', section: true,
            label: b.text,                          // 不另加序号：原文标题多半自带编号
            sub: (articleBlocks.length - i) + ' 段',
            blocks: articleBlocks.slice(i)          // 从该标题起的剩余内容
          });
        });
      }
    }
    for (var i = 0; i < pdfBoxes.length; i++) {
      list.push({ id: 'pdf-' + i, kind: 'pdf', box: pdfBoxes[i], group: '内嵌文件',
                  label: boxTitle(pdfBoxes[i]), tag: 'PDF', blocks: null });
    }
    for (var j = 0; j < pptBoxes.length; j++) {
      list.push({ id: 'ppt-' + j, kind: 'ppt', box: pptBoxes[j], group: '内嵌文件',
                  label: boxTitle(pptBoxes[j]), tag: 'PPT', blocks: null });
    }
    return list;
  }
  function fetchBlocks(source) {
    if (source.kind === 'article') return Promise.resolve(source.blocks);
    if (source.blocks) return Promise.resolve(source.blocks);
    var p = source.kind === 'pdf' ? pdfBlocks(source.box) : pptBlocks(source.box);
    return p.then(function (bs) { source.blocks = bs; return bs; });
  }

  // ---------------- 高亮 ----------------
  function clearHighlight() {
    var old = document.querySelectorAll('.tts-reading');
    for (var i = 0; i < old.length; i++) old[i].classList.remove('tts-reading');
  }
  function setActiveBlock(bi) {
    if (!curSource || bi === curBlock) return;
    curBlock = bi;
    clearHighlight();
    var b = curSource.blocks && curSource.blocks[bi];
    if (!b) return;
    if (b.el) {
      b.el.classList.add('tts-reading');
      if (followChk && followChk.checked) {
        var r = b.el.getBoundingClientRect();
        if (r.top < 60 || r.bottom > window.innerHeight - 40) {
          try { b.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { b.el.scrollIntoView(); }
        }
      }
    } else if (curSource.box) {
      // PDF / PPT：驱动查看器翻到对应页。
      // 注意用块自带的 page（真实页码）而不是下标 bi —— 无文字的页会被过滤掉，
      // 两者并不一致，用 bi 会导致「读第 4 页却翻到第 3 页」。
      var st = curSource.kind === 'pdf' ? curSource.box.__pdf : curSource.box.__ppt;
      var target = (typeof b.page === 'number') ? b.page - 1 : bi;
      if (st && typeof st.goTo === 'function') { try { st.goTo(target); } catch (e) {} }
    }
  }

  // ---------------- 朗读 ----------------
  function buildQueue(blocks) {
    var q2 = [];
    blocks.forEach(function (b, bi) {
      toChunks(b.text).forEach(function (t) { q2.push({ text: t, blockIdx: bi }); });
    });
    return q2;
  }

  function speakNext() {
    if (state !== 'playing') return;
    if (qi >= queue.length) return finish();
    var item = queue[qi];
    setActiveBlock(item.blockIdx);
    var u = new window.SpeechSynthesisUtterance(item.text);
    var v = getVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    else u.lang = 'zh-CN';
    u.rate = getRate();
    u.pitch = 1;
    u.volume = 1;
    u.onend = function () { qi++; if (state === 'playing') speakNext(); };
    u.onerror = function (e) {
      if (e && (e.error === 'interrupted' || e.error === 'canceled')) return;
      qi++; if (state === 'playing') speakNext();
    };
    curUtter = u;
    synth.speak(u);
    updateUI();
  }

  function play() {
    if (state === 'playing') return;
    if (state === 'paused') {
      state = 'playing';
      try { synth.resume(); } catch (e) {}
      updateUI();
      return;
    }
    if (!curSource) return;
    setBusy('正在准备…');
    fetchBlocks(curSource).then(function (blocks) {
      curSource.blocks = blocks;
      if (!blocks.length) { setBusy('没有可朗读的内容'); return; }
      queue = buildQueue(blocks);
      qi = 0; curBlock = -1;
      state = 'playing';
      setBusy('');
      speakNext();
    }).catch(function (err) {
      setBusy((err && err.message) ? err.message : '准备失败', true);
    });
  }

  function pause() {
    if (state !== 'playing') return;
    state = 'paused';
    try { synth.pause(); } catch (e) {}
    updateUI();
  }

  function stop() {
    state = 'idle';
    try { synth.cancel(); } catch (e) {}
    queue = []; qi = 0; curBlock = -1; curUtter = null;
    clearHighlight();
    updateUI();
  }

  function finish() {
    state = 'idle';
    clearHighlight();
    qi = 0;
    updateUI();
  }

  // ---------------- 音色 / 语速 ----------------
  function loadVoices() {
    var all = [];
    try { all = synth.getVoices() || []; } catch (e) {}
    if (!all.length) return [];
    var zh = all.filter(function (v) { return /^zh|^cmn|^yue/i.test(v.lang || ''); });
    var rest = all.filter(function (v) { return zh.indexOf(v) < 0; });
    // 中文优先：本地语音（离线可用）排在前面，在线神经语音（音质更好）随后
    zh.sort(function (a, b) { return (b.localService ? 1 : 0) - (a.localService ? 1 : 0); });
    return zh.concat(rest);
  }
  function fillVoices() {
    voices = loadVoices();
    if (!voiceDD) return;
    var keep = voiceDD.value;
    if (!voices.length) {
      voiceDD.setOptions([{ value: '', label: '系统暂无可用语音' }], '');
      return;
    }
    var opts = voices.map(function (v) {
      return {
        value: v.voiceURI || v.name,
        label: v.name,
        sub: v.localService ? '离线' : '在线',
        group: /^zh|^cmn|^yue/i.test(v.lang || '') ? '中文语音' : '其它语言'
      };
    });
    voiceDD.setOptions(opts, keep);
  }
  function getVoice() {
    if (!voiceDD || !voices.length) return null;
    var val = voiceDD.value;
    for (var i = 0; i < voices.length; i++) {
      if ((voices[i].voiceURI || voices[i].name) === val) return voices[i];
    }
    return voices[0] || null;
  }
  function getRate() {
    var r = parseFloat(rateInput && rateInput.value);
    return isNaN(r) ? 1 : r;
  }

  // ---------------- 界面 ----------------
  var dock, panel, panelOpen = false;
  var srcDD, playBtn, stopBtn, progEl, rateInput, rateVal, voiceDD, followChk, nowEl, hintEl;
  var lastBtnState = '';   // 按钮只在状态真正变化时才改 DOM
  var sections = [];       // 正文里的二级标题（= 阅读起点）
  var articleBlocks = [];  // 正文分块缓存

  // 轻量自定义下拉。原生 <select> 的下拉部分由系统控件绘制（Windows 上中文发虚、
  // 行高与面板对不齐），换成自绘列表后字体、间距、分组和滚动都能自己控制。
  var DD_CARET = '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>';
  function makeDropdown(opt) {
    opt = opt || {};
    var wrap = el('div', 'tts-dd');
    var trig = el('button', 'tts-dd__trigger',
      '<span class="tts-dd__txt"></span><span class="tts-dd__sub"></span>' +
      '<span class="tts-dd__caret">' + DD_CARET + '</span>');
    trig.type = 'button';
    var list = el('div', 'tts-dd__list');
    list.hidden = true;
    var api = { root: wrap, options: [], value: '' };

    function close() { list.hidden = true; wrap.classList.remove('is-open'); }
    api.close = close;

    api.setValue = function (v, silent) {
      api.value = v;
      var hit = null;
      api.options.forEach(function (o) { if (o.value === v) hit = o; });
      var t = q('.tts-dd__txt', trig), s = q('.tts-dd__sub', trig);
      if (t) t.textContent = hit ? hit.label : (opt.placeholder || '请选择');
      if (s) { s.textContent = (hit && hit.sub) ? hit.sub : ''; s.hidden = !(hit && hit.sub); }
      var items = list.querySelectorAll('.tts-dd__opt');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('is-on', items[i].getAttribute('data-value') === v);
      }
      if (!silent && opt.onChange) opt.onChange(v);
    };

    api.setOptions = function (opts, keep) {
      api.options = opts || [];
      list.innerHTML = '';
      var lastGroup = null;
      api.options.forEach(function (o) {
        if (o.group && o.group !== lastGroup) {
          lastGroup = o.group;
          list.appendChild(el('div', 'tts-dd__group', o.group));
        }
        var it = el('button', 'tts-dd__opt',
          '<span class="tts-dd__dot"></span><span class="tts-dd__lab"></span>' +
          (o.tag ? '<span class="tts-dd__tag">' + o.tag + '</span>' : '') +
          (o.sub ? '<span class="tts-dd__num">' + o.sub + '</span>' : ''));
        it.type = 'button';
        q('.tts-dd__lab', it).textContent = o.label;
        it.setAttribute('data-value', o.value);
        it.addEventListener('click', function (e) { e.stopPropagation(); api.setValue(o.value); close(); });
        list.appendChild(it);
      });
      var saved = null;
      try { saved = opt.storeKey ? localStorage.getItem(opt.storeKey) : null; } catch (e) {}
      var want = keep || saved || (api.options[0] && api.options[0].value);
      var ok = api.options.some(function (o) { return o.value === want; });
      api.setValue(ok ? want : (api.options[0] ? api.options[0].value : ''), true);
    };

    // 展开方向自适应：下方空间不足且上方更宽敞时向上展开，并按下方可用量限高
    function place() {
      var t = trig.getBoundingClientRect();
      var down = window.innerHeight - t.bottom - 14;
      var up = t.top - 14;
      var useUp = down < 170 && up > down;
      wrap.classList.toggle('tts-dd--up', useUp);
      list.style.maxHeight = Math.max(120, Math.min(300, useUp ? up : down)) + 'px';
    }
    trig.addEventListener('click', function (e) {
      e.stopPropagation();
      if (list.hidden) { list.hidden = false; wrap.classList.add('is-open'); place(); } else close();
    });
    document.addEventListener('pointerdown', function (e) {
      if (!list.hidden && !wrap.contains(e.target)) close();
    });
    wrap.appendChild(trig); wrap.appendChild(list);
    return api;
  }

  function buildUI() {
    // 入口位置：有正文时挂在文章顶部右上角（sticky，跟着文章走）；
    // 没有正文（例如只有内嵌 PDF/PPT 的页面）才退回右下角悬浮。
    var inline = !!article && !!article.parentNode;
    dock = el('div', 'tts-dock' + (inline ? ' tts-dock--inline' : ' tts-dock--fixed'));
    dock.setAttribute('data-state', 'idle');

    var btn = el('button', 'tts-dock__btn',
                 '<span class="tts-ico">' + ICON.speaker + '</span><span class="tts-dock__label">朗读</span>');
    btn.type = 'button';
    btn.setAttribute('aria-label', '朗读');
    btn.title = '朗读本文';
    btn.addEventListener('click', function (e) { e.stopPropagation(); togglePanel(); });
    dock.appendChild(btn);

    panel = el('div', 'tts-panel');
    panel.hidden = true;

    var head = el('div', 'tts-panel__head', ICON.speaker + '<span>朗读</span>');
    var close = el('button', 'tts-panel__close', '&times;');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', function () { togglePanel(false); });
    head.appendChild(close);
    panel.appendChild(head);

    // 阅读起点：全文 / 各二级标题 / 内嵌的 PDF、PPT
    var f1 = el('div', 'tts-field');
    f1.appendChild(el('label', '', '阅读起点'));
    srcDD = makeDropdown({ storeKey: LS.source, onChange: onSourceChange });
    f1.appendChild(srcDD.root);
    panel.appendChild(f1);

    // 控制行
    var ctrl = el('div', 'tts-controls');
    // 图标与文案分开成固定节点：更新时只改内容、不重建节点。
    // （早先写法每次切块都重写 innerHTML，点击事件的 e.target 会在冒泡到 document 前
    //   被替换掉，导致「点击面板内」被误判成「点击面板外」而关闭面板。）
    playBtn = el('button', 'tts-btn tts-btn--primary',
                 '<span class="tts-ico">' + ICON.play + '</span><span class="tts-label">朗读</span>');
    playBtn.type = 'button';
    playBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (state === 'playing') pause(); else play();
    });
    stopBtn = el('button', 'tts-btn',
                 '<span class="tts-ico">' + ICON.stop + '</span><span class="tts-label">停止</span>');
    stopBtn.type = 'button';
    stopBtn.addEventListener('click', function (e) { e.stopPropagation(); stop(); });
    progEl = el('span', 'tts-progress', '');
    ctrl.appendChild(playBtn); ctrl.appendChild(stopBtn); ctrl.appendChild(progEl);
    panel.appendChild(ctrl);

    // 语速
    var f2 = el('div', 'tts-field');
    var row = el('div', 'tts-rate');
    rateInput = document.createElement('input');
    rateInput.type = 'range';
    rateInput.min = '0.6'; rateInput.max = '1.8'; rateInput.step = '0.1';
    rateInput.value = (function () {
      try { var v = parseFloat(localStorage.getItem(LS.rate)); if (!isNaN(v)) return String(v); } catch (e) {}
      return '1';
    })();
    rateVal = el('span', 'tts-rate__val', parseFloat(rateInput.value).toFixed(1) + 'x');
    rateInput.addEventListener('input', function () {
      rateVal.textContent = parseFloat(rateInput.value).toFixed(1) + 'x';
      try { localStorage.setItem(LS.rate, rateInput.value); } catch (e) {}
      // 正在朗读时立即生效：重启当前这一块
      if (state === 'playing') restartCurrent();
    });
    row.appendChild(rateInput); row.appendChild(rateVal);
    f2.appendChild(el('label', '', '语速'));
    f2.appendChild(row);
    panel.appendChild(f2);

    // 音色
    var f3 = el('div', 'tts-field');
    f3.appendChild(el('label', '', '音色'));
    voiceDD = makeDropdown({
      storeKey: LS.voice,
      onChange: function () {
        try { localStorage.setItem(LS.voice, voiceDD.value); } catch (e) {}
        if (state === 'playing') restartCurrent();
      }
    });
    f3.appendChild(voiceDD.root);
    panel.appendChild(f3);

    // 跟随滚动（开关样式，原生 checkbox 太朴素）
    var lab = el('label', 'tts-switch');
    followChk = document.createElement('input');
    followChk.type = 'checkbox';
    followChk.checked = (function () {
      try { return localStorage.getItem(LS.follow) !== '0'; } catch (e) { return true; }
    })();
    followChk.addEventListener('change', function () {
      try { localStorage.setItem(LS.follow, followChk.checked ? '1' : '0'); } catch (e) {}
    });
    lab.appendChild(followChk);
    lab.appendChild(el('span', 'tts-switch__track', '<span class="tts-switch__knob"></span>'));
    lab.appendChild(el('span', 'tts-switch__txt', '朗读时自动滚动'));
    panel.appendChild(lab);

    nowEl = el('div', 'tts-now', '');
    nowEl.hidden = true;
    panel.appendChild(nowEl);

    hintEl = el('div', 'tts-hint', '');
    hintEl.hidden = true;
    panel.appendChild(hintEl);

    dock.appendChild(panel);
    if (inline) {
      // 挂在正文之前（不是正文内部）：
      //   ① 不会被 .md-text 作用域内的样式污染面板外观；
      //   ② 也不会继承主题给正文元素加的 margin（那会把按钮推进正文里）。
      article.parentNode.insertBefore(dock, article);
      dock.style.margin = '0';
      syncDockTop();
      window.addEventListener('resize', syncDockTop);
      window.addEventListener('load', syncDockTop);   // 图片/字体加载完位置可能变
    } else {
      document.body.appendChild(dock);
    }

    fillVoices();
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', fillVoices);
    } else {
      synth.onvoiceschanged = fillVoices;
    }
    // 音色常常晚于页面加载就绪，兜底再取几次
    [300, 1000, 2500].forEach(function (t) { setTimeout(fillVoices, t); });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var openDD = q('.tts-dd.is-open', panel);   // 先收起下拉，再收面板
      if (openDD) {
        var l = q('.tts-dd__list', openDD);
        if (l) l.hidden = true;
        openDD.classList.remove('is-open');
      } else togglePanel(false);
    });
    // 用 pointerdown（早于 click、早于任何 DOM 重建）判断「是否点在面板外」，更可靠
    document.addEventListener('pointerdown', function (e) {
      if (panelOpen && !dock.contains(e.target)) togglePanel(false);
    });
    window.addEventListener('beforeunload', stop);
    window.addEventListener('pagehide', stop);

    rebuildSources();
    updateUI();
  }

  // 两种位置：
  //   静止 → 按钮落在正文上沿之外（正文顶 - 36px：按钮高 30 + 6px 间隙），随页面滚走；
  //   朗读中 → 吸附在顶栏下方，方便随时暂停/停止。
  // 顶栏是 sticky 的（约 64px 高），高度按实测量，resize / load 后重算。
  var BTN_UP = 36;
  function syncDockTop() {
    if (!dock || dock.className.indexOf('tts-dock--inline') < 0) return;
    if (dock.classList.contains('is-pinned')) {
      var bar = document.querySelector('header.site-region--topbar');
      var h = bar ? Math.round(bar.getBoundingClientRect().height) : 0;
      if (!h || h > 200) h = 64;   // 量不到就按主题默认顶栏高度
      dock.style.top = (h + 10) + 'px';
      // fixed 之后 right 要自己换算成「正文右缘距视口右边多少」
      var r = article.getBoundingClientRect();
      dock.style.right = Math.max(0, Math.round(window.innerWidth - r.right)) + 'px';
      return;
    }
    dock.style.right = '';
    // 静止态：相对定位父级实测正文顶部（不能写死，正文位置随横幅/标题而变）
    var op = dock.offsetParent;
    var base = op ? op.getBoundingClientRect().top : 0;
    dock.style.top = Math.round(article.getBoundingClientRect().top - base - BTN_UP) + 'px';
  }

  function togglePanel(force) {
    panelOpen = (force === undefined) ? !panelOpen : force;
    panel.hidden = !panelOpen;
    if (panelOpen) { rebuildSources(); fillVoices(); }
  }

  function rebuildSources() {
    sources = buildSources();
    if (!srcDD) return;
    var prev = curSource ? curSource.id : null;
    srcDD.setOptions(sources.map(function (s) {
      return { value: s.id, label: s.label, sub: s.sub, group: s.group, tag: s.tag };
    }), prev);
    curSource = sources.filter(function (s) { return s.id === srcDD.value; })[0] || sources[0] || null;
    mountSectionButtons();
    updateUI();
  }

  // 每个二级标题后面挂一个「从这里朗读」的小按钮（阅读起点）
  function mountSectionButtons() {
    sections.forEach(function (s, k) {
      if (!s.el) return;
      var exist = q('.tts-sec', s.el);
      // 面板每次重建都会刷新 sections，按钮若已挂过就直接复用（否则 s.btn 丢失，
      // 「当前朗读的那一节」就点不亮）
      if (exist) { s.btn = exist; return; }
      var b = el('button', 'tts-sec', '<span class="tts-ico">' + ICON.play + '</span>');
      b.type = 'button';
      b.title = '从这里开始朗读';
      b.setAttribute('aria-label', '从「' + s.text + '」开始朗读');
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        startSection(k);
      });
      s.btn = b;
      s.el.appendChild(b);
    });
  }

  // 点标题旁的小喇叭：选中对应起点 → 打开面板 → 立刻开读
  function startSection(k) {
    var s = sections[k];
    if (!s) return;
    var src = sources.filter(function (x) { return x.id === 'sec-' + s.idx; })[0];
    if (!src) return;
    curSource = src;
    if (srcDD) srcDD.setValue(src.id, true);
    togglePanel(true);
    stop();
    nowEl.hidden = true;
    hintEl.hidden = true;
    updateUI();
    play();
  }

  function onSourceChange() {
    stop();
    curSource = sources.filter(function (s) { return s.id === srcDD.value; })[0] || null;
    try { localStorage.setItem(LS.source, srcDD.value); } catch (e) {}
    nowEl.hidden = true;
    hintEl.hidden = true;
    if (curSource && curSource.kind !== 'article') {
      setBusy('正在提取「' + curSource.label + '」的文字…');
      fetchBlocks(curSource).then(function (bs) {
        setBusy('');
        hintEl.hidden = false;
        hintEl.textContent = '已提取 ' + bs.length + ' 页可朗读文字，点「朗读」开始（会自动翻页）。';
      }).catch(function (err) {
        setBusy((err && err.message) ? err.message : '提取失败', true);
      });
    }
    updateUI();
  }

  function setBusy(msg, isErr) {
    if (!nowEl) return;
    nowEl.hidden = !msg;
    nowEl.innerHTML = msg ? (isErr ? msg : '<b>' + msg + '</b>') : '';
    if (isErr) nowEl.style.color = 'var(--theme, #f66)';
    else nowEl.style.color = '';
  }

  // 改语速/音色后立即生效：从当前块重新说一次
  function restartCurrent() {
    if (state !== 'playing' || !queue[qi]) return;
    try { synth.cancel(); } catch (e) {}
    var keep = qi;
    setTimeout(function () {
      if (state !== 'playing') return;
      qi = keep;
      speakNext();
    }, 60);
  }

  function updateUI() {
    if (!dock) return;
    dock.setAttribute('data-state', state);
    // 只在朗读中才吸附到视口右上角（此时需要随时暂停/停止）；
    // 静止时按钮老老实实待在文章顶部上沿，不挡正文。
    if (dock.className.indexOf('tts-dock--inline') >= 0) {
      var pinned = state !== 'idle';
      if (pinned !== dock.classList.contains('is-pinned')) {
        dock.classList.toggle('is-pinned', pinned);
        syncDockTop();      // 吸附与否用的是两套偏移，切换后都要重算
      }
    }
    if (playBtn && lastBtnState !== state) {
      lastBtnState = state;
      var ico = playBtn.querySelector('.tts-ico');
      var lab = playBtn.querySelector('.tts-label');
      if (state === 'playing') { if (ico) ico.innerHTML = ICON.pause; if (lab) lab.textContent = '暂停'; }
      else if (state === 'paused') { if (ico) ico.innerHTML = ICON.play; if (lab) lab.textContent = '继续'; }
      else { if (ico) ico.innerHTML = ICON.play; if (lab) lab.textContent = '朗读'; }
    }
    if (stopBtn) stopBtn.disabled = (state === 'idle');
    var total = curSource && curSource.blocks ? curSource.blocks.length : 0;
    if (progEl) {
      if (state === 'idle' || !total) progEl.textContent = '';
      else {
        var cur = Math.max(1, (curBlock >= 0 ? curBlock : 0) + 1);
        progEl.textContent = cur + ' / ' + total + (curSource.kind === 'article' ? ' 段' : ' 页');
      }
    }
    if (nowEl && state === 'playing' && queue[qi]) {
      nowEl.hidden = false;
      nowEl.style.color = '';
      nowEl.innerHTML = '<b>正在读：</b>' + queue[qi].text.slice(0, 40) + '…';
    }
    // 当前起点对应的标题按钮点亮（读全文时不点亮任何一节）
    sections.forEach(function (s) {
      if (!s.btn) return;
      s.btn.classList.toggle('is-active',
        state !== 'idle' && !!curSource && curSource.id === 'sec-' + s.idx);
    });
  }

  // ---------------- 启动 ----------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }

  // 供自动化测试/调试使用
  window.__tts = {
    get state() { return state; },
    get source() { return curSource; },
    get queue() { return queue; },
    get index() { return qi; },
    get sections() { return sections; },
    get sources() { return sources; },
    toChunks: toChunks,
    buildSources: buildSources,
    collectBlocks: collectBlocks,
    startSection: startSection,
    open: function () { togglePanel(true); },
    play: play, pause: pause, stop: stop
  };
})();
