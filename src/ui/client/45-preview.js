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
  var MD = { open: false, reqId: 0, last: null, err: '', timer: 0 };

  function mdIsDoc() { return currentLang === 'markdown'; }

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
    if (p) { if (want) p.classList.remove('hidden'); else p.classList.add('hidden'); }
    var b = $('mdPrevBtn');
    if (b) b.classList.toggle('on', want);
    if (want) mdRequest();
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
