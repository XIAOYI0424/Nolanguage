  // ---------- Markdown preview + outline (#40) ----------
  //
  // The page never parses Markdown. mdRender asks the engine, which answers
  // with sanitised HTML plus the heading list; the pane shows exactly that, and
  // the Structure tool window reuses the same headings as an outline. Parsing
  // here would mean two parsers that can disagree, and the one in the page would
  // be the one with no tests.
  //
  // No backticks anywhere in this file: verify-pycharm guards every fragment
  // against them, because a stray one used to truncate the enclosing template
  // literal that this code lived in before it was split.
  var MD = { open: false, reqId: 0, last: null, err: '', timer: 0, width: 42, dragging: false };
  var savedMdWidth = Number(PREFS.mdPreviewWidth);
  if (isFinite(savedMdWidth) && savedMdWidth >= 24 && savedMdWidth <= 64) MD.width = savedMdWidth;

  function mdIsDoc() { return currentLang === 'markdown'; }

  function mdSetWidth(percent, persist) {
    MD.width = Math.max(24, Math.min(64, Number(percent) || 42));
    var pane = $('mdprev');
    var handle = $('mdSplit');
    if (pane) pane.style.setProperty('--mdprev-basis', MD.width + '%');
    if (handle) handle.setAttribute('aria-valuenow', String(Math.round(MD.width)));
    if (persist) savePrefs({ mdPreviewWidth: MD.width });
  }

  function mdWidthFromPointer(clientX, persist) {
    var row = $('mdprev');
    var wrap = row && row.parentNode;
    if (!wrap || typeof wrap.getBoundingClientRect !== 'function') return;
    var rect = wrap.getBoundingClientRect();
    if (!rect.width) return;
    mdSetWidth((rect.right - clientX) * 100 / rect.width, persist);
  }

  function mdMetaText(m) {
    var s = m.stats || {}, parts = [];
    if (s.words) parts.push(s.words + ' words');
    if (s.headings) parts.push(s.headings + ' heading' + (s.headings === 1 ? '' : 's'));
    if (s.codeBlocks) parts.push(s.codeBlocks + ' code');
    if (typeof m.ms === 'number') parts.push(m.ms + ' ms');
    if (m.truncated) parts.push('truncated');
    return parts.join(' \u00b7 ');
  }

  function mdSetEmpty(text) {
    var h = $('mdHtml');
    if (h) h.innerHTML = '<div class="empty">' + esc(text) + '</div>';
    var o = $('mdOutline');
    if (o) o.innerHTML = '';
  }

  function mdToggle(force) {
    var want = (typeof force === 'boolean') ? force : !MD.open;
    if (want && !mdIsDoc()) { toast('Markdown preview: open a .md file first'); return; }
    MD.open = want;
    var p = $('mdprev');
    var split = $('mdSplit');
    if (p) { if (want) p.classList.remove('hidden'); else p.classList.add('hidden'); }
    if (split) { if (want) split.classList.remove('hidden'); else split.classList.add('hidden'); }
    var b = $('mdPrevBtn');
    if (b) b.classList.toggle('on', want);
    if (want) { mdSetWidth(MD.width, false); mdRequest(); }
  }

  /** Debounce: a keystroke must not queue a render per character. */
  function schedulePreview() {
    if (!MD.open || !mdIsDoc()) return;
    if (MD.timer) clearTimeout(MD.timer);
    MD.timer = setTimeout(function () { MD.timer = 0; mdRequest(); }, 250);
  }

  function mdRequest() {
    if (!mdIsDoc()) { mdSetEmpty('Preview is for Markdown files.'); return; }
    MD.reqId += 1;
    BRIDGE.send({ kind: 'mdRender', language: 'markdown', code: ta.value, requestId: MD.reqId });
  }

  function mdHeadings() { return (MD.last && MD.last.headings) || []; }

  function mdRow(h) {
    var lv = Math.max(1, Math.min(6, h.level || 1));
    var line = h.line || 1;
    return '<div class="mdoh lv' + lv + '" data-mdl="' + line + '" title="Line ' + line + '">' +
      esc(h.text || '') + '</div>';
  }

  function renderMdOutline() {
    var box = $('mdOutline');
    if (!box) return;
    var hs = mdHeadings();
    box.innerHTML = hs.length
      ? hs.map(mdRow).join('')
      : '<div class="empty">No headings</div>';
  }

  function mdOnPreview(m) {
    // A later keystroke invalidates this answer: without the id check the pane
    // would flicker back to older text whenever two renders overlap.
    if (Number(m.requestId || 0) !== MD.reqId) return;
    if (!m.ok) {
      MD.err = m.error || 'render failed';
      if (MD.open) mdSetEmpty(MD.err);
      return;
    }
    MD.err = '';
    MD.last = m;
    if (!MD.open) {
      // The preview is closed but the Structure window may be showing headings.
      if (activeLeft === 'structure') renderPanel();
      return;
    }
    var h = $('mdHtml');
    if (h) h.innerHTML = m.html;
    var meta = $('mdMeta');
    if (meta) meta.textContent = mdMetaText(m);
    renderMdOutline();
  }

  /** Called on every document switch, before anything is rendered. */
  function mdAfterDocSwitch() {
    if (!mdIsDoc()) {
      MD.last = null;
      MD.reqId += 1;                 // drop any answer still in flight
      if (MD.open) mdToggle(false);
      if (activeLeft === 'structure') renderPanel();
      return;
    }
    if (MD.open || activeLeft === 'structure') mdRequest();
  }

  /** Headings for the Structure window, or null when the file is not Markdown. */
  function mdStructureRows() {
    if (!mdIsDoc()) return null;
    var hs = mdHeadings();
    if (!hs.length) return '<div class="empty">No headings yet \u2014 the outline fills in once the preview renders.</div>';
    return hs.map(mdRow).join('');
  }

  function wireMd() {
    var split = $('mdSplit');
    mdSetWidth(MD.width, false);
    if (split) {
      split.addEventListener('pointerdown', function (e) {
        if (!MD.open || (e.button != null && e.button !== 0)) return;
        e.preventDefault();
        MD.dragging = true;
        split.classList.add('dragging');
        var wrap = split.parentNode;
        if (wrap) wrap.classList.add('md-resizing');
        if (split.setPointerCapture && e.pointerId != null) {
          try { split.setPointerCapture(e.pointerId); } catch (err) { /* document listeners remain the fallback */ }
        }
      });
      document.addEventListener('pointermove', function (e) {
        if (MD.dragging) mdWidthFromPointer(e.clientX, false);
      });
      function endMdResize() {
        if (!MD.dragging) return;
        MD.dragging = false;
        split.classList.remove('dragging');
        var wrap = split.parentNode;
        if (wrap) wrap.classList.remove('md-resizing');
        mdSetWidth(MD.width, true);
      }
      document.addEventListener('pointerup', endMdResize);
      document.addEventListener('pointercancel', endMdResize);
      split.addEventListener('keydown', function (e) {
        var next = MD.width;
        if (e.key === 'ArrowLeft') next += 2;
        else if (e.key === 'ArrowRight') next -= 2;
        else if (e.key === 'Home') next = 24;
        else if (e.key === 'End') next = 64;
        else return;
        e.preventDefault();
        mdSetWidth(next, true);
      });
      split.addEventListener('dblclick', function () { mdSetWidth(42, true); });
    }

    var btn = $('mdPrevBtn');
    if (btn) btn.addEventListener('click', function () { mdToggle(); });
    var close = $('mdPrevClose');
    if (close) close.addEventListener('click', function () { mdToggle(false); });
    var out = $('mdOutlineBtn');
    if (out) out.addEventListener('click', function () {
      var p = $('mdprev'); if (!p) return;
      var on = p.classList.toggle('outline');
      out.classList.toggle('on', on);
    });
    // One delegated handler serves both the pane's outline and the Structure
    // window: the rows carry the source line, so clicking one puts the caret
    // there (gotoLine is 0-based, the heading line is 1-based).
    document.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t.getAttribute && !t.getAttribute('data-mdl')) t = t.parentNode;
      if (!t || !t.getAttribute) return;
      var line = Number(t.getAttribute('data-mdl'));
      if (line > 0) { gotoLine(line - 1, 0); e.preventDefault(); }
    });
  }
  wireMd();
