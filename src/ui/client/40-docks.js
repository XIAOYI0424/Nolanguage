  // ---------- MCP tool window ----------
  // The engine owns the servers; this panel is a projection of the last mcp
  // frame plus the last tool-call output. Keeping both in state means switching
  // tabs never blanks the panel or loses a result.
  var MCP = { servers: [], configPath: '', configExists: false, configError: '' };
  var MCP_OUT = '';

  /** The status dot is the only at-a-glance state, so it gets the four colours. */
  function mcpDot(status) {
    return status === 'ready' ? 'ok'
      : status === 'connecting' ? 'warn'
        : status === 'error' ? 'err'
          : status === 'disabled' ? 'off' : 'idle';
  }
  function mcpPane() {
    var list = MCP.servers || [];
    var h = '<div class="mcp">';
    h += '<div class="mcp-head"><span class="mcp-title">MCP servers</span>' +
      '<button class="tbtn" data-mcp="refresh">Refresh</button>' +
      (list.length ? '' : '<button class="tbtn" data-mcp="init">Example</button>') + '</div>';
    h += '<div class="mcp-cfg" title="Click to copy the path">' + esc(MCP.configPath || 'mcp.json') + '</div>';
    if (MCP.configError) h += '<div class="mcp-err">' + esc(MCP.configError) + '</div>';
    if (!list.length) {
      h += '<div class="empty">No MCP servers configured.<br/>' +
        'Declare them in the file above, then Refresh.' +
        (MCP.configExists ? '' : '<br/>Or create an example config.') + '</div>';
    } else {
      list.forEach(function (sv) {
        var on = sv.status === 'ready';
        var cmd = [sv.command].concat(sv.args || []).join(' ');
        h += '<div class="mcp-card">';
        h += '<div class="mcp-row"><span class="mcp-dot ' + mcpDot(sv.status) + '"></span>' +
          '<b class="mcp-name">' + esc(sv.id) + '</b>' +
          '<span class="mcp-state">' + esc(sv.status) + '</span>';
        if (sv.status !== 'disabled') {
          h += '<button class="tbtn" data-mcp="' + (on ? 'disconnect' : 'connect') + '" data-id="' + esc(sv.id) + '">' +
            (on ? 'Disconnect' : 'Connect') + '</button>';
        }
        h += '</div>';
        h += '<div class="mcp-cmd" title="' + esc(cmd) + '">' + esc(cmd) + '</div>';
        if (sv.description) h += '<div class="mcp-desc">' + esc(sv.description) + '</div>';
        if (sv.error) h += '<div class="mcp-err">' + esc(sv.error) + '</div>';
        var tools = sv.tools || [];
        if (tools.length) {
          h += '<div class="mcp-tools">' + tools.map(function (t) {
            return '<button class="mcp-tool" data-mcp="call" data-id="' + esc(sv.id) + '" data-tool="' + esc(t.name) +
              '" title="' + esc(t.description || 'Call with empty arguments') + '">' + esc(t.name) + '</button>';
          }).join('') + '</div>';
        } else if (on) {
          h += '<div class="mcp-desc">connected · no tools reported</div>';
        }
        h += '</div>';
      });
    }
    h += '<pre class="mcp-out" id="mcpOut">' + esc(MCP_OUT || 'Tool output appears here.') + '</pre>';
    h += '</div>';
    return h;
  }
  function wireMcp(body) {
    body.querySelectorAll('button[data-mcp]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-mcp');
        if (act === 'refresh') { BRIDGE.send({ kind: 'mcpList' }); return; }
        if (act === 'init') { BRIDGE.send({ kind: 'mcpInitConfig' }); return; }
        var id = b.getAttribute('data-id') || '';
        if (act === 'connect' || act === 'disconnect') {
          b.disabled = true;
          BRIDGE.send({ kind: act === 'connect' ? 'mcpConnect' : 'mcpDisconnect', id: id });
          return;
        }
        if (act === 'call') {
          var tool = b.getAttribute('data-tool') || '';
          MCP_OUT = 'calling ' + id + ' / ' + tool + ' …';
          var out = $('mcpOut');
          if (out) out.textContent = MCP_OUT;
          BRIDGE.send({ kind: 'mcpCall', id: id, tool: tool, args: {} });
        }
      });
    });
    var cfg = body.querySelector('.mcp-cfg');
    if (cfg) cfg.addEventListener('click', function () { copyText(cfg.textContent); });
  }

  // ---- bottom dock ----
  function renderDock() {
    var tabs = $('dockTabs');
    // keep the spacer + hide button; rebuild tab buttons before them
    Array.prototype.slice.call(tabs.querySelectorAll('.dtab')).forEach(function (n) { n.remove(); });
    BOTTOM_WINDOWS.concat([PROBLEMS]).forEach(function (w) {
      var b = document.createElement('button');
      b.className = 'dtab' + (activeBottom === w.id ? ' active' : '');
      b.innerHTML = '<span class="ic">' + ic(w.icon, 16) + '</span>' + w.title;
      b.addEventListener('click', function () { activeBottom = w.id; renderDock(); saveLayout(); });
      tabs.insertBefore(b, tabs.querySelector('.spacer'));
    });
    var body = $('dockBody');
    body.innerHTML =
      pane('run', runPaneHtml()) +
      pane('debug', debugPane()) +
      pane('terminal', termPane()) +
      pane('packages', packagesPane()) +
      pane('perf', perfPane()) +
      pane('logs', logsPane()) +
      pane('find', findPane()) +
      pane('problems', '<div id="probOut"><div class="empty">No problems.</div></div>');
    wireLogs(); wireTerm(); wireFind(); wireDbg(); wireDebugViews(); wirePackages();
    var ri = $('runIn');
    if (ri) ri.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var v = ri.value; ri.value = '';
        if (RUN_ACTIVE) { BRIDGE.send({ kind: 'runInput', text: v + '\n' }); appendRun(v + '\n'); }
      }
    });
    if (activeBottom === 'logs') renderLogs();
    if (activeBottom === 'perf') renderPerf(lastMetrics);
    if (activeBottom === 'terminal') { renderTermOut(); var ti = $('termIn'); if (ti) ti.focus(); }
    if (activeBottom === 'packages') { renderPkg(); requestDeps(); }
  }
  // ---- Find in Files (bottom dock, Ctrl+Shift+F) ----
  // Searches the documents currently held in memory (open buffers) plus any
  // project-tree file we can read. Results group by file; each match carries the
  // line number and the snippet, and double-clicking jumps to it.
  function findPane() {
    return '<div class="find-bar">' +
      '<input id="findIn" placeholder="Find in files…" spellcheck="false" autocapitalize="off" autocomplete="off" />' +
      '<label class="dlg-check" style="margin-left:8px"><input type="checkbox" id="findCS" />Case sensitive</label>' +
      '</div><div id="findOut" class="find-out"><div class="empty">Type to search open files.</div></div>';
  }
  var FIND_MAX_TOTAL = 1000, FIND_MAX_PER_FILE = 250, FIND_SCAN_LIMIT = 16 * 1024 * 1024, findTimer = 0;
  function queueFind(q, cs) {
    clearTimeout(findTimer);
    findTimer = setTimeout(function () { renderFind(q, cs); }, 120);
  }
  function wireFind() {
    var inp = $('findIn'); if (!inp) return;
    inp.addEventListener('input', function () { queueFind(inp.value, $('findCS') && $('findCS').checked); });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { inp.value = ''; clearTimeout(findTimer); renderFind('', false); } });
    var cs = $('findCS'); if (cs) cs.addEventListener('change', function () { queueFind(inp.value, cs.checked); });
  }
  function openFindInFiles() {
    if (activeBottom !== 'find') { activeBottom = 'find'; renderDock(); }
    var inp = $('findIn'); if (inp) { inp.focus(); }
  }
  function renderFind(q, cs) {
    var out = $('findOut'); if (!out) return;
    q = q || '';
    if (!q.trim()) { out.innerHTML = '<div class="empty">Type to search open files.</div>'; return; }
    var needle = cs ? q : q.toLowerCase();
    var html = '';
    var total = 0, scanned = 0, capped = false;
    var paths = Object.keys(BUFFERS);
    for (var pi = 0; pi < paths.length && total < FIND_MAX_TOTAL && scanned < FIND_SCAN_LIMIT; pi++) {
      var path = paths[pi], content = BUFFERS[path].content || '';
      var hits = [], start = 0, lineNo = 1;
      while (start <= content.length && total < FIND_MAX_TOTAL && scanned < FIND_SCAN_LIMIT) {
        var end = content.indexOf('\n', start); if (end < 0) end = content.length;
        var ln = content.slice(start, end);
        scanned += ln.length + 1;
        if ((cs ? ln : ln.toLowerCase()).indexOf(needle) >= 0) {
          hits.push({ line: lineNo, text: ln }); total++;
          if (hits.length >= FIND_MAX_PER_FILE || total >= FIND_MAX_TOTAL) { capped = true; break; }
        }
        if (end === content.length) break;
        start = end + 1; lineNo++;
      }
      if (hits.length) {
        html += '<div class="fgroup" data-path="' + esc(path) + '"><div class="fhead">' + esc(path) + ' <span class="dim">(' + hits.length + ')</span></div>';
        hits.forEach(function (h) {
          html += '<div class="fhit" data-path="' + esc(path) + '" data-line="' + h.line + '">' +
            '<span class="fl">Ln ' + h.line + '</span>' + esc(h.text.slice(0, 200)) + '</div>';
        });
        html += '</div>';
      }
    }
    if (total >= FIND_MAX_TOTAL || scanned >= FIND_SCAN_LIMIT) capped = true;
    if (capped) html += '<div class="empty">Search limited to ' + FIND_MAX_PER_FILE + ' matches per file, ' + FIND_MAX_TOTAL + ' total / ' + Math.round(FIND_SCAN_LIMIT / 1048576) + ' Mi characters for responsiveness.</div>';
    out.innerHTML = total ? html : '<div class="empty">' + (capped ? 'Search scan limit reached.' : 'No matches in open files.') + '</div>';
    out.querySelectorAll('.fhit').forEach(function (el) {
      el.addEventListener('dblclick', function () { gotoLineInFile(el.getAttribute('data-path'), +el.getAttribute('data-line')); });
    });
  }
  function gotoLineInFile(path, line) {
    if (!BUFFERS[path]) { openFile(path); }
    else showBuffer(path);
    var target = path, n = line;
    setTimeout(function () {
      var lines = ta.value.split('\n');
      var pos = 0; for (var i = 0; i < n - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      ta.focus(); ta.setSelectionRange(pos, pos); updateCaret();
    }, 0);
  }
  function pane(id, inner) {
    return '<div class="dock-pane' + (activeBottom === id ? ' active' : '') + '" data-pane="' + id + '">' + inner + '</div>';
  }

  // ---- Packages (bottom dock, Alt+6) ----
  // PyCharm's "Python Packages" window, generalized. The list, the file it is
  // read from and the command that installs one package all come from the
  // language manifest, so this pane renders an answer instead of knowing a
  // language: nothing below mentions python, go or node.
  var PKG = { report: null, out: '', busy: false };

  function packagesPane() {
    return '<div class="pkgs">' +
      '<div class="pkgs-head"><span class="pkgs-title">Project packages</span>' +
      '<span class="pkgs-file" id="pkgFile"></span>' +
      '<button class="tbtn" data-pkg="refresh">Refresh</button></div>' +
      '<div class="pkgs-install">' +
      '<input id="pkgName" placeholder="Package name" spellcheck="false" autocapitalize="off" autocomplete="off" />' +
      '<button class="tbtn primary" data-pkg="install" id="pkgGo">Install</button>' +
      '<button class="tbtn" data-pkg="cancel" id="pkgStop">Stop</button>' +
      '</div>' +
      '<div class="pkgs-note" id="pkgNote"></div>' +
      '<div class="pkgs-list" id="pkgList"></div>' +
      '<pre class="pkgs-out" id="pkgOut"></pre>' +
      '</div>';
  }

  // The declaration lives next to the project, so the current buffer has to
  // travel with the request: the engine compares what the file imports against
  // what the dependency file declares.
  function requestDeps() {
    BRIDGE.send({ kind: 'dependencyReport', language: currentLang, code: ta.value });
  }

  /**
   * Follow the document. A language switch makes the last report describe the
   * wrong language, so re-read instead of showing python's packages under go.
   */
  function pkgSync() {
    if (activeBottom !== 'packages') return;
    var dock = $('dock');
    if (dock && dock.classList.contains('hidden')) return;
    if (PKG.report && PKG.report.language === currentLang) return;
    requestDeps();
  }

  function installPkg() {
    var inp = $('pkgName'); if (!inp) return;
    var name = (inp.value || '').trim();
    if (!name || PKG.busy) { inp.focus(); return; }
    PKG.out = '';
    PKG.busy = true;
    renderPkg();
    BRIDGE.send({ kind: 'dependencyInstall', language: currentLang, package: name });
  }

  function renderPkg() {
    var out = $('pkgOut'); if (!out) return;
    out.textContent = PKG.out || 'Installer output appears here.';
    out.scrollTop = out.scrollHeight;
    var go = $('pkgGo'); if (go) go.disabled = PKG.busy;
    var stop = $('pkgStop'); if (stop) stop.disabled = !PKG.busy;
    var list = $('pkgList'), note = $('pkgNote'), file = $('pkgFile');
    if (!list) return;
    var r = PKG.report;
    if (!r) {
      if (file) file.textContent = '';
      if (note) { note.textContent = ''; note.className = 'pkgs-note'; }
      list.innerHTML = '<div class="empty">Reading the dependency file…</div>';
      return;
    }
    if (file) file.textContent = r.file || '';
    if (note) {
      note.textContent = r.note || '';
      note.className = 'pkgs-note' + (r.note ? ' warn' : '');
    }
    var rows = '';
    (r.packages || []).forEach(function (p) {
      rows += '<div class="pkgs-row"><b>' + esc(p.name) + '</b>' +
        (p.version ? '<span class="pkgs-ver">' + esc(p.version) + '</span>' : '') + '</div>';
    });
    // Imports with no matching declaration. A hint, not a verdict: the engine
    // reads imports textually, so a standard-library module shows up here too.
    (r.undeclared || []).forEach(function (name) {
      rows += '<div class="pkgs-row"><b>' + esc(name) + '</b>' +
        '<span class="pkgs-tag">not declared</span>' +
        '<button class="tbtn" data-pkg="use" data-name="' + esc(name) + '">Use</button></div>';
    });
    if (!rows) {
      rows = '<div class="empty">' +
        (r.supported === false ? 'This language declares no dependency file.' : 'Nothing declared yet.') + '</div>';
    }
    list.innerHTML = rows;
    list.querySelectorAll('button[data-pkg="use"]').forEach(function (b) {
      b.addEventListener('click', function () {
        var inp = $('pkgName');
        if (inp) { inp.value = b.getAttribute('data-name') || ''; inp.focus(); }
      });
    });
  }

  function wirePackages() {
    var body = $('dockBody'); if (!body) return;
    body.querySelectorAll('button[data-pkg]').forEach(function (b) {
      var act = b.getAttribute('data-pkg');
      if (act === 'use') return; // per-row buttons are wired by renderPkg
      b.addEventListener('click', function () {
        if (act === 'refresh') requestDeps();
        else if (act === 'cancel') BRIDGE.send({ kind: 'dependencyCancel' });
        else if (act === 'install') installPkg();
      });
    });
    var inp = $('pkgName');
    if (inp) inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); installPkg(); }
    });
  }

  /** Every dependency frame, in one place: the pane is a projection of these. */
  function pkgOnFrame(m) {
    if (m.kind === 'dependencies') {
      // A switch can move the document on while the read is in flight; showing
      // another language's packages would be a lie.
      if (m.language && m.language !== currentLang) return;
      PKG.report = m;
      renderPkg();
      return;
    }
    if (m.kind === 'dependencyStart') {
      PKG.busy = true;
      PKG.out = '$ ' + (m.package || '') + '\n';
      renderPkg();
      return;
    }
    if (m.kind === 'dependencyOut') {
      PKG.out += m.text || '';
      // The engine caps the process output; this is the render cap on top of it.
      if (PKG.out.length > 200000) PKG.out = PKG.out.slice(-200000);
      renderPkg();
      return;
    }
    if (m.kind === 'dependencyCancelled') {
      if (!m.ok && m.error) PKG.out += '[' + m.error + ']\n';
      renderPkg();
      return;
    }
    if (m.kind !== 'dependencyResult') return;
    PKG.busy = false;
    var line = m.ok
      ? '[finished in ' + fmtMs(m.ms) + ']\n'
      : '[failed: ' + (m.error || ('exit code ' + (m.code == null ? '?' : m.code))) + ']\n';
    if (m.refresh && m.refresh.ok) line += '[language server restarted]\n';
    else if (m.refresh && m.refresh.error) line += '[language server not restarted: ' + m.refresh.error + ']\n';
    PKG.out += line;
    renderPkg();
    var inp = $('pkgName'); if (inp) inp.value = '';
    // The file on disk may have just gained a line; re-read it rather than
    // guessing what the installer decided to write.
    if (m.ok) requestDeps();
  }
  // The Run pane owns the debug toolbar: the bar is the control surface for a
  // session that is already running, while the Debug pane (below) is the view
  // that only means something once the program has stopped.
  function runPaneHtml() {
    return '<div class="dbg-bar" id="dbgBar"><span class="dbg-state" id="dbgState">debug</span>' +
      '<button class="tbtn" data-dbg="continue">Continue</button>' +
      '<button class="tbtn" data-dbg="pause">Pause</button>' +
      '<button class="tbtn" data-dbg="next">Step Over</button>' +
      '<button class="tbtn" data-dbg="stepIn">Step In</button>' +
      '<button class="tbtn" data-dbg="stepOut">Step Out</button>' +
      '<button class="tbtn" data-dbg="stop">Stop</button></div>' +
      '<div class="console" id="runOut"><span class="dim">Click Run (Shift+F10) to execute main.py in the sandbox.</span></div>' +
      '<div class="term-line" id="runLine"><span class="prompt" id="runPrompt">input&gt;</span>' +
      '<input class="term-in" id="runIn" disabled spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="program asks for input? type here, then Enter" /></div>';
  }

  // ---------- performance ----------
  var lastMetrics = null;
  function perfPane() {
    return '<div class="perf-grid" id="perfGrid"></div>';
  }
  function renderPerf(m) {
    if (!m) return;
    var grid = $('perfGrid'); if (!grid) return;
    var names = Object.keys(m.metrics || {});
    // highest-p95 metric is the status-bar headline
    var top = null, topP = -1;
    names.forEach(function (n) { var s = m.metrics[n]; if (s && s.p95 > topP) { topP = s.p95; top = n; } });
    if (top) $('stPerfVal').textContent = 'P95 ' + fmtMs(m.metrics[top].p95);
    var shown = names.slice(0, 8);
    grid.innerHTML = shown.map(function (n) {
      var s = m.metrics[n], ser = (m.series || {})[n] || [];
      return '<div class="pcard"><div class="nm" title="' + esc(n) + '">' + esc(n) + '</div>' +
        '<div class="big">' + fmtMs(s.avg) + '</div>' +
        '<div class="row"><span>p50 ' + fmtMs(s.p50) + '</span><span>p95 ' + fmtMs(s.p95) + '</span></div>' +
        '<div class="row"><span>p99 ' + fmtMs(s.p99) + '</span><span>n=' + s.count + '</span></div>' +
        sparkline(ser) + '</div>';
    }).join('') || '<div class="empty">No metrics yet.</div>';
  }
  function fmtMs(v) { return v >= 100 ? Math.round(v) + 'ms' : (Math.round(v * 10) / 10) + 'ms'; }
  function fmtBytes(v) {
    if (!v) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0, n = v;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + ' ' + u[i];
  }
  function sparkline(ser) {
    if (!ser || ser.length < 2) return '';
    var w = 100, h = 30, max = Math.max.apply(null, ser), min = Math.min.apply(null, ser);
    var span = (max - min) || 1;
    var pts = ser.map(function (v, i) {
      var x = (i / (ser.length - 1)) * w, y = h - ((v - min) / span) * (h - 4) - 2;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>';
  }

  // ---------- kernel flame graph window ----------
  // A separate, draggable window rather than a dock pane: the point is to watch
  // the kernel while a program runs, so the editor and the run output must stay
  // usable behind it. Data arrives as "flame" frames pushed by the engine
  // (V8 CPU samples of the kernel process, aggregated into a call tree).
  var FLAME = { open: false, paused: false, last: null, drag: null, mem: [] };
  function shortFlameUrl(u) {
    if (!u) return '';
    var s = String(u).replace(/^file:\/\/\/?/, '');
    var i = s.lastIndexOf('/src/');
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function openFlame() {
    var w = $('flameWin');
    if (!w) return;
    w.classList.add('open');
    w.setAttribute('aria-hidden', 'false');
    FLAME.open = true;
    if (!FLAME.paused) BRIDGE.send({ kind: 'flameStart', intervalMs: 1000 });
    renderFlame(FLAME.last);
  }
  function closeFlame() {
    var w = $('flameWin');
    if (w) { w.classList.remove('open'); w.setAttribute('aria-hidden', 'true'); }
    FLAME.open = false;
    BRIDGE.send({ kind: 'flameStop' });
  }
  function flamePauseToggle() {
    FLAME.paused = !FLAME.paused;
    var b = $('flamePause');
    if (b) b.textContent = FLAME.paused ? 'Resume' : 'Pause';
    BRIDGE.send({ kind: FLAME.paused ? 'flameStop' : 'flameStart', intervalMs: 1000 });
  }
  function renderFlame(f) {
    if (f) FLAME.last = f;
    var chart = $('flameChart'), meta = $('flameMeta'), hot = $('flameHot');
    if (!chart) return;
    // The memory trend lives on its own buffer, so it must be drawn even when
    // this frame carries no call tree (error frames, first sample).
    renderFlameMemory();
    if (!f) {
      chart.innerHTML = '<div class="empty">Sampling the kernel…</div>';
      return;
    }
    if (!f.ok) {
      if (meta) meta.textContent = 'error';
      chart.innerHTML = '<div class="empty" style="color:var(--error)">' + esc(f.error || 'sampler error') + '</div>';
      if (hot) hot.innerHTML = '';
      return;
    }
    if (meta) {
      meta.textContent = 'busy ' + fmtMs(f.busyMs) + ' / ' + fmtMs(f.totalMs) +
        ' · ' + f.samples + ' frames · ' + (f.intervalMs / 1000).toFixed(1) + 's';
    }
    var root = f.root;
    if (!root) { chart.innerHTML = '<div class="empty">No samples yet.</div>'; return; }
    // The vertical scrollbar eats ~17px of the client box; reserving it keeps
    // the right-most frame from sliding under the thumb.
    var chartW = Math.max(320, chart.clientWidth - 30);
    var rowH = 17, html = '', budget = 700, nodes = [];

    function nodeHtml(n, depth, left, width) {
      if (width < 0.6 || width <= 1.5 || depth > 40) return;
      var tip = n.name + ' · self ' + fmtMs(n.selfMs) + ' · total ' + fmtMs(n.totalMs) +
        (n.url ? ' · ' + shortFlameUrl(n.url) + ':' + n.line : '');
      // No half-glyphs: a box narrower than ~26px shows colour + tooltip only.
      var label = width >= 26 ? esc(n.name) : '';
      html += '<div class="fnode k-' + n.kind + '" style="left:' + left.toFixed(1) + 'px;top:' +
        (depth * rowH) + 'px;width:' + Math.max(1, width - 1).toFixed(1) + 'px" title="' +
        esc(tip) + '">' + label + '</div>';
    }

    function walk(n, depth, left, width) {
      if (budget <= 0 || width < 0.6 || depth > 40) return;
      budget--;
      nodeHtml(n, depth, left, width);
      // Idle is "waiting for work", not a hotspot; keeping it out of the list
      // is what makes the right-hand ranking about actual kernel load.
      if (n.kind !== 'idle') nodes.push(n);
      var total = n.totalMs || 1, x = left;
      (n.children || []).forEach(function (c) {
        var w = width * (c.totalMs / total);
        walk(c, depth + 1, x, w);
        x += w;
      });
    }

    // Idle usually owns 90%+ of the root width, which squeezes every frame
    // that carries load into an unreadable sliver at the right edge. Give idle
    // a full-width row of its own and stack the busy boxes *below* it, scaled
    // to their own total so the small coloured frames become readable.
    var idleNode = null, busy = [];
    (root.children || []).forEach(function (c) {
      if (c.kind === 'idle') idleNode = c; else busy.push(c);
    });

    nodeHtml(root, 0, 0, chartW);
    var depth = 1;
    if (idleNode) {
      walk(idleNode, depth, 0, chartW);
      depth++;
    }
    var busyTotal = 0;
    busy.forEach(function (n) { busyTotal += n.totalMs; });
    if (busy.length) {
      var bx = 0;
      busy.forEach(function (n) {
        // A zero-sample frame would vanish at 0px; share the row evenly.
        var w = busyTotal > 0 ? chartW * (n.totalMs / busyTotal) : chartW / busy.length;
        walk(n, depth, bx, w);
        bx += w;
      });
    }

    chart.innerHTML = html || '<div class="empty">No samples yet.</div>';
    if (hot) {
      var top = nodes.slice().sort(function (a, b) { return b.selfMs - a.selfMs; }).slice(0, 12);
      hot.innerHTML = top.map(function (n) {
        return '<div class="flame-hot-row" title="' + esc(shortFlameUrl(n.url) + ':' + n.line) + '">' +
          '<span class="flame-hot-name">' + esc(n.name) + '</span>' +
          '<span class="flame-hot-meta">self ' + fmtMs(n.selfMs) + ' · total ' + fmtMs(n.totalMs) + '</span></div>';
      }).join('') || '<div class="empty">No hotspots yet.</div>';
    }
  }

  /**
   * Memory trend: one line per holder, sampled alongside each CPU frame.
   *
   * The kernel's RSS is the whole process; "kernel heap" is the part V8 owns;
   * every running language server is a separate process, which is why it can be
   * attributed exactly. The legend is sorted by the latest value, so the first
   * entry is the answer to "which service is using the most memory".
   */
  function renderFlameMemory() {
    var box = $('flameMemChart'), legend = $('flameMemLegend'), top = $('flameMemTop');
    if (!box) return;
    var pts = FLAME.mem;
    if (!pts.length) {
      box.innerHTML = '<div class="empty">Waiting for a memory sample…</div>';
      if (top) top.textContent = 'waiting…';
      if (legend) legend.innerHTML = '';
      return;
    }
    var last = pts[pts.length - 1];
    var series = [
      { name: 'kernel rss', color: '#8b949e', get: function (p) { return p.rss; } },
      { name: 'kernel heap', color: '#61afef', get: function (p) { return p.heapUsed; } }
    ];
    var seen = {};
    pts.forEach(function (p) {
      (p.services || []).forEach(function (s) { seen[s.name] = 1; });
    });
    var palette = ['#e06c75', '#98c379', '#e5c07b', '#c678dd', '#56b6c2', '#d19a66'];
    var ci = 0;
    Object.keys(seen).forEach(function (name) {
      series.push({
        name: name,
        color: palette[ci++ % palette.length],
        get: function (p) {
          var list = p.services || [];
          for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i].bytes;
          return 0;
        }
      });
    });

    var W = Math.max(320, box.clientWidth || 320);
    var H = Math.max(64, box.clientHeight || 96);
    var padL = 46, padR = 8, padT = 6, padB = 12;
    var innerW = Math.max(10, W - padL - padR), innerH = Math.max(10, H - padT - padB);
    var maxV = 1;
    series.forEach(function (s) {
      pts.forEach(function (p) { var v = s.get(p); if (v > maxV) maxV = v; });
    });
    maxV *= 1.1;
    function xOf(i) { return padL + (pts.length === 1 ? innerW / 2 : innerW * (i / (pts.length - 1))); }
    function yOf(v) { return padT + innerH - innerH * Math.min(1, v / maxV); }

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '">';
    for (var g = 0; g <= 2; g++) {
      var gy = padT + innerH * (g / 2);
      svg += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' +
        gy.toFixed(1) + '" stroke="rgba(140,150,165,.20)" stroke-width="1"/>';
      svg += '<text x="' + (padL - 5) + '" y="' + (gy + 3).toFixed(1) +
        '" fill="#8b949e" font-size="9" text-anchor="end">' + fmtBytes(maxV * (1 - g / 2)) + '</text>';
    }
    series.forEach(function (s) {
      var d = [];
      for (var i = 0; i < pts.length; i++) d.push(xOf(i).toFixed(1) + ',' + yOf(s.get(pts[i])).toFixed(1));
      svg += '<polyline fill="none" stroke="' + s.color + '" stroke-width="1.5" points="' + d.join(' ') + '"/>';
      svg += '<circle cx="' + xOf(pts.length - 1).toFixed(1) + '" cy="' + yOf(s.get(last)).toFixed(1) +
        '" r="2.2" fill="' + s.color + '"/>';
    });
    svg += '</svg>';
    box.innerHTML = svg;

    var ranked = series.slice().sort(function (a, b) { return b.get(last) - a.get(last); });
    if (top) top.textContent = 'top: ' + ranked[0].name + ' · ' + fmtBytes(ranked[0].get(last));
    if (legend) {
      legend.innerHTML = ranked.map(function (s) {
        return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + ' ' +
          fmtBytes(s.get(last)) + '</span>';
      }).join('');
    }
  }
  function initFlameWindow() {
    var w = $('flameWin'), head = $('flameHead');
    if (!w || !head) return;
    var close = $('flameClose'); if (close) close.addEventListener('click', closeFlame);
    var pause = $('flamePause'); if (pause) pause.addEventListener('click', flamePauseToggle);
    head.addEventListener('mousedown', function (e) {
      if (e.target && e.target.closest && e.target.closest('button')) return;
      var r = w.getBoundingClientRect();
      FLAME.drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      w.style.transform = 'none';
      w.style.left = r.left + 'px';
      w.style.top = r.top + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!FLAME.drag) return;
      w.style.left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - FLAME.drag.dx)) + 'px';
      w.style.top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - FLAME.drag.dy)) + 'px';
    });
    document.addEventListener('mouseup', function () { FLAME.drag = null; });
  }
  /** Window → Minimize: real in the desktop shell, explained in a browser tab. */
  function minimizeWindow() {
    if (tauriInvoke) { tauriInvoke('plugin:window|minimize'); return; }
    toast('Minimize is only available in the desktop window');
  }

  // ---------- logs ----------
  var LOGS = [];
  var logMin = 0; // 0=TRACE
  function logLevelLabel() {
    for (var i = 0; i < LOG_LEVELS.length; i++) if (LOG_LEVELS[i].val === logMin) return LOG_LEVELS[i].label;
    return 'All';
  }
  function logsPane() {
    return '<div class="logs-toolbar"><span style="font-size:12px;color:var(--text-secondary)">Level</span>' +
      '<button class="dd" id="logLevel">' + esc(logLevelLabel()) + '<span class="ic">' + ic('chevD', 13) + '</span></button>' +
      '<span style="margin-left:auto;font-size:11.5px;color:var(--text-tertiary)" id="logCount"></span></div>' +
      '<div id="logList"></div>';
  }
  /**
   * Self-drawn dropdown: the browser's <select> looks different on every
   * platform and cannot host the PyCharm layout. Reuses the context-menu
   * surface, anchored under the button.
   */
  function showDropdown(anchorEl, items, onPick) {
    var r = anchorEl.getBoundingClientRect();
    showCtx(r.left, r.bottom + 3, items.map(function (it) {
      return {
        label: (it.checked ? '\u25cf  ' : '   ') + it.label,
        act: function () { onPick(it); },
      };
    }));
  }
  var LOG_LEVELS = [
    { val: 0, label: 'All' }, { val: 3, label: 'INFO+' }, { val: 4, label: 'WARN+' }, { val: 5, label: 'ERROR+' },
  ];
  function wireLogs() {
    var btn = $('logLevel');
    if (!btn) return;
    var sync = function () {
      for (var i = 0; i < LOG_LEVELS.length; i++) {
        if (LOG_LEVELS[i].val === logMin) btn.firstChild.textContent = LOG_LEVELS[i].label;
      }
    };
    btn.addEventListener('click', function () {
      showDropdown(btn, LOG_LEVELS.map(function (l) {
        return { label: l.label, val: l.val, checked: l.val === logMin };
      }), function (it) { logMin = it.val; sync(); renderLogs(); });
    });
    sync();
  }
  function renderLogs() {
    var list = $('logList'); if (!list) return;
    var rows = LOGS.filter(function (r) { return r.level >= logMin; }).slice(-400).reverse();
    $('logCount').textContent = rows.length + ' records';
    list.innerHTML = rows.map(function (r) {
      var t = new Date(r.ts);
      var hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0'), ss = String(t.getSeconds()).padStart(2, '0');
      return '<div class="logline"><span class="t">' + hh + ':' + mm + ':' + ss + '</span>' +
        '<span class="lv lv-' + r.levelName + '">' + r.levelName + '</span>' +
        '<span class="cp" title="' + esc(r.component) + '">' + esc(r.component) + '</span>' +
        '<span class="ms">' + esc(r.message) + '</span></div>';
    }).join('') || '<div class="empty">No log records at this level.</div>';
  }

  // ---------- problems (LSP diagnostics) ----------
  // problems is the list the panel renders; DIAGS is the same list kept so
  // the editor can paint marks from it. One setter drives both, so the squiggles
  // and the panel can never disagree.
  var problems = [];
  var pendingSaveCheck = false;
  function diagSev(d) { return d.severity === 1 ? 1 : d.severity === 2 ? 2 : 3; }
  function diagEndLine(d) { return d.endLine == null ? (d.line || 0) : d.endLine; }
  function diagsOnLine(line0) {
    var out = [];
    for (var i = 0; i < DIAGS.length; i++) {
      var d = DIAGS[i];
      if (line0 >= (d.line || 0) && line0 <= diagEndLine(d)) out.push(d);
    }
    return out;
  }
  function clearDiagMarks() {
    if (CMEDITOR) DIAG_MARKS.forEach(function (h) { h.clear(); });
    DIAG_MARKS = [];
  }
  // Wavy underline + a gutter tint per diagnostic. CodeMirror's textMarker is the
  // same mechanism the coverage view already leans on, so this adds no
  // dependency; the textarea fallback shows a coloured line number instead.
  function paintDiagMarks() {
    clearDiagMarks();
    if (!CMEDITOR || !DIAGS.length) return;
    var cm = CMEDITOR.cm;
    DIAGS.forEach(function (d) {
      try {
        var line = d.line || 0;
        var from = { line: line, ch: d.character || 0 };
        var to = { line: diagEndLine(d), ch: d.endCharacter == null ? from.ch : d.endCharacter };
        if (to.line < from.line || (to.line === from.line && to.ch <= from.ch)) to = { line: from.line, ch: from.ch + 1 };
        var cls = 'diag-sq diag-s' + diagSev(d), gcls = 'diag-g' + diagSev(d);
        DIAG_MARKS.push(cm.markText(from, to, { className: cls }));
        cm.addLineClass(line, 'gutter', gcls);
        DIAG_MARKS.push({ clear: function () { cm.removeLineClass(line, 'gutter', gcls); } });
      } catch (e) { /* the document shrank under a stale diagnostic */ }
    });
  }
  function setDiags(items) {
    DIAGS = items || [];
    renderProblems(DIAGS);
    paintDiagMarks();
    // The textarea fallback paints its tint from the gutter, so it needs a
    // re-render; CodeMirror already carries its marks from paintDiagMarks.
    renderEditor();
    // L3: a save is a checkpoint. If the file we just wrote still has errors,
    // say so once instead of letting Run be the first to find out.
    if (pendingSaveCheck) {
      pendingSaveCheck = false;
      var errs = 0;
      for (var i = 0; i < DIAGS.length; i++) if (DIAGS[i].severity === 1) errs++;
      if (errs) {
        balloon({
          type: 'warning',
          title: 'Saved ' + (currentFile || 'file'),
          message: errs + (errs === 1 ? ' syntax error' : ' syntax errors') + ' - see the Problems panel.',
          actions: [{ label: 'Show', onClick: function () { toggleWindow('problems'); } }]
        });
      }
    }
  }
  function clearDiags() { DIAGS = []; renderProblems([]); paintDiagMarks(); renderEditor(); }
  function renderProblems(items) {
    problems = items || [];
    var out = $('probOut');
    $('stProblems').textContent = problems.length + (problems.length === 1 ? ' problem' : ' problems');
    if (!out) return;
    if (!problems.length) { out.innerHTML = '<div class="empty">No problems detected.</div>'; return; }
    out.innerHTML = problems.map(function (p, i) {
      var sev = p.severity === 1 ? 'error' : p.severity === 2 ? 'warn' : 'info';
      return '<div class="prob ' + sev + '" data-pi="' + i + '"><span class="ic">' + ic(sev === 'error' ? 'close' : 'warn', 14) + '</span>' +
        '<span class="loc">' + (p.line + 1) + ':' + (p.character + 1) + '</span>' +
        '<span class="msg">' + esc(p.message) + '</span></div>';
    }).join('');
    // A Problems row is a navigation shortcut, as in PyCharm: click jumps there.
    Array.prototype.forEach.call(out.querySelectorAll('.prob'), function (row) {
      row.addEventListener('click', function () {
        var p = problems[+row.getAttribute('data-pi')];
        if (p) gotoLine(p.line || 0, p.character || 0);
      });
    });
  }
  /** Put the caret on a diagnostic's position and bring it into view. */
  function gotoLine(line0, ch) {
    if (CMEDITOR) {
      var cm = CMEDITOR.cm;
      cm.setCursor({ line: line0, ch: ch || 0 });
      cm.scrollIntoView({ line: line0, ch: ch || 0 }, 80);
      cm.focus();
      return;
    }
    var lines = ta.value.split(NLc), idx = 0;
    for (var i = 0; i < line0 && i < lines.length; i++) idx += lines[i].length + 1;
    ta.selectionStart = ta.selectionEnd = idx + (ch || 0);
    ta.scrollTop = Math.max(0, (line0 - 4) * 20);
    syncScroll();
    updateCaret();
    ta.focus();
  }