  // ---------- tab context menu ----------
  function closeAllTabs() {
    // A pin's whole job is to survive the bulk closes, so pinned tabs are not
    // candidates here at all (an explicit Close still closes one).
    var tabs = TABS.filter(function (p) { return !isPinnedTab(p); });
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
    var reopen = { label: 'Reopen Closed Tab', sc: 'Ctrl+Shift+T', act: reopenClosedTab };
    if (!name) return [{ label: 'Close All', act: closeAllTabs }, { sep: true }, reopen];
    return [
      { label: isPinnedTab(name) ? 'Unpin Tab' : 'Pin Tab', act: function () { togglePinTab(name); } },
      { sep: true },
      { label: 'Close', sc: 'Ctrl+F4', act: function () { closeTab(name); } },
      { label: 'Close Others', act: function () { TABS.slice().forEach(function (p) { if (p !== name && !isPinnedTab(p)) closeTab(p); }); } },
      { label: 'Close All', act: closeAllTabs },
      { sep: true },
      reopen
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
    // Ctrl+Tab belongs to the editor switcher; the plain Tab insertion path
    // below must not also consume it when the event bubbles to the editor.
    if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') return;
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
    // Ctrl+Alt+N: the wizard. Kept out of the editor's own keymap on purpose —
    // it opens a modal, so it must not depend on the caret having focus.
    if (e.ctrlKey && e.altKey && (e.key || '').toLowerCase() === 'n') { e.preventDefault(); wizOpen(); return; }
    if (e.ctrlKey && e.altKey && (e.key || '').toLowerCase() === 'd') { e.preventDefault(); depOpen(); return; }
    if (e.ctrlKey && e.altKey && (e.key || '').toLowerCase() === 'r') { e.preventDefault(); rcOpen(); return; }
    if (e.altKey && e.key === 'F7') { e.preventDefault(); navReferences(); return; }
    if (e.shiftKey && e.key === 'F6') { e.preventDefault(); navRename(); return; }
    if (e.altKey && e.key === 'Enter') { e.preventDefault(); navCodeActions(); return; }
    if (e.key === 'Tab') { e.preventDefault(); insertText(editorIndentUnit()); scheduleComplete(); return; }
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
    var unit = editorIndentUnit();
    var trimmed = lineText.replace(/[ ]+$/, '');
    var last = trimmed.charAt(trimmed.length - 1);
    var grow = (':{(['.indexOf(last) >= 0);
    var nextCh = val.charAt(pos);
    // A colon grows one line; only a real bracket pair opens the blank line
    // that keeps the closing delimiter on its own row.
    if (grow && last !== ':' && (')]}'.indexOf(nextCh) >= 0)) {
      replaceRange(pos, pos, NLc + indent + unit + NLc + indent);
      ta.selectionStart = ta.selectionEnd = pos + 1 + indent.length + unit.length;
    } else {
      var add = grow ? unit : '';
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
    if (DOC_REQ && m.requestId === DOC_REQ) { onDocumentationHover(m); return; }
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
  // A jump to a line in a file that is not buffered yet has to survive the
  // async fsRead: without this, "go to TODO" reads the file, keeps the old tab
  // active, and moves the caret in the wrong buffer.
  var FOCUS_ON_READ = Object.create(null); // path -> { line: zero-based line }
  var SAVE_SEQ = 0;
  var CLOSE_ALL_BATCH = null;
  var TABS = ['main.py', 'utils.py', 'README.md']; // open rel-paths (seeded with samples)
  // Ctrl+Tab is an MRU order, not the tab-bar order. Keeping it beside TABS
  // means every open/close path updates both without a second source of truth.
  var TAB_MRU = [];
  // Ctrl+Shift+T needs the position the user was at, not just the path. The
  // stack is session-scoped: a closed file comes back from disk, not from a
  // discarded buffer, so "Don't Save" still means "don't save".
  var CLOSED_TABS = [];
  var CLOSED_TABS_MAX = 20;
  // Last Edit Location is deliberately one snapshot, not the navigation
  // history: ordinary tab switches must not push the place where typing
  // happened. Recording on the editor input event keeps programmatic buffer
  // refreshes from stealing this marker.
  var LAST_EDIT = null;
  function noteEditLocation() {
    if (!currentFile || !BUFFERS[currentFile]) return;
    LAST_EDIT = { path: currentFile, view: viewSnapshot() };
  }
  function gotoLastEditLocation() {
    if (!LAST_EDIT) { toast('No previous edit location'); return; }
    var target = LAST_EDIT;
    LAST_EDIT = null;
    openFile(target.path, 0, target.view);
    setStatusHint('Last edit · ' + target.path);
  }
  function caretSnapshot() {
    if (CMEDITOR && CMEDITOR.cm) {
      var c = CMEDITOR.cm.getCursor(), s = CMEDITOR.cm.getScrollInfo();
      return { line: c.line, ch: c.ch, scroll: s.top || 0 };
    }
    var pos = ta.selectionStart, before = ta.value.slice(0, pos);
    return { line: before.split('\n').length - 1, ch: pos - before.lastIndexOf('\n') - 1, scroll: ta.scrollTop || 0 };
  }
  // A tab is more than text: going back to it should keep the caret, any
  // selection and the scroll position. The view map is session-scoped and
  // separate from buffers so disk reloads do not depend on it.
  var VIEW_STATE = Object.create(null);
  function viewSnapshot() {
    var v = caretSnapshot();
    // The textarea adapter mirrors selections onto CodeMirror. Recording the
    // DOM offsets keeps multi-character selections exact in both modes.
    v.selStart = ta.selectionStart;
    v.selEnd = ta.selectionEnd;
    return v;
  }
  function applyViewSnapshot(v) {
    if (!v || typeof v.line !== 'number') return;
    gotoLine(v.line, v.ch || 0);
    if (typeof v.selStart === 'number' && v.selStart >= 0 && typeof v.selEnd === 'number' && v.selEnd >= 0) {
      var max = ta.value.length;
      ta.selectionStart = Math.min(v.selStart, max);
      ta.selectionEnd = Math.min(v.selEnd, max);
      updateCaret();
    }
    if (typeof v.scroll === 'number') {
      if (CMEDITOR && CMEDITOR.cm && CMEDITOR.cm.scrollTo) CMEDITOR.cm.scrollTo(null, v.scroll);
      else { ta.scrollTop = v.scroll; if (typeof syncScroll === 'function') syncScroll(); }
    }
  }
  function rememberClosedTab(p) {
    if (!p) return;
    var at = currentFile === p ? caretSnapshot() : { line: 0, ch: 0, scroll: 0 };
    CLOSED_TABS.push({ path: p, line: at.line, ch: at.ch, scroll: at.scroll });
    if (CLOSED_TABS.length > CLOSED_TABS_MAX) CLOSED_TABS.shift();
  }
  function touchTabMru(p) {
    if (!p) return;
    var i = TAB_MRU.indexOf(p);
    if (i >= 0) TAB_MRU.splice(i, 1);
    TAB_MRU.push(p);
  }
  function mruTabs() {
    var out = [];
    for (var i = TAB_MRU.length - 1; i >= 0; i--) {
      if (isOpen(TAB_MRU[i]) && out.indexOf(TAB_MRU[i]) < 0) out.push(TAB_MRU[i]);
    }
    TABS.forEach(function (p) { if (out.indexOf(p) < 0) out.push(p); });
    return out;
  }
  // Pinned tabs: the right-click menu and the Window menu both offer the toggle,
  // so the state lives here, beside the tabs it protects. A pin only protects a
  // tab from the bulk closes ("Close Others" / "Close All"); an explicit Close
  // still closes it, exactly as in PyCharm.
  var PINNED = {};
  (Array.isArray(PREFS.pinnedTabs) ? PREFS.pinnedTabs : []).forEach(function (p) { PINNED[p] = true; });
  function isPinnedTab(p) { return !!PINNED[p]; }
  function togglePinTab(p) {
    if (!p || !isOpen(p)) return;
    if (PINNED[p]) delete PINNED[p]; else PINNED[p] = true;
    savePrefs({ pinnedTabs: Object.keys(PINNED) });
    renderTabs();
    toast((PINNED[p] ? 'Pinned ' : 'Unpinned ') + p);
  }
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
      b.className = 'etab' + (p === currentFile ? ' active' : '') + (isPinnedTab(p) ? ' pinned' : '');
      b.setAttribute('data-tab', p); // the right-click menu needs to know which tab
      // Every dirty tab carries the dot, not just the active one: an unsaved
      // buffer you cannot see is the one you close by accident.
      b.innerHTML = badgeHtml(p) + '<span class="nm">' + esc(p) + '</span>' +
        (isPinnedTab(p) ? '<span class="pin" title="Pinned" aria-label="Pinned">' + ic('pin', 10) + '</span>' : '') +
        (bufferDirty(p) ? '<span class="dirty" title="Unsaved changes" aria-label="Unsaved changes"></span>' : '') +
        '<span class="x" data-close="' + esc(p) + '">' + ic('close', 12) + '</span>';
      b.addEventListener('click', function (e) {
        if (e.target.closest('[data-close]')) { e.stopPropagation(); closeTab(p); return; }
        openFile(p);
      });
      // PyCharm closes a tab on middle click. The close icon and Ctrl+F4 stay
      // available, and dirty tabs still go through the same confirm dialog.
      b.addEventListener('mousedown', function (e) {
        if (e.button !== 1) return;
        e.preventDefault(); e.stopPropagation();
        closeTab(p);
      });
      el.appendChild(b);
    });
    var more = document.createElement('button');
    more.className = 'more'; more.innerHTML = ic('chevD', 16); more.title = 'Show hidden tabs';
    more.addEventListener('click', function (e) {
      e.stopPropagation();
      var rect = more.getBoundingClientRect();
      showCtx(rect.left, rect.bottom, TABS.map(function (p) {
        return { label: p, act: function () {
          openFile(p);
          var target = null;
          var tabs = el.querySelectorAll('.etab');
          for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].getAttribute('data-tab') === p) { target = tabs[i]; break; }
          }
          if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } };
      }));
    });
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
    var mru = TAB_MRU.indexOf(p); if (mru >= 0) TAB_MRU.splice(mru, 1);
    if (!discard && bufferDirty(p) && PREFS.confirmDirtyClose !== false) {
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
    rememberClosedTab(p);
    // Closing is the end of this buffer: keep nothing that could resurrect it.
    // (Save already dropped the copy on its ACK; this covers "Don't Save".)
    draftDrop(p);
    TABS.splice(i, 1); delete BUFFERS[p];
    // A closed tab is gone; its pin must not outlive it or it would come back
    // pinned after a re-open the user never asked to be pinned.
    var unpinned = !!PINNED[p];
    if (unpinned) delete PINNED[p];
    if (currentFile === p) {
      var next = TABS[TABS.length - 1];
      if (next) openFile(next);
      else { currentFile = null; currentLang = 'python'; ta.value = ''; ta.readOnly = true; $('stFile').textContent = ''; renderStLang(); renderTabs(); renderEditor(); }
    } else { renderTabs(); }
    savePrefs(unpinned ? { tabs: TABS, current: currentFile, pinnedTabs: Object.keys(PINNED) } : { tabs: TABS, current: currentFile });
  }
  function applyFocusAfterRead(name) {
    var focus = FOCUS_ON_READ[name];
    if (!focus) return false;
    delete FOCUS_ON_READ[name];
    if (typeof focus.line !== 'number') return true;
    var hasSelection = typeof focus.selStart === 'number' && typeof focus.selEnd === 'number' && focus.selEnd > focus.selStart;
    if (hasSelection) applyViewSnapshot(focus);
    else {
      gotoLine(focus.line, focus.ch || 0);
      if (typeof focus.scroll === 'number') {
        if (CMEDITOR && CMEDITOR.cm && CMEDITOR.cm.scrollTo) CMEDITOR.cm.scrollTo(null, focus.scroll);
        else { ta.scrollTop = focus.scroll; if (typeof syncScroll === 'function') syncScroll(); }
        updateCaret();
      }
    }
    return true;
  }
  function openFile(name, focusLine, focusView) {
    var view = focusView || (typeof focusLine === 'number' && isFinite(focusLine)
      ? { line: Math.max(0, focusLine), ch: 0 } : null);
    if (BUFFERS[name]) {
      showBuffer(name);
      if (view) {
        FOCUS_ON_READ[name] = view;
        applyFocusAfterRead(name);
      }
      return;
    }
    // Every explicit open is a request to make that file active once its
    // contents arrive, not only when it happens to be the first tab.
    FOCUS_ON_READ[name] = view || { show: true };
    // Load from the real filesystem; fall back to the bundled sample for offline boot.
    BRIDGE.send({ kind: 'fsRead', path: name });
    if (FILES[name] != null) {
      showBuffer(name, FILES[name]);
      applyFocusAfterRead(name);
    }
  }
  function reopenClosedTab() {
    var rec = null;
    while (CLOSED_TABS.length) {
      var candidate = CLOSED_TABS.pop();
      if (candidate.path && !isOpen(candidate.path)) { rec = candidate; break; }
    }
    if (!rec) { toast('No closed tab to reopen'); return; }
    openFile(rec.path, rec.line, { line: rec.line, ch: rec.ch, scroll: rec.scroll });
    setStatusHint('Reopened ' + rec.path + ' · Ctrl+Shift+T for the previous one');
  }
  /** File > Reload from Disk: re-read the active file, never silently drop edits. */
  function reloadFile() {
    var p = currentFile;
    if (!p) { toast('No file is open'); return; }
    function read() {
      BRIDGE.send({ kind: 'fsRead', path: p });
      setStatusHint('Reloading ' + p + ' …');
    }
    if (!bufferDirty(p)) { read(); return; }
    confirmDialog({
      title: 'Reload from Disk', icon: 'warn',
      message: 'Discard unsaved changes in ' + p + '?',
      sub: 'The version on disk replaces the editor buffer. This cannot be undone.',
      buttons: [
        { label: 'Cancel', onClick: function () {} },
        { label: 'Reload', primary: true, onClick: read }
      ]
    });
  }
  // Breadcrumbs: every segment is a real target. Directory crumbs reveal the
  // folder in the project tree, file crumbs open that workspace file, and the
  // trailing symbol crumb jumps to the declaration that contains the caret.
  var CRUMB_TRACK = '';
  function renderBreadcrumbs(name) {
    var el = $('breadcrumbs'); if (!el) return;
    var parts = String(name || '').replace(/\\/g, '/').split('/').filter(Boolean);
    var html = '', cum = '';
    parts.forEach(function (part, i) {
      if (i) html += '<span class="crumb-sep">' + ic('chevR', 12) + '</span>';
      cum = cum ? cum + '/' + part : part;
      var kind = i === parts.length - 1 ? 'file' : 'dir';
      html += '<button type="button" class="crumb" data-crumb-path="' + esc(cum) + '"' +
        ' data-crumb-kind="' + kind + '" title="' + (kind === 'dir' ? 'Reveal ' : 'Open ') + esc(cum) + '">' +
        esc(part) + '</button>';
    });
    var spans = typeof methodSpans === 'function' ? methodSpans() : [];
    var here = typeof caretSnapshot === 'function' ? (caretSnapshot().line || 0) : 0;
    var enclosing = null;
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].line > here) break;
      enclosing = spans[i];
    }
    if (enclosing) {
      html += '<span class="crumb-sep">' + ic('chevR', 12) + '</span>' +
        '<button type="button" class="crumb crumb--symbol" data-crumb-line="' + Number(enclosing.line) + '"' +
        ' title="Go to ' + esc(enclosing.name) + '">' + esc(enclosing.name) + '</button>';
    }
    el.innerHTML = html;
    el.onclick = function (e) {
      var t = e.target && e.target.closest ? e.target : null;
      var pathBtn = t && t.closest('[data-crumb-path]');
      if (pathBtn) {
        var path = pathBtn.getAttribute('data-crumb-path');
        if (pathBtn.getAttribute('data-crumb-kind') === 'dir') revealTreePath(path);
        else openFile(path);
        return;
      }
      var symBtn = t && t.closest('[data-crumb-line]');
      if (symBtn) gotoLine(Number(symBtn.getAttribute('data-crumb-line')) || 0, 0);
    };
    CRUMB_TRACK = String(name) + ':' + here;
  }
  // Minimap: a compressed colour map of the current buffer. It mirrors the
  // syntax tokens the highlighter already knows about — no second parser.
  function renderMinimap(text) {
    var host = $('minimapLines'); if (!host) return;
    var lines = String(text || '').split('\n');
    var html = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var cls = /^\s*(#|\/\/|\/\*)/.test(line) ? 'minimap__line--comment'
        : /^\s*(from|import|class|def|public|private|package|if|for|while|return)\b/.test(line) ? 'minimap__line--kw'
        : /["']/.test(line) ? 'minimap__line--str'
        : /\b(def|function|void|async)\b/.test(line) ? 'minimap__line--fn' : '';
      var width = Math.max(6, Math.min(52, line.trim().length * 0.62));
      html += '<span class="minimap__line ' + cls + '" style="width:' + width + 'px"></span>';
    }
    host.innerHTML = html;
    if (typeof updateMinimapViewport === 'function') updateMinimapViewport();
  }
  // Back/forward navigation keeps the place you left, not just the file name.
  // showBuffer already stores the outgoing view in VIEW_STATE; each history
  // entry owns the snapshot for its own path, so navigating away cannot make a
  // later forward jump land at the top of the file.
  var DOC_HISTORY = [], DOC_HIST_IDX = -1;
  function historyPush(name) {
    var current = DOC_HISTORY[DOC_HIST_IDX];
    if (current && current.path === name) return;
    if (current) current.view = VIEW_STATE[current.path] || current.view;
    DOC_HISTORY = DOC_HISTORY.slice(0, DOC_HIST_IDX + 1);
    DOC_HISTORY.push({ path: name, view: VIEW_STATE[name] || null });
    DOC_HIST_IDX = DOC_HISTORY.length - 1;
  }
  function historyStep(delta) {
    var next = DOC_HIST_IDX + delta;
    if (next < 0 || next >= DOC_HISTORY.length) { toast(delta < 0 ? 'No previous file' : 'No next file'); return; }
    var here = DOC_HISTORY[DOC_HIST_IDX];
    if (here && currentFile === here.path) here.view = viewSnapshot();
    DOC_HIST_IDX = next;
    var target = DOC_HISTORY[next];
    openFile(target.path, 0, target.view);
  }
  function historyBack() { historyStep(-1); }
  function historyForward() { historyStep(1); }
  function renderFileFormat() {
    var buf = currentFile && BUFFERS[currentFile] ? BUFFERS[currentFile] : null;
    var enc = $('stEnc'), eol = $('stEol');
    if (enc) {
      enc.textContent = buf && buf.bom ? 'UTF-8 BOM' : 'UTF-8';
      enc.title = 'Text encoding: UTF-8' + (buf && buf.bom ? ' with BOM' : '') + '. Click to change.';
      enc.classList.add('act');
    }
    if (eol) {
      eol.textContent = buf && buf.eol === 'CRLF' ? 'CRLF' : 'LF';
      eol.title = 'Line endings: ' + eol.textContent + '. Click to change.';
      eol.classList.add('act');
    }
  }
  function setCurrentLineEnding(value) {
    var buf = currentFile && BUFFERS[currentFile] ? BUFFERS[currentFile] : null;
    if (!buf || (value !== 'LF' && value !== 'CRLF')) { toast('Open an editable file first'); return; }
    if (buf.eol === value) { toast('Line endings already ' + value); return; }
    buf.eol = value; buf.dirty = true;
    renderFileFormat(); renderTabs(); draftTouch(currentFile);
    setStatusHint('Line endings set to ' + value + ' · save to write the change');
  }
  function setCurrentUtf8Bom(enabled) {
    var buf = currentFile && BUFFERS[currentFile] ? BUFFERS[currentFile] : null;
    if (!buf || buf.editable === false) { toast('Open an editable file first'); return; }
    if (!!buf.bom === !!enabled) { toast('Encoding already ' + (enabled ? 'UTF-8 BOM' : 'UTF-8')); return; }
    buf.bom = !!enabled; buf.dirty = true;
    renderFileFormat(); renderTabs(); draftTouch(currentFile);
    setStatusHint('Encoding set to ' + (enabled ? 'UTF-8 BOM' : 'UTF-8') + ' · save to write the change');
  }
  function showBuffer(name, fallback) {
    // Preserve the live editor text before another buffer replaces the textarea.
    // Dirty state belongs to the buffer, not to whichever document is visible.
    if (currentFile && currentFile !== name && BUFFERS[currentFile]) {
      BUFFERS[currentFile].content = ta.value;
      VIEW_STATE[currentFile] = viewSnapshot();
    }
    var buf = BUFFERS[name];
    if (!buf) {
      if (fallback == null) { toast('no content for ' + name); return; }
      buf = BUFFERS[name] = { content: String(fallback), languageId: langOfDoc(name), editable: true, dirty: false, eol: 'LF', bom: false };
    }
    if (!isOpen(name)) TABS.push(name);
    if (currentFile !== name) clearCoverage();
    currentFile = name; currentLang = buf.languageId || 'python';
    touchTabMru(name);
    historyPush(name);
    pkgSync();
    ta.value = buf.content;
    ta.readOnly = !buf.editable;
    $('stFile').textContent = name;
    renderStLang(); renderFileFormat();
    renderBreadcrumbs(name); renderMinimap(buf.content);
    renderTabs(); renderEditor(); updateCaret();
    if (VIEW_STATE[name]) applyViewSnapshot(VIEW_STATE[name]);
    // A Markdown buffer needs a render before its outline can exist; switching
    // away must drop the pane instead of showing the previous file's HTML.
    mdAfterDocSwitch();
    // Stale marks from the previous document must not follow the caret here.
    clearDiags();
    clearUsageMarks();
    requestCheck();
    // Fold spans belong to the previous document: drop them now, not in 500ms.
    setFoldRanges(null);
    scheduleFolds();
    // Same for hints: the next reply repaints them for this buffer.
    setInlayHints(null);
    scheduleInlayHints();
    pushRecent(name);
    savePrefs({ tabs: TABS, current: currentFile });
  }
  function sendBufferSave(p, content) {
    var reqId = ++SAVE_SEQ;
    var buf = BUFFERS[p];
    if (isScratchPath(p)) {
      var scratchText = String(content == null ? '' : content).replace(/\r\n?/g, '\n');
      saveScratch(p, scratchText);
      if (buf) buf.dirty = false;
      draftDrop(p);
      if (p === currentFile) setStatusHint('Saved scratch ' + p);
      return;
    }
    var eol = buf && buf.eol === 'CRLF' ? 'CRLF' : 'LF';
    var bom = !!(buf && buf.bom);
    var logical = String(content == null ? '' : content).replace(/\r\n?/g, '\n');
    var diskText = eol === 'CRLF' ? logical.replace(/\n/g, '\r\n') : logical;
    if (bom) diskText = String.fromCharCode(0xFEFF) + diskText;
    SAVE_IN_FLIGHT[p] = reqId;
    PENDING_SAVES[reqId] = { path: p, content: logical, eol: eol, bom: bom };
    BRIDGE.send({ kind: 'fsWrite', path: p, content: diskText, reqId: reqId });
    if (p === currentFile) setStatusHint('Saving ' + p + ' …');
  }
  function saveBuffer(p) {
    var buf = BUFFERS[p];
    if (!buf || buf.editable === false) { reportError({ level: 'warn', title: 'Read-only', message: p + ' cannot be modified.' }); return false; }
    var content = (p === currentFile) ? ta.value : buf.content;
    buf.content = content;
    if (SAVE_IN_FLIGHT[p] != null || Object.prototype.hasOwnProperty.call(SAVE_QUEUED, p)) {
      SAVE_QUEUED[p] = content;
      return true;
    }
    // PyCharm does not rewrite a file that has no unsaved edits. Avoiding the
    // no-op write keeps mtime stable and leaves other tools' watches quiet.
    if (!buf.dirty) {
      if (p === currentFile) setStatusHint(p + ' has no unsaved changes');
      return false;
    }
    sendBufferSave(p, content);
    return true;
  }
  function saveAllFiles(opts) {
    if (currentFile && BUFFERS[currentFile]) BUFFERS[currentFile].content = ta.value;
    var targets = TABS.filter(function (p) { return BUFFERS[p] && BUFFERS[p].editable !== false && bufferDirty(p); });
    if (!targets.length) { toast('All files are saved'); return 0; }
    var sent = 0;
    targets.forEach(function (p) { if (saveBuffer(p) !== false) sent++; });
    setStatusHint('Saving ' + sent + ' file' + (sent === 1 ? '' : 's') + ' …');
    // Ctrl+S is a natural L3 checkpoint. The explicit File > Save All command
    // stays a plain write; only the keyboard shortcut asks for a fresh check.
    if (sent && opts && opts.check && lspLang()) { pendingSaveCheck = true; requestCheck(); }
    return sent;
  }
  /**
   * PyCharm's Ctrl+S writes every dirty open document, not just the active tab.
   * Format-on-save still applies to the active buffer first; the formatter's
   * reply then continues through finishSaveAfterFormat with the same batch.
   */
  function saveShortcut() {
    if (!currentFile || !BUFFERS[currentFile]) { saveFile(); return; }
    if (PREFS.formatOnSave && lspLang()) {
      FMT_SAVE_ALL = true;
      FMT_SAVE_PENDING = true;
      reformatCode();
      setStatusHint('Formatting before saving all files …');
      return;
    }
    saveAllFiles({ check: true });
  }
  function saveFile() {
    if (!currentFile || !BUFFERS[currentFile]) { reportError({ level: 'warn', title: 'Nothing to save', message: 'No document is open.' }); return; }
    if (ta.readOnly) { reportError({ level: 'warn', title: 'Read-only', message: currentFile + ' cannot be modified.' }); return; }
    var p = currentFile;
    // Format-on-save: format first, then write the formatted buffer when the
    // edits land (onFormatResult -> finishSaveAfterFormat). A language with no
    // server saves immediately.
    if (PREFS.formatOnSave && lspLang()) {
      FMT_SAVE_PENDING = true;
      reformatCode();
      setStatusHint('Formatting ' + p + ' …');
      return;
    }
    var sent = saveBuffer(p);
    if (!sent) return;
    // No dialog: PyCharm writes straight to disk and only shows a transient
    // status-bar hint. The failure path is the one that talks.
    setStatusHint('Saving ' + p + ' …');
    // L3: a save is a natural checkpoint — check the file we just wrote and, if
    // it still has errors, say so once instead of letting Run be the first to
    // find out. (setDiags turns pendingSaveCheck into the balloon.)
    if (lspLang()) { pendingSaveCheck = true; requestCheck(); }
  }
  function onFsFile(f, reqId) {
    reqId = Number(reqId) || 0;
    delete VIEW_STATE[f && f.path];
    if (FINDPROJ_PENDING[reqId]) { onFindProjectFile(reqId, f); return; }
    if (TODO_PENDING[reqId]) { onTodoFile(reqId, f); return; }
    if (SAVED_PENDING[reqId]) { onSavedVersionFile(reqId, f); return; }
    if (COMPARE_PENDING[reqId]) { onCompareFile(reqId, f); return; }
    var name = f.path;
    var raw = String(f.content == null ? '' : f.content);
    var bom = raw.charCodeAt(0) === 0xFEFF;
    if (bom) raw = raw.slice(1);
    var eol = raw.indexOf('\r\n') >= 0 ? 'CRLF' : 'LF';
    var content = raw.replace(/\r\n?/g, '\n');
    BUFFERS[name] = { content: content, languageId: langOfDoc(name, f.languageId), editable: f.truncated ? false : f.editable !== false, dirty: false, mtime: f.mtime, eol: eol, bom: bom };
    if (!isOpen(name)) TABS.push(name);
    if (FOCUS_ON_READ[name]) {
      showBuffer(name);
      applyFocusAfterRead(name);
    } else if (currentFile === name || currentFile == null) showBuffer(name);
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
    // A save is the natural checkpoint for the project indexes as well.
    startTodoScan();
    if (activeBottom === 'find') startFindProjectScan();
    var buf = BUFFERS[m.path];
    if (buf && buf.content === pending.content && (buf.eol === 'CRLF' ? 'CRLF' : 'LF') === pending.eol && !!buf.bom === pending.bom) buf.dirty = false;
    // Disk has this content now, so the recovery copy is obsolete — but only an
    // ACK may drop it: a failed write must leave the draft in place.
    if (buf && !buf.dirty) {
      draftDrop(m.path);
      if (buf.draftOf) draftDrop(buf.draftOf);
    }

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
    // A folder from a previous session can be moved or deleted. Clear the
    // stale pointer and continue with the engine's default root: a shell that
    // refuses to boot because a path vanished is worse than a lost preference.
    var proj = PROJECT_PENDING[reqId];
    if (proj) {
      delete PROJECT_PENDING[reqId];
      if (proj.restore) {
        PROJECT_AWAIT_RESTORE = false;
        updatePrefs({ lastProjectRoot: '' });
        toast('Last project is no longer available — opened the default folder');
        bootProject();
      }
      return;
    }
    if (SAVED_PENDING[reqId]) {
      var savedPath = SAVED_PENDING[reqId];
      delete SAVED_PENDING[reqId];
      toast('Saved version is unavailable for ' + savedPath);
      return;
    }
    if (COMPARE_PENDING[reqId]) { onCompareFileError(reqId, m); return; }
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

  // ---------- crash recovery: what the last session left behind ----------
  // The "drafts" frame arrives once per connection (the engine answers draftList). It is
  // an offer, not a fait accompli: the user decides, because silently restoring
  // text into a file they just fixed by hand is how a recovery feature loses
  // trust on day one.
  var DRAFTS_OFFERED = null;
  function onDrafts(m) {
    var items = (m.drafts || []).filter(function (d) { return d && typeof d.path === 'string'; });
    var live = [], stale = [];
    items.forEach(function (d) {
      // Already on disk: the write landed before the crash, nothing to restore.
      if (d.sameAsDisk) { BRIDGE.send({ kind: 'draftDrop', path: d.path }); return; }
      (d.stale ? stale : live).push(d);
    });
    if (!live.length && !stale.length) return;
    DRAFTS_OFFERED = { live: live, stale: stale };
    var all = live.concat(stale);
    confirmDialog({
      title: 'Restore Unsaved Changes',
      icon: 'warn',
      message: all.length === 1
        ? 'An earlier session left 1 unsaved file.'
        : 'An earlier session left ' + all.length + ' unsaved files.',
      sub: 'They come back as unsaved tabs. Nothing is written to disk until you save.',
      list: all.slice(0, 8).map(function (d) {
        return { label: d.path + (d.stale ? '  (changed on disk since)' : ''), icon: 'file' };
      }),
      buttons: [
        { label: 'Discard All', danger: true, onClick: discardDrafts },
        { label: 'Restore', primary: true, onClick: restoreDrafts }
      ]
    });
  }
  function discardDrafts() {
    var offer = DRAFTS_OFFERED; DRAFTS_OFFERED = null;
    if (!offer) return;
    offer.live.concat(offer.stale).forEach(function (d) { draftDrop(d.path); });
    toast('Discarded ' + (offer.live.length + offer.stale.length) + ' recovered file(s)');
  }
  function restoreDrafts() {
    var offer = DRAFTS_OFFERED; DRAFTS_OFFERED = null;
    if (!offer) return;
    var all = offer.live.concat(offer.stale);
    var active = null, restored = 0;
    all.forEach(function (d) {
      // A draft whose file changed on disk must not land on top of newer text:
      // it comes back as "<name>.recovered" and only becomes a file when saved.
      var target = d.stale ? d.path + '.recovered' : d.path;
      var existing = BUFFERS[target];
      if (existing && existing.dirty) return; // live edits win over a stale draft
      BUFFERS[target] = {
        content: String(d.content == null ? '' : d.content),
        languageId: langOfDoc(target),
        editable: true,
        dirty: true,
        draftOf: d.stale ? d.path : undefined
      };
      if (!isOpen(target)) TABS.push(target);
      DRAFT_WRITTEN[d.path] = Number(d.savedAt) || Date.now();
      active = target;
      restored++;
    });
    paintDraftState();
    renderTabs();
    if (active) showBuffer(active);
    if (restored) toast(restored === 1 ? 'Restored 1 unsaved file' : 'Restored ' + restored + ' unsaved files');
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
      draftTouch(currentFile);
      noteEditLocation();
      clearUsageMarks();
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
    { id: 'todo', title: 'TODO', icon: 'todo', key: '' },
    { id: 'vcs', title: 'Version Control', icon: 'vcs', key: 'Alt+9' },
    { id: 'commit', title: 'Commit', icon: 'commit', key: '' },
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
    // Tests is PyCharm's Test tool window: a tree of cases plus the runner's
    // raw output. It only fills in for languages whose manifest declares a
    // test mode, so the window is present but explains itself otherwise.
    { id: 'tests', title: 'Tests', icon: 'run', key: 'Alt+5' },
    { id: 'logs', title: 'Logs', icon: 'logs', key: 'Alt+0' },
    { id: 'find', title: 'Find', icon: 'search', key: 'Ctrl+Shift+F' }
  ];
  var PROBLEMS = { id: 'problems', title: 'Problems', icon: 'warn', key: '' };
  // strip order per PyCharm New UI
  var STRIP = ['project', 'vcs', 'commit', 'terminal', 'run', 'structure', 'todo', 'perf', 'logs', 'ai', 'mcp'];

  var activeLeft = 'project';
  var activeBottom = 'run';
  var pinned = true;

  function windowById(id) {
    var all = LEFT_WINDOWS.concat(BOTTOM_WINDOWS).concat([PROBLEMS]);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function isBottom(id) { return id === 'run' || id === 'debug' || id === 'terminal' || id === 'packages' || id === 'perf' || id === 'tests' || id === 'logs' || id === 'problems' || id === 'find'; }

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
      if (id === 'todo' && !panel.classList.contains('hidden') && !TODO_SCAN) startTodoScan();
      if (id === 'structure' && !panel.classList.contains('hidden')) requestStructureSymbols();
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
    else if (activeLeft === 'todo') { body.innerHTML = todoPane(); wireTodo(body); }
    else if (activeLeft === 'vcs') body.innerHTML = vcsPane();
    else if (activeLeft === 'commit') body.innerHTML = commitPane();
    else if (activeLeft === 'ai') { body.innerHTML = aiPane(); wireAi(body); }
    else if (activeLeft === 'mcp') { body.innerHTML = mcpPane(); wireMcp(body); }
    else body.innerHTML = '';
    if (activeLeft === 'structure') wireStructure(body);
    if (activeLeft === 'commit') wireCommit(body);
    if (activeLeft === 'vcs') wireVcs(body);
  }
  // ---------- TODO tool window ----------
  // A bounded scan built from the same fs protocol as the explorer. It does not
  // add a backend message: the request ids keep these replies out of the tree,
  // and the walk stops at a small directory/file budget so opening the window
  // cannot turn into a whole-disk read.
  var TODO_SEQ = 700000;
  var TODO_PENDING = Object.create(null);
  var TODO_SCAN = null;
  var TODO_ITEMS = [];
  var TODO_SKIP = { '.git': 1, '.hg': 1, 'node_modules': 1, 'dist': 1, 'build': 1, 'out': 1, 'target': 1, '__pycache__': 1, '.venv': 1, 'venv': 1, '.tmp': 1 };
  var TODO_EXT = /\.(py|js|jsx|ts|tsx|go|java|kt|kts|c|cc|cpp|h|hpp|rs|rb|php|cs|md|txt|json|ya?ml|toml|sh|bat|ps1)$/i;
  var TODO_RE = /\b(TODO|FIXME|NOTE|HACK)\b\s*[:：]?\s*(.*)$/i;
  function todoReq(kind, path) {
    var id = ++TODO_SEQ;
    TODO_PENDING[id] = { kind: kind, path: path, token: TODO_SCAN ? TODO_SCAN.token : 0 };
    return id;
  }
  function startTodoScan() {
    if (!BRIDGE.ready()) return;
    // The root listing is already in flight below; seeding dirs with '' here
    // would make the walk list the root a second time and leave the panel
    // stuck on "scanning" until a reply to that redundant request arrives.
    TODO_SCAN = { token: ++TODO_SEQ, dirs: [], files: [], found: [], seenDir: {}, seenFile: {}, dirsVisited: 0, fileLimit: 80, itemLimit: 200 };
    TODO_ITEMS = [];
    if (activeLeft === 'todo') renderPanel();
    BRIDGE.send({ kind: 'fsList', path: '', reqId: todoReq('list', '') });
  }
  function todoNext() {
    if (!TODO_SCAN) return;
    if (TODO_SCAN.files.length) {
      var path = TODO_SCAN.files.shift();
      BRIDGE.send({ kind: 'fsRead', path: path, reqId: todoReq('read', path) });
      return;
    }
    if (TODO_SCAN.dirs.length) {
      var dir = TODO_SCAN.dirs.shift();
      BRIDGE.send({ kind: 'fsList', path: dir, reqId: todoReq('list', dir) });
      return;
    }
    TODO_ITEMS = TODO_SCAN.found.slice(0, TODO_SCAN.itemLimit);
    TODO_SCAN = null;
    if (activeLeft === 'todo') renderPanel();
  }
  function onTodoListing(reqId, m) {
    var pending = TODO_PENDING[reqId];
    delete TODO_PENDING[reqId];
    if (!pending || !TODO_SCAN || pending.token !== TODO_SCAN.token) return;
    var entries = m.entries || [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || !e.path) continue;
      if (e.kind === 'dir') {
        var base = e.path.split('/').pop();
        if (TODO_SKIP[base] || TODO_SCAN.seenDir[e.path]) continue;
        if (++TODO_SCAN.dirsVisited > 120) continue;
        TODO_SCAN.seenDir[e.path] = true;
        TODO_SCAN.dirs.push(e.path);
      } else if (TODO_EXT.test(e.path) && !TODO_SCAN.seenFile[e.path] && TODO_SCAN.found.length < TODO_SCAN.itemLimit) {
        TODO_SCAN.seenFile[e.path] = true;
        TODO_SCAN.files.push(e.path);
      }
    }
    todoNext();
  }
  function onTodoFile(reqId, f) {
    var pending = TODO_PENDING[reqId];
    delete TODO_PENDING[reqId];
    if (!pending || !TODO_SCAN || pending.token !== TODO_SCAN.token) return;
    var content = f && typeof f.content === 'string' ? f.content : '';
    if (f && f.truncated) content = '';
    var lines = content.replace(/\r\n?/g, '\n').split('\n');
    for (var i = 0; i < lines.length && TODO_SCAN.found.length < TODO_SCAN.itemLimit; i++) {
      var mm = TODO_RE.exec(lines[i]);
      if (!mm) continue;
      TODO_SCAN.found.push({
        path: pending.path, line: i + 1, kind: mm[1].toUpperCase(),
        text: String(mm[2] || '').trim().slice(0, 120) || lines[i].trim().slice(0, 120)
      });
    }
    todoNext();
  }
  function todoPane() {
    if (TODO_SCAN) return '<div class="pempty">scanning project…</div>';
    if (!TODO_ITEMS.length) return '<div class="pempty">No TODO / FIXME / NOTE / HACK comments found.</div>';
    var h = '<div class="todo-list">';
    TODO_ITEMS.forEach(function (t) {
      h += '<div class="todo-row" data-path="' + esc(t.path) + '" data-line="' + (t.line - 1) + '" title="' + esc(t.path + ':' + t.line) + '">' +
        '<span class="todo-tag todo-' + esc(t.kind.toLowerCase()) + '">' + esc(t.kind) + '</span>' +
        '<span class="todo-where">' + esc(t.path) + ':' + t.line + '</span>' +
        '<span class="todo-text">' + esc(t.text) + '</span></div>';
    });
    return h + '</div>';
  }
  function wireTodo(body) {
    body.querySelectorAll('.todo-row').forEach(function (row) {
      row.addEventListener('click', function () {
        // data-line is already zero-based (t.line - 1 in todoPane).
        openFile(row.getAttribute('data-path'), Number(row.getAttribute('data-line')) || 0);
      });
    });
  }
  function treeHtml(nodes) {
    var h = '<div style="padding:6px 4px;font-size:12.5px">';
    nodes.forEach(function (n) {
      var clickable = typeof n.i === 'number';
      var data = clickable ? ' data-struct-node="' + n.i + '"' : '';
      h += '<div' + data + ' style="display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:5px;margin-left:' +
        (n.d * 14) + 'px" class="tnode' + (clickable ? ' struct-node' : '') + '"' + (clickable ? ' tabindex="0"' : '') + '>';
      h += '<span class="ic" style="color:var(--icon-default)">' + ic(n.dir ? 'project' : 'file', 16) + '</span>';
      h += '<span>' + esc(n.name) + '</span></div>';
    });
    return h + '</div>';
  }
  function wireStructure(body) {
    if (!body) return;
    body.querySelectorAll('[data-struct-node]').forEach(function (el) {
      function pick() {
        var s = STRUCT.visible[+el.getAttribute('data-struct-node')];
        if (!s) return;
        navOpen(s);
      }
      el.addEventListener('click', pick);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); pick(); } });
    });
  }
  // ---------- project tree (real filesystem) ----------
  var TREE = {};        // dir relPath -> FsEntry[] (one level, cached)
  var TREE_LOADING = {};// dir relPath -> true while a listing is in flight
  var TREE_REVEAL = ''; // pending Alt+F1 target, followed through async listings
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
  /**
   * Manual refresh differs from refreshDir: an external tool may have changed
   * any cached level, so drop all listings but keep EXPANDED. Re-loading the
   * expanded paths means the user's place in the tree survives the refresh.
   */
  function refreshProjectTree() {
    Object.keys(TREE).forEach(function (path) { delete TREE[path]; });
    Object.keys(TREE_LOADING).forEach(function (path) { delete TREE_LOADING[path]; });
    if (activeLeft === 'project') renderTree();
    // Ask directly instead of going through loadDir: a manual refresh must send
    // even if a stale TREE_LOADING flag survived a failed listing.
    var paths = [''].concat(Object.keys(EXPANDED).filter(function (path) { return !!path; }));
    paths.forEach(function (path) {
      if (!BRIDGE.ready()) return;
      TREE_LOADING[path] = true;
      BRIDGE.send({ kind: 'fsList', path: path });
    });
    setStatusHint('Refreshing project tree…');
  }
  function treeAbsolutePath(rel) {
    var root = String(PROJECT_LAST_ROOT || '').replace(/\\/g, '/').replace(/\/+$/, '');
    var rest = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!root) return rest;
    return (root + (rest ? '/' + rest : '')).replace(/\/{2,}/g, '/');
  }
  function copyAbsolutePath(rel) {
    if (!rel) return;
    if (!PROJECT_LAST_ROOT) toast('Project root is not known yet');
    copyText(treeAbsolutePath(rel));
  }
  /**
   * Forget every cached listing and load the new root.
   *
   * The cache is keyed by a path *relative to the root*, so after a root switch
   * those keys describe different directories: src in the old project and src in
   * the new one are not the same folder. Keeping them is why opening a folder
   * changed the name in the toolbar and nothing else — the explorer went on
   * rendering the previous project under the new name.
   */
  function resetTree() {
    TREE = {};
    TREE_LOADING = {};
    TREE_REVEAL = '';
    EXPANDED = { '': true };
    renderTree();
    loadDir('');
  }
  /**
   * A successful openFolder. Two jobs beyond the tree: remember the folder for
   * the next launch, and finish a startup restore. Only an acknowledged root is
   * saved — a path that was typed but refused must never become the default.
   */
  function onFsRoot(m) {
    var reqId = Number(m.reqId);
    // reqId 0 is the engine's own default root, not an openFolder acknowledgement.
    // It races the startup restore: accepting it would reset the tree twice and
    // ask the interpreter picker about a folder the user did not choose.
    if (reqId === 0 && (PROJECT_AWAIT_RESTORE || PROJECT_LAST_ROOT)) return;
    PROJECT_LAST_ROOT = String(m.root || '');
    ROOT_NAME = m.name;
    var pv = document.querySelector('#projWidget .val'); if (pv) pv.textContent = m.name;
    var pending = PROJECT_PENDING[reqId];
    if (pending) {
      delete PROJECT_PENDING[reqId];
      if (pending.restore) PROJECT_AWAIT_RESTORE = false;
    }
    if (pending && m.root) updatePrefs({ lastProjectRoot: m.root });
    else if (reqId === 0 && !PREFS.lastProjectRoot && m.root) updatePrefs({ lastProjectRoot: m.root });
    resetTree();
    if (pending && pending.restore) {
      // The restored root is now active; load the session's files under it.
      openFile(currentFile || 'main.py');
      toast('Restored project: ' + m.name);
    }
    // A new project may have its own local environment. Ask once per root.
    applyProjectInterpreter();
    // Project indexes belong to the folder, not to the tab set open before.
    startTodoScan();
    if (activeBottom === 'find') startFindProjectScan();
  }
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
        h += '<div class="tnode dir ' + (EXPANDED[e.path] ? 'open' : '') + '" tabindex="0" data-path="' + esc(e.path) + '" data-kind="dir" style="padding-left:' + (6 + depth * 14) + 'px">' +
          '<span class="chev">' + ic(EXPANDED[e.path] ? 'chevD' : 'chevR', 14) + '</span>' +
          '<span class="ic">' + ic('project', 16) + '</span><span class="nm">' + esc(e.name) + '</span></div>';
        h += renderNodes(e.path, depth + 1);
      } else {
        h += '<div class="tnode file ' + (e.path === currentFile ? 'active' : '') + (e.editable ? '' : ' ro') + '" tabindex="0" data-path="' + esc(e.path) + '" data-kind="file" style="padding-left:' + (6 + (depth + 1) * 14) + 'px">' +
          '<span class="chev"></span>' + badgeHtml(e.name) + '<span class="nm">' + esc(e.name) + '</span></div>';
      }
    });
    return h;
  }
  function focusTreeRowAfterRender(path, focus) {
    var root = $('ptree'); if (!root || !path) return false;
    var rows = root.querySelectorAll('.tnode');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-path') === path) {
        if (focus !== false) rows[i].focus();
        return true;
      }
    }
    return false;
  }
  /** Locate a workspace path in the tree without opening it a second time. */
  function revealTreePath(rel) {
    rel = String(rel || '').replace(/\\/g, '/');
    if (!rel) return;
    if (/^[A-Za-z]:/.test(rel) || rel.indexOf('..') !== -1) {
      toast('Only files in the current project can be revealed');
      return;
    }
    TREE_REVEAL = rel;
    if (activeLeft !== 'project' || $('leftPanel').classList.contains('hidden')) {
      activeLeft = 'project';
      $('leftPanel').classList.remove('hidden');
      renderPanel(); renderStrip(); saveLayout();
    } else renderTree();
    var parts = rel.split('/'), dir = '';
    for (var i = 0; i < parts.length - 1; i++) {
      dir = i ? dir + '/' + parts[i] : parts[i];
      EXPANDED[dir] = true;
      loadDir(dir);
    }
    if (!focusTreeRowAfterRender(rel)) setStatusHint('Revealing ' + rel + ' in the project tree…');
  }
  /** Select In: locate the active file without opening it a second time. */
  function revealCurrentInTree() {
    if (!currentFile) { toast('No file is open'); return; }
    revealTreePath(currentFile);
  }
  function activateTreeRow(row) {
    var path = row.getAttribute('data-path'), kind = row.getAttribute('data-kind');
    if (kind === 'dir') {
      if (EXPANDED[path]) delete EXPANDED[path];
      else EXPANDED[path] = true;
      loadDir(path);
      renderTree();
      focusTreeRowAfterRender(path);
      return;
    }
    openFile(path);
  }
  function moveTreeFocus(row, delta) {
    var root = $('ptree'); if (!root) return;
    var rows = Array.prototype.slice.call(root.querySelectorAll('.tnode'));
    var i = rows.indexOf(row); if (i < 0) return;
    var next = rows[Math.max(0, Math.min(rows.length - 1, i + delta))];
    if (next) next.focus();
  }
  function wireTree(scope) {
    scope.querySelectorAll('.tnode').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.button !== 0) return;
        row.focus();
        activateTreeRow(row);
      });
      row.addEventListener('keydown', function (e) {
        if (e.key === 'F2') {
          e.preventDefault(); e.stopPropagation();
          var rp = row.getAttribute('data-path');
          if (rp) startInlineRename(row, rp);
          return;
        }
        var handled = true;
        if (e.key === 'ArrowDown') moveTreeFocus(row, 1);
        else if (e.key === 'ArrowUp') moveTreeFocus(row, -1);
        else if (e.key === 'ArrowRight') {
          if (row.getAttribute('data-kind') === 'dir' && !EXPANDED[row.getAttribute('data-path')]) activateTreeRow(row);
          else moveTreeFocus(row, 1);
        } else if (e.key === 'ArrowLeft') {
          if (row.getAttribute('data-kind') === 'dir' && EXPANDED[row.getAttribute('data-path')]) activateTreeRow(row);
          else {
            var parent = parentDir(row.getAttribute('data-path'));
            var root = $('ptree');
            if (parent && root) {
              var rows = root.querySelectorAll('.tnode');
              for (var i = 0; i < rows.length; i++) {
                if (rows[i].getAttribute('data-path') === parent) { rows[i].focus(); break; }
              }
            }
          }
        } else if (e.key === 'Enter') activateTreeRow(row);
        else handled = false;
        if (handled) { e.preventDefault(); e.stopPropagation(); }
      });
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var rp = row.getAttribute('data-path'), dir = parentDir(rp), isDir = row.getAttribute('data-kind') === 'dir';
        var target = isDir ? rp : dir;
        var items = [
          { label: 'New', sc: 'Alt+Ins', act: function () { showNewPopup(e.clientX, e.clientY, target); } },
          { sep: true },
          { label: 'Open', act: function () { openFile(rp); } }
        ];
        if (!isDir) items.push(
          { sep: true },
          { label: 'Compare with File…', act: function () { compareWithFile(rp); } }
        );
        items.push(
          { label: 'Refresh', sc: 'F5', act: refreshProjectTree },
          { label: 'Copy Path', act: function () { copyText(rp); } },
          { label: 'Copy Absolute Path', act: function () { copyAbsolutePath(rp); } },
          { sep: true },
          { label: 'Rename…', act: function () { startInlineRename(row, rp); } },
          { label: 'Delete…', sc: 'Del', act: function () { deleteEntry([rp]); } }
        );
        showCtx(e.clientX, e.clientY, items);
      });
      // PyCharm renames on F2 or a slow second click as well as from the menu.
      row.addEventListener('dblclick', function () {
        var rp = row.getAttribute('data-path');
        if (rp) startInlineRename(row, rp);
      });
    });
  }
  function onFsListing(m) {
    var reqId = Number(m.reqId) || 0;
    if (FINDPROJ_PENDING[reqId]) { onFindProjectListing(reqId, m); return; }
    if (TODO_PENDING[reqId]) { onTodoListing(reqId, m); return; }
    if (WSFILE_PENDING[reqId]) { onWorkspaceFileListing(reqId, m); return; }
    TREE[m.path] = m.entries || []; TREE_LOADING[m.path] = false;
    if (activeLeft === 'project') renderTree();
    if (TREE_REVEAL) {
      if (focusTreeRowAfterRender(TREE_REVEAL)) TREE_REVEAL = '';
      else if (m.path === '' && !Object.keys(TREE_LOADING).some(function (p) { return !!TREE_LOADING[p]; })) {
        toast('File is not in the current project tree');
        TREE_REVEAL = '';
      }
    }
  }
  function onFsChanged(m) {
    if (m.op === 'create') refreshDir(parentDir(m.path));
    else if (m.op === 'rename') { refreshDir(parentDir(m.from)); refreshDir(parentDir(m.path)); }
    else if (m.op === 'delete') refreshDir(parentDir(m.path));
    startTodoScan();
    if (activeBottom === 'find') startFindProjectScan();
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
      el.className = 'citem' + (it.dis ? ' dis' : '') + (it.sel ? ' sel' : '');
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
  // Structure used to be a regex over the current buffer. It now consumes the
  // same workspaceSymbol reply as Search Everywhere and Go to Symbol, filtered
  // to the active file. The regex outline is still painted while the request is
  // in flight and is kept when the server says "unsupported" — an old Python
  // install without a language server is not a reason to show an empty pane.
  var STRUCT = { seq: 930000, reqId: 0, file: '', timer: 0, source: 'local', symbols: [], visible: [] };
  function requestStructureSymbols() {
    if (!lspLang() || !currentFile) { STRUCT.source = 'local'; STRUCT.symbols = []; return; }
    clearTimeout(STRUCT.timer);
    var file = currentFile;
    STRUCT.timer = setTimeout(function () {
      if (activeLeft !== 'structure' || currentFile !== file || !lspLang()) return;
      var id = ++STRUCT.seq;
      STRUCT.reqId = id;
      STRUCT.file = file;
      BRIDGE.send({ kind: 'workspaceSymbol', language: lspLang(), query: '', requestId: id });
    }, 180);
  }
  function onStructureSymbolResult(m) {
    if (Number(m.requestId || 0) !== STRUCT.reqId || STRUCT.file !== currentFile) return;
    STRUCT.reqId = 0;
    if (m.unsupported) {
      STRUCT.source = 'local';
      STRUCT.symbols = [];
    } else {
      var here = (m.symbols || []).map(navNormalSymbol).filter(function (s) {
        var path = navEditPath(s);
        return !!path && navSameFile(currentFile, path);
      });
      STRUCT.symbols = navSymbolSort(here).slice(0, 120);
      STRUCT.source = 'lsp';
    }
    if (activeLeft === 'structure') renderPanel();
  }
  function structureSourceNote() {
    if (STRUCT.source !== 'lsp') return '';
    return '<div class="struct-src">language server · ' + STRUCT.symbols.length + ' symbol' +
      (STRUCT.symbols.length === 1 ? '' : 's') + '</div>';
  }
  function structureSymbolNodes(symbols) {
    STRUCT.visible = symbols;
    return symbols.map(function (s, i) {
      var label = s.name + (s.kind && s.kind !== 'symbol' && s.kind !== 'variable' ? '  ' + s.kind : '');
      return { name: label, d: s.containerName ? 1 : 0, i: i };
    });
  }
  function structureTree(code) {
    // Markdown has no symbols to parse: its structure is the heading list the
    // renderer already produced, so the same rows serve the pane and this window.
    var md = mdStructureRows();
    if (md !== null) { STRUCT.visible = []; return md; }
    if (STRUCT.source === 'lsp' && STRUCT.file === currentFile && STRUCT.symbols.length) {
      return structureSourceNote() + treeHtml(structureSymbolNodes(STRUCT.symbols));
    }
    var lines = code.split('\n'), nodes = [], locals = [];
    lines.forEach(function (l, i) {
      var m = /^(\s*)(def|class)\s+([A-Za-z_]\w*)/.exec(l);
      if (m) {
        nodes.push({ name: m[3] + (m[2] === 'class' ? ' (class)' : '()'), d: Math.floor(m[1].length / 4) });
        locals.push(navNormalSymbol({ name: m[3], kind: m[2] === 'class' ? 'class' : 'function', uri: currentFile, line: i, local: true }));
      }
    });
    if (!nodes.length) {
      STRUCT.visible = [];
      return structureSourceNote() + '<div class="empty">No symbols in this file.</div>';
    }
    STRUCT.visible = locals;
    return structureSourceNote() + treeHtml(nodes.map(function (n, i) {
      return { name: n.name, d: n.d, i: i };
    }));
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
  // ---------- AI Assistant (Alt+A) ----------
  // One answer at a time. The prompt goes to the engine, the engine talks to the
  // provider, and the key only ever exists inside %LOCALAPPDATA%/Nolanguage/ai.json
  // — never in PREFS, which is plaintext localStorage the page can re-read.
  var AI = { reqId: 0, running: false, configured: false, text: '', drawer: null, node: null };
  function aiPane() {
    return '<div class="ai-wrap">' +
      '<div class="ai-head"><span id="aiState" class="dim">Checking the provider…</span>' +
      '<button class="tbtn" id="aiGear">Configure</button></div>' +
      '<div id="aiCfg" class="ai-cfg hidden">' +
        '<input id="aiBase" placeholder="Base URL, e.g. https://api.openai.com/v1" spellcheck="false" />' +
        '<input id="aiModel" placeholder="Model, e.g. gpt-4o-mini" spellcheck="false" />' +
        '<input id="aiKey" type="password" placeholder="API key (kept by the engine, not the page)" spellcheck="false" />' +
        '<div class="ai-cfg-row"><button class="tbtn" id="aiSave">Save</button>' +
        '<span class="dim">The key is written to the app data folder and never echoed back.</span></div>' +
      '</div>' +
      '<div id="aiOut" class="console dim">Ask about the current file. Configure a provider first; the answer streams here.</div>' +
      '<div class="ai-row"><input id="aiInput" placeholder="Ask about the active file…" spellcheck="false" />' +
      '<button class="tbtn" id="aiAsk">Ask</button><button class="tbtn" id="aiStop" disabled>Stop</button></div>' +
      '</div>';
  }
  /** Append streamed text to the panel box and, when open, the drawer bubble. */
  function aiAppend(text) {
    if (!text) return;
    AI.text += text;
    var out = $('aiOut');
    if (out) {
      out.classList.remove('dim');
      out.textContent = (out.classList.contains('ai-answer') ? out.textContent : '') + text;
      out.classList.add('ai-answer');
      out.scrollTop = out.scrollHeight;
    }
    if (AI.node) {
      AI.node.textContent = AI.text;
      var host = $('assistantMessages');
      if (host) host.scrollTop = host.scrollHeight;
    }
  }
  /** Send one prompt through the engine; 'drawer' targets the side panel. */
  function aiAskNow(prompt, target) {
    var question = String(prompt || '').trim();
    if (!question) return false;
    if (AI.running) { toast('An answer is still streaming — press Stop first'); return false; }
    AI.reqId += 1;
    AI.running = true;
    AI.text = '';
    AI.node = null;
    var out = $('aiOut');
    if (out) {
      out.classList.remove('dim', 'ai-answer');
      out.textContent = 'Thinking…';
    }
    var stop = $('aiStop');
    if (stop) stop.disabled = false;
    if (target === 'drawer') AI.drawer = true;
    BRIDGE.send({ kind: 'aiAsk', requestId: AI.reqId, prompt: question, language: currentLang });
    return true;
  }
  function aiStopNow() {
    if (!AI.running) return;
    BRIDGE.send({ kind: 'aiCancel', requestId: AI.reqId });
  }
  /** Settle the panel/drawer after aiDone / aiCancelled. */
  function aiFinish(ok, error) {
    AI.running = false;
    AI.drawer = false;
    var stop = $('aiStop');
    if (stop) stop.disabled = true;
    var out = $('aiOut');
    if (out && !AI.text) {
      out.classList.remove('ai-answer');
      out.classList.add('dim');
      out.textContent = ok ? 'The provider returned an empty answer.' : 'AI: ' + (error || 'the provider returned nothing');
    } else if (out && !ok && error) {
      out.textContent += '\n\n[cancelled: ' + error + ']';
    }
    if (!ok && error && error !== 'cancelled') toast('AI: ' + error);
    AI.node = null;
  }
  function aiSetState(label) {
    var el = $('aiState');
    if (el) el.textContent = label;
  }
  function wireAi(body) {
    var input = body.querySelector('#aiInput'), ask = body.querySelector('#aiAsk');
    var stop = body.querySelector('#aiStop'), gear = body.querySelector('#aiGear');
    var cfg = body.querySelector('#aiCfg'), save = body.querySelector('#aiSave');
    if (gear && cfg) {
      gear.addEventListener('click', function () {
        cfg.classList.toggle('hidden');
        if (!cfg.classList.contains('hidden')) {
          BRIDGE.send({ kind: 'aiConfig' });
          var base = body.querySelector('#aiBase');
          if (base) base.focus();
        }
      });
    }
    // The key field is cleared on save instead of being kept in the DOM: a
    // repaint must not be able to show it again. An empty field therefore means
    // "keep the stored key", so it is only sent when the user typed something —
    // otherwise editing the model would silently wipe the key.
    function saveConfig() {
      var base = body.querySelector('#aiBase'), model = body.querySelector('#aiModel'), key = body.querySelector('#aiKey');
      var message = {
        kind: 'aiSetConfig',
        baseUrl: base ? base.value.trim() : '',
        model: model ? model.value.trim() : '',
      };
      var typed = key ? key.value : '';
      if (typed) message.key = typed;
      BRIDGE.send(message);
      if (key) key.value = '';
    }
    if (save) save.addEventListener('click', saveConfig);
    if (input) {
      input.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault(); event.stopPropagation();
        if (aiAskNow(input.value, 'pane')) input.value = '';
      });
    }
    if (ask) ask.addEventListener('click', function () { if (aiAskNow(input && input.value, 'pane') && input) input.value = ''; });
    if (stop) stop.addEventListener('click', aiStopNow);
    BRIDGE.send({ kind: 'aiConfig' });
  }
