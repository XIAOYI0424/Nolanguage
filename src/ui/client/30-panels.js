  // ---------- tab context menu ----------
  function closeAllTabs() {
    var tabs = TABS.slice();
    var dirty = tabs.filter(bufferDirty);
    if (!dirty.length) { tabs.forEach(function (p) { closeTab(p, true); }); return; }
    confirmDialog({
      title: 'Unsaved Changes', icon: 'warn',
      message: 'Save changes to ' + dirty.length + ' file' + (dirty.length === 1 ? '' : 's') + ' before closing all tabs?',
      buttons: [
        { label: 'Cancel', onClick: function () {} },
        { label: "Don't Save All", danger: true, onClick: function () { tabs.forEach(function (p) { closeTab(p, true); }); } },
        { label: 'Save All', primary: true, onClick: function () {
          CLOSE_ALL_BATCH = { tabs: tabs, dirty: dirty };
          dirty.forEach(function (p) { CLOSE_AFTER_SAVE[p] = true; saveBuffer(p); });
          finishCloseAllBatch();
        } }
      ]
    });
  }
  function tabMenu(name) {
    if (!name) return [{ label: 'Close All', act: closeAllTabs }];
    return [
      { label: 'Close', sc: 'Ctrl+F4', act: function () { closeTab(name); } },
      { label: 'Close Others', act: function () { TABS.slice().forEach(function (p) { if (p !== name) closeTab(p); }); } },
      { label: 'Close All', act: closeAllTabs }
    ];
  }
  // ---------- dock context menu ----------
  function dockMenu(pane) {
    return [
      { label: 'Copy', sc: 'Ctrl+C', act: function () { copyText(pane ? pane.textContent : ''); } },
      { sep: true },
      { label: 'Clear Buffer', act: function () { clearDockPane(pane); } }
    ];
  }
  function clearDockPane(pane) {
    if (!pane) return;
    RUN_ACTIVE = false;
    if (activeBottom === 'terminal') { TERM_LINES.length = 0; renderTermOut(); }
    else if (activeBottom === 'problems') renderProblems([]);
    else if (activeBottom === 'logs') { LOGS.length = 0; renderLogs(); }
    else if (activeBottom === 'perf') renderPerf(null);
    else renderDock();
    var win = windowById(activeBottom === 'problems' ? 'problems' : activeBottom);
    toast('Cleared ' + (win ? win.title : 'console'));
  }
  // The left tool windows are read-only panes except Project, so the others get
  // no menu — but still no browser menu, whose only useful entry here is Reload.
  function panelMenu() {
    if (activeLeft !== 'project') return null;
    return [
      { label: 'New', sc: 'Alt+Ins', act: function () { showNewPopup(lastCtxX, lastCtxY, ''); } },
      { sep: true },
      { label: 'Collapse All', act: function () { EXPANDED = { '': true }; renderTree(); } }
    ];
  }
  function isWordCh(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$'; }
  function leadWs(s) { var i = 0; while (i < s.length && (s.charAt(i) === ' ' || s.charAt(i) === TABc)) i++; return s.slice(0, i); }
  function wordPrefix() { var pos = ta.selectionStart, v = ta.value, i = pos; while (i > 0 && isWordCh(v.charAt(i - 1))) i--; return v.slice(i, pos); }
  var CLOSERS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
  CLOSERS[BT] = BT;
  function onCodeKeyDown(e) {
    if (CMP.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); cmpMove(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); cmpMove(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); cmpAccept(); return; }
      if (e.key === 'Escape') { e.preventDefault(); CMP.dismissed = true; cmpClose(); return; }
    }
    if (e.ctrlKey && (e.key === ' ' || e.key === 'Spacebar')) { e.preventDefault(); requestComplete(); return; }
    // Navigation, with the keys the checklist settled on. Shift+F6 here is the
    // symbol rename; the project tree keeps Shift+F6 for renaming a file, so the
    // two never fire for the same intent.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key || '').toLowerCase() === 'b') { e.preventDefault(); navDefinition(); return; }
    if (e.altKey && e.key === 'F7') { e.preventDefault(); navReferences(); return; }
    if (e.shiftKey && e.key === 'F6') { e.preventDefault(); navRename(); return; }
    if (e.altKey && e.key === 'Enter') { e.preventDefault(); navCodeActions(); return; }
    if (e.key === 'Tab') { e.preventDefault(); insertText('    '); scheduleComplete(); return; }
    if (e.key === 'Enter') { e.preventDefault(); autoIndentEnter(); scheduleComplete(); return; }
    if (e.key === 'Escape') { CMP.dismissed = true; cmpClose(); return; }
    // Parameter hints fire on the two characters that change the argument the
    // caret is on. ')' and Escape close the popup; anything else leaves it.
    if (e.key === '(' || e.key === ',') { sigTrigger(); }
    else if (e.key === ')' || e.key === 'Escape') { sigClose(); }
    var close = CLOSERS[e.key];
    if (close) { e.preventDefault(); autoPair(e.key, close); scheduleComplete(); return; }
  }
  function autoIndentEnter() {
    var pos = ta.selectionStart, val = ta.value;
    var ls = val.lastIndexOf(NLc, pos - 1) + 1;
    var lineText = val.slice(ls, pos);
    var indent = leadWs(lineText);
    var trimmed = lineText.replace(/[ ]+$/, '');
    var last = trimmed.charAt(trimmed.length - 1);
    var grow = (':{(['.indexOf(last) >= 0);
    var nextCh = val.charAt(pos);
    if (grow && (')]}'.indexOf(nextCh) >= 0)) {
      replaceRange(pos, pos, NLc + indent + '    ' + NLc + indent);
      ta.selectionStart = ta.selectionEnd = pos + 1 + indent.length + 4;
    } else {
      var add = grow ? '    ' : '';
      replaceRange(pos, pos, NLc + indent + add);
      ta.selectionStart = ta.selectionEnd = pos + 1 + indent.length + add.length;
    }
    renderEditor(); updateCaret();
  }
  function autoPair(open, close) {
    var s = ta.selectionStart, e = ta.selectionEnd, val = ta.value;
    if (s !== e) {
      replaceRange(s, e, open + val.slice(s, e) + close);
      ta.selectionStart = s + 1; ta.selectionEnd = e + 1;
      renderEditor(); updateCaret(); return;
    }
    var next = val.charAt(s);
    if (next === close) { ta.selectionStart = ta.selectionEnd = s + 1; return; }
    replaceRange(s, s, open + close);
    ta.selectionStart = ta.selectionEnd = s + 1;
    renderEditor(); updateCaret();
  }
  var cmpTimer = 0;
  function scheduleComplete() { clearTimeout(cmpTimer); cmpTimer = setTimeout(requestComplete, 130); }
  function caretLC() {
    var pos = ta.selectionStart, before = ta.value.slice(0, pos);
    return { line: before.split(NLc).length - 1, character: pos - (before.lastIndexOf(NLc) + 1) };
  }
  /* ---------- L1 · lexical completion (language-agnostic) ----------
     No grammar, no scopes, no types: every word-shaped token in the buffer is a
     candidate. That is enough to be useful in *any* language, which is the
     point — L2 (the LSP) is absent, cold or slow for most of them, and this
     source cannot fail because it never leaves the page.

     Cost is one regex pass per change of the buffer text, cached by value
     identity, so typing in a 10k-line file re-scans only when it changed. */
  var LEX = { text: null, ids: null, kinds: null };
  /** Dollar signs count as identifier characters in JS/Shell, and are harmless elsewhere. */
  var LEX_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  var LEX_MAX = 5000;
  /** LSP CompletionItemKind numbers, so both sources render through one table. */
  var KIND_TEXT = {
    2: 'fn', 3: 'fn', 4: 'fn', 5: 'va', 6: 'va', 7: 'cl', 8: 'cl', 9: 'mo',
    10: 'va', 13: 'cl', 14: 'kw', 20: 'co', 21: 'co', 22: 'cl', 25: 'ty'
  };
  function lexicalIndex() {
    if (LEX.text === ta.value) return LEX;
    var text = ta.value, ids = Object.create(null), kinds = Object.create(null);
    var m, n = 0;
    LEX_RE.lastIndex = 0;
    while ((m = LEX_RE.exec(text)) !== null) {
      var w = m[0];
      if (w.length < 2) continue;                 // a single letter is not worth a popup
      if (ids[w] != null) { ids[w]++; continue; }
      if (n >= LEX_MAX) continue;
      ids[w] = 1; n++;
      // Only the first occurrence is inspected: "followed by (" is a guess that
      // survives being wrong, and it costs nothing next to a real parse.
      var i = LEX_RE.lastIndex, ch = '';
      while (i < text.length) {
        ch = text.charAt(i);
        if (ch !== ' ' && ch !== '\t') break;
        i++;
      }
      kinds[w] = ch === '(' ? 3 : (/^[A-Z][A-Z0-9_]*$/.test(w) ? 21 : (/^[A-Z]/.test(w) ? 7 : 6));
    }
    LEX.text = text; LEX.ids = ids; LEX.kinds = kinds;
    return LEX;
  }
  function lexicalItems(prefix) {
    var lex = lexicalIndex(), ids = lex.ids, out = [];
    var lower = prefix.toLowerCase();
    for (var w in ids) {
      if (w.length <= prefix.length) continue;
      if (w.slice(0, prefix.length).toLowerCase() !== lower) continue;
      out.push({ label: w, kind: lex.kinds[w], detail: '', count: ids[w] });
    }
    // Frequent first (identifiers the file keeps using), then the shorter one:
    // for the prefix "tot" the winner should be total, not total_price_cents.
    out.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      if (a.label.length !== b.label.length) return a.label.length - b.label.length;
      return a.label < b.label ? -1 : 1;
    });
    return out.slice(0, 50);
  }
  function requestComplete() {
    if (ta.readOnly) { cmpClose(); return; }
    var pref = wordPrefix();
    if (pref.length < 1) { cmpClose(); return; }
    // Fresh input / an explicit request re-opens the popup even if the user had
    // dismissed the previous one.
    CMP.dismissed = false;
    // L1 first: it is local and instant, so the popup is on screen before the
    // LSP round-trip answers — or when it never answers at all.
    CMP.lex = LEXICAL[currentLang] === false ? [] : lexicalItems(pref);
    if (CMP.lex.length) {
      CMP.items = CMP.lex.slice(0, 50); CMP.sel = 0; CMP.open = true; renderCmp();
    } else {
      cmpClose();
    }
    if (!lspLang()) return;
    CMP.reqId++;
    var lc = caretLC();
    BRIDGE.send({ kind: 'complete', code: ta.value, language: lspLang(), line: lc.line, character: lc.character, requestId: CMP.reqId });
  }
  function onCompletion(m) {
    if (m.requestId !== CMP.reqId) return;
    // The user closed it (Esc / accept / blur): a late answer must not reopen.
    if (CMP.dismissed) return;
    var pref = wordPrefix();
    // Match the prefix the same way L1 does (case-insensitive), otherwise an LSP
    // that returns Calculate for a typed cal would be silently dropped.
    var lowerPref = pref.toLowerCase();
    var lsp = (m.items || []).filter(function (it) {
      return it && it.label && it.label.length > pref.length && it.label.slice(0, pref.length).toLowerCase() === lowerPref;
    });
    // Nothing from L2: keep what L1 already put on screen.
    if (!lsp.length) return;
    var seen = Object.create(null), merged = [];
    lsp.forEach(function (it) { if (!seen[it.label]) { seen[it.label] = 1; merged.push(it); } });
    (CMP.lex || []).forEach(function (it) { if (!seen[it.label]) { seen[it.label] = 1; merged.push(it); } });
    // The server's ranking beats alphabetical order: 'sortText' is how pyright
    // puts the likely match first. Falls back to the label when absent.
    merged.sort(function (a, b) {
      var ka = a.sortText || a.label, kb = b.sortText || b.label;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    var keep = (CMP.open && CMP.items[CMP.sel]) ? CMP.items[CMP.sel].label : '';
    CMP.items = merged.slice(0, 50);
    CMP.sel = 0;
    if (keep) {
      for (var i = 0; i < CMP.items.length; i++) { if (CMP.items[i].label === keep) { CMP.sel = i; break; } }
    }
    CMP.open = true;
    renderCmp();
  }
  function renderCmp() {
    var el = $('cmp');
    el.innerHTML = CMP.items.map(function (it, i) {
      var k = it.kind == null ? '' : (KIND_TEXT[it.kind] || String(it.kind).slice(0, 2));
      return '<div class="row' + (i === CMP.sel ? ' sel' : '') + '" data-i="' + i + '"><span class="k">' + esc(k) + '</span><span>' + esc(it.label) + '</span><span class="d">' + esc(it.detail || '') + '</span></div>';
    }).join('');
    var selIt = CMP.items[CMP.sel];
    var doc = selIt ? CMP.docs[selIt.label] : undefined;
    if (doc) {
      el.innerHTML += '<div class="cmp-doc" data-cmpdoc="1">' + esc(String(doc).slice(0, 160)) + '</div>';
    }
    el.querySelectorAll('.row').forEach(function (row) {
      row.addEventListener('mousedown', function (ev) { ev.preventDefault(); CMP.sel = +row.getAttribute('data-i'); cmpAccept(); });
    });
    // Ask for the highlighted row's documentation once; the list frame carries
    // labels only, because full docstrings for a hundred items is tens of KB per
    // keystroke and the user reads one.
    if (selIt && CMP.docs[selIt.label] === undefined && lspLang()) {
      CMP.docs[selIt.label] = null;
      BRIDGE.send({ kind: 'completionResolve', language: currentLang, label: selIt.label, requestId: navNextId() });
    }
    var host = el.parentNode ? el.parentNode : document.body;
    var left, top;
    if (CMEDITOR) {
      // Anchor to the real cursor: CM's gutter/padding differ from the
      // textarea's fixed 56px/14px assumptions.
      var co = CMEDITOR.cm.cursorCoords(true, 'local');
      var wrapRect = CMEDITOR.cm.getWrapperElement().getBoundingClientRect();
      var hostRect = host.getBoundingClientRect();
      left = wrapRect.left - hostRect.left + co.left;
      top = wrapRect.top - hostRect.top + co.bottom;
    } else {
      var lc = caretLC();
      left = 56 + 14 + lc.character * 7.2 - ta.scrollLeft;
      top = 10 + (lc.line + 1) * 20 - ta.scrollTop;
    }
    el.style.left = Math.max(58, Math.min(left, host.clientWidth - 250)) + 'px';
    el.style.top = Math.max(2, Math.min(top, host.clientHeight - 44)) + 'px';
    el.classList.add('open');
  }
  function cmpMove(d) { if (!CMP.open || !CMP.items.length) return; CMP.sel = (CMP.sel + d + CMP.items.length) % CMP.items.length; renderCmp(); }
  /**
   * Expand the subset of the snippet syntax a language server actually sends:
   * a placeholder like $ followed by a number and an optional :default becomes
   * the default text (or nothing), and placeholder zero marks where the caret
   * should land. Anything else is kept verbatim.
   *
   * Full LSP snippets (choices, transforms, nesting) are not attempted - a
   * half-implemented grammar is worse than the common cases plus a caret.
   */
  function expandSnippet(text) {
    if (text == null) return { text: '', caret: 0 };
    var src = String(text);
    if (src.indexOf('$') < 0) return { text: src, caret: src.length };
    var out = '', caret = -1, i = 0;
    while (i < src.length) {
      var ch = src.charAt(i);
      if (ch !== '$') { out += ch; i++; continue; }
      var rest = src.slice(i);
      var m = /^\$\{(\d+):([^}]*)\}/.exec(rest) || /^\$\{(\d+)\}/.exec(rest) || /^\$(\d+)/.exec(rest);
      if (!m) { out += ch; i++; continue; }
      var num = Number(m[1]);
      var body = m[2] == null ? '' : m[2];
      if (num === 0) caret = out.length;
      out += body;
      i += m[0].length;
    }
    return { text: out, caret: caret >= 0 ? caret : out.length };
  }

  function cmpAccept() {
    if (!CMP.open) return;
    var it = CMP.items[CMP.sel]; CMP.dismissed = true; cmpClose();
    if (!it) return;
    // 'insertText' is the server's preferred insertion (often 'get(url, timeout)');
    // 'label' is only the display text.
    var ins = expandSnippet(it.insertText != null ? it.insertText : it.label);
    var pos = ta.selectionStart, pref = wordPrefix(), start = pos - pref.length;
    ta.value = ta.value.slice(0, start) + ins.text + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = start + ins.caret;
    renderEditor(); updateCaret();
  }
  function cmpClose() { CMP.open = false; var el = $('cmp'); if (el) el.classList.remove('open'); }
  function onCodeMouseMove(e) {
    clearTimeout(HOV.timer);
    if (CMEDITOR) {
      var p = CMEDITOR.cm.coordsChar({ left: e.clientX, top: e.clientY });
      HOV.cx = e.clientX; HOV.cy = e.clientY;
      // A diagnostic on the line under the pointer wins over an LSP hover: it is
      // already local, so it answers "why is this red?" instantly, with no
      // round-trip. Only fall back to hover when the line is clean.
      var ds = diagsOnLine(p.line);
      if (ds.length) {
        var tip = $('hoverTip');
        if (tip) {
          tip.textContent = ds.map(function (d) {
            return (d.severity === 1 ? 'Error' : d.severity === 2 ? 'Warning' : 'Info') + ': ' + d.message;
          }).join(NLc + NLc);
          showTipAt(HOV.cx, HOV.cy, tip);
        }
        return;
      }
      var t0 = $('hoverTip'); if (t0) t0.classList.remove('open');
      HOV.timer = setTimeout(function () { requestHoverAt(p.line, p.ch); }, 450);
      return;
    }
    var rect = ta.getBoundingClientRect();
    HOV.cx = e.clientX; HOV.cy = e.clientY;
    var x = e.clientX - rect.left, y = e.clientY - rect.top;
    HOV.timer = setTimeout(function () { requestHover(x, y); }, 450);
  }
  function wordAt(text, col) {
    var i = 0, n = text.length;
    while (i < n) {
      if (isWordCh(text.charAt(i))) {
        var j = i; while (j < n && isWordCh(text.charAt(j))) j++;
        if (i <= col && col <= j) return { start: i, text: text.slice(i, j) };
        i = j;
      } else i++;
    }
    return null;
  }
  function requestHover(x, y) {
    if (!lspLang()) return;
    var line = Math.floor((y - 10 + ta.scrollTop) / 20);
    var col = Math.floor((x - 14 + ta.scrollLeft) / 7.2);
    requestHoverAt(line, col);
  }
  function requestHoverAt(line, col) {
    if (!lspLang()) return;
    var lines = ta.value.split(NLc);
    if (line < 0 || line >= lines.length) { $('hoverTip').classList.remove('open'); return; }
    var w = wordAt(lines[line], col);
    if (!w) { $('hoverTip').classList.remove('open'); return; }
    HOV.reqId++;
    BRIDGE.send({ kind: 'hover', code: ta.value, language: lspLang(), line: line, character: w.start + 1, requestId: HOV.reqId });
  }
  /** Position an open hover tip near the pointer, clamped inside its host. */
  function showTipAt(cx, cy, tip) {
    var host = tip.parentNode ? tip.parentNode : document.body;
    var hr = host.getBoundingClientRect();
    tip.style.left = Math.max(0, Math.min(cx - hr.left + 12, host.clientWidth - 340)) + 'px';
    tip.style.top = (cy - hr.top + 16) + 'px';
    tip.classList.add('open');
  }
  function onHover(m) {
    if (m.requestId !== HOV.reqId) return;
    var tip = $('hoverTip'), text = hoverText(m.hover);
    if (!text) { tip.classList.remove('open'); return; }
    tip.textContent = text;
    showTipAt(HOV.cx, HOV.cy, tip);
  }
  function hoverText(h) {
    if (!h) return '';
    var c = (h.contents != null) ? h.contents : h;
    if (typeof c === 'string') return c;
    if (c && typeof c.value === 'string') return c.value;
    if (Object.prototype.toString.call(c) === '[object Array]') {
      return c.map(function (x) { return (typeof x === 'string') ? x : (x && x.value) || ''; }).join(NLc + NLc);
    }
    return '';
  }

  // ---------- editor buffers + tabs ----------
  // BUFFERS maps a file's rel-path -> { content, languageId, editable, dirty, mtime }.
  // Editing happens in memory; saveFile flushes the active buffer to disk via fsWrite.
  var BUFFERS = {};
  var PENDING_SAVES = Object.create(null); // reqId -> { path, content }
  var SAVE_IN_FLIGHT = Object.create(null); // path -> reqId
  var SAVE_QUEUED = Object.create(null); // path -> newest requested content
  var CLOSE_AFTER_SAVE = Object.create(null);
  var SAVE_SEQ = 0;
  var CLOSE_ALL_BATCH = null;
  var TABS = ['main.py', 'utils.py', 'README.md']; // open rel-paths (seeded with samples)
  function isOpen(p) { return TABS.indexOf(p) >= 0; }
  function bufferDirty(p) { return BUFFERS[p] ? BUFFERS[p].dirty : false; }
  function langOfName(name) {
    var d = String(name).lastIndexOf('.');
    var ext = d < 0 ? '' : name.slice(d + 1).toLowerCase();
    if (!ext) return undefined;
    return EXT_LANG[ext];
  }
  function renderTabs() {
    var el = $('etabs'); el.innerHTML = '';
    TABS.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'etab' + (p === currentFile ? ' active' : '');
      b.setAttribute('data-tab', p); // the right-click menu needs to know which tab
      b.innerHTML = '<span class="ic">' + ic('file', 16) + '</span><span class="nm">' + esc(p) + '</span>' +
        (p === currentFile && bufferDirty(p) ? '<span class="dirty">●</span>' : '') +
        '<span class="x" data-close="' + esc(p) + '">' + ic('close', 12) + '</span>';
      b.addEventListener('click', function (e) {
        if (e.target.closest('[data-close]')) { e.stopPropagation(); closeTab(p); return; }
        openFile(p);
      });
      el.appendChild(b);
    });
    var more = document.createElement('button');
    more.className = 'more'; more.innerHTML = ic('chevD', 16); more.title = 'Show hidden tabs';
    el.appendChild(more);
  }
  function finishCloseAllBatch() {
    var batch = CLOSE_ALL_BATCH;
    if (!batch) return;
    for (var i = 0; i < batch.dirty.length; i++) {
      var p = batch.dirty[i];
      if (SAVE_IN_FLIGHT[p] != null || Object.prototype.hasOwnProperty.call(SAVE_QUEUED, p) || bufferDirty(p)) return;
    }
    CLOSE_ALL_BATCH = null;
    batch.tabs.forEach(function (p) { closeTab(p, true); });
  }
  function closeTab(p, discard) {
    var i = TABS.indexOf(p); if (i < 0) return;
    if (!discard && bufferDirty(p)) {
      confirmDialog({
        title: 'Unsaved Changes',
        icon: 'warn',
        message: 'Save changes to ' + p + ' before closing?',
        buttons: [
          { label: 'Cancel', onClick: function () {} },
          { label: "Don't Save", danger: true, onClick: function () { closeTab(p, true); } },
          { label: 'Save', primary: true, onClick: function () { CLOSE_AFTER_SAVE[p] = true; saveBuffer(p); } }
        ]
      });
      return;
    }
    delete CLOSE_AFTER_SAVE[p];
    TABS.splice(i, 1); delete BUFFERS[p];
    if (currentFile === p) {
      var next = TABS[TABS.length - 1];
      if (next) openFile(next);
      else { currentFile = null; currentLang = 'python'; ta.value = ''; ta.readOnly = true; $('stFile').textContent = ''; renderStLang(); renderTabs(); renderEditor(); }
    } else { renderTabs(); }
    savePrefs({ tabs: TABS, current: currentFile });
  }
  function openFile(name) {
    if (BUFFERS[name]) { showBuffer(name); return; }
    // Load from the real filesystem; fall back to the bundled sample for offline boot.
    BRIDGE.send({ kind: 'fsRead', path: name });
    if (FILES[name] != null) showBuffer(name, FILES[name]);
  }
  function showBuffer(name, fallback) {
    // Preserve the live editor text before another buffer replaces the textarea.
    // Dirty state belongs to the buffer, not to whichever document is visible.
    if (currentFile && currentFile !== name && BUFFERS[currentFile]) BUFFERS[currentFile].content = ta.value;
    var buf = BUFFERS[name];
    if (!buf) {
      if (fallback == null) { toast('no content for ' + name); return; }
      buf = BUFFERS[name] = { content: fallback, languageId: langOfDoc(name), editable: true, dirty: false };
    }
    if (!isOpen(name)) TABS.push(name);
    if (currentFile !== name) clearCoverage();
    currentFile = name; currentLang = buf.languageId || 'python';
    pkgSync();
    ta.value = buf.content;
    ta.readOnly = !buf.editable;
    $('stFile').textContent = name;
    renderStLang();
    renderTabs(); renderEditor(); updateCaret();
    // A Markdown buffer needs a render before its outline can exist; switching
    // away must drop the pane instead of showing the previous file's HTML.
    mdAfterDocSwitch();
    // Stale marks from the previous document must not follow the caret here.
    clearDiags();
    requestCheck();
    pushRecent(name);
    savePrefs({ tabs: TABS, current: currentFile });
  }
  function sendBufferSave(p, content) {
    var reqId = ++SAVE_SEQ;
    SAVE_IN_FLIGHT[p] = reqId;
    PENDING_SAVES[reqId] = { path: p, content: content };
    BRIDGE.send({ kind: 'fsWrite', path: p, content: content, reqId: reqId });
    if (p === currentFile) setStatusHint('Saving ' + p + ' …');
  }
  function saveBuffer(p) {
    var buf = BUFFERS[p];
    if (!buf || buf.editable === false) { reportError({ level: 'warn', title: 'Read-only', message: p + ' cannot be modified.' }); return; }
    var content = (p === currentFile) ? ta.value : buf.content;
    buf.content = content;
    if (SAVE_IN_FLIGHT[p] != null) SAVE_QUEUED[p] = content;
    else sendBufferSave(p, content);
  }
  function saveFile() {
    if (!currentFile || !BUFFERS[currentFile]) { reportError({ level: 'warn', title: 'Nothing to save', message: 'No document is open.' }); return; }
    if (ta.readOnly) { reportError({ level: 'warn', title: 'Read-only', message: currentFile + ' cannot be modified.' }); return; }
    var p = currentFile;
    saveBuffer(p);
    // No dialog: PyCharm writes straight to disk and only shows a transient
    // status-bar hint. The failure path is the one that talks.
    setStatusHint('Saving ' + p + ' …');
    // L3: a save is a natural checkpoint — check the file we just wrote and, if
    // it still has errors, say so once instead of letting Run be the first to
    // find out. (setDiags turns pendingSaveCheck into the balloon.)
    if (lspLang()) { pendingSaveCheck = true; requestCheck(); }
  }
  function onFsFile(f) {
    var name = f.path;
    BUFFERS[name] = { content: f.content, languageId: langOfDoc(name, f.languageId), editable: f.truncated ? false : f.editable !== false, dirty: false, mtime: f.mtime };
    if (!isOpen(name)) TABS.push(name);
    if (currentFile === name || currentFile == null) showBuffer(name);
    else renderTabs();
  }
  function onFsSaved(m) {
    var reqId = Number(m.reqId);
    if (!isFinite(reqId) || !PENDING_SAVES[reqId]) reqId = Number(SAVE_IN_FLIGHT[m.path]);
    var pending = PENDING_SAVES[reqId];
    if (!pending || pending.path !== m.path) {
      // An uncorrelated acknowledgement must not clear dirty state: doing so
      // would claim unsaved text reached disk when this page has no matching write.
      renderTabs();
      setStatusHint('Save acknowledgement was not matched for ' + m.path);
      return;
    }
    delete PENDING_SAVES[reqId];
    if (SAVE_IN_FLIGHT[m.path] === reqId) delete SAVE_IN_FLIGHT[m.path];
    var buf = BUFFERS[m.path];
    if (buf && buf.content === pending.content) buf.dirty = false;

    if (Object.prototype.hasOwnProperty.call(SAVE_QUEUED, m.path)) {
      var queued = SAVE_QUEUED[m.path];
      delete SAVE_QUEUED[m.path];
      sendBufferSave(m.path, queued);
    }
    renderTabs();
    setStatusHint((buf && buf.dirty) ? 'Saved an earlier version of ' + m.path : 'Saved ' + m.path);

    if (CLOSE_ALL_BATCH) {
      finishCloseAllBatch();
      if (CLOSE_ALL_BATCH) return;
    }
    if (CLOSE_AFTER_SAVE[m.path] && SAVE_IN_FLIGHT[m.path] == null && !Object.prototype.hasOwnProperty.call(SAVE_QUEUED, m.path)) {
      delete CLOSE_AFTER_SAVE[m.path];
      if (buf && !buf.dirty) closeTab(m.path, true);
      else toast('Newer edits remain in ' + m.path + '; save again before closing.');
    }
  }
  function onFsError(m) {
    var reqId = Number(m.reqId);
    var pending = PENDING_SAVES[reqId];
    if (pending && pending.path === m.path) {
      delete PENDING_SAVES[reqId];
      if (SAVE_IN_FLIGHT[m.path] === reqId) delete SAVE_IN_FLIGHT[m.path];
      delete SAVE_QUEUED[m.path];
      delete CLOSE_AFTER_SAVE[m.path];
      if (CLOSE_ALL_BATCH) CLOSE_ALL_BATCH.dirty.forEach(function (p) { delete CLOSE_AFTER_SAVE[p]; });
      CLOSE_ALL_BATCH = null;
      reportError({ level: 'error', title: 'Save failed', message: String(m.message || m.code || 'unknown'), detail: m.path + ' was not closed.' });
      return;
    }
    // A read of an embedded-sample path (e.g. boot's main.py) legitimately has
    // no on-disk file; we already loaded the bundled fallback, so stay quiet.
    if (m.path && BUFFERS[m.path]) return;
    reportError({ level: 'error', title: 'File system error', message: String(m.message || m.code || 'unknown'), detail: m.path });
  }
  /** Transient status-bar hint — the only feedback a successful save gives. */
  var hintT;
  function setStatusHint(text) {
    var el = $('stHint'); if (!el) return;
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(hintT);
    hintT = setTimeout(function () { el.textContent = ''; el.classList.remove('on'); }, 2400);
  }
  ta.addEventListener('input', function () {
    if (currentFile && BUFFERS[currentFile]) {
      BUFFERS[currentFile].content = ta.value;
      BUFFERS[currentFile].dirty = true;
    }
    if (CLOSE_ALL_BATCH) {
      CLOSE_ALL_BATCH.dirty.forEach(function (p) { delete CLOSE_AFTER_SAVE[p]; });
      CLOSE_ALL_BATCH = null;
      toast('Edits changed while saving; tabs remain open.');
    }
    renderTabs();
  });

  // ---------- tool strip + tool windows ----------
  // Scope note: this shell is a *language* IDE. Database / Docker / remote / HTTP
  // client tooling is deliberately out of scope, so there is no database window
  // or strip entry — only the language-relevant tool windows live here.
  var LEFT_WINDOWS = [
    { id: 'project', title: 'Project', icon: 'project', key: 'Alt+1' },
    { id: 'structure', title: 'Structure', icon: 'structure', key: 'Alt+7' },
    { id: 'vcs', title: 'Version Control', icon: 'vcs', key: 'Alt+9' },
    { id: 'commit', title: 'Commit', icon: 'commit', key: 'Ctrl+K' },
    { id: 'ai', title: 'AI Assistant', icon: 'ai', key: 'Alt+A' },
    { id: 'mcp', title: 'MCP', icon: 'mcp', key: 'Alt+M' }
  ];
  var BOTTOM_WINDOWS = [
    { id: 'run', title: 'Run', icon: 'run', key: 'Alt+4' },
    // PyCharm keeps a separate Debug window: the run console is for output,
    // while frames / variables / watches only make sense while stopped.
    { id: 'debug', title: 'Debug', icon: 'debug', key: '' },
    { id: 'terminal', title: 'Terminal', icon: 'terminal', key: 'Alt+F12' },
    // Packages is PyCharm's Python Packages window, generalized: the list and
    // the installer both come from the language manifest, so it shows the
    // project's real dependency file for whichever language is open.
    { id: 'packages', title: 'Packages', icon: 'database', key: 'Alt+6' },
    { id: 'perf', title: 'Performance', icon: 'perf', key: 'Alt+8' },
    { id: 'logs', title: 'Logs', icon: 'logs', key: 'Alt+0' },
    { id: 'find', title: 'Find', icon: 'search', key: 'Ctrl+Shift+F' }
  ];
  var PROBLEMS = { id: 'problems', title: 'Problems', icon: 'warn', key: '' };
  // strip order per PyCharm New UI
  var STRIP = ['project', 'vcs', 'commit', 'terminal', 'run', 'structure', 'perf', 'logs', 'ai', 'mcp'];

  var activeLeft = 'project';
  var activeBottom = 'run';
  var pinned = true;

  function windowById(id) {
    var all = LEFT_WINDOWS.concat(BOTTOM_WINDOWS).concat([PROBLEMS]);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function isBottom(id) { return id === 'run' || id === 'debug' || id === 'terminal' || id === 'packages' || id === 'perf' || id === 'logs' || id === 'problems' || id === 'find'; }

  function renderStrip() {
    var el = $('strip'); el.innerHTML = '';
    STRIP.forEach(function (id) {
      var w = windowById(id); if (!w) return;
      var b = document.createElement('button');
      b.className = 'sbtn' + ((isBottom(id) ? activeBottom === id : activeLeft === id && !$('leftPanel').classList.contains('hidden')) ? ' active' : '');
      b.innerHTML = ic(w.icon, 20);
      b.title = w.title + (w.key ? '  ' + w.key : '');
      b.addEventListener('click', function () { toggleWindow(id); });
      el.appendChild(b);
    });
    var grow = document.createElement('span'); grow.className = 'grow'; el.appendChild(grow);
    var s = document.createElement('button');
    s.className = 'sbtn'; s.innerHTML = ic('settings', 20); s.title = 'Settings  Ctrl+Alt+S';
    s.addEventListener('click', openSettings);
    el.appendChild(s);
  }

  function saveLayout() {
    savePrefs({
      left: activeLeft, bottom: activeBottom,
      leftHidden: $('leftPanel').classList.contains('hidden'),
      bottomHidden: $('dock').classList.contains('hidden')
    });
  }
  function toggleWindow(id) {
    if (isBottom(id)) {
      activeBottom = id;
      $('dock').classList.remove('hidden');
      renderDock();
    } else {
      var panel = $('leftPanel');
      if (activeLeft === id && !panel.classList.contains('hidden')) panel.classList.add('hidden');
      else { activeLeft = id; panel.classList.remove('hidden'); }
      renderPanel();
      // Opening the panel asks for a fresh catalogue (the engine may have
      // restarted, or the config file changed on disk).
      if (id === 'mcp' && !panel.classList.contains('hidden')) BRIDGE.send({ kind: 'mcpList' });
    }
    renderStrip();
    saveLayout();
  }

  // ---- left panel content ----
  function renderPanel() {
    var w = windowById(activeLeft); if (!w) return;
    $('panelTitle').textContent = w.title;
    var body = $('panelBody');
    if (activeLeft === 'project') { if (!TREE['']) loadDir(''); renderTree(); }
    else if (activeLeft === 'structure') body.innerHTML = structureTree(ta.value);
    else if (activeLeft === 'vcs') body.innerHTML = vcsPane();
    else if (activeLeft === 'commit') body.innerHTML = commitPane();
    else if (activeLeft === 'ai') body.innerHTML = aiPane();
    else if (activeLeft === 'mcp') { body.innerHTML = mcpPane(); wireMcp(body); }
    else body.innerHTML = '';
    if (activeLeft === 'commit') wireCommit(body);
    if (activeLeft === 'vcs') wireVcs(body);
  }
  function treeHtml(nodes) {
    var h = '<div style="padding:6px 4px;font-size:12.5px">';
    nodes.forEach(function (n) {
      h += '<div style="display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:5px;margin-left:' + (n.d * 14) + 'px" class="tnode">';
      h += '<span class="ic" style="color:var(--icon-default)">' + ic(n.dir ? 'project' : 'file', 16) + '</span>';
      h += '<span>' + esc(n.name) + '</span></div>';
    });
    return h + '</div>';
  }
  // ---------- project tree (real filesystem) ----------
  var TREE = {};        // dir relPath -> FsEntry[] (one level, cached)
  var TREE_LOADING = {};// dir relPath -> true while a listing is in flight
  var EXPANDED = { '': true }; // root expanded by default
  var ROOT_NAME = 'Project';

  function parentDir(p) { var i = String(p).lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function loadDir(path) {
    if (!BRIDGE.ready()) return; // don't send until the socket is open
    if (TREE[path] || TREE_LOADING[path]) return;
    TREE_LOADING[path] = true;
    BRIDGE.send({ kind: 'fsList', path: path });
  }
  function refreshDir(path) { delete TREE[path]; delete TREE_LOADING[path]; loadDir(path); }
  function renderTree() {
    var body = $('panelBody'); if (!body) return;
    body.innerHTML = '<div class="ptree" id="ptree">' + renderNodes('', 0) + '</div>';
    wireTree(body);
  }
  function renderNodes(path, depth) {
    if (path && !EXPANDED[path]) return '';
    var entries = TREE[path];
    if (entries == null) return TREE_LOADING[path] ? '<div class="pempty">loading…</div>' : '';
    var h = '';
    entries.forEach(function (e) {
      var isDir = e.kind === 'dir';
      if (isDir) {
        h += '<div class="tnode dir ' + (EXPANDED[e.path] ? 'open' : '') + '" data-path="' + esc(e.path) + '" data-kind="dir" style="padding-left:' + (6 + depth * 14) + 'px">' +
          '<span class="chev">' + ic(EXPANDED[e.path] ? 'chevD' : 'chevR', 14) + '</span>' +
          '<span class="ic">' + ic('project', 16) + '</span><span class="nm">' + esc(e.name) + '</span></div>';
        h += renderNodes(e.path, depth + 1);
      } else {
        h += '<div class="tnode file ' + (e.path === currentFile ? 'active' : '') + (e.editable ? '' : ' ro') + '" data-path="' + esc(e.path) + '" data-kind="file" style="padding-left:' + (6 + (depth + 1) * 14) + 'px">' +
          '<span class="chev"></span><span class="ic">' + ic('file', 16) + '</span><span class="nm">' + esc(e.name) + '</span></div>';
      }
    });
    return h;
  }
  function wireTree(scope) {
    scope.querySelectorAll('.tnode').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.button !== 0) return;
        var path = row.getAttribute('data-path'), kind = row.getAttribute('data-kind');
        if (kind === 'dir') { var was = EXPANDED[path]; if (was) delete EXPANDED[path]; else EXPANDED[path] = true; loadDir(path); renderTree(); }
        else openFile(path);
      });
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var rp = row.getAttribute('data-path'), dir = parentDir(rp), isDir = row.getAttribute('data-kind') === 'dir';
        var target = isDir ? rp : dir;
        showCtx(e.clientX, e.clientY, [
          { label: 'New', sc: 'Alt+Ins', act: function () { showNewPopup(e.clientX, e.clientY, target); } },
          { sep: true },
          { label: 'Open', act: function () { openFile(rp); } },
          { label: 'Copy Path', act: function () { copyText(rp); } },
          { sep: true },
          { label: 'Rename…', sc: 'Shift+F6', act: function () { startInlineRename(row, rp); } },
          { label: 'Delete…', sc: 'Del', act: function () { deleteEntry([rp]); } }
        ]);
      });
      // PyCharm renames on F2 / a slow second click as well as from the menu.
      row.addEventListener('dblclick', function () {
        var rp = row.getAttribute('data-path');
        if (rp) startInlineRename(row, rp);
      });
    });
  }
  function onFsListing(m) {
    TREE[m.path] = m.entries || []; TREE_LOADING[m.path] = false;
    if (activeLeft === 'project') renderTree();
  }
  function onFsChanged(m) {
    if (m.op === 'create') refreshDir(parentDir(m.path));
    else if (m.op === 'rename') { refreshDir(parentDir(m.from)); refreshDir(parentDir(m.path)); }
    else if (m.op === 'delete') refreshDir(parentDir(m.path));
  }
  // ---------- project-tree editing (PyCharm semantics) ----------
  // New is a popup menu of entry kinds, then a naming dialog whose field starts
  // with the whole name selected — typing replaces it, Enter commits, Escape
  // cancels, and a name that already exists is refused inline.
  function showNewPopup(x, y, dirPath) {
    // Derived from the language catalogue, so a newly installed plugin adds its
    // own "New … File" entry without touching this file.
    var items = LANG_LIST.filter(function (l) {
      return SERVER_LANGS[l.id] && DEFAULT_EXT[l.id];
    }).map(function (l) {
      var ext = DEFAULT_EXT[l.id];
      return { label: l.name + ' File', act: function () { nameEntry(dirPath, 'file', ext); } };
    });
    items.push({ sep: true });
    items.push({ label: 'File', act: function () { nameEntry(dirPath, 'file', ''); } });
    items.push({ label: 'Directory', act: function () { nameEntry(dirPath, 'dir', ''); } });
    showCtx(x, y, items);
  }
  /** Does path already exist among the entries we know for its directory? */
  function entryExists(dirPath, name) {
    var full = dirPath ? dirPath + '/' + name : name;
    var known = TREE[dirPath] || [];
    for (var i = 0; i < known.length; i++) if (known[i].path === full) return true;
    return false;
  }
  function nameEntry(dirPath, kind, ext) {
    var seed = ext ? 'untitled.' + ext : (kind === 'dir' ? 'newFolder' : 'untitled');
    showModal({
      title: 'New ' + (kind === 'dir' ? 'Directory' : ext ? ext.toUpperCase() + ' File' : 'File'),
      icon: kind === 'dir' ? 'project' : 'file',
      message: dirPath ? 'in ' + dirPath : 'in the project root',
      fields: [{
        name: 'name', label: 'Name', value: seed, placeholder: 'name' + (ext ? '.' + ext : ''),
        validator: function (v) {
          var n = String(v || '').trim();
          if (!n) return 'Name is required';
          if (/[\/:*?"<>|]/.test(n)) return 'These characters are not allowed: \ / : * ? " < > |';
          if (entryExists(dirPath, n)) return 'That name already exists here';
          return null;
        },
      }],
      buttons: [
        { label: 'Cancel', onClick: function () {} },
        {
          label: 'OK', primary: true, onClick: function (v) {
            var n = String(v.name || '').trim();
            if (!n) return;
            // PyCharm completes the extension when the user typed a bare name.
            if (ext && n.toLowerCase().indexOf('.' + ext) < 0) n += '.' + ext;
            BRIDGE.send({ kind: 'fsCreate', path: dirPath ? dirPath + '/' + n : n, entryKind: kind });
          },
        },
      ],
    });
  }
  /**
   * Rename in place: the tree row's label becomes an input. No dialog at all —
   * Enter commits, Escape restores, blur commits (PyCharm's tree behaviour).
   */
  function startInlineRename(rowEl, path) {
    var label = rowEl.querySelector('.nm');
    if (!label || rowEl.querySelector('.inline-rename')) return;
    var old = path.split('/').pop();
    var input = document.createElement('input');
    input.className = 'inline-rename';
    input.value = old;
    input.setAttribute('data-rename', path);
    label.parentNode.replaceChild(input, label);
    input.focus(); input.select();
    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      var nv = input.value.trim();
      if (commit && nv && nv !== old) {
        var parent = parentDir(path);
        BRIDGE.send({ kind: 'fsRename', path: path, to: parent ? parent + '/' + nv : nv });
      } else {
        renderTree();
      }
    }
    input.addEventListener('blur', function () { finish(true); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
  }
  /** Delete asks first, with the names on the line — and a danger-coloured button. */
  function deleteEntry(paths) {
    var list = Array.isArray(paths) ? paths : [paths];
    if (!list.length) return;
    confirmDialog({
      title: 'Delete',
      icon: 'warn',
      message: 'Delete ' + list.length + (list.length > 1 ? ' items' : ' item') + '? This cannot be undone.',
      list: list.map(function (p) { return { icon: 'file', label: p }; }),
      buttons: [
        { label: 'Cancel', onClick: function () {} },
        {
          label: 'Delete', danger: true, onClick: function () {
            list.forEach(function (p) { BRIDGE.send({ kind: 'fsDelete', path: p }); });
            balloon({ type: 'success', title: 'Deleted', message: list.length + (list.length > 1 ? ' items' : ' item') });
          },
        },
      ],
    });
  }
  /**
   * Show a context menu. Items are {label, sc?, act?, dis?} or {sep:true}.
   * The menu is flipped back inside the viewport rather than allowed to open
   * off-screen near an edge — the same thing PyCharm does with a popup.
   */
  function showCtx(x, y, items) {
    var m = $('ctxMenu'); if (!m) return;
    m.innerHTML = '';
    items.forEach(function (it) {
      if (it.sep) {
        var s = document.createElement('div'); s.className = 'csep'; m.appendChild(s); return;
      }
      var el = document.createElement('div');
      el.className = 'citem' + (it.dis ? ' dis' : '');
      el.innerHTML = '<span class="clbl">' + esc(it.label) + '</span>' + (it.sc ? '<span class="csc">' + esc(it.sc) + '</span>' : '');
      if (!it.dis) el.addEventListener('click', function (ev) { ev.stopPropagation(); hideCtx(); it.act(); });
      m.appendChild(el);
    });
    m.style.left = '0px'; m.style.top = '0px';
    m.classList.add('open');
    var mw = m.offsetWidth || 220, mh = m.offsetHeight || 100;
    m.style.left = Math.max(6, Math.min(x, window.innerWidth - mw - 6)) + 'px';
    m.style.top = Math.max(6, Math.min(y, window.innerHeight - mh - 6)) + 'px';
  }
  function hideCtx() { var m = $('ctxMenu'); if (m) m.classList.remove('open'); }
  function bootProject() { loadDir(''); openFile(currentFile || 'main.py'); }
  function structureTree(code) {
    // Markdown has no symbols to parse: its structure is the heading list the
    // renderer already produced, so the same rows serve the pane and this window.
    var md = mdStructureRows();
    if (md !== null) return md;
    var lines = code.split('\n'), nodes = [];
    lines.forEach(function (l, i) {
      var m = /^(\s*)(def|class)\s+([A-Za-z_]\w*)/.exec(l);
      if (m) nodes.push({ name: m[3] + (m[2] === 'class' ? ' (class)' : '()'), d: Math.floor(m[1].length / 4), line: i + 1 });
    });
    if (!nodes.length) return '<div class="empty">No symbols in this file.</div>';
    return treeHtml(nodes.map(function (n) { return { name: n.name, d: n.d }; }));
  }
  // The Commit panel is a projection of "git status --porcelain"; pressing
  // Commit asks the engine to stage tracked changes and commit them. Nothing
  // here invents a clean tree.
  var GIT = { status: null, error: '', loading: false };
  function gitChangeRow(c) {
    var s = c.status || '  ';
    var kind = s.indexOf('??') >= 0 ? 'new' : s.indexOf('D') >= 0 ? 'del' : 'mod';
    return '<div class="git-row"><span class="git-st ' + kind + '">' + esc(s.replace(/ /g, '·')) + '</span>' +
      '<span class="git-path" title="' + esc(c.path) + '">' + esc(c.path) + '</span></div>';
  }
  function gitListHtml() {
    if (GIT.error) return '<div class="git-err">' + esc(GIT.error) + '</div>';
    if (!GIT.status) return '<div class="empty">Reading git status…</div>';
    if (!GIT.status.changes.length) {
      return '<div class="empty">Working tree clean on <b>' + esc(GIT.status.branch || 'HEAD') + '</b>.</div>';
    }
    return GIT.status.changes.map(gitChangeRow).join('');
  }
  function commitPane() {
    return '<div class="commit-pane">' +
      '<textarea id="commitMsg" placeholder="Commit message" spellcheck="false"></textarea>' +
      '<div class="commit-actions"><button class="tbtn primary" id="commitBtn">Commit</button>' +
      '<button class="tbtn" id="gitRefresh" title="Refresh git status">Refresh</button></div>' +
      '<div class="commit-branch">' +
      (GIT.status ? 'Changes on <b>' + esc(GIT.status.branch || 'HEAD') + '</b>' : 'Git status') +
      '</div><div class="git-list">' + gitListHtml() + '</div></div>';
  }
  function wireCommit(body) {
    var b = body.querySelector('#commitBtn');
    if (b) b.addEventListener('click', function () {
      var msgEl = body.querySelector('#commitMsg');
      var text = msgEl ? msgEl.value.trim() : '';
      if (!text) { toast('A commit message is required'); if (msgEl) msgEl.focus(); return; }
      b.disabled = true;
      BRIDGE.send({ kind: 'gitCommit', message: text });
    });
    var r = body.querySelector('#gitRefresh');
    if (r) r.addEventListener('click', function () { GIT.status = null; GIT.loading = true; BRIDGE.send({ kind: 'gitStatus' }); });
    if (!GIT.status && !GIT.loading) { GIT.loading = true; BRIDGE.send({ kind: 'gitStatus' }); }
  }
  function vcsPane() {
    return '<div class="commit-pane">' +
      '<div class="commit-branch">' +
      (GIT.status ? 'On <b>' + esc(GIT.status.branch || 'HEAD') + '</b>' : 'Git status') +
      ' · <a id="vcsCommit" style="color:var(--accent);cursor:pointer">Commit…</a></div>' +
      '<div class="git-list">' + gitListHtml() + '</div></div>';
  }
  function wireVcs(body) {
    var c = body.querySelector('#vcsCommit');
    if (c) c.addEventListener('click', function () { toggleWindow('commit'); });
    if (!GIT.status && !GIT.loading) { GIT.loading = true; BRIDGE.send({ kind: 'gitStatus' }); }
  }
  function aiPane() {
    return '<div style="padding:12px;display:flex;flex-direction:column;gap:10px">' +
      '<div style="color:var(--text-secondary);font-size:12px">Ask about the current file.</div>' +
      '<div style="display:flex;gap:6px"><input id="aiInput" placeholder="Explain this function…" style="flex:1;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text-primary)"/>' +
      '<button class="tbtn" id="aiAsk">Ask</button></div>' +
      '<div id="aiOut" class="console dim">—</div></div>';
  }
