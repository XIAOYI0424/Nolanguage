  // ---------- editor ----------
  var ta = $('ta'), hlCode = $('hlCode'), hl = $('hl'), glines = $('glines');
  var currentFile = 'main.py';
  var currentLang = 'python';
  // Breakpoints survive a restart. They are the one piece of debug state a user
  // rebuilds by hand every time, and losing them on every launch is the fastest
  // way to make a debugger feel unusable — so they live with the preferences
  // rather than only in this closure.
  var BREAKPOINTS = (PREFS.breakpoints && typeof PREFS.breakpoints === 'object' && !Array.isArray(PREFS.breakpoints))
    ? PREFS.breakpoints : {};
  function bpsFor(file) { return BREAKPOINTS[file] || (BREAKPOINTS[file] = {}); }
  function saveBreakpoints() { savePrefs({ breakpoints: BREAKPOINTS }); }
  // Bookmarks are the other piece of editor state people rebuild by hand after
  // every restart. Like breakpoints they live in preferences, keyed by the same
  // workspace-relative path the tabs use, and a line keeps its mnemonic label.
  var BOOKMARKS = (PREFS.bookmarks && typeof PREFS.bookmarks === 'object' && !Array.isArray(PREFS.bookmarks))
    ? PREFS.bookmarks : {};
  function bookmarksFor(file) { return BOOKMARKS[file] || (BOOKMARKS[file] = {}); }
  function saveBookmarks() { savePrefs({ bookmarks: BOOKMARKS }); }
  function bmGlyph(title) {
    var d = document.createElement('span');
    d.className = 'bm';
    d.setAttribute('title', title || 'Bookmark');
    return d;
  }
  function paintCmBookmarks() {
    if (!CMEDITOR || !currentFile) return;
    var cm = CMEDITOR.cm;
    cm.clearGutter('bm-gutter');
    var mk = bookmarksFor(currentFile), count = cm.lineCount();
    for (var i = 0; i < count; i++) {
      var bm = mk[i + 1];
      if (bm) cm.setGutterMarker(i, 'bm-gutter', bmGlyph('Bookmark ' + (bm.mnemonic || '') + ' - ' + (bm.label || '')));
    }
  }
  function caretLineNo() {
    var v = ta.value || '';
    return v.slice(0, ta.selectionStart).split(String.fromCharCode(10)).length - 1;
  }
  function setLineBookmark(mnemonic) {
    if (!currentFile) { toast('Open a file first'); return; }
    var n = caretLineNo() + 1, mk = bookmarksFor(currentFile);
    var key = String(mnemonic || '').trim().toUpperCase();
    if (key && !/^[0-9A-Z]$/.test(key)) { toast('Use one digit or letter for a mnemonic'); return; }
    if (mk[n]) {
      delete mk[n];
      toast('Bookmark removed from line ' + n);
    } else {
      var line = (ta.value || '').split(String.fromCharCode(10))[n - 1] || '';
      mk[n] = { label: line.trim().slice(0, 80) || ('Line ' + n), mnemonic: key };
      toast((key ? 'Bookmark ' + key : 'Bookmark') + ' set at line ' + n);
    }
    saveBookmarks();
    paintCmBookmarks();
    renderEditor();
  }
  function promptMnemonicBookmark() {
    if (!currentFile) { toast('Open a file first'); return; }
    showModal({
      title: 'Mnemonic bookmark', icon: 'file', message: currentFile,
      sub: 'Use a digit or letter. Leave empty for an anonymous bookmark.',
      fields: [{ name: 'm', label: 'Mnemonic', value: '', placeholder: '0-9 or A-Z' }],
      buttons: [
        { label: 'Cancel' },
        { label: 'Set', primary: true, onClick: function (v) { setLineBookmark(v.m); } }
      ]
    });
  }
  function allBookmarks() {
    var out = [];
    Object.keys(BOOKMARKS).forEach(function (file) {
      var mk = BOOKMARKS[file] || {};
      Object.keys(mk).forEach(function (n) {
        out.push({ file: file, line: Number(n), label: mk[n].label || '', mnemonic: mk[n].mnemonic || '' });
      });
    });
    out.sort(function (a, b) { return a.file.localeCompare(b.file) || a.line - b.line; });
    return out;
  }
  function jumpToBookmark(key) {
    var pos = String(key || '').lastIndexOf(':');
    if (pos < 0) return;
    var file = key.slice(0, pos), line = Number(key.slice(pos + 1));
    if (!file || !isFinite(line)) return;
    gotoLineInFile(file, Math.max(0, line - 1));
  }
  function showLineBookmarks() {
    var list = allBookmarks();
    if (!list.length) { toast('No bookmarks yet'); return; }
    var radios = list.map(function (b, i) {
      return {
        name: 'bm', value: b.file + ':' + b.line, def: i === 0,
        label: (b.mnemonic ? b.mnemonic + '  ' : '') + b.file + ':' + b.line + '  ' + b.label
      };
    });
    showModal({
      title: 'Line bookmarks', icon: 'file', message: 'Jump to a bookmarked line',
      sub: list.length + ' bookmark' + (list.length === 1 ? '' : 's'),
      radios: radios,
      buttons: [
        { label: 'Cancel' },
        { label: 'Remove', onClick: function (v) {
          if (!v.bm) return;
          jumpToBookmark(v.bm);
          var p = String(v.bm).lastIndexOf(':');
          var f = String(v.bm).slice(0, p), n = String(v.bm).slice(p + 1);
          if (bookmarksFor(f)[n]) delete bookmarksFor(f)[n];
          saveBookmarks(); paintCmBookmarks(); renderEditor(); toast('Bookmark removed');
        } },
        { label: 'Go', primary: true, onClick: function (v) { if (v.bm) jumpToBookmark(v.bm); } }
      ]
    });
  }
  var folded = {}; // line -> collapsed
  // Diagnostics for the current document (the engine's check answer). Kept
  // apart from problems (the rendered list) so the editor can paint marks from
  // the same data the panel shows — one source, two projections.
  var DIAGS = [];
  var DIAG_MARKS = []; // CodeMirror textMarker handles, cleared on every repaint
  // Highlight Usages in File: exact spans in CodeMirror, gutter tint in the
  // textarea fallback. Both projections share one source so they clear together.
  var USAGE_LINES = Object.create(null);
  var USAGE_MARKS = [];
  var USAGE_RANGE = null;
  function clearUsageMarks() {
    if (CMEDITOR) USAGE_MARKS.forEach(function (h) { h.clear(); });
    USAGE_MARKS = [];
    USAGE_LINES = Object.create(null);
    USAGE_RANGE = null;
  }
  function setUsageSpans(spans, caretStart, caretEnd) {
    clearUsageMarks();
    if (!spans || !spans.length) return;
    spans.forEach(function (s) {
      var from = CMEDITOR ? CMEDITOR.cm.posFromIndex(s.start) : s.start;
      var to = CMEDITOR ? CMEDITOR.cm.posFromIndex(s.end) : s.end;
      if (CMEDITOR) USAGE_MARKS.push(CMEDITOR.cm.markText(from, to, { className: 'usage-mark' }));
      var before = ta.value.slice(0, s.start), line = before.split('\n').length;
      USAGE_LINES[line] = true;
    });
    USAGE_RANGE = { start: caretStart, end: caretEnd };
  }

  // ---------- CodeMirror (vendored, optional) ----------
  // When the vendored CodeMirror is present the textarea becomes a thin adapter
  // over a real CM instance. The adapter mirrors the textarea API, so the rest
  // of this file, written against a textarea, keeps working unchanged. jsdom
  // has no layout, so the test harness stays on the textarea.
  var CMEDITOR = null;
  /** The language the CM mode was last set for; see renderEditor. */
  var CM_MODE_LANG = null;
  // Breakpoints are painted into a dedicated CodeMirror gutter column while CM
  // is active (the app's own #gutter is hidden in that mode). Markers track
  // their lines as the user types, but cm.setValue() — which every file switch
  // goes through — drops them, so the current file is repainted when it changes.
  var CM_BP_FILE = null;
  function bpDot() {
    var d = document.createElement('span');
    d.className = 'bp';
    d.setAttribute('title', 'Breakpoint - click to remove');
    return d;
  }
  function paintCmBreakpoints() {
    if (!CMEDITOR || !currentFile) return;
    var cm = CMEDITOR.cm;
    cm.clearGutter('bp-gutter');
    var mk = bpsFor(currentFile);
    var count = cm.lineCount();
    for (var i = 0; i < count; i++) {
      if (mk[i + 1]) cm.setGutterMarker(i, 'bp-gutter', bpDot());
    }
  }
  function toggleCmBreakpoint(line0) {
    if (!CMEDITOR || !currentFile) return;
    var n = line0 + 1;
    var mk = bpsFor(currentFile);
    if (mk[n]) {
      delete mk[n];
      CMEDITOR.cm.setGutterMarker(line0, 'bp-gutter', null);
    } else {
      mk[n] = true;
      CMEDITOR.cm.setGutterMarker(line0, 'bp-gutter', bpDot());
    }
    saveBreakpoints();
  }
  function cmModeFor(lang) {
    switch (lang) {
      case 'python': return 'python';
      case 'go': return 'go';
      case 'javascript': case 'typescript': return 'javascript';
      case 'markdown': return 'markdown';
      case 'json': return { name: 'javascript', json: true };
      case 'html': return 'htmlmixed';
      case 'xml': return 'xml';
      case 'css': return 'css';
      case 'yaml': return 'yaml';
      case 'sql': return 'sql';
      case 'shell': return 'shell';
      case 'toml': return 'toml';
      default: return null;
    }
  }
  // ---------- folding ----------
  // Two sources, one finder chain. The language server knows the real structure
  // (a Python class is not a brace pair), so its foldingRange answer wins;
  // brace/indent finders stay underneath for servers that never implement it and
  // for the moment before the first reply arrives.
  var LSP_FOLDS = null;
  var FOLD_SIGNATURE = '';
  /** Replace the server's spans; rebuild the gutter only when they really changed. */
  function setFoldRanges(list) {
    var ranges = (list && list.length) ? list : null;
    var next = ranges ? ranges.map(function (r) { return r.startLine + ':' + r.endLine; }).join(',') : '';
    if (next === FOLD_SIGNATURE) return;
    FOLD_SIGNATURE = next;
    LSP_FOLDS = ranges;
    if (!CMEDITOR) return;
    var cm = CMEDITOR.cm;
    // foldgutter paints from its own state and only redraws on viewport/change
    // events, so a new span list needs one rebuild. This runs on a debounced
    // reply, never per keystroke — the trap that made setOption per keystroke
    // expensive elsewhere in this file.
    try { cm.setOption('foldGutter', cm.getOption('foldGutter')); } catch (e) {}
  }
  function lspFoldFinder(cm, pos) {
    if (!LSP_FOLDS) return null;
    for (var i = 0; i < LSP_FOLDS.length; i++) {
      var r = LSP_FOLDS[i];
      if (r.startLine !== pos.line) continue;
      var end = Math.min(r.endLine, cm.lineCount() - 1);
      // Fold to the end of the last line, not to column 0 of the line after it:
      // CM5 hides from..to, and a "to" at the next line's column 0 leaves that
      // line visible outside the fold.
      return { from: CodeMirror.Pos(r.startLine, 0), to: CodeMirror.Pos(end, cm.getLine(end).length) };
    }
    return null;
  }
  function localFoldFinder(cm, pos) {
    if (!window.CodeMirror || !window.CodeMirror.fold) return null;
    var brace = window.CodeMirror.fold.brace && window.CodeMirror.fold.brace(cm, pos);
    if (brace) return brace;
    return (window.CodeMirror.fold.indent && window.CodeMirror.fold.indent(cm, pos)) || null;
  }
  function foldFinder(cm, pos) {
    return lspFoldFinder(cm, pos) || localFoldFinder(cm, pos);
  }
  /**
   * Menu / palette entry point for folding.
   *
   * Says why it does nothing on the textarea fallback instead of pretending: the
   * fallback has no folds, and a menu item that silently no-ops reads as a bug.
   */
  function foldCommand(what) {
    if (!CMEDITOR) { toast('Folding needs the CodeMirror editor, which is not available here.'); return; }
    var name = what === 'foldAll' ? 'foldAll' : what === 'unfoldAll' ? 'unfoldAll' : what === 'unfold' ? 'unfold' : 'toggleFold';
    try { CMEDITOR.cm.execCommand(name); } catch (e) { toast('Folding failed: ' + (e && e.message ? e.message : 'unknown')); }
  }

  // ---------- inlay hints ----------
  // Decorations only: every mark is a zero-width widget, so typing, selection and
  // search never see the hint text as buffer content. The list is kept so a new
  // reply can clear the old marks before painting the new ones; a document switch
  // rebuilds the buffer and CodeMirror drops the marks with it, which is why the
  // array is cleared here on every paint instead of relying on the editor.
  var INLAY_MARKS = [];
  function setInlayHints(list) {
    var i;
    for (i = 0; i < INLAY_MARKS.length; i++) { try { INLAY_MARKS[i].clear(); } catch (e) {} }
    INLAY_MARKS = [];
    if (!CMEDITOR || !list || !list.length) return;
    var cm = CMEDITOR.cm;
    var seen = {};
    for (i = 0; i < list.length; i++) {
      var h = list[i];
      if (!h || typeof h.label !== 'string' || !h.label) continue;
      if (typeof h.line !== 'number' || typeof h.character !== 'number') continue;
      if (h.line < 0 || h.line >= cm.lineCount()) continue;
      var lineText = cm.getLine(h.line) || '';
      var ch = Math.max(0, Math.min(lineText.length, h.character));
      // Two collapsed widgets on one position throw in CM5, and the server cannot
      // know we merged its duplicate. Keep the first and drop the rest.
      var key = h.line + ':' + ch;
      if (seen[key]) continue;
      seen[key] = true;
      var node = document.createElement('span');
      var cls = 'cm-inlay';
      if (h.kind === 'type') cls += ' cm-inlay-type';
      else if (h.kind === 'parameter') cls += ' cm-inlay-param';
      if (h.paddingLeft) cls += ' pad-l';
      if (h.paddingRight) cls += ' pad-r';
      node.className = cls;
      // textContent, never innerHTML: the label comes from a language server.
      node.textContent = h.label;
      try {
        INLAY_MARKS.push(cm.markText(
          CodeMirror.Pos(h.line, ch),
          CodeMirror.Pos(h.line, ch),
          { collapsed: true, clearWhenEmpty: false, replacedWith: node, insertLeft: true },
        ));
      } catch (e) {}
    }
  }

  function makeCmAdapter(cm) {
    // Every input listener owns its suppression count. A single shared counter
    // used to be decremented by the first listener, so the second one saw the
    // programmatic setValue from showBuffer() as a user edit and marked the
    // freshly opened file dirty. Arming touches all listeners; consuming is
    // per listener, so opening a file is silent for all of them.
    var inputHooks = [];
    var api = {
      isCM: true,
      cm: cm,
      get value() { return cm.getValue(); },
      set value(v) {
        var text = String(v == null ? '' : v);
        for (var i = 0; i < inputHooks.length; i++) inputHooks[i].skip++;
        cm.setValue(text);
      },
      get selectionStart() { return cm.indexFromPos(cm.getCursor('from')); },
      set selectionStart(p) { cm.setSelection(cm.posFromIndex(p), cm.getCursor('to')); },
      get selectionEnd() { return cm.indexFromPos(cm.getCursor('to')); },
      set selectionEnd(p) { cm.setSelection(cm.getCursor('from'), cm.posFromIndex(p)); },
      setSelectionRange: function (a, b) { cm.setSelection(cm.posFromIndex(a), cm.posFromIndex(b)); },
      get scrollTop() { return cm.getScrollInfo().top; },
      set scrollTop(v) { cm.scrollTo(null, v); },
      get scrollLeft() { return cm.getScrollInfo().left; },
      set scrollLeft(v) { cm.scrollTo(v, null); },
      get readOnly() { return !!cm.getOption('readOnly'); },
      set readOnly(v) { cm.setOption('readOnly', !!v); },
      focus: function () { cm.focus(); },
      getBoundingClientRect: function () { return cm.getWrapperElement().getBoundingClientRect(); },
      addEventListener: function (type, fn) {
        if (type === 'input') {
          var hook = { skip: 0 };
          inputHooks.push(hook);
          cm.on('change', function () {
            if (hook.skip > 0) { hook.skip--; return; }
            fn({ target: api });
          });
        } else if (type === 'scroll') {
          cm.on('scroll', function () { fn({ target: api }); });
        } else if (type === 'keyup') {
          cm.on('keyup', function () { fn({ target: api }); });
        } else if (type === 'click') {
          cm.on('cursorActivity', function () { fn({ target: api }); });
        } else if (type === 'blur') {
          cm.on('blur', function () { fn({ target: api }); });
        } else if (type === 'keydown') {
          // Capture on the wrapper: Tab/Enter/Escape must be interceptable
          // before CM's own keymap sees them.
          cm.getWrapperElement().addEventListener('keydown', function (e) {
            fn(e);
            if (e.defaultPrevented) e.stopPropagation();
          }, true);
        } else {
          cm.getWrapperElement().addEventListener(type, fn);
        }
      },
    };
    return api;
  }

  // Editor settings are read from the same preference bag as the rest of the
  // shell, so a change made in Settings survives a restart and takes effect
  // immediately on the live CodeMirror instance.
  function editorPref(name, fallback) {
    var v = PREFS[name];
    return v == null ? fallback : !!v;
  }
  function editorNumber(name, fallback, min, max) {
    var n = Number(PREFS[name]);
    return isFinite(n) && n >= min && n <= max ? n : fallback;
  }
  /** One indentation unit from the live Editor preferences. */
  function editorIndentUnit() {
    if (editorPref('useTabs', false)) return String.fromCharCode(9);
    var n = editorNumber('tabSize', 4, 2, 8), out = '';
    for (var i = 0; i < n; i++) out += ' ';
    return out;
  }
  function applyEditorPrefs() {
    var gutter = $('gutter'), curline = $('curline');
    if (!CMEDITOR || !CMEDITOR.cm) {
      // Textarea fallback: only the line-number column has a DOM counterpart.
      if (gutter) gutter.style.display = editorPref('lineNumbers', true) ? '' : 'none';
      if (curline) curline.style.display = editorPref('activeLine', true) ? '' : 'none';
      renderEditor();
      return;
    }
    var cm = CMEDITOR.cm;
    cm.setOption('lineNumbers', editorPref('lineNumbers', true));
    cm.setOption('lineWrapping', editorPref('softWrap', false));
    cm.setOption('matchBrackets', editorPref('matchBrackets', true));
    cm.setOption('autoCloseBrackets', editorPref('autoCloseBrackets', true));
    cm.setOption('styleActiveLine', editorPref('activeLine', true));
    var size = editorNumber('tabSize', 4, 2, 8);
    cm.setOption('tabSize', size);
    cm.setOption('indentUnit', size);
    cm.setOption('indentWithTabs', editorPref('useTabs', false));
  }

  (function initCodeMirror() {
    if (!window.CodeMirror) return;
    if (/jsdom/i.test((navigator && navigator.userAgent) || '')) return;
    var host = null;
    try {
      host = document.createElement('div');
      host.id = 'cmHost';
      ta.parentNode.insertBefore(host, ta);
      var cm = window.CodeMirror(host, {
        value: ta.value,
        mode: cmModeFor(currentLang),
        lineNumbers: editorPref('lineNumbers', true),
        // A dedicated breakpoint gutter sits left of the line numbers; clicking
        // either column toggles a breakpoint (wired just below).
        gutters: ['CodeMirror-linenumbers', { className: 'bp-gutter', style: 'width:16px' }, { className: 'bm-gutter', style: 'width:16px' }, 'CodeMirror-foldgutter'],
        // The fold arrow column sits right of the breakpoints, like PyCharm's
        // fold gutter sits inside the line-number band.
        // Indicators stay at their defaults: foldgutter reads a string option as a
        // *class name*, so overriding it with an arrow character would leave the
        // gutter empty instead of drawing one.
        foldGutter: { rangeFinder: foldFinder },
        lineWrapping: editorPref('softWrap', false),
        matchBrackets: editorPref('matchBrackets', true),
        autoCloseBrackets: editorPref('autoCloseBrackets', true),
        styleActiveLine: editorPref('activeLine', true),
        // CM reads dropped files into the buffer by default. The app is a
        // native shell that must not read local files from a drag; an empty
        // allow-list makes every file drop a no-op.
        allowDropFileTypes: [],
        indentUnit: editorNumber('tabSize', 4, 2, 8),
        tabSize: editorNumber('tabSize', 4, 2, 8),
        indentWithTabs: editorPref('useTabs', false),
        viewportMargin: 40,
      });
      ta.style.display = 'none';
      if (hl) hl.style.display = 'none';
      var cl0 = $('curline'); if (cl0) cl0.style.display = 'none';
      var g0 = $('gutter'); if (g0) g0.style.display = 'none';
      CMEDITOR = makeCmAdapter(cm);
      ta = CMEDITOR;
      // CodeMirror owns its gutter here, so breakpoint dots and the toggle are
      // projected onto it. CM fires gutterClick on mousedown and reports which
      // column was hit; both the line numbers and the breakpoint column toggle,
      // exactly as PyCharm does. (The hidden app #gutter keeps its own wiring
      // for the textarea fallback.)
      cm.on('gutterClick', function (cmi, line, g) {
        if (g !== 'CodeMirror-linenumbers' && g !== 'bp-gutter') return;
        toggleCmBreakpoint(line);
      });
      // Fold keys stay inside CodeMirror's keymap: the app's own Ctrl+D is
      // Duplicate Line, and folding must not join that list.
      cm.addKeyMap({
        'Ctrl-Shift-[': function (cmx) { cmx.execCommand('toggleFold'); },
        'Ctrl-Shift-]': function (cmx) { cmx.execCommand('unfold'); },
      });
      // Hints follow the viewport only for a big buffer; the debounce and the
      // "is this file too big" decision live in the runtime, so scrolling just
      // schedules the same request path an edit uses.
      cm.on('viewportChange', function () {
        if (typeof scheduleInlayHints === 'function') scheduleInlayHints();
      });
      paintCmBreakpoints();
      paintCmBookmarks();
    } catch (e) {
      if (host && host.parentNode) host.parentNode.removeChild(host);
      CMEDITOR = null;
    }
  })();

  // ---------- multi-language tokeniser (dependency-free) ----------
  // Newline / tab / backtick / angle brackets are built from char codes so this
  // block needs no backslash escapes (the whole script is a template literal).
  // Rules also avoid digit/word/space/boundary escapes: character classes and
  // lookarounds are used, and each rule is anchored per position (sticky y).
  var NLc = String.fromCharCode(10);
  var TABc = String.fromCharCode(9);
  var BT = String.fromCharCode(96);
  var LT = String.fromCharCode(60);
  var GT = String.fromCharCode(62);
  var WB = '(?<![A-Za-z0-9_])';
  var WA = '(?![A-Za-z0-9_])';
  var LANG_RULES = {
    go: [
      { re: '//[^' + NLc + ']*', cls: 'c' },
      { re: '[/][*][^]*?[*][/]', cls: 'c' },
      { re: BT + '[^' + BT + ']*' + BT, cls: 's' },
      { re: '"[^"]*"', cls: 's' },
      { re: "'[^']*'", cls: 's' },
      { re: WB + '(?:package|import|func|return|if|else|for|range|var|const|type|struct|interface|map|chan|go|defer|select|switch|case|default|break|continue|nil|true|false|make|new|append|len|cap)' + WA, cls: 'k' },
      { re: WB + '(?:string|int|int8|int16|int32|int64|uint|uint64|float32|float64|bool|byte|rune|error|any)' + WA, cls: 'b' },
      { re: '[0-9][0-9_]*(?:[.][0-9]+)?(?:[eE][+-]?[0-9]+)?', cls: 'n' },
      { re: '[A-Za-z_][A-Za-z0-9_]*(?=[(])', cls: 'f' }
    ],
    json: [
      { re: '"[^"]*"(?=[ ]*:)', cls: 'f' },
      { re: '"[^"]*"', cls: 's' },
      { re: WB + '(?:true|false|null)' + WA, cls: 'k' },
      { re: '[-]?[0-9]+(?:[.][0-9]+)?(?:[eE][+-]?[0-9]+)?', cls: 'n' }
    ],
    markdown: [
      { re: BT + BT + BT + '[^]*?' + BT + BT + BT, cls: 's' },
      { re: BT + '[^' + BT + NLc + ']*' + BT, cls: 's' },
      { re: '^#{1,6}[^' + NLc + ']*', cls: 'k', f: 'm' },
      { re: '[*][*][^' + NLc + ']+[*][*]', cls: 'b' },
      { re: '[*][^' + NLc + '*]+[*]', cls: 'd' },
      { re: '[[][^]]*[]][(][^)]*[)]', cls: 'f' },
      { re: '^[ ]*[-*+][ ]', cls: 'k', f: 'm' },
      { re: '^>[^' + NLc + ']*', cls: 'c', f: 'm' }
    ],
    yaml: [
      { re: '#[^' + NLc + ']*', cls: 'c' },
      { re: '"[^"]*"', cls: 's' },
      { re: "'[^']*'", cls: 's' },
      { re: '^[ ]*[A-Za-z0-9_.$-]+(?=[ ]*:)', cls: 'f', f: 'm' },
      { re: WB + '(?:true|false|null|yes|no|on|off)' + WA, cls: 'k' },
      { re: '[0-9]+(?:[.][0-9]+)?', cls: 'n' }
    ],
    javascript: [
      { re: '//[^' + NLc + ']*', cls: 'c' },
      { re: '[/][*][^]*?[*][/]', cls: 'c' },
      { re: BT + '[^' + BT + ']*' + BT, cls: 's' },
      { re: '"[^"]*"', cls: 's' },
      { re: "'[^']*'", cls: 's' },
      { re: WB + '(?:const|let|var|function|return|if|else|for|while|do|class|extends|new|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|of|in|void|delete|switch|case|break|continue|null|undefined|true|false|this|super|yield|interface|type|enum|public|private|protected|readonly|as)' + WA, cls: 'k' },
      { re: WB + '(?:console|process|globalThis|Math|JSON|Object|Array|Number|String|Boolean|Symbol|BigInt|Promise|Map|Set|WeakMap|Date|RegExp|Error|TypeError|RangeError|SyntaxError|parseInt|parseFloat|isNaN|structuredClone)' + WA, cls: 'b' },
      { re: '[0-9][0-9_]*(?:[.][0-9]+)?', cls: 'n' },
      { re: '[A-Za-z_$][A-Za-z0-9_$]*(?=[(])', cls: 'f' }
    ],
    html: [
      { re: LT + '!--[^]*?--' + GT, cls: 'c' },
      { re: LT + '[/]?[A-Za-z][A-Za-z0-9-]*', cls: 'k' },
      { re: '"[^"]*"', cls: 's' },
      { re: "'[^']*'", cls: 's' },
      { re: '[A-Za-z-:]+(?==)', cls: 'd' }
    ],
    css: [
      { re: '[/][*][^]*?[*][/]', cls: 'c' },
      { re: '"[^"]*"', cls: 's' },
      { re: "'[^']*'", cls: 's' },
      { re: '#[0-9A-Fa-f]{3,8}', cls: 'n' },
      { re: '[0-9]+(?:[.][0-9]+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr|pt)?', cls: 'n' },
      { re: '[@][A-Za-z-]+', cls: 'k' },
      { re: '[.][A-Za-z_-][A-Za-z0-9_-]*(?=[ ,{:.])', cls: 'cl' }
    ]
  };
  var RULES = (function () {
    var out = {};
    Object.keys(LANG_RULES).forEach(function (lang) {
      out[lang] = LANG_RULES[lang].map(function (r) { return { re: new RegExp(r.re, 'y' + (r.f || '')), cls: r.cls }; });
    });
    out.typescript = out.javascript;
    return out;
  })();
  function tokenizeRules(code, rules) {
    if (!rules || code.length > 200000) return esc(code);
    var out = '', i = 0, n = code.length;
    while (i < n) {
      var hit = false;
      for (var r = 0; r < rules.length; r++) {
        var re = rules[r].re; re.lastIndex = i;
        var mm = re.exec(code);
        if (mm && mm.index === i && mm[0].length > 0) {
          out += '<span class="tok-' + rules[r].cls + '">' + esc(mm[0]) + '</span>';
          i += mm[0].length; hit = true; break;
        }
      }
      if (!hit) { out += esc(code[i]); i++; }
    }
    return out;
  }
  // ---------- language catalogue ----------
  // The backend's plugin registry is authoritative: it arrives as a "workspace"
  // message on connect and carries display names, extensions, capabilities and
  // grammar rules straight from each manifest.json. The tables below are the
  // *offline bootstrap* — what the page can do before that message lands (and
  // if it is opened with no backend at all). Installing a language plugin must
  // never require editing this file.
  var SERVER_LANGS = { python: true, go: true, javascript: true };
  // A language can run, but not every one can be *tested*: the plugin has to
  // declare a 'test' mode. The toolbar button follows this map so it never
  // offers an action the engine would refuse.
  var TESTABLE = {};
  // Languages whose runtime puts program arguments on argv. A run configuration
  // for a language that answers false cannot honour "程序参数", so the field is
  // disabled rather than accepted and dropped.
  var ARGS_OK = {};
  /** Runtime id per language, for messages that need to name it. */
  var RUN_MODE = {};
  /**
   * Languages whose built-in (L1) completion is on.
   *
   * On by default — that is the whole point of L1: a language plugin never has
   * to declare a completion engine to get one. The manifest opts *out* with
   * contributes.completion.lexical.enabled: false, which is what Markdown
   * does (every English word would be offered as an identifier) and what plain
   * text would do for the same reason.
   */
  var LEXICAL = { python: true, go: true, javascript: true, markdown: false, text: false };
  var LANG_NAMES = {
    python: 'Python', go: 'Go', javascript: 'JavaScript', typescript: 'TypeScript',
    markdown: 'Markdown', json: 'JSON', yaml: 'YAML', toml: 'TOML',
    html: 'HTML', css: 'CSS', sql: 'SQL', shell: 'Shell Script', text: 'Plain text'
  };
  var EXT_LANG = {
    py: 'python', pyi: 'python', go: 'go', md: 'markdown', markdown: 'markdown',
    json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript',
    tsx: 'typescript', jsx: 'javascript', sh: 'shell', bash: 'shell',
    html: 'html', css: 'css', sql: 'sql', txt: 'text'
  };
  var LANG_LIST = [];
  /** Language ids that arrived from the backend catalogue (installed plugins). */
  var CATALOG_IDS = [];
  /** language id -> default extension (no dot), for the New… menu. */
  var DEFAULT_EXT = {};
  (function () {
    Object.keys(EXT_LANG).forEach(function (e) {
      var id = EXT_LANG[e];
      if (id && !DEFAULT_EXT[id]) DEFAULT_EXT[id] = e;
    });
  })();
  function rebuildLangList() {
    // The picker offers exactly what the highlighter can colour: a language
    // that silently rendered as plain text would be a worse answer than no
    // choice. Python has its own tokeniser; everything else needs RULES.
    var ids = ['python'].concat(Object.keys(RULES));
    CATALOG_IDS.forEach(function (id) {
      if (ids.indexOf(id) === -1 && RULES[id]) ids.push(id);
    });
    LANG_LIST = ids.map(function (id) { return { id: id, name: LANG_NAMES[id] || id }; });
  }
  rebuildLangList();
  /**
   * Merge the backend catalogue into the local tables. Idempotent: the message
   * is re-sent on every reconnect.
   */
  function applyLanguageCatalog(list) {
    if (!list || !list.length) return;
    list.forEach(function (l) {
      if (!l || !l.id) return;
      if (CATALOG_IDS.indexOf(l.id) === -1) CATALOG_IDS.push(l.id);
      LANG_NAMES[l.id] = l.displayName || l.id;
      // "the backend can act on this language": run it, check it, or both.
      SERVER_LANGS[l.id] = !!(l.supportsRun || l.hasLsp);
      TESTABLE[l.id] = !!l.supportsTest;
      ARGS_OK[l.id] = !!l.supportsArgs;
      if (l.runMode) RUN_MODE[l.id] = l.runMode;
      // L1 is opt-out only; a manifest that says nothing keeps it.
      LEXICAL[l.id] = l.lexical !== false;
      (l.extensions || []).forEach(function (e) { EXT_LANG[String(e).replace(/^[.]/, '').toLowerCase()] = l.id; });
      if (l.defaultExt) {
        var de = String(l.defaultExt).replace(/^[.]/, '').toLowerCase();
        EXT_LANG[de] = l.id;
        DEFAULT_EXT[l.id] = de;
      }
      if (l.grammar && l.grammar.length) {
        RULES[l.id] = l.grammar.map(function (r) {
          try { return { re: new RegExp(r.re, 'y' + (r.flags || '')), cls: r.cls }; } catch (e) { return null; }
        }).filter(Boolean);
      }
    });
    rebuildLangList();
    renderStLang();
    if (currentFile) renderLangs('');
  }
  function langLabel(id) {
    for (var i = 0; i < LANG_LIST.length; i++) if (LANG_LIST[i].id === id) return LANG_LIST[i].name;
    return String(id || '');
  }
  /** The language id to send to the backend, or '' when it can do nothing with it. */
  function lspLang() { return SERVER_LANGS[currentLang] ? currentLang : ''; }
  function highlight(code) {
    if (currentLang !== 'python') return tokenizeRules(code, RULES[currentLang]);
    var re = new RegExp(PY_PATTERN, 'g'), out = '', last = 0, mm;
    while ((mm = re.exec(code))) {
      out += esc(code.slice(last, mm.index));
      var cls = mm[1] ? 'c' : mm[2] ? 's' : mm[3] ? 'd' : mm[4] ? 'k' : mm[5] ? 'n' : mm[6] ? 'b' : mm[7] ? 'f' : mm[8] ? 'cl' : '';
      out += '<span class="tok-' + cls + '">' + esc(mm[0]) + '</span>';
      last = mm.index + mm[0].length;
      if (mm[0].length === 0) re.lastIndex++;
    }
    out += esc(code.slice(last));
    return out;
  }
  function lineIndent(line) { var m = /^[ \t]*/.exec(line); return m ? m[0].length : 0; }
  function isDefLine(line) { return /^[ \t]*(def|class)\b/.test(line); }

  function renderGutter(lines) {
    var html = '';
    // One pass over the diagnostics builds a line -> severity map, so a file
    // with many problems still renders in O(lines + diagnostics).
    var sev = {};
    for (var q = 0; q < DIAGS.length; q++) {
      var dd = DIAGS[q];
      var da = dd.line || 0, db = dd.endLine == null ? da : dd.endLine;
      if (db < da) db = da;
      for (var ln = da; ln <= db; ln++) if (sev[ln] !== 1) sev[ln] = dd.severity === 1 ? 1 : dd.severity === 2 ? 2 : 3;
    }
    for (var i = 0; i < lines.length; i++) {
      var n = i + 1;
      var cls = 'gline';
      if (bpsFor(currentFile)[n]) cls += ' hasbp';
      if (bookmarksFor(currentFile)[n]) cls += ' hasbm';
      if (USAGE_LINES[n]) cls += ' hasusage';
      var sv = sev[i];
      if (sv === 1) cls += ' haserr';
      else if (sv === 2) cls += ' haswarn';
      else if (sv) cls += ' hasinfo';
      // Coverage marks belong to the document they were measured on; a tab
      // switch must not paint the previous file's misses on this one.
      if (COVERAGE && COVERAGE.file === currentFile) {
        if (COVERAGE.missing[n]) cls += ' covmiss';
        else if (COVERAGE.covered[n]) cls += ' covhit';
      }
      var defI = isDefLine(lines[i]) ? lineIndent(lines[i]) : -1;
      if (defI >= 0) {
        // foldable when the block has at least one deeper, non-blank line
        for (var j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '') continue;
          if (lineIndent(lines[j]) > defI) cls += ' foldable';
          break;
        }
      }
      var inner = '<span class="num">' + n + '</span>';
      if (bpsFor(currentFile)[n]) inner = '<span class="bp" data-bp="' + n + '"></span>' + inner;
      if (bookmarksFor(currentFile)[n]) inner = '<span class="bm" data-bm="' + n + '"></span>' + inner;
      if (cls.indexOf('foldable') >= 0) inner = '<span class="fold" data-fold="' + n + '">' + (folded[n] ? ic('chevR', 12) : ic('chevD', 12)) + '</span>' + inner;
      html += '<div class="' + cls + '" data-line="' + n + '">' + inner + '</div>';
    }
    glines.innerHTML = html;
    // Click a gutter line to toggle a breakpoint (add or remove). The fold
    // chevron keeps its own stopPropagation handler so folding never toggles a
    // breakpoint, and an existing breakpoint is removed by the same click.
    if (!glines.__bpWired) {
      glines.__bpWired = true;
      glines.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('[data-fold]')) return;
        if (e.target.closest && e.target.closest('[data-bm]')) {
          var bn = +e.target.closest('[data-bm]').getAttribute('data-bm');
          if (bn && bookmarksFor(currentFile)[bn]) {
            delete bookmarksFor(currentFile)[bn];
            saveBookmarks(); paintCmBookmarks(); renderEditor(); toast('Bookmark removed from line ' + bn);
          }
          return;
        }
        var g = e.target.closest ? e.target.closest('.gline') : null;
        if (!g) return;
        var n = +g.getAttribute('data-line');
        if (!n) return;
        var mk = bpsFor(currentFile);
        if (mk[n]) delete mk[n]; else mk[n] = true;
        saveBreakpoints();
        renderEditor();
      });
    }
    glines.querySelectorAll('[data-fold]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); var n = +el.getAttribute('data-fold'); if (folded[n]) delete folded[n]; else folded[n] = true; renderEditor(); });
    });
  }

  function visibleLines(code) {
    if (!Object.keys(folded).length) return code.split('\n');
    var lines = code.split('\n'), out = [], skipIndent = -1;
    for (var i = 0; i < lines.length; i++) {
      var n = i + 1;
      if (skipIndent >= 0) {
        if (lines[i].trim() !== '' && lineIndent(lines[i]) <= skipIndent) skipIndent = -1;
        else continue;
      }
      out.push(lines[i]);
      if (folded[n]) skipIndent = lineIndent(lines[i]);
    }
    return out;
  }

  function renderEditor() {
    if (CMEDITOR) {
      // CM renders itself; keep its language in step with the tab's language.
      // Only when it actually changed: setOption('mode', ...) rebuilds the mode
      // and re-highlights, and this function runs on *every* keystroke — it cost
      // ~9 ms per character on an idle page, against ~0.1 ms for a bare CM.
      if (CM_MODE_LANG !== currentLang) {
        CMEDITOR.cm.setOption('mode', cmModeFor(currentLang));
        CM_MODE_LANG = currentLang;
      }
      // A file switch lands here right after the adapter's value setter ran
      // cm.setValue(), which drops every gutter marker. Repaint this file's
      // breakpoints once — not on every keystroke, since markers follow lines.
      if (CM_BP_FILE !== currentFile) { CM_BP_FILE = currentFile; paintCmBreakpoints(); paintCmBookmarks(); }
      return;
    }
    var code = ta.value;
    var vis = visibleLines(code);
    hlCode.innerHTML = highlight(vis.join('\n')) + '\n';
    renderGutter(code.split('\n'));
    syncScroll();
  }
  function syncScroll() {
    glines.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
    var cl = $('curline'); if (cl) cl.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
  }
  function updateCaret() {
    var line, col, herePos;
    if (CMEDITOR) {
      // O(1): the cursor knows its line. Slicing the buffer and splitting it
      // here is O(document) per keystroke, which showed up as 3.8 ms at 20k
      // lines versus 1.3 ms at 500.
      var c = CMEDITOR.cm.getCursor();
      line = c.line + 1;
      col = c.ch + 1;
      herePos = CMEDITOR.cm.indexFromPos ? CMEDITOR.cm.indexFromPos(c) : ta.selectionStart;
    } else {
      var pos = ta.selectionStart, before = ta.value.slice(0, pos);
      line = before.split('\n').length;
      col = pos - before.lastIndexOf('\n');
      herePos = pos;
    }
    // Usage marks describe the symbol under the caret; once it moves away they
    // are stale, so drop them without waiting for another explicit command.
    if (USAGE_RANGE && (herePos < USAGE_RANGE.start || herePos > USAGE_RANGE.end)) {
      clearUsageMarks();
      renderEditor();
    }
    $('stPos').textContent = 'Ln ' + line + ', Col ' + col;
    var gl = glines.children[line - 1];
    Array.prototype.forEach.call(glines.children, function (c) { c.classList.remove('cur'); });
    if (gl) gl.classList.add('cur');
    var cl = $('curline');
    if (cl) { cl.style.top = (10 + (line - 1) * 20) + 'px'; cl.style.display = 'block'; }
    // The symbol crumb follows the caret, but only when the line changes:
    // recomputing the outline on every keystroke would make large files slow.
    if (typeof renderBreadcrumbs === 'function' && CRUMB_TRACK !== currentFile + ':' + (line - 1)) {
      renderBreadcrumbs(currentFile);
    }
    if (typeof updateMinimapViewport === 'function') updateMinimapViewport();
  }

  // lex holds the L1 candidates of the current prefix, so an LSP answer can be
  // merged with them instead of replacing the popup the user is already reading.
  // The dismissed flag records that the user closed the popup on purpose (Esc, accept,
  // blur). A late LSP answer for the same request must not yank it back open;
  // only fresh input / an explicit Ctrl+Space clears the flag.
  var CMP = { open: false, items: [], sel: 0, reqId: 0, lex: [], dismissed: false, docs: {} };
  var HOV = { timer: 0, reqId: 0, cx: 0, cy: 0 };

  ta.addEventListener('input', function () { renderEditor(); scheduleComplete(); scheduleCheck(); schedulePreview(); });
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('keyup', updateCaret);
  ta.addEventListener('click', updateCaret);
  ta.addEventListener('blur', function () { CMP.dismissed = true; cmpClose(); });
  ta.addEventListener('mousemove', onCodeMouseMove);
  ta.addEventListener('mouseleave', function () { clearTimeout(HOV.timer); var t = $('hoverTip'); if (t) t.classList.remove('open'); });
  ta.addEventListener('keydown', onCodeKeyDown);

  function insertText(txt) {
    var s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + txt + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + txt.length;
    renderEditor(); updateCaret();
    if (typeof noteEditLocation === 'function') noteEditLocation();
  }
  function replaceRange(a, b, txt) {
    ta.value = ta.value.slice(0, a) + txt + ta.value.slice(b);
    ta.selectionStart = ta.selectionEnd = a + txt.length;
    if (typeof noteEditLocation === 'function') noteEditLocation();
  }
  // ---------- editor context menu ----------
  // PyCharm's editor menu. Undo/redo/cut/copy go through execCommand, which is
  // what a WebView2 textarea accepts inside a click; *paste* cannot (browsers
  // block it for the page), so Paste reads the async clipboard and says so when
  // that is denied too, instead of silently doing nothing.
  var CAN_EDIT = function () { return !!(currentFile && BUFFERS[currentFile] && BUFFERS[currentFile].editable); };
  function docCmd(name) {
    if (CMEDITOR && (name === 'undo' || name === 'redo')) {
      CMEDITOR.cm[name]();
      return;
    }
    ta.focus();
    if (typeof document.execCommand === 'function') {
      try { document.execCommand(name); } catch (e) { /* clipboard policy denied it */ }
    }
  }
  function copyText(text) {
    if (!text) { toast('Nothing to copy'); return; }
    if (typeof rememberClipboard === 'function') rememberClipboard(text);
    var clip = navigator.clipboard;
    if (clip && clip.writeText) {
      clip.writeText(text).then(function () { toast('Copied'); }, function () { toast('Copy failed — use Ctrl+C'); });
    } else { toast('Copy failed — clipboard unavailable'); }
  }
  /** Copy Reference: a shareable, one-based location for the caret. */
  function copyCodeReference() {
    if (!currentFile) { toast('No file is open'); return; }
    var at = navCaret();
    copyText(String(currentFile).replace(/\\/g, '/') + ':' + (at.line + 1));
  }
  function pasteAtCaret() {
    var clip = navigator.clipboard;
    if (!clip || !clip.readText) { toast('Paste blocked — use Ctrl+V'); return; }
    clip.readText().then(function (text) {
      var s = String(text || '');
      if (s && typeof rememberClipboard === 'function') rememberClipboard(s);
      insertText(s);
    }, function () { toast('Paste blocked — use Ctrl+V'); });
  }
  function deleteSelection() {
    ta.focus();
    var s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e) return;
    insertText('');
  }
  function selectAllInEditor() {
    ta.focus();
    ta.selectionStart = 0; ta.selectionEnd = ta.value.length;
    updateCaret();
  }
  function editorMenu() {
    var canEdit = CAN_EDIT(), hasDoc = !!currentFile;
    return [
      { label: 'Undo', sc: 'Ctrl+Z', dis: !canEdit, act: function () { docCmd('undo'); } },
      { label: 'Redo', sc: 'Ctrl+Shift+Z', dis: !canEdit, act: function () { docCmd('redo'); } },
      { sep: true },
      { label: 'Cut', sc: 'Ctrl+X', dis: !canEdit, act: function () { docCmd('cut'); } },
      { label: 'Copy', sc: 'Ctrl+C', dis: !hasDoc, act: function () { docCmd('copy'); } },
      { label: 'Paste', sc: 'Ctrl+V', dis: !canEdit, act: pasteAtCaret },
      { label: 'Delete', sc: 'Del', dis: !canEdit, act: deleteSelection },
      { label: 'Select All', sc: 'Ctrl+A', dis: !hasDoc, act: selectAllInEditor },
      { sep: true },
      { label: 'Change Language Mode…', dis: !hasDoc, act: openLangPicker }
    ];
  }