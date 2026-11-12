  // ---------- L1 · check as you type ----------
  // The engine already has the realtime plumbing (didChange -> publishDiagnostics);
  // what was missing is the editor asking. A debounced check turns the manual
  // Check button into live diagnostics, the way every IDE behaves.
  var diagTimer = 0;
  function requestCheck() {
    var lg = lspLang();
    if (!lg) { clearDiags(); return; }
    BRIDGE.send({ kind: 'check', code: ta.value, language: lg });
  }
  function scheduleCheck() { clearTimeout(diagTimer); diagTimer = setTimeout(requestCheck, 300); }

  // ---------- run ----------
  function runCode() {
    activeBottom = 'run'; $('dock').classList.remove('hidden'); renderDock();
    var out = $('runOut');
    out.innerHTML = '<span class="cmd">&gt; ' + lg + ' ' + esc(currentFile) + '</span>\n';
    // Run follows the file on screen: its language (honouring an explicit
    // #stLang override) and its buffer. This is the "run the open file"
    // contract the UI suite asserts — a Run/Debug *configuration* must never
    // hijack the editor, so it is not consulted here. Debug (Shift+F9) is where
    // the configuration drives things: program, args, env and cwd.
    var lg = lspLang();
    if (!lg) { toast('run: only Python / Go / JavaScript are supported yet'); return; }
    BRIDGE.send({ kind: 'run', code: ta.value, language: lg, sessionId: 'pycharm' });
    BRIDGE.send({ kind: 'check', code: ta.value, language: lg });
    toast('Running ' + currentFile + ' …');
    var ri = $('runIn'); if (ri) { ri.disabled = false; ri.focus(); }
  }
  function appendRun(text, cls) {
    var out = $('runOut'); if (!out) return;
    var s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text;
    out.appendChild(s);
  }

  // ---------- stop / debug ----------
  // "Stop" is a protocol message, not a line of text: the engine aborts the
  // live run (and a debug adapter, if one is attached) and answers "stopped".
  // DBG carries the whole stopped picture: frames (the call stack), scopes
  // (Locals / Globals, each with its variables) and the thread every
  // continuation must name. The scopes are what turn "it stopped" into "I can
  // see why" — without it a debugger is only a stepper.
  var DBG = { active: false, state: '', frames: [], scopes: [], reason: '', threadId: 1 };
  var DBG_WATCHES = [];  // [{ expr, result }]
  var DBG_OPEN = {};     // variablesReference -> true (expanded in the UI)
  var DBG_CHILDREN = {}; // variablesReference -> variables[] fetched so far
  var DBG_CONSOLE = [];  // [{ expr, result }] one-off evaluations
  var DBG_LINE = null;   // 0-based line the program is stopped on, if any
  function stopRun() {
    // Always ask: the engine owns the truth about what is running, and it
    // answers "stopped" with a cancelled flag either way. Guessing locally (a
    // run that has not reached runStart yet) would drop a legitimate Stop.
    BRIDGE.send({ kind: 'stop', sessionId: 'pycharm' });
    setStatusHint('Stopping…');
  }
  function renderDbgBar() {
    var bar = $('dbgBar');
    if (!bar) return;
    bar.style.display = DBG.active ? 'flex' : 'none';
    var st = $('dbgState');
    if (st) st.textContent = 'debug · ' + (DBG.state || 'idle');
    bar.querySelectorAll('[data-dbg]').forEach(function (b) {
      var cmd = b.getAttribute('data-dbg');
      // Stop always works. Continue ends a stop, Pause only means something
      // while the program is moving, and the step buttons need a stopped thread.
      var usable;
      if (cmd === 'stop' || cmd === 'continue') usable = DBG.active;
      else if (cmd === 'pause') usable = DBG.active && DBG.state !== 'stopped';
      else usable = DBG.active && DBG.state === 'stopped';
      b.disabled = !usable;
    });
  }
  function wireDbg() {
    var bar = $('dbgBar');
    if (!bar) return;
    bar.querySelectorAll('[data-dbg]').forEach(function (b) {
      b.addEventListener('click', function () {
        var cmd = b.getAttribute('data-dbg');
        if (cmd === 'stop') { stopRun(); return; }
        BRIDGE.send({ kind: 'debugCmd', cmd: cmd });
      });
    });
    renderDbgBar();
  }
  function debugCurrent() {
    activeBottom = 'run'; $('dock').classList.remove('hidden'); renderDock();
    var cfg = normCfg(activeConfig());
    if (!cfg.language) {
      reportError({ level: 'warn', title: 'Debug', message: 'Cannot determine a language for "' + cfg.path + '" — set it in the Run/Debug configuration.' });
      return;
    }
    if (isOpen(cfg.path) && currentFile !== cfg.path) openFile(cfg.path);
    var fileOpen = isOpen(cfg.path) && currentFile === cfg.path;
    var lg = cfg.language;
    DBG = { active: true, state: 'starting', frames: [], reason: '' };
    renderDbgBar();
    appendRun('\n[debug] starting ' + cfg.name + ' → ' + cfg.path + ' (' + cfg.language + ' adapter)…\n', 'dim');
    var bps = fileOpen ? Object.keys(bpsFor(currentFile)).map(Number).filter(function (n) { return n > 0; }) : [];
    BRIDGE.send({
      kind: 'debug',
      code: fileOpen ? ta.value : '',
      language: cfg.language,
      program: cfg.path,
      breakpoints: bps,
      stopOnEntry: cfg.stopOnEntry,
      serverReads: !fileOpen,
      args: cfg.args,
      env: cfg.env,
      cwd: cfg.cwd,
      request: cfg.request,
      // Attach reaches a target that is already running; launch ignores these.
      host: cfg.host,
      port: cfg.port,
      processId: cfg.processId
    });
  }
  function applyDebugState(m) {
    if (m.ok === false) {
      DBG.active = false; DBG.state = '';
      appendRun('\n[debug] ' + String(m.error || 'session failed') +
        (m.hint ? '\n[debug] ' + m.hint : '') + '\n', 'err');
      renderDbgBar();
      if (m.install) appendRun('\n[debug] install:  ' + m.install + '\n', 'warn');
      var dbgDetail = (m.install ? (m.install + '\n') : '') + (m.hint || '');
      reportError({ level: 'warn', title: 'Debug unavailable', message: String(m.error || 'session failed'), detail: dbgDetail || undefined });
      return;
    }
    var state = String(m.state || '');
    if (state === 'running') {
      DBG.active = true; DBG.state = 'running';
      clearDbgLine();
      appendRun('[debug] running' + (m.adapter ? ' · ' + m.adapter : '') + '\n', 'dim');
      RUN_ACTIVE = true;
    } else if (state === 'pausing') {
      // Acknowledgement only — the real answer arrives as its own stopped event.
      DBG.active = true; DBG.state = 'running';
    } else if (state === 'stopped') {
      DBG.active = true; DBG.state = 'stopped';
      DBG.frames = m.frames || [];
      DBG.scopes = m.scopes || [];
      DBG.reason = String(m.reason || '');
      DBG.threadId = Number(m.threadId) || 1;
      // Raise the Debug window first: renderDock rebuilds the panes, so any
      // console text appended before it would be thrown away.
      if (activeBottom !== 'debug') { activeBottom = 'debug'; renderDock(); }
      appendRun('\n[debug] stopped · ' + (DBG.reason || 'breakpoint') + '\n', 'warn');
      paintDbgLine();
      renderDebugViews();
      refreshWatches();
    } else if (state === 'terminated') {
      DBG.active = false; DBG.state = '';
      DBG.frames = []; DBG.scopes = [];
      clearDbgLine();
      RUN_ACTIVE = false;
      appendRun('[debug] session terminated\n', 'dim');
      renderDebugViews();
    }
    renderDbgBar();
  }

  // ---------- debug views (frames / variables / watches / evaluate) ----------
  // The engine already answers scopes and variables on every stop; these
  // functions only project that into the Debug window. Nothing here asks the
  // adapter for a stop — stepping stays on the toolbar.
  function debugPane() {
    return '<div class="dbg-wrap">' +
      '<div class="dbg-col"><div class="dbg-h">Frames</div><div class="dbg-list" id="dbgFrames"></div></div>' +
      '<div class="dbg-col"><div class="dbg-h">Variables</div><div class="dbg-list" id="dbgVars"></div></div>' +
      '<div class="dbg-col"><div class="dbg-h">Watches</div>' +
      '<div class="dbg-eval"><input id="dbgEvalIn" placeholder="expression" spellcheck="false" autocomplete="off" />' +
      '<button class="tbtn" id="dbgWatchAdd">Watch</button>' +
      '<button class="tbtn" id="dbgEvalGo">Evaluate</button></div>' +
      '<div class="dbg-list" id="dbgWatches"></div>' +
      '<div class="dbg-list dbg-console" id="dbgConsole"></div></div>' +
      '</div>';
  }
  function wireDebugViews() {
    var inp = $('dbgEvalIn');
    if (inp) inp.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var v = inp.value; inp.value = '';
      if (v.trim()) dbgEvaluate(v);
    });
    var go = $('dbgEvalGo');
    if (go) go.addEventListener('click', function () {
      var v = inp ? inp.value : '';
      if (inp) inp.value = '';
      if (v.trim()) dbgEvaluate(v);
    });
    var add = $('dbgWatchAdd');
    if (add) add.addEventListener('click', function () {
      var v = inp ? inp.value.trim() : '';
      if (!v) return;
      if (inp) inp.value = '';
      if (!DBG_WATCHES.some(function (w) { return w.expr === v; })) DBG_WATCHES.push({ expr: v, result: null });
      refreshWatches();
    });
    renderDebugViews();
  }
  function dbgVarRows(vars, depth) {
    var out = '';
    (vars || []).forEach(function (v) {
      var ref = Number(v.variablesReference || 0);
      var open = ref > 0 && !!DBG_OPEN[ref];
      out += '<div class="dbg-row dbg-var' + (ref > 0 ? ' expandable' : '') + (open ? ' open' : '') +
        '" data-vr="' + ref + '" style="padding-left:' + (8 + depth * 12) + 'px">' +
        '<span class="vt">' + (ref > 0 ? ic(open ? 'chevD' : 'chevR', 12) : '') + '</span>' +
        '<span class="vn">' + esc(String(v.name || '')) + '</span>' +
        '<span class="vv">' + esc(String(v.value == null ? '' : v.value)) + '</span></div>';
      if (open && DBG_CHILDREN[ref]) out += dbgVarRows(DBG_CHILDREN[ref], depth + 1);
    });
    return out;
  }
  function renderDebugViews() {
    var fr = $('dbgFrames');
    if (fr) {
      if (!DBG.frames.length) {
        fr.innerHTML = '<div class="empty">Not stopped — no call stack.</div>';
      } else {
        fr.innerHTML = DBG.frames.map(function (f, i) {
          var loc = f.file ? (String(f.file).replace(/\\/g, '/').split('/').pop() + (f.line ? ':' + f.line : '')) : '';
          return '<div class="dbg-row dbg-frame' + (i === 0 ? ' cur' : '') + '" data-fi="' + i + '">' +
            '<span class="fn">' + esc(f.name || '(frame)') + '</span>' +
            '<span class="fl">' + esc(loc) + '</span></div>';
        }).join('');
        Array.prototype.forEach.call(fr.querySelectorAll('.dbg-frame'), function (row) {
          row.addEventListener('click', function () { dbgGotoFrame(DBG.frames[+row.getAttribute('data-fi')]); });
        });
      }
    }
    var vs = $('dbgVars');
    if (vs) {
      vs.innerHTML = DBG.scopes.length
        ? DBG.scopes.map(function (s) {
            return '<div class="dbg-scope">' + esc(s.name) + '</div>' + dbgVarRows(s.variables, 0);
          }).join('')
        : '<div class="empty">No variables in scope.</div>';
      Array.prototype.forEach.call(vs.querySelectorAll('.dbg-var.expandable'), function (row) {
        row.addEventListener('click', function () { dbgToggleVar(Number(row.getAttribute('data-vr') || 0)); });
      });
    }
    renderWatches();
    renderDbgConsole();
  }
  /** Expand (or collapse) one structured variable, fetching children on first open. */
  function dbgToggleVar(ref) {
    if (!ref) return;
    if (DBG_OPEN[ref]) { delete DBG_OPEN[ref]; renderDebugViews(); return; }
    DBG_OPEN[ref] = true;
    if (!DBG_CHILDREN[ref]) BRIDGE.send({ kind: 'debugCmd', cmd: 'vars', variablesReference: ref });
    else renderDebugViews();
  }
  function onDebugVars(m) {
    var ref = Number(m.variablesReference || 0);
    if (!ref) return;
    DBG_CHILDREN[ref] = m.variables || [];
    renderDebugViews();
  }
  function renderWatches() {
    var ws = $('dbgWatches');
    if (!ws) return;
    ws.innerHTML = DBG_WATCHES.length
      ? DBG_WATCHES.map(function (w, i) {
          return '<div class="dbg-row dbg-watch"><span class="vn">' + esc(w.expr) + '</span>' +
            '<span class="vv">' + esc(w.result == null ? '…' : w.result) + '</span>' +
            '<span class="vx" data-wx="' + i + '">✕</span></div>';
        }).join('')
      : '<div class="empty">No watches yet.</div>';
    Array.prototype.forEach.call(ws.querySelectorAll('[data-wx]'), function (x) {
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        DBG_WATCHES.splice(+x.getAttribute('data-wx'), 1);
        renderWatches();
      });
    });
  }
  /** Re-evaluate every watch after a stop; the answers arrive as debugEval. */
  function refreshWatches() {
    DBG_WATCHES.forEach(function (w) {
      BRIDGE.send({ kind: 'debugCmd', cmd: 'evaluate', expression: w.expr, frameId: (DBG.frames[0] || {}).id });
    });
    renderWatches();
  }
  function dbgEvaluate(expr) {
    expr = String(expr || '').trim();
    if (!expr) return;
    BRIDGE.send({ kind: 'debugCmd', cmd: 'evaluate', expression: expr, frameId: (DBG.frames[0] || {}).id });
    DBG_CONSOLE.push({ expr: expr, result: '…' });
    renderDbgConsole();
  }
  function onDebugEval(m) {
    var expr = String(m.expression || '');
    var result = m.ok === false ? String(m.error || '<error>') : String(m.result == null ? '' : m.result);
    DBG_WATCHES.forEach(function (w) { if (w.expr === expr) w.result = result; });
    var last = DBG_CONSOLE[DBG_CONSOLE.length - 1];
    if (last && last.expr === expr && last.result === '…') last.result = result;
    else DBG_CONSOLE.push({ expr: expr, result: result });
    renderWatches();
    renderDbgConsole();
  }
  function renderDbgConsole() {
    var el = $('dbgConsole');
    if (!el) return;
    el.innerHTML = DBG_CONSOLE.length
      ? DBG_CONSOLE.map(function (c) {
          return '<div class="dbg-row dbg-evalrow"><span class="vn">' + esc(c.expr) + '</span>' +
            '<span class="vv">' + esc(c.result) + '</span></div>';
        }).join('')
      : '<div class="empty">Evaluate an expression above.</div>';
  }
  /** Jump to a frame: open its document if needed, then put the caret on the line. */
  function dbgGotoFrame(f) {
    if (!f) return;
    var rel = '';
    if (f.file) {
      var s = String(f.file).replace(/\\/g, '/');
      var base = s.split('/').pop();
      rel = isOpen(base) ? base : (isOpen(s) ? s : '');
    }
    var line0 = Math.max(0, Number(f.line || 1) - 1);
    if (rel && rel !== currentFile) openFile(rel);
    setTimeout(function () { gotoLine(line0, 0); }, 0);
  }
  /** Mark the line the program is stopped on — the red "you are here" row. */
  function paintDbgLine() {
    clearDbgLine();
    var f = DBG.frames && DBG.frames[0];
    if (!f || !f.line) return;
    var line0 = Math.max(0, Number(f.line) - 1);
    DBG_LINE = line0;
    if (CMEDITOR) {
      CMEDITOR.cm.addLineClass(line0, 'background', 'dbgcur');
      CMEDITOR.cm.addLineClass(line0, 'gutter', 'dbgcur');
      CMEDITOR.cm.scrollIntoView({ line: line0, ch: 0 }, 80);
      return;
    }
    var g = document.querySelectorAll('#glines .gline')[line0];
    if (g) g.classList.add('dbgcur');
  }
  function clearDbgLine() {
    if (CMEDITOR && DBG_LINE != null) {
      CMEDITOR.cm.removeLineClass(DBG_LINE, 'background', 'dbgcur');
      CMEDITOR.cm.removeLineClass(DBG_LINE, 'gutter', 'dbgcur');
    }
    Array.prototype.forEach.call(document.querySelectorAll('#glines .gline.dbgcur'), function (n) {
      n.classList.remove('dbgcur');
    });
    DBG_LINE = null;
  }

  // ---------- coverage ----------
  // Line coverage comes from the engine (Python's stdlib tracer); the UI only
  // projects the answer: gutter marks for covered/missing executable lines.
  var COVERAGE = null; // { file, covered:{line:1}, missing:{line:1} }
  var CM_COVER_MARKS = [];
  function runCoverage() {
    var lg = lspLang();
    if (lg !== 'python') {
      reportError({ level: 'warn', title: 'Coverage', message: 'Line coverage is implemented for Python only.' });
      return;
    }
    activeBottom = 'run'; $('dock').classList.remove('hidden'); renderDock();
    appendRun('\n[coverage] running the file under the Python tracer…\n', 'dim');
    BRIDGE.send({ kind: 'coverage', code: ta.value, language: 'python' });
  }
  function clearCoverage() {
    COVERAGE = null;
    if (CMEDITOR) {
      CM_COVER_MARKS.forEach(function (n) {
        CMEDITOR.cm.removeLineClass(n - 1, 'background', 'covmiss');
        CMEDITOR.cm.removeLineClass(n - 1, 'background', 'covhit');
      });
    }
    CM_COVER_MARKS = [];
  }
  function applyCoverage(r) {
    if (!r || r.ok === false) {
      appendRun('[coverage] ' + String((r && r.error) || 'failed') + '\n', 'err');
      reportError({ level: 'error', title: 'Coverage failed', message: String((r && r.error) || 'unknown error') });
      return;
    }
    clearCoverage();
    var covered = {}, missing = {};
    (r.lines || []).forEach(function (l) {
      if (l.count > 0) covered[l.line] = 1; else missing[l.line] = 1;
    });
    COVERAGE = { file: currentFile, covered: covered, missing: missing };
    var pct = r.executableLines ? Math.round((r.coveredLines / r.executableLines) * 100) : 0;
    var miss = (r.missing || []).slice(0, 30).join(', ');
    appendRun('[coverage] ' + r.coveredLines + '/' + r.executableLines + ' lines · ' + pct + '%' +
      (miss ? '\n[coverage] missing: ' + miss : '') + '\n', pct >= 80 ? 'ok' : 'warn');
    setStatusHint('Coverage ' + pct + '% · ' + r.coveredLines + '/' + r.executableLines + ' lines');
    if (CMEDITOR) {
      Object.keys(missing).forEach(function (n) {
        var line = Number(n) - 1;
        if (line >= 0) { CMEDITOR.cm.addLineClass(line, 'background', 'covmiss'); CM_COVER_MARKS.push(Number(n)); }
      });
      Object.keys(covered).forEach(function (n) {
        var line = Number(n) - 1;
        if (line >= 0) { CMEDITOR.cm.addLineClass(line, 'background', 'covhit'); CM_COVER_MARKS.push(Number(n)); }
      });
    } else {
      renderEditor();
    }
    showModal({
      title: 'Coverage', icon: 'coverage',
      message: r.coveredLines + ' of ' + r.executableLines + ' executable lines covered (' + pct + '%).',
      list: (r.missing || []).slice(0, 12).map(function (n) { return { icon: 'warn', label: 'line ' + n + ' not executed' }; }),
      detail: r.command,
      buttons: [{ label: 'Close', primary: true, onClick: function () {} }],
    });
  }

  // ---------- formatting ----------
  // Reformat is a real text transform, not a toast: trailing whitespace, tabs
  // in indentation, runs of blank lines and a missing final newline are exactly
  // the things a hand-written buffer accumulates. The rewrite keeps the file's
  // own line ending so a CRLF document does not flip to LF behind the user.
  function setEditorText(text) {
    if (CMEDITOR) {
      var cm = CMEDITOR.cm;
      var last = cm.lastLine();
      cm.replaceRange(text, { line: 0, ch: 0 }, { line: last, ch: cm.getLine(last).length });
    } else {
      ta.value = text;
      renderEditor();
    }
    if (currentFile && BUFFERS[currentFile]) BUFFERS[currentFile].dirty = true;
    renderTabs(); updateCaret();
  }
  function basicFormat(text) {
    var eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    var lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    var out = [], blank = 0;
    lines.forEach(function (line) {
      var s = line.replace(/[ \t]+$/, '').replace(/^\t+/, function (m) { return '    '.repeat(m.length); });
      if (s.trim() === '') {
        blank++;
        if (blank > 2) return;
      } else blank = 0;
      out.push(s);
    });
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join(eol) + eol;
  }
  function changedLines(a, b) {
    var x = a.split(/\r?\n/), y = b.split(/\r?\n/), n = 0;
    for (var i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) n++;
    return n;
  }
  function reformatCode() {
    if (!CAN_EDIT()) { toast('Reformat: no editable document'); return; }
    var before = ta.value, after = basicFormat(before);
    if (after === before) { toast('Reformatted · nothing to change'); return; }
    setEditorText(after);
    toast('Reformatted · ' + changedLines(before, after) + ' lines changed');
  }
  /**
   * Import hygiene: de-duplicate and sort the leading import block. Nothing is
   * deleted — deciding an import is unused needs a resolver — so this is safe
   * on a half-edited file and still fixes the two things people actually hit.
   */
  function optimizeImportsText(text, lang) {
    var eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    var lines = text.split(/\r?\n/);
    if (lang !== 'python' && lang !== 'javascript' && lang !== 'typescript') return null;
    var re = lang === 'python'
      ? /^\s*(import\s+\S|from\s+\S+\s+import\s+)/
      : /^\s*import\s.+from\s+['"]/;
    var start = -1, end = -1;
    for (var i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) { if (start < 0) start = i; end = i; }
      else if (start >= 0) break;
    }
    if (start < 0) return null;
    var seen = {}, block = [];
    for (var j = start; j <= end; j++) {
      var line = lines[j];
      if (!line.trim()) continue;
      if (!re.test(line)) { block.push(line); continue; } // comment inside the block
      if (seen[line.trim()]) continue;
      seen[line.trim()] = 1;
      block.push(line);
    }
    var imports = block.filter(function (l) { return re.test(l); });
    var comments = block.filter(function (l) { return !re.test(l); });
    imports.sort(function (a, b) {
      var key = function (s) {
        var m = /^\s*from\s+(\S+)/.exec(s);
        return (m ? '1' + m[1] : '0' + s.trim());
      };
      return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    });
    var next = lines.slice(0, start).concat(comments, imports, lines.slice(end + 1));
    return { text: next.join(eol), added: imports.length, removed: block.length - imports.length };
  }
  function optimizeImports() {
    if (!CAN_EDIT()) { toast('Optimize Imports: no editable document'); return; }
    var res = optimizeImportsText(ta.value, currentLang);
    if (!res) { toast('Optimize Imports: no import block found for ' + currentLang); return; }
    if (res.text === ta.value) { toast('Imports already optimized'); return; }
    setEditorText(res.text);
    toast('Imports optimized · ' + res.added + ' kept, ' + res.removed + ' duplicate lines removed');
  }

  // ---------- terminal ----------
  var TERM_LINES = [];
  var TERM_HIST = [];
  var TERM_HI = -1;
  var TERM_SEEDED = false;
  var TERM_PROMPT = 'nolanguage $';
  var TERM_ATTACHED = false;
  var RUN_ACTIVE = false;
  function termPane() {
    return '<div class="term">' +
      '<div class="term-out" id="termOut"></div>' +
      '<div class="term-line"><span class="prompt" id="termPrompt">' + TERM_PROMPT + '</span>' +
      '<input class="term-in" id="termIn" spellcheck="false" autocapitalize="off" autocomplete="off" /></div></div>';
  }
  function termWrite(text, cls) { TERM_LINES.push({ t: text, c: cls || '' }); if (TERM_LINES.length > 3000) TERM_LINES.shift(); }
  function renderTermOut() {
    var o = $('termOut'); if (!o) return;
    o.innerHTML = TERM_LINES.map(function (l) {
      return l.c ? '<span class="' + l.c + '">' + esc(l.t) + '</span>' : esc(l.t);
    }).join('');
    o.scrollTop = o.scrollHeight;
  }
  function termBuiltins(cmd) {
    var parts = cmd.split(/s+/), head = parts[0], rest = cmd.slice(head.length).trim();
    switch (head) {
      case 'clear': TERM_LINES = []; renderTermOut(); return true;
      case 'help':
        termWrite('Built-ins: help, clear, echo, date, pwd, whoami, history, theme [dark|light]\n', 'dim');
        termWrite('Everything else runs as a shell command in the project root (ls, git status, python main.py …).\n', 'dim');
        return true;
      case 'echo': termWrite(rest + '\n'); return true;
      case 'date': termWrite(new Date().toString() + '\n'); return true;
      case 'pwd': termWrite('/Nolanguage\n', 'acc'); return true;
      case 'whoami': termWrite('developer\n', 'acc'); return true;
      case 'theme':
        setTheme(rest === 'light' ? 'light' : 'darcula');
        termWrite('theme -> ' + (rest === 'light' ? 'light' : 'darcula') + '\n', 'dim');
        return true;
      case 'history':
        TERM_HIST.forEach(function (h, i) { termWrite((i + 1) + '  ' + h + '\n', 'dim'); });
        return true;
      default: return false;
    }
  }
  function termSubmit(raw) {
    var cmd = raw.replace(/s+$/, '');
    termWrite(TERM_PROMPT + ' ' + cmd + '\n');
    var trimmed = cmd.trim();
    if (trimmed) {
      if (TERM_HIST[TERM_HIST.length - 1] !== trimmed) TERM_HIST.push(trimmed);
      TERM_HI = -1;
      if (!termBuiltins(trimmed)) {
        TERM_ATTACHED = true;
        BRIDGE.send({ kind: 'termExec', cmd: trimmed });
      }
    }
    renderTermOut();
  }
  function wireTerm() {
    if (!TERM_SEEDED) {
      TERM_SEEDED = true;
      termWrite('Nolanguage terminal — type "help" for built-ins; other commands run in the project root.\n', 'dim');
    }
    renderTermOut();
    var inp = $('termIn'); if (!inp) return;
    var out = $('termOut');
    if (out) out.addEventListener('click', function () { inp.focus(); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var v = inp.value; inp.value = '';
        if (TERM_ATTACHED) {
          BRIDGE.send({ kind: 'termInput', text: v + '\n' });
          termWrite(v + '\n'); renderTermOut();
        } else {
          termSubmit(v);
        }
      }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (TERM_HI < TERM_HIST.length - 1) { TERM_HI++; inp.value = TERM_HIST[TERM_HIST.length - 1 - TERM_HI] || ''; } }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (TERM_HI > 0) { TERM_HI--; inp.value = TERM_HIST[TERM_HIST.length - 1 - TERM_HI] || ''; } else { TERM_HI = -1; inp.value = ''; } }
      else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); TERM_LINES = []; renderTermOut(); }
    });
  }

  // ---------- message handling ----------
  function handle(m) {
    switch (m.kind) {
      case 'hello':
        KCOMMANDS = m.commands || [];
        // First real git read: the status bar's branch cell must not keep the
        // sample name it booted with.
        BRIDGE.send({ kind: 'gitStatus' });
        $('aboutBody').innerHTML = 'Nolanguage · PyCharm-style shell<br/>app ' + esc(m.appVersion) +
          '<br/>' + esc(m.os) + ' / ' + esc(m.arch) + '<br/><span class="dim">kernel commands: ' + KCOMMANDS.length + '</span>';
        break;
      case 'workspace':
        // The plugin catalogue: languages, extensions, grammar and capabilities.
        applyLanguageCatalog(m.languages || []);
        break;
      case 'plugins':
        // The full plugin catalogue. It arrives unprompted on connect, and again
        // after every enable/disable/install, so an open dialog stays current.
        PLUGINS = m;
        paintPluginDialog();
        break;
      case 'profileResult':
        // Stash it so a freshly opened /profile page can render immediately
        // without the engine relaying state.
        try { localStorage.setItem('nl-profile', JSON.stringify(m)); } catch (e) { /* ignore */ }
        toast(m.ok ? ('profile ready · ' + (m.source || '') + ' · ' + (m.sampleCount || 0) + ' fns') : ('profile failed: ' + (m.error || 'unknown')));
        paintProfileDialog(m);
        break;
      case 'mcp':
        // The catalogue arrives on connect and after every connect/disconnect, so
        // an open sidebar stays current without polling.
        MCP = m;
        if (activeLeft === 'mcp') renderPanel();
        break;
      case 'mcpCallResult':
        MCP_OUT = (m.ok ? 'OK ' : 'ERROR ') + (m.id || '') + ' / ' + (m.tool || '') + '\n' +
          (m.ok ? JSON.stringify(m.result, null, 2) : String(m.error || ''));
        if (activeLeft === 'mcp') renderPanel();
        break;
      case 'mcpError':
        MCP_OUT = 'ERROR ' + (m.id ? m.id + ': ' : '') + String(m.error || '');
        if (activeLeft === 'mcp') renderPanel();
        break;
      case 'interpreters':
        showInterpreters(m);
        break;
      case 'interpreterSet':
        if (m.ok) {
          toast('Interpreter: ' + (m.toolchain || 'auto'));
          renderStLang();
        } else {
          toast('Interpreter error: ' + String(m.error || 'unknown'));
        }
        break;
      case 'ideaImport':
        applyIdeaImport(m);
        break;
      case 'attribution':
        paintAttribution(m);
        break;
      case 'metrics':
        lastMetrics = m; if (activeBottom === 'perf') renderPerf(m);
        break;
      case 'flame':
        // Live CPU profile frame: keep the memory trend even when the window is
        // closed, so opening it shows the last ~90s instead of a single dot.
        if (m.memory) {
          FLAME.mem.push({
            at: m.at, rss: m.memory.rss, heapUsed: m.memory.heapUsed,
            services: m.memory.services || []
          });
          if (FLAME.mem.length > 90) FLAME.mem.shift();
        }
        if (FLAME.open) renderFlame(m); else FLAME.last = m;
        break;
      case 'log':
        (m.records || []).forEach(function (r) { LOGS.push(r); });
        if (LOGS.length > 2000) LOGS = LOGS.slice(-1500);
        if (activeBottom === 'logs') renderLogs();
        break;
      case 'diagnostics':
        // A switch can move the document on while a check is in flight; showing
        // the old language's problems under the new one would be a lie.
        if (m.language && m.language !== currentLang) break;
        setDiags(m.items || []);
        break;
      case 'runResult':
        if (m.cancelled) {
          RUN_ACTIVE = false;
          { var ri4 = $('runIn'); if (ri4) ri4.disabled = true; }
          appendRun('\n[stopped by user]\n', 'warn');
          break;
        }
        appendRun('\nProcess finished with exit code ' + (m.exitCode == null ? '?' : m.exitCode) +
          '  (' + fmtMs(m.durationMs) + ')\n', m.exitCode === 0 ? 'ok' : 'err');
        RUN_ACTIVE = false;
        { var ri2 = $('runIn'); if (ri2) ri2.disabled = true; }
        break;
      case 'runStart':
        { var ro = $('runOut'); if (ro) ro.innerHTML = '<span class="dim">Running ' + currentFile + ' …</span>'; }
        RUN_ACTIVE = true;
        { var ri3 = $('runIn'); if (ri3) { ri3.disabled = false; ri3.focus(); } }
        break;
      case 'runOut':
        appendRun(m.text, m.stream === 'stderr' ? 'err' : '');
        break;
      case 'stopped':
        RUN_ACTIVE = false;
        DBG.active = false; DBG.state = '';
        appendRun('\n[stopped]\n', 'dim');
        renderDbgBar();
        toast(m.cancelled ? 'Run stopped' : (m.debugStopped ? 'Debug session stopped' : 'Nothing was running'));
        break;
      case 'debugState':
        applyDebugState(m);
        break;
      case 'debugVars':
        onDebugVars(m);
        break;
      case 'debugEval':
        onDebugEval(m);
        break;
      case 'debugOut':
        appendRun(m.text, m.category === 'stderr' ? 'err' : '');
        break;
      case 'coverageResult':
        applyCoverage(m);
        break;
      case 'commandResult': {
        if (m.ok) {
          var kres;
          try { kres = m.result === undefined ? 'ok' : JSON.stringify(m.result); } catch (e) { kres = String(m.result); }
          if (!kres) kres = 'ok';
          balloon({
            type: 'success', title: 'Kernel: ' + m.id,
            message: kres.length > 240 ? kres.slice(0, 240) + '…' : kres,
          });
        } else {
          reportError({ level: 'error', title: 'Kernel command failed', message: String(m.error || 'unknown error'), detail: String(m.id || '') });
        }
        break;
      }
      case 'gitStatus':
        GIT.status = m.ok ? m : null;
        GIT.error = m.error || '';
        GIT.loading = false;
        if (m.ok) {
          var sg = $('stGit');
          if (sg) {
            var n = (m.changes || []).length;
            sg.innerHTML = ic('vcs', 14) + esc(m.branch || 'git') + (n ? ' · ' + n : '');
          }
        }
        if (activeLeft === 'commit' || activeLeft === 'vcs') renderPanel();
        break;
      case 'gitCommitResult':
        GIT.status = null; GIT.loading = false;
        if (m.ok) {
          balloon({ type: 'success', title: 'Committed', message: String(m.branch || '') + ' · ' + m.committed + ' files' });
          var cmEl = $('commitMsg'); if (cmEl) cmEl.value = '';
          BRIDGE.send({ kind: 'gitStatus' });
        } else {
          reportError({ level: 'error', title: 'Commit failed', message: String(m.error || 'git refused the commit'), detail: m.output });
        }
        if (activeLeft === 'commit' || activeLeft === 'vcs') renderPanel();
        break;
      case 'termResult':
        TERM_ATTACHED = false;
        if (m.code !== 0 && m.code !== null) termWrite('[exit ' + m.code + ' · ' + fmtMs(m.ms) + ']\n', 'dim');
        renderTermOut();
        { var ti2 = $('termIn'); if (ti2) ti2.focus(); }
        break;
      case 'termOut':
        termWrite(m.text, m.stream === 'stderr' ? 'err' : '');
        renderTermOut();
        break;
      case 'extensions':
        renderExtModal(m.extensions || []);
        break;
      case 'extension':
        toast('[' + m.event + '] ' + m.extensionId);
        break;
      case 'extensionResult':
        toast(m.ok ? ('result: ' + JSON.stringify(m.result)) : ('error: ' + m.error));
        break;
      case 'fsListing': onFsListing(m); break;
      case 'fsFile': onFsFile(m.file); break;
      case 'fsSaved': onFsSaved(m); break;
      case 'fsChanged': onFsChanged(m); break;
      case 'fsRoot':
        ROOT_NAME = m.name;
        { var pv = document.querySelector('#projWidget .val'); if (pv) pv.textContent = m.name; }
        break;
      case 'fsError': onFsError(m); break;
      case 'completion': onCompletion(m); break;
      case 'hover': onHover(m); break;
      case 'scriptOut':
        appendPaletteOut(m.text, m.stream === 'stderr' ? 'err' : '');
        break;
      case 'scriptResult':
        PAL_BUSY = false;
        appendPaletteOut('\n[exit ' + (m.code == null ? '?' : m.code) + (m.error ? ' · ' + m.error : '') + ']\n', m.ok ? 'ok' : 'err');
        break;
    }
  }
