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
  var folded = {}; // line -> collapsed
  // Diagnostics for the current document (the engine's check answer). Kept
  // apart from problems (the rendered list) so the editor can paint marks from
  // the same data the panel shows — one source, two projections.
  var DIAGS = [];
  var DIAG_MARKS = []; // CodeMirror textMarker handles, cleared on every repaint

  // ---------- CodeMirror (vendored, optional) ----------
  // When the vendored CodeMirror is present the textarea becomes a thin adapter
  // over a real CM instance. The adapter mirrors the textarea API, so the rest
  // of this file, written against a textarea, keeps working unchanged. jsdom
  // has no layout, so the test harness stays on the textarea.
  var CMEDITOR = null;
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
  function makeCmAdapter(cm) {
    var skip = 0;
    var api = {
      isCM: true,
      cm: cm,
      get value() { return cm.getValue(); },
      set value(v) { skip++; cm.setValue(String(v == null ? '' : v)); },
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
          cm.on('change', function () { if (skip > 0) { skip--; return; } fn({ target: api }); });
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
        lineNumbers: true,
        // A dedicated breakpoint gutter sits left of the line numbers; clicking
        // either column toggles a breakpoint (wired just below).
        gutters: ['CodeMirror-linenumbers', { className: 'bp-gutter', style: 'width:16px' }],
        lineWrapping: false,
        matchBrackets: true,
        autoCloseBrackets: true,
        styleActiveLine: true,
        // CM reads dropped files into the buffer by default. The app is a
        // native shell that must not read local files from a drag; an empty
        // allow-list makes every file drop a no-op.
        allowDropFileTypes: [],
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: false,
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
      paintCmBreakpoints();
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
      CMEDITOR.cm.setOption('mode', cmModeFor(currentLang));
      // A file switch lands here right after the adapter's value setter ran
      // cm.setValue(), which drops every gutter marker. Repaint this file's
      // breakpoints once — not on every keystroke, since markers follow lines.
      if (CM_BP_FILE !== currentFile) { CM_BP_FILE = currentFile; paintCmBreakpoints(); }
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
    var pos = ta.selectionStart, before = ta.value.slice(0, pos);
    var line = before.split('\n').length, col = pos - before.lastIndexOf('\n');
    $('stPos').textContent = 'Ln ' + line + ', Col ' + col;
    var gl = glines.children[line - 1];
    Array.prototype.forEach.call(glines.children, function (c) { c.classList.remove('cur'); });
    if (gl) gl.classList.add('cur');
    var cl = $('curline');
    if (cl) { cl.style.top = (10 + (line - 1) * 20) + 'px'; cl.style.display = 'block'; }
  }

  // lex holds the L1 candidates of the current prefix, so an LSP answer can be
  // merged with them instead of replacing the popup the user is already reading.
  // The dismissed flag records that the user closed the popup on purpose (Esc, accept,
  // blur). A late LSP answer for the same request must not yank it back open;
  // only fresh input / an explicit Ctrl+Space clears the flag.
  var CMP = { open: false, items: [], sel: 0, reqId: 0, lex: [], dismissed: false };
  var HOV = { timer: 0, reqId: 0, cx: 0, cy: 0 };

  ta.addEventListener('input', function () { renderEditor(); scheduleComplete(); scheduleCheck(); });
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
  }
  function replaceRange(a, b, txt) {
    ta.value = ta.value.slice(0, a) + txt + ta.value.slice(b);
    ta.selectionStart = ta.selectionEnd = a + txt.length;
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
    var clip = navigator.clipboard;
    if (clip && clip.writeText) {
      clip.writeText(text).then(function () { toast('Copied'); }, function () { toast('Copy failed — use Ctrl+C'); });
    } else { toast('Copy failed — clipboard unavailable'); }
  }
  function pasteAtCaret() {
    var clip = navigator.clipboard;
    if (!clip || !clip.readText) { toast('Paste blocked — use Ctrl+V'); return; }
    clip.readText().then(function (text) { insertText(String(text || '')); }, function () { toast('Paste blocked — use Ctrl+V'); });
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
      { label: 'Redo', sc: 'Ctrl+Y', dis: !canEdit, act: function () { docCmd('redo'); } },
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