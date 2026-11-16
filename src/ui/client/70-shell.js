  // ---------- native file pickers (Tauri only) ----------
  // These are the one allowed piece of OS-native UI: Open / Open Folder / Save As
  // are real system dialogs. The page bundles no @tauri-apps/api, so the calls go
  // straight to the dialog plugin through __TAURI_INTERNALS__ — the same trap the
  // bridge and the title-bar buttons document: window.__TAURI__ does not exist
  // here, and asking for it made every native picker a no-op in the desktop app.
  // In the web preview there is no OS picker, so we fall back to a balloon and the
  // Project tool window still opens files.
  function tauriInternals() {
    var T = window.__TAURI_INTERNALS__;
    return (T && typeof T.invoke === 'function') ? T : null;
  }
  function nativeOpen(opts) {
    var T = tauriInternals();
    return T ? T.invoke('plugin:dialog|open', { options: opts }) : null;
  }
  function nativeSave(opts) {
    var T = tauriInternals();
    return T ? T.invoke('plugin:dialog|save', { options: opts }) : null;
  }
  function pickerFailed(title, err) {
    balloon({ type: 'error', title: title, message: 'The system dialog could not open: ' + ((err && err.message) || err || 'unknown error') });
  }
  function openNativeFile() {
    var p = nativeOpen({
      multiple: false, directory: false,
      filters: [{ name: 'Source', extensions: ['py', 'js', 'ts', 'go', 'md', 'json', 'yaml', 'html', 'css'] }],
      title: 'Open File'
    });
    if (!p) { balloon({ type: 'info', title: 'Open', message: 'The native file picker is available in the desktop app. In the web preview, open files from the Project tool window.' }); return; }
    p.then(
      function (r) { var path = Array.isArray(r) ? r[0] : r; if (path) BRIDGE.send({ kind: 'fsRead', path: path }); },
      function (err) { pickerFailed('Open', err); }
    );
  }
  function openNativeFolder() {
    var p = nativeOpen({ directory: true, multiple: false, title: 'Open Folder' });
    if (!p) { balloon({ type: 'info', title: 'Open Folder', message: 'The native folder picker is available in the desktop app.' }); return; }
    p.then(
      function (r) { var path = Array.isArray(r) ? r[0] : r; if (path) BRIDGE.send({ kind: 'openFolder', path: path }); },
      function (err) { pickerFailed('Open Folder', err); }
    );
  }
  function saveAsNative() {
    var p = nativeSave({ defaultPath: currentFile || 'untitled.py', filters: [{ name: 'Source', extensions: ['py', 'js', 'ts', 'go', 'md'] }], title: 'Save As' });
    if (!p) { balloon({ type: 'info', title: 'Save As', message: 'The native save dialog is available in the desktop app.' }); return; }
    p.then(
      function (path) { if (path) BRIDGE.send({ kind: 'fsWrite', path: path, content: ta.value }); },
      function (err) { pickerFailed('Save As', err); }
    );
  }

  // ---------- language mode wiring ----------
  $('stLang').addEventListener('click', openLangPicker);
  // Status-bar cells are navigation shortcuts in PyCharm, not decoration.
  { var stP = $('stPerf'); if (stP) stP.addEventListener('click', function () { toggleWindow('perf'); }); }
  { var stG = $('stGit'); if (stG) stG.addEventListener('click', function () { toggleWindow('vcs'); }); }
  { var stB = $('stProblems'); if (stB) stB.addEventListener('click', function () { toggleWindow('problems'); }); }
  $('langClose').addEventListener('click', closeModals);
  $('langInput').addEventListener('input', function () { renderLangs(this.value); });
  $('langInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var first = $('langBody').querySelector('.mres'); if (first) first.click(); }
    if (e.key === 'Escape') { closeModals(); this.blur(); }
  });

  // ---------- search everywhere ----------
  var searchTab = 'all';
  var SYMBOLS = [
    { name: 'fib(n)', path: 'main.py:5' },
    { name: 'main()', path: 'main.py:13' },
    { name: 'Point', path: 'utils.py:5' },
    { name: 'Point.norm()', path: 'utils.py:9' }
  ];
  var ACTIONS = [
    { name: "Run 'main'", sc: 'Shift+F10', act: function () { runCode('run'); } },
    { name: 'Run tests', sc: 'Ctrl+Shift+F10', act: function () { runCode('test'); } },
    { name: "Debug 'main'", sc: 'Shift+F9', act: debugCurrent },
    { name: 'Run with Coverage', act: runCoverage },
    { name: 'Stop', act: stopRun },
    { name: 'Reformat Code', act: reformatCode },
    { name: 'Optimize Imports', act: optimizeImports },
    { name: 'Kernel Flame Graph', sc: 'Ctrl+Alt+F', act: openFlame },
    { name: 'Toggle Theme', act: function () { setTheme(document.documentElement.getAttribute('data-theme') === 'darcula' ? 'light' : 'darcula'); } },
    { name: 'Change Language Mode', act: openLangPicker },
    { name: 'Open Extensions', act: openExt }
  ];
  function openSearch() { openModal('searchModal'); renderSearch(''); setTimeout(function () { $('searchInput').focus(); }, 0); }
  /** Run one kernel command (the list arrives in the hello frame) and show it. */
  function runKernelCommand(id) {
    closeModals();
    toast('running ' + id + ' …');
    BRIDGE.send({ kind: 'command', id: id });
  }
  function searchResults(q) {
    q = q.toLowerCase();
    var files = Object.keys(FILES).filter(function (f) { return f.toLowerCase().indexOf(q) >= 0; }).map(function (f) { return { group: 'Files', name: f, path: 'src', icon: 'file', act: function () { openFile(f); } }; });
    var syms = SYMBOLS.filter(function (s) { return s.name.toLowerCase().indexOf(q) >= 0; }).map(function (s) { return { group: 'Symbols', name: s.name, path: s.path, icon: 'structure', act: function () { openFile(s.path.split(':')[0]); } }; });
    var acts = KCOMMANDS.filter(function (c) { return c.id.toLowerCase().indexOf(q) >= 0; }).slice(0, 6).map(function (c) { return { group: 'Actions', name: c.title || c.id, path: c.id, icon: 'settings', act: function () { runKernelCommand(c.id); } }; });
    acts = acts.concat(ACTIONS.filter(function (a) { return a.name.toLowerCase().indexOf(q) >= 0; }).map(function (a) { return { group: 'Actions', name: a.name, path: '', icon: 'run', act: a.act }; }));
    var all = files.concat(syms, acts);
    if (searchTab !== 'all') all = all.filter(function (r) { return r.group.toLowerCase() === searchTab; });
    return all;
  }
  function renderSearch(q) {
    var res = searchResults(q), body = $('searchBody');
    if (!res.length) { body.innerHTML = '<div class="empty">No matches.</div>'; return; }
    var html = '', group = '';
    res.forEach(function (r, i) {
      if (r.group !== group) { group = r.group; html += '<div class="mgrp">' + group + '</div>'; }
      html += '<div class="mres' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '">' +
        '<span class="ic">' + ic(r.icon, 16) + '</span><span class="nm">' + esc(r.name) + '</span>' +
        (r.path ? '<span class="path">' + esc(r.path) + '</span>' : '') + '</div>';
    });
    body.innerHTML = html;
    Array.prototype.forEach.call(body.querySelectorAll('.mres'), function (el) {
      el.addEventListener('click', function () { var r = res[+el.getAttribute('data-i')]; closeModals(); r.act(); });
    });
  }
  $('searchInput').addEventListener('input', function () { renderSearch(this.value); });
  $('searchInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var first = $('searchBody').querySelector('.mres'); if (first) first.click(); }
    if (e.key === 'Escape') closeModals();
  });
  Array.prototype.forEach.call($('searchChips').querySelectorAll('.chip'), function (c) {
    c.addEventListener('click', function () {
      $('searchChips').querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); });
      c.classList.add('on'); searchTab = c.getAttribute('data-tab'); renderSearch($('searchInput').value);
    });
  });
  $('searchBtn').addEventListener('click', openSearch);
  $('searchClose').addEventListener('click', closeModals);
  $('extClose').addEventListener('click', closeModals);
  $('aboutClose').addEventListener('click', closeModals);

  // ---------- toolbar wiring ----------
  $('runBtn').addEventListener('click', function () { runCode('run'); });
  var tb0 = $('testBtn');
  if (tb0) tb0.addEventListener('click', function () { runCode('test'); });
  $('debugBtn').addEventListener('click', debugCurrent);
  $('covBtn').addEventListener('click', runCoverage);
  $('stopBtn').addEventListener('click', stopRun);
  $('cfgBtn').addEventListener('click', function (e) { e.stopPropagation(); openRunConfig(); });
  $('projWidget').addEventListener('click', function () { toggleWindow('project'); });
  $('newBtn').addEventListener('click', function () { var r = $('newBtn').getBoundingClientRect(); showNewPopup(r.left, r.bottom + 3, ''); });
  $('vcsWidget').addEventListener('click', function () { toggleWindow('vcs'); });
  $('themeBtn').addEventListener('click', function () { setTheme(document.documentElement.getAttribute('data-theme') === 'darcula' ? 'light' : 'darcula'); });
  $('settingsBtn').addEventListener('click', openSettings);
  $('panelCloseBtn').addEventListener('click', function () { $('leftPanel').classList.add('hidden'); renderStrip(); saveLayout(); });
  $('collapseBtn').addEventListener('click', function () { if (activeLeft === 'structure') { folded = {}; renderEditor(); } toast('Collapsed'); });
  $('pinBtn').addEventListener('click', function () { pinned = !pinned; this.style.color = pinned ? '' : 'var(--text-tertiary)'; toast(pinned ? 'Pinned' : 'Unpinned'); });
  $('dockHide').addEventListener('click', function () { $('dock').classList.add('hidden'); saveLayout(); });
  // The two header buttons that used to be decoration: both surface the same
  // tool-window menu the right-click handler builds.
  function panelViewMenu() {
    return panelMenu() || [
      {
        label: 'Collapse All', act: function () {
          folded = {};
          if (activeLeft === 'structure') renderEditor();
          else if (activeLeft === 'project') { EXPANDED = { '': true }; renderTree(); }
        }
      },
      { label: 'Hide', act: function () { $('leftPanel').classList.add('hidden'); renderStrip(); saveLayout(); } },
    ];
  }
  ['panelViewBtn', 'panelMoreBtn'].forEach(function (id) {
    var b = $(id);
    if (!b) return;
    b.addEventListener('click', function () {
      var r = b.getBoundingClientRect();
      showCtx(r.left, r.bottom + 3, panelViewMenu());
    });
  });

  // ---------- Tauri window controls (the desktop app turns OS chrome off) ----------
  // Which global to talk to matters, and the transport bridge above already
  // documented the trap: Tauri v2 injects window.__TAURI_INTERNALS__ (invoke +
  // transformCallback), while the friendlier window.__TAURI__ only exists when
  // the @tauri-apps/api bundle is loaded — which this page deliberately does
  // not do. Calling window.__TAURI__.window.getCurrentWindow() therefore either
  // throws (global absent) or returns undefined, and every title-bar button
  // silently does nothing: the handler was never attached. So the commands go
  // through the internals, with the friendly API kept as a fallback.
  var tauriInvoke = null;
  if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
    tauriInvoke = function (cmd) { window.__TAURI_INTERNALS__.invoke(cmd); };
  } else if (window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow) {
    var win0 = window.__TAURI__.window.getCurrentWindow();
    tauriInvoke = function (cmd) {
      var name = cmd.split('|')[1];
      if (typeof win0[name] === 'function') win0[name]();
    };
  }
  if (tauriInvoke) {
    document.documentElement.setAttribute('data-tauri', '1');
    var tbMin = $('tbMin'), tbMax = $('tbMax'), tbClose = $('tbClose');
    if (tbMin) tbMin.addEventListener('click', function () { tauriInvoke('plugin:window|minimize'); });
    if (tbMax) tbMax.addEventListener('click', function () { tauriInvoke('plugin:window|toggle_maximize'); });
    if (tbClose) tbClose.addEventListener('click', function () { tauriInvoke('plugin:window|close'); });
    // Dragging: -webkit-app-region:drag is a Chromium/Edge-app property that
    // WebView2 ignores, so the shell asks the window plugin to start a drag on
    // mousedown instead. Buttons are excluded — a drag started on them would
    // swallow the click.
    var tbBar = document.querySelector('.titlebar');
    if (tbBar) {
      tbBar.addEventListener('mousedown', function (e) {
        if (!e || e.button !== 0) return;
        var t = e.target;
        while (t && t !== tbBar) {
          if (t.tagName === 'BUTTON' || t.tagName === 'INPUT' || t.tagName === 'A') return;
          t = t.parentNode;
        }
        tauriInvoke('plugin:window|start_dragging');
      });
    }
  }



  // ---------- find & replace (Ctrl+F / Ctrl+H) ----------
  // PyCharm's bar, not the browser's: Ctrl+F must not open Chrome's find, and a
  // match has to be *selected in the document* so Replace acts on what the user
  // sees. Case sensitivity follows PyCharm's implicit rule — an all-lowercase
  // query is case-insensitive, any capital makes it exact.
  var FIND = { bar: null, input: null, rep: null, count: null, hits: [], idx: -1, replace: false };
  function findCaseSensitive(q) { return q !== q.toLowerCase(); }
  function escapeRe(s) { return String(s).replace(/[.*+?^$()|[]{}\-]/g, '\$&'); }
  function findMatches(q) {
    if (!q) return [];
    var text = ta.value;
    var sensitive = findCaseSensitive(q);
    var hay = sensitive ? text : text.toLowerCase();
    var needle = sensitive ? q : q.toLowerCase();
    var out = [], i = 0;
    while (i <= hay.length) {
      var k = hay.indexOf(needle, i);
      if (k === -1) break;
      out.push(k);
      i = k + needle.length;
    }
    return out;
  }
  function ensureFindBar() {
    if (FIND.bar) return FIND.bar;
    var bar = document.createElement('div');
    bar.className = 'findbar';
    bar.innerHTML =
      '<input class="fb-in" type="text" placeholder="Find" spellcheck="false" />' +
      '<span class="fb-count"></span>' +
      '<button class="fb-btn" data-a="prev" title="Previous (Shift+Enter)">&#8593;</button>' +
      '<button class="fb-btn" data-a="next" title="Next (Enter)">&#8595;</button>' +
      '<input class="fb-rep" type="text" placeholder="Replace" spellcheck="false" />' +
      '<button class="fb-btn" data-a="rep">Replace</button>' +
      '<button class="fb-btn" data-a="all">All</button>' +
      '<button class="fb-btn" data-a="close" title="Close (Esc)">&#215;</button>';
    document.body.appendChild(bar);
    FIND.bar = bar;
    FIND.input = bar.querySelector('.fb-in');
    FIND.rep = bar.querySelector('.fb-rep');
    FIND.count = bar.querySelector('.fb-count');
    bar.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-a]') : null;
      if (!b) return;
      var a = b.getAttribute('data-a');
      if (a === 'next') findStep(1);
      else if (a === 'prev') findStep(-1);
      else if (a === 'rep') replaceCurrent();
      else if (a === 'all') replaceAll();
      else if (a === 'close') closeFindBar();
    });
    FIND.input.addEventListener('input', function () {
      FIND.idx = -1;
      refreshHits();
      paintCount();
      if (FIND.input.value) findStep(1);
    });
    [FIND.input, FIND.rep].forEach(function (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) findStep(-1);
          else if (FIND.replace) replaceCurrent();
          else findStep(1);
        } else if (e.key === 'Escape') { e.preventDefault(); closeFindBar(); }
      });
    });
    return bar;
  }
  function refreshHits() {
    FIND.hits = findMatches(FIND.input ? FIND.input.value : '');
    if (FIND.idx >= FIND.hits.length) FIND.idx = FIND.hits.length - 1;
    return FIND.hits;
  }
  function paintCount() {
    if (!FIND.count) return;
    if (!FIND.input.value) { FIND.count.textContent = ''; return; }
    FIND.count.textContent = FIND.hits.length ? ((FIND.idx + 1) + '/' + FIND.hits.length) : 'no results';
  }
  function selectHit(i) {
    var hits = FIND.hits;
    if (!hits.length) { FIND.idx = -1; paintCount(); return; }
    if (i < 0) i = hits.length - 1;
    if (i >= hits.length) i = 0;
    FIND.idx = i;
    var q = FIND.input.value;
    ta.focus();
    ta.selectionStart = hits[i];
    ta.selectionEnd = hits[i] + q.length;
    updateCaret();
    paintCount();
  }
  function findStep(dir) {
    var hits = refreshHits();
    if (!hits.length) { FIND.idx = -1; paintCount(); return; }
    if (FIND.idx < 0) {
      var from = ta.selectionStart, pick = -1;
      for (var i = 0; i < hits.length; i++) {
        if (dir > 0 ? hits[i] >= from : hits[i] < from) { pick = i; break; }
      }
      selectHit(pick < 0 ? (dir > 0 ? 0 : hits.length - 1) : pick);
      return;
    }
    selectHit(FIND.idx + dir);
  }
  function replaceCurrent() {
    var q = FIND.input.value, rep = FIND.rep.value;
    if (!q) return;
    var s = ta.selectionStart, e = ta.selectionEnd;
    var sel = ta.value.slice(s, e);
    var same = findCaseSensitive(q) ? sel === q : sel.toLowerCase() === q.toLowerCase();
    if (!same) { FIND.idx = -1; findStep(1); return; }
    replaceRange(s, e, rep);
    renderEditor(); updateCaret();
    FIND.idx = -1;
    refreshHits(); paintCount();
    findStep(1);
  }
  function replaceAll() {
    var q = FIND.input.value, rep = FIND.rep.value;
    if (!q) return;
    var text = ta.value;
    var sensitive = findCaseSensitive(q);
    var hay = sensitive ? text : text.toLowerCase();
    var needle = sensitive ? q : q.toLowerCase();
    var out = '', i = 0, n = 0;
    while (true) {
      var k = hay.indexOf(needle, i);
      if (k === -1) break;
      out += text.slice(i, k) + rep;
      i = k + needle.length;
      n++;
    }
    if (!n) { toast('No matches'); return; }
    out += text.slice(i);
    ta.value = out;
    renderEditor(); updateCaret();
    FIND.idx = -1;
    refreshHits(); paintCount();
    toast('Replaced ' + n + ' occurrence' + (n === 1 ? '' : 's'));
  }
  function openFindBar(replace) {
    var bar = ensureFindBar();
    FIND.replace = !!replace;
    bar.classList.add('open');
    if (replace) bar.classList.add('replace'); else bar.classList.remove('replace');
    var sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel && sel.indexOf('\n') === -1 && sel.length < 120) FIND.input.value = sel;
    FIND.idx = -1;
    refreshHits(); paintCount();
    FIND.input.focus();
    if (FIND.input.select) FIND.input.select();
  }
  function closeFindBar() {
    if (!FIND.bar) return;
    FIND.bar.classList.remove('open');
    FIND.idx = -1;
    ta.focus();
  }

  // ---------- line editing (PyCharm keymap) ----------
  function lineBounds() {
    var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    var start = v.lastIndexOf('\n', s - 1) + 1;
    var end = v.indexOf('\n', e);
    if (end === -1) end = v.length;
    return { start: start, end: end };
  }
  function duplicateLine() {
    if (!CAN_EDIT()) { toast('Read-only buffer'); return; }
    var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    var b = lineBounds();
    var block = v.slice(b.start, b.end);
    ta.value = v.slice(0, b.end) + '\n' + block + v.slice(b.end);
    ta.selectionStart = b.end + 1 + (s - b.start);
    ta.selectionEnd = b.end + 1 + (e - b.start);
    renderEditor(); updateCaret();
  }
  function deleteLine() {
    if (!CAN_EDIT()) { toast('Read-only buffer'); return; }
    var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    var b = lineBounds();
    if (b.end >= v.length) {
      // Last line: drop the separator before it, not the line's own newline.
      var cut = b.start > 0 ? b.start - 1 : 0;
      ta.value = v.slice(0, cut) + v.slice(b.end);
      ta.selectionStart = ta.selectionEnd = Math.min(cut, ta.value.length);
    } else {
      ta.value = v.slice(0, b.start) + v.slice(b.end + 1);
      ta.selectionStart = ta.selectionEnd = Math.min(b.start, ta.value.length);
    }
    renderEditor(); updateCaret();
  }
  var COMMENT_PREFIX = { python: '#', javascript: '//', go: '//', cpp: '//', c: '//', rust: '//', java: '//', kotlin: '//' };
  function toggleComment() {
    if (!CAN_EDIT()) { toast('Read-only buffer'); return; }
    var prefix = COMMENT_PREFIX[currentLang];
    if (!prefix) { toast('No line comment for ' + currentLang); return; }
    var v = ta.value, b = lineBounds();
    var block = v.slice(b.start, b.end);
    var lines = block.split('\n');
    var allCommented = lines.every(function (l) {
      return !l.trim() || l.replace(/^\s+/, '').indexOf(prefix) === 0;
    });
    var out = lines.map(function (l) {
      if (!l.trim()) return l;
      if (allCommented) return l.replace(new RegExp('^(\\s*)' + escapeRe(prefix) + ' ?'), '$1');
      return l.replace(/^(\s*)/, '$1' + prefix + ' ');
    }).join('\n');
    ta.value = v.slice(0, b.start) + out + v.slice(b.end);
    ta.selectionStart = b.start;
    ta.selectionEnd = b.start + out.length;
    renderEditor(); updateCaret();
  }
  function openGotoLine() {
    showModal({
      title: 'Go to Line', icon: 'file',
      fields: [{ name: 'line', label: 'Line', value: '1', validator: function (v) { return /^\d+$/.test(v) ? null : 'Enter a line number'; } }],
      buttons: [
        { label: 'Cancel' },
        { label: 'Go', primary: true, onClick: function (v) { gotoLine(Math.max(0, Number(v.line) - 1), 0); } }
      ]
    });
  }

  // ---------- code editing utilities ----------
  // These operate on the caret line (or the selected line range) and route
  // through ta.value + renderEditor, so the CodeMirror adapter and the
  // textarea fallback behave identically.
  function replaceLines(lines) {
    var b = lineBounds();
    var out = lines.join('\n');
    var v = ta.value;
    ta.value = v.slice(0, b.start) + out + v.slice(b.end);
    ta.selectionStart = b.start;
    ta.selectionEnd = b.start + out.length;
    renderEditor(); updateCaret();
  }
  function toggleCase(mode) {
    if (!CAN_EDIT()) { toast('Read-only buffer'); return; }
    var s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e) { toast('Select text to change its case'); return; }
    var sel = ta.value.slice(s, e), out;
    if (mode === 'upper') out = sel.toUpperCase();
    else if (mode === 'lower') out = sel.toLowerCase();
    else if (mode === 'toggle') out = sel.replace(/[A-Z]/g, function (c) { return c.toLowerCase(); }).replace(/[a-z]/g, function (c) { return c.toUpperCase(); });
    else out = sel.replace(/\w\S*/g, function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); });
    ta.value = ta.value.slice(0, s) + out + ta.value.slice(e);
    ta.selectionStart = s; ta.selectionEnd = s + out.length;
    renderEditor(); updateCaret();
  }
  function sortLines(mode) {
    if (!CAN_EDIT()) { toast('Read-only buffer'); return; }
    var b = lineBounds();
    var lines = ta.value.slice(b.start, b.end).split('\n');
    if (mode === 'unique') {
      var seen = {}, kept = [];
      lines.forEach(function (l) { if (!seen[l]) { seen[l] = 1; kept.push(l); } });
      lines = kept;
    } else {
      lines.sort(function (a, c) { return a < c ? -1 : a > c ? 1 : 0; });
      if (mode === 'desc') lines.reverse();
    }
    replaceLines(lines);
    toast('Sorted ' + lines.length + ' line' + (lines.length === 1 ? '' : 's'));
  }
  function joinLines() {
    if (!CAN_EDIT()) { toast('Read-only buffer'); return; }
    var b = lineBounds();
    var lines = ta.value.slice(b.start, b.end).split('\n');
    if (lines.length < 2) { toast('Select two or more lines to join'); return; }
    replaceLines([lines.map(function (l) { return l.replace(/\s+$/, ''); }).join(' ')]);
    toast('Joined ' + lines.length + ' lines');
  }
  function moveLine(dir) {
    if (!CAN_EDIT()) { toast('Read-only buffer'); return; }
    var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    var all = v.split('\n');
    var b = lineBounds();
    var blockLen = v.slice(b.start, b.end).split('\n').length;
    var first = v.slice(0, b.start).split('\n').length - 1;
    var last = first + blockLen - 1;
    if (dir < 0) {
      if (first === 0) return;
      var above = all.splice(first - 1, 1)[0];
      all.splice(first - 1 + blockLen, 0, above);
      var d = above.length + 1;
      s -= d; e -= d;
    } else {
      if (last >= all.length - 1) return;
      var below = all.splice(last + 1, 1)[0];
      all.splice(first, 0, below);
      var d2 = below.length + 1;
      s += d2; e += d2;
    }
    ta.value = all.join('\n');
    ta.selectionStart = Math.max(0, s);
    ta.selectionEnd = Math.max(0, e);
    renderEditor(); updateCaret();
  }
  function indentBlock(dir) {
    if (!CAN_EDIT()) { toast('Read-only buffer'); return; }
    var b = lineBounds();
    var lines = ta.value.slice(b.start, b.end).split('\n');
    var unit = '    ';
    if (dir > 0) lines = lines.map(function (l) { return l ? unit + l : l; });
    else lines = lines.map(function (l) { return l.indexOf(unit) === 0 ? l.slice(unit.length) : l.replace(/^ {1,4}/, '').replace(/^\t/, ''); });
    replaceLines(lines);
  }
  function toggleBreakpointAtCaret() {
    if (!currentFile) { toast('Open a file first'); return; }
    var line0 = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
    if (CMEDITOR) { toggleCmBreakpoint(line0); }
    else {
      var mk = bpsFor(currentFile);
      if (mk[line0 + 1]) delete mk[line0 + 1]; else mk[line0 + 1] = true;
      saveBreakpoints(); renderEditor();
    }
    toast((bpsFor(currentFile)[line0 + 1] ? 'Breakpoint added' : 'Breakpoint removed') + ' at line ' + (line0 + 1));
  }

  // ---------- project interpreter (migration threshold 1) ----------
  /** Project SDK name last seen in .idea/misc.xml; used to break ties. */
  var LAST_SDK = '';
  function openInterpreter() {
    var lang = currentLang || 'python';
    toast('Scanning ' + lang + ' interpreters…');
    BRIDGE.send({ kind: 'interpreters', language: lang, sdkName: LAST_SDK });
  }
  function showInterpreters(m) {
    var list = m.candidates || [];
    if (!list.length) {
      toast('No ' + m.language + ' interpreter found');
      return;
    }
    var radios = list.map(function (c) {
      return {
        name: 'bin', value: c.path, def: c.path === m.active,
        label: c.label + (c.sdkMatch ? '  · SDK' : '') + (c.path === m.active ? '  · active' : '')
      };
    });
    // Only one radio in the group may start checked — the HTML parser keeps the
    // *last* checked one, so "Auto" must stay unchecked while an interpreter is
    // active, or the dialog would silently apply the unpinned state.
    radios.push({ name: 'bin', value: '', label: 'Auto (discovered, no pin)', def: !m.active && !m.pinned });
    showModal({
      title: 'Project interpreter — ' + m.language, icon: 'settings',
      message: m.root,
      sub: list.length + ' candidate' + (list.length === 1 ? '' : 's'),
      radios: radios,
      buttons: [
        { label: 'Cancel' },
        { label: 'Apply', primary: true, onClick: function (v) {
          BRIDGE.send({ kind: 'setInterpreter', language: m.language, path: v.bin || undefined });
        } }
      ]
    });
  }

  // ---------- Stage 11 · attribution ----------
  /** Ask the engine to attribute a metric's shift (CUSUM + Welch t + Cohen's d). */
  function openAttribution() {
    var names = lastMetrics && lastMetrics.metrics ? Object.keys(lastMetrics.metrics) : [];
    showModal({
      title: 'Explain a performance change', icon: 'perf',
      message: 'Compares the first half of the hot window with the second half.',
      fields: [{
        name: 'metric', label: 'Metric', value: names[0] || 'command.duration',
        validator: function (v) { return v ? null : 'Metric name required'; }
      }],
      buttons: [
        { label: 'Cancel' },
        { label: 'Analyse', primary: true, onClick: function (v) { BRIDGE.send({ kind: 'attribute', metric: v.metric }); } }
      ]
    });
  }
  function paintAttribution(m) {
    var parts = ['verdict: ' + String(m.verdict || 'unknown')];
    if (m.relativeChange != null) parts.push('change: ' + (m.relativeChange * 100).toFixed(1) + '%');
    if (m.pValue != null) parts.push('p: ' + String(m.pValue));
    if (m.effectSize != null) parts.push("Cohen's d: " + String(m.effectSize) + (m.magnitude ? ' (' + m.magnitude + ')' : ''));
    if (m.samples) parts.push('samples: ' + m.samples.before + ' / ' + m.samples.after);
    if (m.changePoint) parts.push('change point: sample ' + m.changePoint.index + ' (' + m.changePoint.direction + ')');
    showModal({
      title: 'Attribution — ' + String(m.metric || ''), icon: 'perf',
      message: String(m.summary || ''),
      detail: parts.join(' · '),
      buttons: [{ label: 'Close', primary: true }]
    });
  }

  // ---------- .idea import (migration threshold 2) ----------
  function importIdeaConfigs() {
    BRIDGE.send({ kind: 'importIdea' });
  }
  function applyIdeaImport(m) {
    if (m.missing) { toast('No .idea folder in ' + m.root); return; }
    LAST_SDK = m.projectSdk || LAST_SDK;
    var cfgs = m.configurations || [];
    if (!cfgs.length) {
      toast('No run configurations in .idea' + (m.warnings && m.warnings.length ? ' (' + m.warnings.length + ' warning)' : ''));
      return;
    }
    var taken = {};
    RUN_CONFIGS.forEach(function (c) { taken[c.name] = true; });
    var added = 0;
    cfgs.forEach(function (c) {
      if (taken[c.name]) return;
      taken[c.name] = true;
      // args/cwd are the names the run/debug pipeline actually reads
      // (normCfg). Storing PyCharm's params/workdir here would import the
      // configuration and then silently drop its arguments.
      RUN_CONFIGS.push({
        name: c.name,
        path: c.script,
        args: c.parameters || '',
        cwd: c.workdir && c.workdir !== '.' ? c.workdir : '',
        env: c.env || {}
      });
      added++;
    });
    savePrefs({ runConfigs: RUN_CONFIGS });
    renderCfgLabel();
    toast('Imported ' + added + ' run configuration' + (added === 1 ? '' : 's') +
      (m.projectSdk ? ' · SDK ' + m.projectSdk : ''));
  }

  // ---------- keyboard shortcuts ----------
  document.addEventListener('keydown', function (e) {
    // Order matters: the Alt/Ctrl combos must be tested before the bare Ctrl+S,
    // otherwise Ctrl+Alt+S is swallowed by the save shortcut.
    if (e.ctrlKey && e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); openSettings(); return; }
    if (e.ctrlKey && e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFlame(); return; }
    if (e.ctrlKey && e.altKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); reformatCode(); return; }
    if (e.ctrlKey && e.altKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); optimizeImports(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault(); mdToggle(); return;
    }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'F4' && currentFile && !(e.target && e.target.closest && e.target.closest('.dlg-scrim, .modal.open'))) {
      e.preventDefault(); closeTab(currentFile); return;
    }
    // PyCharm's editor keys. Ctrl+F must win over the browser's find bar, which
    // is why every one of these prevents the default.
    if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFindBar(false); return; }
    if (e.ctrlKey && !e.altKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); openFindBar(true); return; }
    if (e.ctrlKey && !e.altKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateLine(); return; }
    if (e.ctrlKey && !e.altKey && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); deleteLine(); return; }
    if (e.ctrlKey && !e.altKey && e.key === '/') { e.preventDefault(); toggleComment(); return; }
    if (e.ctrlKey && !e.altKey && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); openGotoLine(); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); docCmd('redo'); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); openFindInFiles(); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveAsNative(); return; }
    if (e.ctrlKey && (e.key === 's' || e.key === 'S') && !e.shiftKey && !e.altKey) { e.preventDefault(); saveFile(); return; }
    if (e.ctrlKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); openNativeFile(); return; }
    if (e.ctrlKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); openPalette(); return; }
    if (e.shiftKey && e.key === 'F9') { e.preventDefault(); debugCurrent(); return; }
    if (e.key === 'F10' && e.shiftKey) {
      e.preventDefault();
      // Ctrl+Shift+F10 tests; Shift+F10 runs. Same key, one modifier apart, as
      // PyCharm's "run context" pair.
      runCode(e.ctrlKey || e.metaKey ? 'test' : 'run');
      return;
    }
    // Developer shortcuts added with the expanded menus.
    if (e.ctrlKey && e.altKey && e.shiftKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); openGoToSymbol(); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); openGoToFile(); return; }
    if (e.ctrlKey && e.key === 'F8') { e.preventDefault(); toggleBreakpointAtCaret(); return; }
    if (e.key === 'F11') { e.preventDefault(); toggleFullScreen(); return; }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomUi(1); return; }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === '-') { e.preventDefault(); zoomUi(-1); return; }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === '0') { e.preventDefault(); zoomUi(0); return; }
    if (e.key === 'Escape') { if (FLAME.open) closeFlame(); hideCtx(); return; }
    if (e.key === 'Shift' && !e.repeat) {
      var now = Date.now();
      if (now - lastShift < 400) { openSearch(); lastShift = 0; } else lastShift = now;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    var map = { '1': 'project', '9': 'vcs', 'k': 'commit', '7': 'structure', 'a': 'ai', 'm': 'mcp', '4': 'run', '8': 'perf', '0': 'logs' };
    var k = e.key.toLowerCase();
    if (map[k]) { e.preventDefault(); toggleWindow(map[k]); }
    if (e.key === 'F12') { e.preventDefault(); toggleWindow('terminal'); }
  });
  var lastShift = 0;

  // ---------- boot ----------
  // Restore persisted theme / layout / tabs before the first paint.
  if (PREFS.theme) document.documentElement.setAttribute('data-theme', PREFS.theme);
  if (PREFS.left) activeLeft = PREFS.left;
  if (PREFS.bottom) activeBottom = PREFS.bottom;
  if (PREFS.leftHidden) $('leftPanel').classList.add('hidden');
  else if (PREFS.leftHidden === false) $('leftPanel').classList.remove('hidden');
  if (PREFS.bottomHidden) $('dock').classList.add('hidden');
  if (PREFS.tabs && PREFS.tabs.length) { TABS = PREFS.tabs.slice(); currentFile = PREFS.current || TABS[0]; }
  // Only the bundled samples have content before the first fs round-trip, so a
  // restored file that is not one of them falls back to the first showable tab.
  if (!FILES[currentFile]) currentFile = TABS.filter(function (p) { return FILES[p] != null; })[0] || 'main.py';
  // A persisted language override travels with the document, so boot applies it.
  currentLang = langOfDoc(currentFile);
  paintIcons(document);
  renderMenus();
  renderStrip();
  applyI18n(document);
  document.documentElement.setAttribute('lang', activeLocale() === 'zh-CN' ? 'zh-CN' : 'en');

  // Command palette: Enter runs, Esc closes.
  (function wirePalette() {
    var inp = $('palInput');
    if (inp) inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); runPalette(); }
      else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    });
    var pal = $('palette');
    if (pal) pal.addEventListener('click', function (e) { if (e.target === pal) closePalette(); });
  })();
  renderCfgLabel();
  renderTabs();
  ta.value = FILES[currentFile] || '';
  // The status bar names the active file and its language, so restore must
  // refresh both (they are otherwise only written by openFile, which boot skips).
  $('stFile').textContent = currentFile;
  renderStLang();
  renderEditor();
  updateCaret();
  renderDock();
  renderPanel();
  initFlameWindow();
})();
