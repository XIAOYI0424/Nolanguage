  // ---------- native file pickers ----------
  // These are the one allowed piece of OS-native UI: Open / Open Folder / Save As
  // are real system dialogs. Two ways to get one, and the shipped build uses the
  // second: the page bundles no @tauri-apps/api, so under the Tauri shell the
  // calls go straight to the dialog plugin through __TAURI_INTERNALS__. The
  // shipped app is Edge --app, where that object does not exist — which is why
  // "Open Folder" used to answer "available in the desktop app" from inside the
  // desktop app. Without Tauri the request goes to the engine, which opens the
  // same dialog through the OS on this machine.
  function tauriInternals() {
    var T = window.__TAURI_INTERNALS__;
    return (T && typeof T.invoke === 'function') ? T : null;
  }
  var PICK_WAIT = null;
  function pickViaEngine(opts) {
    // One dialog at a time: a second menu click while the first is open would
    // overwrite the waiter and leave the first promise unsettled forever.
    if (PICK_WAIT) return PICK_WAIT.promise;
    var wait = {};
    wait.promise = new Promise(function (resolve, reject) {
      wait.resolve = resolve;
      wait.reject = reject;
    });
    PICK_WAIT = wait;
    BRIDGE.send({
      kind: 'nativePick',
      reqId: 'pick-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      mode: opts.save ? 'save' : (opts.directory ? 'directory' : 'file'),
      title: opts.title || '',
      defaultPath: opts.defaultPath || '',
      filters: opts.filters || []
    });
    return wait.promise;
  }
  /** The engine's answer. Resolves with the array shape the Tauri plugin returns. */
  function nativeOnPicked(m) {
    var wait = PICK_WAIT;
    PICK_WAIT = null;
    if (!wait) return;
    if (m && m.message) { wait.reject(new Error(m.message)); return; }
    wait.resolve(m && m.path ? [m.path] : null);
  }
  function nativeOpen(opts) {
    var T = tauriInternals();
    if (T) return T.invoke('plugin:dialog|open', { options: opts });
    return pickViaEngine(opts);
  }
  function nativeSave(opts) {
    var T = tauriInternals();
    if (T) return T.invoke('plugin:dialog|save', { options: opts });
    return pickViaEngine({ save: true, title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
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
      function (r) { var path = Array.isArray(r) ? r[0] : r; if (path) openProject(path); },
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
  function statusChoiceMenu(cell, items) {
    if (!cell || !currentFile) { toast('Open a file first'); return; }
    var r = cell.getBoundingClientRect();
    showCtx(r.left, r.bottom, items);
  }
  {
    var stEnc = $('stEnc'), stEol = $('stEol');
    if (stEnc) {
      stEnc.classList.add('act');
      stEnc.addEventListener('click', function () {
        var buf = BUFFERS[currentFile] || {};
        statusChoiceMenu(stEnc, [
          { label: 'UTF-8' + (!buf.bom ? '  · current' : ''), act: function () { setCurrentUtf8Bom(false); } },
          { label: 'UTF-8 with BOM' + (buf.bom ? '  · current' : ''), act: function () { setCurrentUtf8Bom(true); } },
          { sep: true },
          { label: 'Other encodings are not supported', dis: true }
        ]);
      });
    }
    if (stEol) {
      stEol.classList.add('act');
      stEol.addEventListener('click', function () {
        var buf = BUFFERS[currentFile] || {}, current = buf.eol === 'CRLF' ? 'CRLF' : 'LF';
        statusChoiceMenu(stEol, [
          { label: 'LF' + (current === 'LF' ? '  · current' : ''), act: function () { setCurrentLineEnding('LF'); } },
          { label: 'CRLF' + (current === 'CRLF' ? '  · current' : ''), act: function () { setCurrentLineEnding('CRLF'); } }
        ]);
      });
    }
  }
  $('langClose').addEventListener('click', closeModals);
  $('langInput').addEventListener('input', function () { renderLangs(this.value); });
  $('langInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var first = $('langBody').querySelector('.mres'); if (first) first.click(); }
    if (e.key === 'Escape') { closeModals(); this.blur(); }
  });

  // ---------- search everywhere ----------
  var searchTab = 'all';
  var searchIndex = 0;
  // Symbols come from the active language server. A cached answer is keyed by
  // the exact query so a late reply cannot replace results for newer text.
  var SEARCH_SYM_SEQ = 890000;
  var SEARCH_SYM_REQ = 0;
  var SEARCH_SYM_QUERY = '';
  var SEARCH_SYMS = [];
  var SEARCH_SYM_TIMER = 0;
  function requestSearchSymbols(q) {
    clearTimeout(SEARCH_SYM_TIMER);
    SEARCH_SYM_QUERY = String(q || '');
    SEARCH_SYMS = [];
    if (!lspLang() || !SEARCH_SYM_QUERY.trim()) return;
    SEARCH_SYM_TIMER = setTimeout(function () {
      var id = ++SEARCH_SYM_SEQ;
      SEARCH_SYM_REQ = id;
      BRIDGE.send({ kind: 'workspaceSymbol', language: currentLang, query: SEARCH_SYM_QUERY, requestId: id });
    }, 180);
  }
  function onSearchSymbolResult(m) {
    if (m.requestId !== SEARCH_SYM_REQ) return;
    SEARCH_SYMS = Array.isArray(m.symbols) ? m.symbols.slice(0, 80) : [];
    if ($('searchModal') && $('searchModal').classList.contains('open')) renderSearch($('searchInput').value);
  }
  function searchSymbolRows(q) {
    var out = [];
    if (SEARCH_SYMS.length) {
      SEARCH_SYMS.forEach(function (s) {
        if (String(s.name || '').toLowerCase().indexOf(q) < 0) return;
        var kind = String(s.kind || '').toLowerCase();
        var cls = kind.indexOf('class') >= 0 || kind.indexOf('interface') >= 0 || kind.indexOf('struct') >= 0 || kind.indexOf('enum') >= 0;
        out.push({
          group: cls ? 'Classes' : 'Symbols', name: s.name, path: navLabel(s.uri, s.line),
          icon: cls ? 'project' : 'structure', act: function () { navOpen(s); }
        });
      });
      return out;
    }
    if (!currentFile) return out;
    extractSymbols(ta.value, currentLang).forEach(function (s) {
      if (String(s.name || '').toLowerCase().indexOf(q) < 0) return;
      out.push({
        group: /class|interface|struct|enum/i.test(s.kind) ? 'Classes' : 'Symbols',
        name: s.name, path: currentFile + ':' + Number(s.line), icon: 'structure',
        act: function () { gotoLine(Math.max(0, Number(s.line) - 1), 0); }
      });
    });
    return out;
  }
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
  // Search Everywhere used to index four bundled sample files. The workspace
  // is the only source a developer cares about, so the Files tab is built from
  // a bounded fsList walk. fsRead is not needed: names are enough for fuzzy
  // navigation, and opening still goes through the normal buffer path.
  var WSFILE_SEQ = 870000;
  var WSFILE_PENDING = Object.create(null);
  var WSFILE_SCAN = null;
  var WSFILE_INDEX = [];
  var WSFILE_SKIP = { '.git': 1, '.hg': 1, 'node_modules': 1, 'dist': 1, 'build': 1, 'out': 1, 'target': 1, '__pycache__': 1, '.venv': 1, 'venv': 1, '.tmp': 1 };
  function wsFileReq(path) {
    var id = ++WSFILE_SEQ;
    WSFILE_PENDING[id] = { path: path, token: WSFILE_SCAN ? WSFILE_SCAN.token : 0 };
    return id;
  }
  function startWorkspaceFileIndex() {
    if (!BRIDGE.ready() || WSFILE_SCAN) return;
    WSFILE_SCAN = { token: ++WSFILE_SEQ, dirs: [], seen: {}, dirsVisited: 0, files: [] };
    BRIDGE.send({ kind: 'fsList', path: '', reqId: wsFileReq('') });
  }
  function onWorkspaceFileListing(reqId, m) {
    var pending = WSFILE_PENDING[reqId];
    delete WSFILE_PENDING[reqId];
    if (!pending || !WSFILE_SCAN || pending.token !== WSFILE_SCAN.token) return;
    (m.entries || []).forEach(function (e) {
      if (!e || !e.path) return;
      if (e.kind === 'dir') {
        var base = e.path.split('/').pop();
        if (WSFILE_SKIP[base] || WSFILE_SCAN.seen[e.path]) return;
        if (++WSFILE_SCAN.dirsVisited > 120) return;
        WSFILE_SCAN.seen[e.path] = true;
        WSFILE_SCAN.dirs.push(e.path);
      } else if (WSFILE_SCAN.files.length < 2000 && WSFILE_SCAN.files.indexOf(e.path) < 0) {
        WSFILE_SCAN.files.push(e.path);
      }
    });
    if (WSFILE_SCAN.dirs.length) {
      var dir = WSFILE_SCAN.dirs.shift();
      BRIDGE.send({ kind: 'fsList', path: dir, reqId: wsFileReq(dir) });
      return;
    }
    WSFILE_INDEX = WSFILE_SCAN.files.sort();
    WSFILE_SCAN = null;
    if ($('searchModal') && $('searchModal').classList.contains('open')) renderSearch($('searchInput').value);
  }
  function wsFuzzy(path, query) {
    if (!query) return true;
    var hay = String(path).toLowerCase(), needle = String(query).toLowerCase();
    if (hay.indexOf(needle) >= 0) return true;
    var i = 0;
    for (var j = 0; j < hay.length && i < needle.length; j++) if (hay.charAt(j) === needle.charAt(i)) i++;
    return i === needle.length;
  }
  function setSearchTab(tab) {
    searchTab = tab;
    var chips = $('searchChips');
    if (chips) chips.querySelectorAll('.chip').forEach(function (chip) {
      chip.classList.toggle('on', chip.getAttribute('data-tab') === tab);
    });
  }
  function openSearch(tab) {
    searchIndex = 0;
    $('searchInput').value = '';
    setSearchTab(tab || 'all');
    openModal('searchModal');
    startWorkspaceFileIndex();
    renderSearch('');
    setTimeout(function () { $('searchInput').focus(); }, 0);
  }
  function openFindAction() { openSearch('actions'); }
  /**
   * The menu tree is the real action list. A hand-written duplicate drifts the
   * moment someone adds a menu item, which is why Find Action reads MENUS
   * itself instead of maintaining a second catalogue.
   */
  function menuActions() {
    var out = [];
    Object.keys(MENUS).forEach(function (group) {
      MENUS[group].forEach(function (item) {
        if (item.sep || !item.act || !item.label) return;
        out.push({
          group: 'Actions', name: group + ' > ' + item.label,
          path: item.sc || '', icon: 'settings', act: item.act
        });
      });
    });
    return out;
  }
  /** Run one kernel command (the list arrives in the hello frame) and show it. */
  function runKernelCommand(id) {
    closeModals();
    toast('running ' + id + ' …');
    BRIDGE.send({ kind: 'command', id: id });
  }
  // Ctrl+Tab is a quick MRU switcher, not a second tab bar. The popup reuses
  // the same context menu the project tree uses, with one row marked selected;
  // holding Ctrl and pressing Tab again advances without a modal round trip.
  var TAB_SWITCH_OPEN = false;
  var TAB_SWITCH_LIST = [];
  var TAB_SWITCH_INDEX = 0;
  function cycleTabSwitcher(back) {
    var list = mruTabs();
    if (list.length < 2) { if (list.length === 1) toast('Only one tab is open'); return; }
    if (!TAB_SWITCH_OPEN) {
      TAB_SWITCH_OPEN = true;
      TAB_SWITCH_LIST = list;
      TAB_SWITCH_INDEX = back ? list.length - 1 : 0;
    } else {
      TAB_SWITCH_INDEX = (TAB_SWITCH_INDEX + (back ? -1 : 1) + TAB_SWITCH_LIST.length) % TAB_SWITCH_LIST.length;
      list = TAB_SWITCH_LIST;
    }
    var et = $('etabs'), r = et && et.getBoundingClientRect ? et.getBoundingClientRect() : null;
    var items = list.map(function (p, i) {
      return {
        label: p + (i === TAB_SWITCH_INDEX ? '  · current' : ''), sel: i === TAB_SWITCH_INDEX,
        act: function () { TAB_SWITCH_OPEN = false; openFile(p); }
      };
    });
    showCtx(r ? Math.max(8, r.left + 40) : 200, r ? Math.max(8, r.bottom + 4) : 120, items);
  }
  function closeTabSwitcher() { TAB_SWITCH_OPEN = false; }

  // ---------- lightweight side-by-side diff ----------
  // Enough for "did the clipboard overwrite my edit?" — not a merge tool.
  var DIFF_MAX_LINES = 600;
  function diffLines(a, b) {
    var left = String(a == null ? '' : a).split('\n');
    var right = String(b == null ? '' : b).split('\n');
    var capped = left.length > DIFF_MAX_LINES || right.length > DIFF_MAX_LINES;
    if (capped) { left = left.slice(0, DIFF_MAX_LINES); right = right.slice(0, DIFF_MAX_LINES); }
    var n = left.length, m = right.length;
    var dp = [];
    for (var i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
    for (i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    var rows = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (left[i] === right[j]) { rows.push({ type: 'same', a: i + 1, b: j + 1, l: left[i], r: right[j] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ type: 'del', a: i + 1, b: 0, l: left[i], r: '' }); i++; }
      else { rows.push({ type: 'add', a: 0, b: j + 1, l: '', r: right[j] }); j++; }
    }
    while (i < n) { rows.push({ type: 'del', a: ++i, b: 0, l: left[i - 1], r: '' }); }
    while (j < m) { rows.push({ type: 'add', a: 0, b: ++j, l: '', r: right[j - 1] }); }
    return { rows: rows, capped: capped };
  }
  function openDiffDialog(left, right, leftTitle, rightTitle) {
    var root = $('dlgRoot'); if (!root) return;
    var prev = root.querySelector('.diff-scrim'); if (prev) root.removeChild(prev);
    var result = diffLines(left, right);
    var scrim = document.createElement('div');
    scrim.className = 'dlg-scrim diff-scrim';
    var card = document.createElement('div');
    card.className = 'diffcard';
    var head = '<div class="diff-head"><span>' + esc(leftTitle || 'Left') + '</span><span>' + esc(rightTitle || 'Right') + '</span></div>';
    var body = '<div class="diff-body">';
    result.rows.forEach(function (r) {
      body += '<div class="diff-row ' + r.type + '">' +
        '<span class="dn">' + (r.a || '') + '</span><span class="dt">' + esc(r.l) + '</span>' +
        '<span class="dn">' + (r.b || '') + '</span><span class="dt">' + esc(r.r) + '</span></div>';
    });
    body += '</div>';
    if (result.capped) body += '<div class="diff-cap">Diff limited to the first ' + DIFF_MAX_LINES + ' lines per side.</div>';
    card.innerHTML = head + body +
      '<div class="dlg-foot"><button class="dlg-btn primary" data-close>Close</button></div>';
    scrim.appendChild(card);
    root.appendChild(scrim);
    function close() { if (scrim.parentNode) scrim.parentNode.removeChild(scrim); }
    card.querySelector('[data-close]').addEventListener('click', close);
    scrim.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });
    var primary = card.querySelector('.dlg-btn.primary'); if (primary) primary.focus();
    return close;
  }
  function compareWithClipboard() {
    if (!currentFile || !BUFFERS[currentFile]) { toast('Open a file first'); return; }
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      toast('Clipboard is not available in this host'); return;
    }
    navigator.clipboard.readText().then(function (text) {
      openDiffDialog(ta.value, text, currentFile, 'Clipboard');
    }).catch(function () { toast('Clipboard could not be read'); });
  }
  // A separate reqId namespace keeps this read out of the editor's own fsFile
  // path: comparing must never replace the live buffer with the disk version.
  var SAVED_SEQ = 930000;
  var SAVED_PENDING = Object.create(null);
  function compareWithSaved() {
    if (!currentFile || !BUFFERS[currentFile]) { toast('Open a file first'); return; }
    if (isScratchPath(currentFile)) { toast('Scratch files have no saved version'); return; }
    var reqId = ++SAVED_SEQ;
    SAVED_PENDING[reqId] = currentFile;
    BRIDGE.send({ kind: 'fsRead', path: currentFile, reqId: reqId });
    setStatusHint('Reading saved copy of ' + currentFile + ' …');
  }
  function onSavedVersionFile(reqId, f) {
    var path = SAVED_PENDING[reqId];
    if (!path) return;
    delete SAVED_PENDING[reqId];
    if (!f) { toast('Saved version is unavailable for ' + path); return; }
    var raw = String(f.content == null ? '' : f.content);
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    var saved = raw.replace(/\r\n?/g, '\n');
    var live = BUFFERS[path] ? BUFFERS[path].content : ta.value;
    openDiffDialog(saved, live, path + ' (saved)', path + ' (editor)');
  }

  // Compare two workspace files from the project tree. Both halves come from
  // separate bounded fsRead requests with their own reqIds: a diff must never
  // replace either editor buffer, even if one of the files is open and dirty.
  var COMPARE_SEQ = 950000;
  var COMPARE_PENDING = Object.create(null);
  var COMPARE_JOBS = Object.create(null);
  var COMPARE_LIMIT = 24;
  function compareCandidatePaths(exclude) {
    var out = [], seen = Object.create(null);
    var dirs = Object.keys(TREE);
    for (var d = 0; d < dirs.length && out.length < COMPARE_LIMIT; d++) {
      var entries = TREE[dirs[d]] || [];
      for (var i = 0; i < entries.length && out.length < COMPARE_LIMIT; i++) {
        var e = entries[i];
        if (!e || e.kind === 'dir') continue;
        var p = String(e.path || '').replace(/\\/g, '/');
        if (!p || p === exclude || seen[p] || isScratchPath(p)) continue;
        seen[p] = true; out.push(p);
      }
    }
    Object.keys(BUFFERS).forEach(function (p) {
      var norm = String(p).replace(/\\/g, '/');
      if (out.length >= COMPARE_LIMIT || !norm || norm === exclude || seen[norm] || isScratchPath(norm)) return;
      seen[norm] = true; out.push(norm);
    });
    return out.sort(function (a, b) { return a.localeCompare(b); }).slice(0, COMPARE_LIMIT);
  }
  function compareWithFile(left) {
    left = String(left || '').replace(/\\/g, '/');
    if (!left) { toast('Select a file in the project tree first'); return; }
    if (isScratchPath(left)) { toast('Scratch files have no workspace path'); return; }
    var candidates = compareCandidatePaths(left);
    showModal({
      title: 'Compare with File', icon: 'file', message: left,
      sub: 'Choose another project file, or type its workspace-relative path.',
      fields: [{ name: 'path', label: 'File path', value: '', placeholder: 'src/other.py',
        validator: function (v) { return (String(v || '').trim() || candidates.length) ? '' : 'Choose or type a file path'; } }],
      radios: candidates.map(function (p, i) { return { name: 'file', value: p, label: p, def: i === 0 }; }),
      buttons: [
        { label: 'Cancel' },
        { label: 'Compare', primary: true, onClick: function (v) {
          var typed = String(v.path || '').trim().replace(/\\/g, '/');
          var right = typed || String(v.file || '');
          if (!right || right === left) { toast('Choose a different file'); return; }
          compareTwoFiles(left, right);
        } }
      ]
    });
  }
  function compareTwoFiles(left, right) {
    var job = ++COMPARE_SEQ;
    var leftReq = ++COMPARE_SEQ, rightReq = ++COMPARE_SEQ;
    COMPARE_JOBS[job] = { left: left, right: right, leftText: null, rightText: null };
    COMPARE_PENDING[leftReq] = { job: job, side: 'leftText' };
    COMPARE_PENDING[rightReq] = { job: job, side: 'rightText' };
    BRIDGE.send({ kind: 'fsRead', path: left, reqId: leftReq });
    BRIDGE.send({ kind: 'fsRead', path: right, reqId: rightReq });
    setStatusHint('Comparing ' + left + ' with ' + right + ' …');
  }
  function compareReadText(f) {
    var raw = String(f && f.content != null ? f.content : '');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return raw.replace(/\r\n?/g, '\n');
  }
  function onCompareFile(reqId, f) {
    var pending = COMPARE_PENDING[reqId];
    if (!pending) return;
    delete COMPARE_PENDING[reqId];
    var job = COMPARE_JOBS[pending.job];
    if (!job) return;
    job[pending.side] = compareReadText(f);
    if (job.leftText == null || job.rightText == null) return;
    delete COMPARE_JOBS[pending.job];
    openDiffDialog(job.leftText, job.rightText, job.left, job.right);
    setStatusHint('Compared ' + job.left + ' with ' + job.right);
  }
  function onCompareFileError(reqId, m) {
    var pending = COMPARE_PENDING[reqId];
    if (!pending) return;
    delete COMPARE_PENDING[reqId];
    var job = COMPARE_JOBS[pending.job];
    if (!job) return;
    delete COMPARE_JOBS[pending.job];
    toast('Cannot compare: ' + String(m.path || pending.side) + ' is unavailable');
  }

  // ---------- local revision history ----------
  var HISTORY_SEQ = 600000;
  var HISTORY_REQ = 0;
  var HISTORY_ENTRIES = [];
  var HISTORY_COMPARE = false;
  function openRecentChanges() {
    HISTORY_REQ = ++HISTORY_SEQ;
    BRIDGE.send({ kind: 'historyList', path: '', reqId: HISTORY_REQ });
    setStatusHint('Reading recent changes …');
  }
  function showCurrentFileHistory() {
    if (!currentFile) { toast('Open a file first'); return; }
    HISTORY_REQ = ++HISTORY_SEQ;
    BRIDGE.send({ kind: 'historyList', path: currentFile, reqId: HISTORY_REQ });
    setStatusHint('Reading history for ' + currentFile + ' …');
  }
  function historyStamp(n) {
    var d = new Date(Number(n) || 0);
    return isNaN(d.getTime()) ? 'unknown time' : d.toLocaleString();
  }
  function showHistoryEntries(m) {
    if (Number(m.reqId || 0) !== HISTORY_REQ) return;
    HISTORY_ENTRIES = m.entries || [];
    if (!HISTORY_ENTRIES.length) { toast('No local revisions yet'); return; }
    var radios = HISTORY_ENTRIES.map(function (e, i) {
      return {
        name: 'rev', value: e.id, def: i === 0,
        label: historyStamp(e.savedAt) + '  ' + e.reason + '  ' + e.path + '  (' + e.size + ' B)'
      };
    });
    var close = showModal({
      title: 'Recent Changes', icon: 'history', message: 'Local revisions are not Git commits',
      sub: 'Snapshots are kept outside the project. Select a revision to compare or restore.',
      radios: radios,
      buttons: [
        { label: 'Close' },
        { label: 'Compare', onClick: function (v) {
          if (!v.rev) return;
          HISTORY_COMPARE = true;
          BRIDGE.send({ kind: 'historyRead', id: v.rev, reqId: ++HISTORY_SEQ });
        } },
        { label: 'Revert', primary: true, onClick: function (v) {
          if (!v.rev) return;
          BRIDGE.send({ kind: 'historyRevert', id: v.rev, reqId: ++HISTORY_SEQ });
        } }
      ]
    });
    if (close) HISTORY_CLOSE = close;
  }
  var HISTORY_CLOSE = null;
  function onHistoryFile(m) {
    if (!HISTORY_COMPARE) return;
    HISTORY_COMPARE = false;
    var oldText = String(m.content || '');
    var now = BUFFERS[m.path] ? BUFFERS[m.path].content : (m.path === currentFile ? ta.value : '');
    openDiffDialog(oldText, now, m.path + ' @ ' + historyStamp(m.savedAt), 'Current');
  }
  function onHistoryReverted(m) {
    toast('Reverted ' + m.path);
    BRIDGE.send({ kind: 'fsRead', path: m.path, reqId: 0 });
    if (HISTORY_CLOSE && HISTORY_CLOSE.close) HISTORY_CLOSE.close();
    HISTORY_CLOSE = null;
  }

  // ---------- scratch files and buffers ----------
  // Scratch state is IDE state, not project state: it follows the user, not the
  // folder, and never triggers a workspace fsWrite. Saving a scratch writes to
  // preferences instead, so it cannot appear as a phantom project file.
  var SCRATCH = (PREFS.scratch && typeof PREFS.scratch === 'object') ? PREFS.scratch : {};
  if (!SCRATCH.files || typeof SCRATCH.files !== 'object' || Array.isArray(SCRATCH.files)) SCRATCH.files = {};
  if (!Array.isArray(SCRATCH.buffers)) SCRATCH.buffers = ['', '', '', '', ''];
  while (SCRATCH.buffers.length < 5) SCRATCH.buffers.push('');
  function persistScratch() { savePrefs({ scratch: SCRATCH }); }
  function isScratchPath(p) {
    return !!(SCRATCH.files[p] || /^scratch-\d+\.[A-Za-z0-9]+$/.test(String(p || '')) || /^buffer[1-5]\.txt$/.test(String(p || '')));
  }
  function saveScratch(p, content) {
    if (SCRATCH.files[p]) SCRATCH.files[p].content = content;
    else {
      var n = Number(String(p).replace(/^buffer/, '').replace(/\.txt$/, '')) - 1;
      if (n >= 0 && n < SCRATCH.buffers.length) SCRATCH.buffers[n] = content;
    }
    persistScratch();
  }
  function scratchBufferRecord(name) {
    if (SCRATCH.files[name]) return { content: SCRATCH.files[name].content || '', languageId: SCRATCH.files[name].language || langOfDoc(name) };
    var n = Number(String(name).replace(/^buffer/, '').replace(/\.txt$/, '')) - 1;
    return { content: SCRATCH.buffers[n] || '', languageId: 'text' };
  }
  function hydrateScratch() {
    Object.keys(SCRATCH.files).forEach(function (name) {
      if (!BUFFERS[name]) {
        var r = scratchBufferRecord(name);
        BUFFERS[name] = { content: r.content, languageId: r.languageId, editable: true, dirty: false, eol: 'LF', bom: false };
      }
    });
    for (var i = 1; i <= 5; i++) {
      var name2 = 'buffer' + i + '.txt';
      if (!BUFFERS[name2]) {
        BUFFERS[name2] = { content: SCRATCH.buffers[i - 1] || '', languageId: 'text', editable: true, dirty: false, eol: 'LF', bom: false };
      }
    }
  }
  function openScratch(name) {
    var r = scratchBufferRecord(name);
    if (!BUFFERS[name]) {
      BUFFERS[name] = { content: r.content, languageId: r.languageId, editable: true, dirty: false, eol: 'LF', bom: false };
    }
    if (!isOpen(name)) TABS.push(name);
    openFile(name);
  }
  function newScratchFile() {
    var close = showModal({
      title: 'New Scratch File', icon: 'file', message: 'Stored with the IDE, not in the project',
      sub: 'Leave the name empty for the next automatic number.',
      fields: [{ name: 'name', label: 'File name', value: '', placeholder: 'scratch-1.py' }],
      radios: [
        { name: 'sl', value: 'py', def: true, label: 'Python  (.py)' },
        { name: 'sl', value: 'js', label: 'JavaScript  (.js)' },
        { name: 'sl', value: 'go', label: 'Go  (.go)' },
        { name: 'sl', value: 'md', label: 'Markdown  (.md)' },
        { name: 'sl', value: 'txt', label: 'Plain text  (.txt)' }
      ],
      buttons: [
        { label: 'Cancel' },
        { label: 'Create', primary: true, onClick: function (v) {
          var ext = v.sl || 'py';
          var name = String(v.name || '').trim();
          if (!name) {
            var n = 1;
            while (SCRATCH.files['scratch-' + n + '.' + ext]) n++;
            name = 'scratch-' + n + '.' + ext;
          }
          if (SCRATCH.files[name]) { toast('Scratch file already exists: ' + name); return; }
          SCRATCH.files[name] = { content: '', language: langOfDoc(name), createdAt: Date.now() };
          persistScratch();
          openScratch(name);
          toast('Created scratch ' + name);
        } }
      ]
    });
    return close;
  }
  function newScratchBuffer() {
    var name = '';
    for (var i = 1; i <= 5; i++) {
      var candidate = 'buffer' + i + '.txt';
      if (!SCRATCH.buffers[i - 1]) { name = candidate; break; }
    }
    if (!name) { name = 'buffer1.txt'; SCRATCH.buffers[0] = ''; toast('Rotated buffer1.txt'); }
    persistScratch();
    openScratch(name);
  }
  function showScratchFiles() {
    var names = Object.keys(SCRATCH.files).sort();
    for (var i = 1; i <= 5; i++) names.push('buffer' + i + '.txt');
    var radios = names.map(function (name, idx) {
      var isBuffer = /^buffer[1-5]\.txt$/.test(name);
      var size = isBuffer ? SCRATCH.buffers[Number(name.charAt(6)) - 1].length : String(SCRATCH.files[name].content || '').length;
      return { name: 'scratch', value: name, def: idx === 0, label: name + '  (' + size + ' chars)' + (isBuffer ? '  · buffer' : '') };
    });
    showModal({
      title: 'Scratch Files', icon: 'file', message: 'Project-independent notes and drafts',
      sub: 'Scratch files are available from every project in this profile.',
      radios: radios,
      buttons: [
        { label: 'Close' },
        { label: 'Delete', danger: true, onClick: function (v) {
          if (!v.scratch) return;
          if (SCRATCH.files[v.scratch]) delete SCRATCH.files[v.scratch];
          else {
            var n = Number(String(v.scratch).replace(/^buffer/, '').replace(/\.txt$/, '')) - 1;
            if (n >= 0 && n < 5) SCRATCH.buffers[n] = '';
          }
          persistScratch();
          if (BUFFERS[v.scratch]) BUFFERS[v.scratch].content = '';
          toast('Cleared ' + v.scratch);
        } },
        { label: 'Open', primary: true, onClick: function (v) { if (v.scratch) openScratch(v.scratch); } }
      ]
    });
  }

  function searchResults(q) {
    q = q.toLowerCase();
    var fileNames = WSFILE_INDEX.length ? WSFILE_INDEX : Object.keys(FILES);
    var files = fileNames.filter(function (f) { return wsFuzzy(f, q); }).slice(0, 80).map(function (f) {
      return { group: 'Files', name: f.split('/').pop(), path: f.indexOf('/') >= 0 ? f.slice(0, f.lastIndexOf('/')) : 'workspace', icon: 'file', act: function () { openFile(f); } };
    });
    var syms = searchSymbolRows(q);
    var acts = KCOMMANDS.filter(function (c) { return c.id.toLowerCase().indexOf(q) >= 0; }).slice(0, 6).map(function (c) { return { group: 'Actions', name: c.title || c.id, path: c.id, icon: 'settings', act: function () { runKernelCommand(c.id); } }; });
    acts = acts.concat(ACTIONS.filter(function (a) { return a.name.toLowerCase().indexOf(q) >= 0; }).map(function (a) { return { group: 'Actions', name: a.name, path: '', icon: 'run', act: a.act }; }));
    // Find Action must see every real menu command, not a hand-written list.
    acts = acts.concat(menuActions().filter(function (a) { return a.name.toLowerCase().indexOf(q) >= 0; }));
    var seenAct = {};
    acts = acts.filter(function (a) { if (seenAct[a.name]) return false; seenAct[a.name] = true; return true; });
    var all = files.concat(syms, acts);
    if (searchTab !== 'all') all = all.filter(function (r) { return r.group.toLowerCase() === searchTab; });
    return all;
  }
  function renderSearch(q) {
    var res = searchResults(q), body = $('searchBody');
    if (!res.length) { searchIndex = 0; body.innerHTML = '<div class="empty">No matches.</div>'; return; }
    searchIndex = Math.max(0, Math.min(searchIndex, res.length - 1));
    var html = '', group = '';
    res.forEach(function (r, i) {
      if (r.group !== group) { group = r.group; html += '<div class="mgrp">' + group + '</div>'; }
      html += '<div class="mres' + (i === searchIndex ? ' sel' : '') + '" data-i="' + i + '">' +
        '<span class="ic">' + ic(r.icon, 16) + '</span><span class="nm">' + esc(r.name) + '</span>' +
        (r.path ? '<span class="path">' + esc(r.path) + '</span>' : '') + '</div>';
    });
    body.innerHTML = html;
    Array.prototype.forEach.call(body.querySelectorAll('.mres'), function (el) {
      el.addEventListener('mouseenter', function () {
        searchIndex = +el.getAttribute('data-i');
        body.querySelectorAll('.mres').forEach(function (row) { row.classList.toggle('sel', row === el); });
      });
      el.addEventListener('click', function () { var r = res[+el.getAttribute('data-i')]; closeModals(); r.act(); });
    });
  }
  $('searchInput').addEventListener('input', function () {
    searchIndex = 0;
    requestSearchSymbols(this.value);
    renderSearch(this.value);
  });
  $('searchInput').addEventListener('keydown', function (e) {
    var rows = $('searchBody').querySelectorAll('.mres');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (rows.length) {
        searchIndex = (searchIndex + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
        rows.forEach(function (row, i) { row.classList.toggle('sel', i === searchIndex); });
        if (rows[searchIndex] && rows[searchIndex].scrollIntoView) rows[searchIndex].scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (e.key === 'Enter') { if (rows[searchIndex]) rows[searchIndex].click(); }
    if (e.key === 'Escape') closeModals();
  });
  Array.prototype.forEach.call($('searchChips').querySelectorAll('.chip'), function (c) {
    c.addEventListener('click', function () {
      $('searchChips').querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); });
      c.classList.add('on'); searchTab = c.getAttribute('data-tab'); searchIndex = 0; renderSearch($('searchInput').value);
    });
  });
  $('searchBtn').addEventListener('click', function () { openSearch(); });
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
  $('buildBtn').addEventListener('click', function () {
    requestCheck();
    toast('Build check started for ' + (currentFile || 'untitled'));
  });
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

  // ---------- project header tabs (Project / Structure) ----------
  document.querySelectorAll('.tw-head .tw-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var view = tab.getAttribute('data-project-view');
      var panel = $('leftPanel');
      if (activeLeft !== view || panel.classList.contains('hidden')) toggleWindow(view);
      document.querySelectorAll('.tw-head .tw-tab').forEach(function (t) {
        t.classList.toggle('is-active', t === tab);
      });
    });
  });

  // ---------- right AI Assistant drawer ----------
  function assistantOpen() {
    var p = $('assistantPanel'), r = $('rightResize');
    if (!p) return;
    if (window.matchMedia && window.matchMedia('(max-width:1099px)').matches) {
      p.classList.add('force-open'); if (r) r.classList.add('force-open');
    }
    var hidden = p.classList.contains('hidden');
    p.classList.toggle('hidden', !hidden);
    if (r) r.classList.toggle('hidden', !hidden);
    seedAssistant();
    savePrefs({ assistantHidden: !hidden });
  }
  function seedAssistant() {
    var host = $('assistantMessages'); if (!host || host.childNodes.length) return;
    host.innerHTML = '<div class="amsg amsg--ai"><span class="amsg__role">Assistant</span>' +
      'Ask about the current file. Answers stream from the provider configured in the AI panel (Alt+A).</div>';
  }
  var at = $('assistantToggle'); if (at) at.addEventListener('click', assistantOpen);
  var ac = $('assistantClose'); if (ac) ac.addEventListener('click', assistantOpen);
  var af = $('assistantForm');
  function sendAssistant() {
    var input = $('assistantInput'), q = (input.value || '').trim();
    if (!q) return;
    var host = $('assistantMessages');
    var user = document.createElement('div'); user.className = 'amsg amsg--user';
    user.innerHTML = '<span class="amsg__role">You</span>' + esc(q); host.appendChild(user);
    input.value = '';
    var bubble = document.createElement('div'); bubble.className = 'amsg amsg--ai';
    bubble.innerHTML = '<span class="amsg__role">Assistant</span>';
    var body = document.createElement('span'); body.textContent = 'Thinking…';
    bubble.appendChild(body);
    host.appendChild(bubble);
    host.scrollTop = host.scrollHeight;
    if (!aiAskNow(q, 'drawer')) {
      body.textContent = 'An answer is already streaming — stop it or wait for it to finish.';
      return;
    }
    AI.node = body;
  }
  if (af) {
    var send = af.querySelector('.assistant-send');
    if (send) send.addEventListener('click', sendAssistant);
    var question = $('assistantInput');
    if (question) question.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault(); e.stopPropagation(); sendAssistant();
    });
  }

  // ---------- minimap click-to-scroll and viewport ----------
  function minimapMetrics() {
    if (CMEDITOR && CMEDITOR.cm) {
      var s = CMEDITOR.cm.getScrollInfo();
      var total = Math.max(1, Number(s.height) || 0);
      var view = Math.max(1, Math.min(total, Number(s.clientHeight) || total));
      return { top: Number(s.top) || 0, max: Math.max(1, total - view), ratio: view / total };
    }
    var doc = Math.max(1, Number(ta.scrollHeight) || 0);
    var visible = Math.max(1, Math.min(doc, Number(ta.clientHeight) || doc));
    return { top: Number(ta.scrollTop) || 0, max: Math.max(1, doc - visible), ratio: visible / doc };
  }
  function updateMinimapViewport() {
    var vp = $('minimapViewport'); if (!vp) return;
    var m = minimapMetrics();
    var span = Math.max(0, 1 - m.ratio);
    vp.style.height = Math.round(m.ratio * 100) + '%';
    vp.style.top = Math.round(Math.min(span, Math.max(0, m.top / m.max) * span) * 100) + '%';
  }
  function scrollToMinimapRatio(ratio) {
    var m = minimapMetrics();
    var y = Math.max(0, Math.min(1, Number(ratio) || 0)) * m.max;
    if (CMEDITOR && CMEDITOR.cm) CMEDITOR.cm.scrollTo(0, y);
    else ta.scrollTop = y;
    updateMinimapViewport();
  }
  var mini = $('minimap');
  if (mini) mini.addEventListener('click', function (e) {
    var bounds = mini.getBoundingClientRect();
    var span = bounds.height || mini.clientHeight || 1;
    scrollToMinimapRatio((e.clientY - bounds.top) / span);
  });
  ta.addEventListener('scroll', updateMinimapViewport);
  if (CMEDITOR && CMEDITOR.cm && CMEDITOR.cm.on) CMEDITOR.cm.on('scroll', updateMinimapViewport);
  updateMinimapViewport();

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
  // sees. The three toggles are explicit rather than inferred from capital
  // letters: a lowercase regex still needs case-sensitive matching, and a
  // capital letter in a file path was never a good proxy for user intent.
  var FIND_OPTS = (PREFS.findOpts && typeof PREFS.findOpts === 'object') ? PREFS.findOpts : {};
  var FIND = {
    bar: null, input: null, rep: null, count: null,
    hits: [], spans: [], idx: -1, replace: false, error: '',
    cs: !!FIND_OPTS.cs, word: !!FIND_OPTS.word, rx: !!FIND_OPTS.rx
  };
  var FIND_MAX_HITS = 10000;
  function escapeRe(s) { return String(s).replace(/[.*+?^$()|[]{}\-]/g, '\$&'); }
  function persistFindOpts() {
    updatePrefs({ findOpts: { cs: FIND.cs, word: FIND.word, rx: FIND.rx } });
  }
  function findRegExp(q) {
    try { return new RegExp(q, (FIND.cs ? '' : 'i') + 'g'); }
    catch (e) { return null; }
  }
  function findSpans(q) {
    if (!q) return [];
    var text = ta.value, out = [];
    if (FIND.rx) {
      var re = findRegExp(q);
      if (!re) { FIND.error = 'invalid regex'; return []; }
      FIND.error = '';
      var m;
      while ((m = re.exec(text)) !== null) {
        out.push({ start: m.index, end: m.index + m[0].length });
        if (!m[0].length) re.lastIndex++;
        if (out.length >= FIND_MAX_HITS) break;
      }
      return out;
    }
    FIND.error = '';
    var hay = FIND.cs ? text : text.toLowerCase();
    var needle = FIND.cs ? q : q.toLowerCase();
    var i = 0;
    while (i <= hay.length && out.length < FIND_MAX_HITS) {
      var k = hay.indexOf(needle, i);
      if (k === -1) break;
      var end = k + q.length;
      if (!FIND.word || !((k > 0 && isWordCh(hay.charAt(k - 1))) || (end < hay.length && isWordCh(hay.charAt(end))))) {
        out.push({ start: k, end: end });
      }
      i = k + Math.max(1, needle.length);
    }
    return out;
  }
  function findMatches(q) {
    FIND.spans = findSpans(q);
    return FIND.spans.map(function (s) { return s.start; });
  }
  function ensureFindBar() {
    if (FIND.bar) return FIND.bar;
    var bar = document.createElement('div');
    bar.className = 'findbar';
    bar.innerHTML =
      '<input class="fb-in" type="text" placeholder="Find" spellcheck="false" />' +
      '<label class="fb-opt" title="Match case"><input type="checkbox" data-opt="cs" />Aa</label>' +
      '<label class="fb-opt" title="Whole words only"><input type="checkbox" data-opt="word" />ab</label>' +
      '<label class="fb-opt" title="Regular expression"><input type="checkbox" data-opt="rx" />.*</label>' +
      '<span class="fb-count"></span>' +
      '<button class="fb-btn" data-a="prev" title="Previous (Shift+Enter / Shift+F3)">&#8593;</button>' +
      '<button class="fb-btn" data-a="next" title="Next (Enter / F3)">&#8595;</button>' +
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
    bar.addEventListener('change', function (e) {
      var opt = e.target && e.target.getAttribute ? e.target.getAttribute('data-opt') : null;
      if (opt !== 'cs' && opt !== 'word' && opt !== 'rx') return;
      if (opt === 'cs') FIND.cs = !!e.target.checked;
      else if (opt === 'word') FIND.word = !!e.target.checked;
      else FIND.rx = !!e.target.checked;
      persistFindOpts();
      FIND.idx = -1;
      refreshHits(); paintCount();
      if (FIND.input.value) findStep(1);
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
    if (FIND.error) { FIND.count.textContent = FIND.error; return; }
    FIND.count.textContent = FIND.hits.length ? ((FIND.idx + 1) + '/' + FIND.hits.length) : 'no results';
  }
  function selectHit(i) {
    var hits = FIND.hits;
    if (!hits.length) { FIND.idx = -1; paintCount(); return; }
    if (i < 0) i = hits.length - 1;
    if (i >= hits.length) i = 0;
    FIND.idx = i;
    var span = FIND.spans[i];
    ta.focus();
    ta.selectionStart = hits[i];
    ta.selectionEnd = span ? span.end : hits[i];
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
  /** F3 reuses the last find bar query; it never opens a new search UI. */
  function repeatFind(dir) {
    if (!FIND.input || !FIND.input.value) { toast('No find query yet — press Ctrl+F'); return; }
    findStep(dir);
  }
  function replaceCurrent() {
    if (!FIND.input.value) return;
    var span = FIND.spans[FIND.idx];
    if (!span || ta.selectionStart !== span.start || ta.selectionEnd !== span.end) {
      FIND.idx = -1; findStep(1); return;
    }
    var replacement = FIND.rep.value;
    if (FIND.rx) {
      var re = findRegExp(FIND.input.value);
      var match = re ? re.exec(ta.value.slice(span.start, span.end)) : null;
      if (match) replacement = match[0].replace(new RegExp(FIND.input.value, FIND.cs ? '' : 'i'), replacement);
    }
    replaceRange(span.start, span.end, replacement);
    renderEditor(); updateCaret();
    FIND.idx = -1;
    refreshHits(); paintCount();
    findStep(1);
  }
  function replaceAll() {
    var q = FIND.input.value, rep = FIND.rep.value;
    if (!q) return;
    refreshHits();
    var spans = FIND.spans;
    if (!spans.length) { toast(FIND.error ? ('No replacement: ' + FIND.error) : 'No matches'); return; }
    var text = ta.value, out = text, n = spans.length;
    if (FIND.rx) {
      var re = findRegExp(q);
      if (re) out = text.replace(re, rep);
    } else {
      for (var i = spans.length - 1; i >= 0; i--) {
        out = out.slice(0, spans[i].start) + rep + out.slice(spans[i].end);
      }
    }
    ta.value = out;
    renderEditor(); updateCaret();
    FIND.idx = -1;
    refreshHits(); paintCount();
    toast('Replaced ' + n + ' occurrence' + (n === 1 ? '' : 's'));
  }
  function syncFindOpts() {
    if (!FIND.bar) return;
    var boxes = FIND.bar.querySelectorAll('[data-opt]');
    for (var i = 0; i < boxes.length; i++) {
      var opt = boxes[i].getAttribute('data-opt');
      boxes[i].checked = opt === 'cs' ? FIND.cs : opt === 'word' ? FIND.word : FIND.rx;
    }
  }
  function openFindBar(replace) {
    var bar = ensureFindBar();
    syncFindOpts();
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
    setStatusHint('Duplicated line ' + (v.slice(0, b.start).split('\n').length));
    if (typeof noteEditLocation === 'function') noteEditLocation();
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
    setStatusHint('Deleted line ' + (v.slice(0, b.start).split('\n').length));
    if (typeof noteEditLocation === 'function') noteEditLocation();
  }
  var COMMENT_PREFIX = {
    python: '#', bash: '#', shell: '#', sh: '#', ruby: '#', yaml: '#', yml: '#', r: '#',
    javascript: '//', typescript: '//', java: '//', go: '//', c: '//', cpp: '//',
    csharp: '//', rust: '//', kotlin: '//', swift: '//', scala: '//', dart: '//',
    groovy: '//', php: '//',
    sql: '--', lua: '--', haskell: '--', clojure: ';'
  };
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
    setStatusHint((allCommented ? 'Uncommented ' : 'Commented ') + lines.length + ' line' + (lines.length === 1 ? '' : 's'));
    if (typeof noteEditLocation === 'function') noteEditLocation();
  }
  var BLOCK_COMMENT = {
    python: ['"""', '"""'], javascript: ['/*', '*/'], typescript: ['/*', '*/'],
    go: ['/*', '*/'], java: ['/*', '*/'], kotlin: ['/*', '*/'],
    c: ['/*', '*/'], cpp: ['/*', '*/'], rust: ['/*', '*/'],
    csharp: ['/*', '*/'], swift: ['/*', '*/'], scala: ['/*', '*/'],
    dart: ['/*', '*/'], groovy: ['/*', '*/'], php: ['/*', '*/'], css: ['/*', '*/']
  };
  function toggleBlockComment() {
    if (!CAN_EDIT()) { toast('Read-only buffer'); return; }
    var pair = BLOCK_COMMENT[currentLang] || ['/*', '*/'];
    var v = ta.value, from = ta.selectionStart, to = ta.selectionEnd;
    var inner = v.slice(from, to);
    var out;
    if (inner.indexOf(pair[0]) === 0 && inner.lastIndexOf(pair[1]) === inner.length - pair[1].length && inner.length >= pair[0].length + pair[1].length) {
      out = inner.slice(pair[0].length, inner.length - pair[1].length);
    } else {
      out = pair[0] + inner + pair[1];
    }
    replaceRange(from, to, out);
    ta.selectionStart = from; ta.selectionEnd = from + out.length;
    renderEditor(); updateCaret();
    setStatusHint(inner.indexOf(pair[0]) === 0 ? 'Removed block comment' : 'Added block comment');
    if (typeof noteEditLocation === 'function') noteEditLocation();
  }
  // Ctrl+Shift+M: jump to the counterpart of () / [] / {}. Quoted text and
  // comments are masked first, otherwise a "(" inside a string would win.
  var BRACKET_PAIRS = { ')': '(', ']': '[', '}': '{' };
  var BRACKET_OPEN = { '(': ')', '[': ']', '{': '}' };
  function bracketCodeMask(v, hashComments) {
    var out = v.split('');
    var dq = String.fromCharCode(34), sq = String.fromCharCode(39), tq = String.fromCharCode(96);
    var quote = '', escaped = false, lineComment = false, blockComment = false;
    for (var i = 0; i < v.length; i++) {
      var c = v.charAt(i), next = v.charAt(i + 1);
      if (lineComment) { if (c === '\n') lineComment = false; out[i] = ' '; continue; }
      if (hashComments && c === '#') { lineComment = true; out[i] = ' '; continue; }
      if (blockComment) { out[i] = ' '; if (c === '*' && next === '/') { out[i + 1] = ' '; i++; blockComment = false; } continue; }
      if (quote) {
        out[i] = ' ';
        if (escaped) { escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (c === quote) quote = '';
        continue;
      }
      if (c === '/' && next === '/') { lineComment = true; out[i] = out[i + 1] = ' '; i++; continue; }
      if (c === '/' && next === '*') { blockComment = true; out[i] = out[i + 1] = ' '; i++; continue; }
      if (c === dq || c === sq || c === tq) { quote = c; out[i] = ' '; }
    }
    return out.join('');
  }
  function matchingBracketAt(mask, start, text) {
    var c = mask.charAt(start), forward = !!BRACKET_OPEN[c];
    if (!forward && !BRACKET_PAIRS[c]) return -1;
    var open = forward ? c : BRACKET_PAIRS[c];
    var close = forward ? BRACKET_OPEN[c] : c;
    var stack = [];
    if (forward) {
      for (var i = start; i < mask.length; i++) {
        var x = mask.charAt(i);
        if (x === open) stack.push(i);
        else if (x === close) {
          if (!stack.length) return -1;
          stack.pop();
          if (!stack.length) return i;
        }
      }
    } else {
      for (var j = start; j >= 0; j--) {
        var y = mask.charAt(j);
        if (y === close) stack.push(j);
        else if (y === open) {
          if (!stack.length) return -1;
          stack.pop();
          if (!stack.length) return j;
        }
      }
    }
    return -1;
  }
  function gotoMatchingBracket() {
    var text = ta.value, pos = ta.selectionStart;
    var mask = bracketCodeMask(text);
    var at = mask.charAt(pos), prev = mask.charAt(pos - 1);
    var start = (BRACKET_OPEN[at] || BRACKET_PAIRS[at]) ? pos
      : ((BRACKET_OPEN[prev] || BRACKET_PAIRS[prev]) ? pos - 1 : -1);
    if (start < 0) { toast('Place the caret on a bracket'); return; }
    var match = matchingBracketAt(mask, start, text);
    if (match < 0) { toast('No matching bracket'); return; }
    var before = text.slice(0, match);
    var line = before.split('\n').length - 1;
    var ch = match - before.lastIndexOf('\n') - 1;
    gotoLine(line, ch);
    setStatusHint('Matched ' + mask.charAt(start) + ' on line ' + (line + 1));
  }
  /** Mark every code occurrence of the symbol under the caret, not text in strings. */
  function highlightUsages() {
    var v = ta.value, pos = ta.selectionStart;
    var before = v.slice(0, pos), line = before.split('\n').length - 1;
    var w = wordAt(v.split('\n')[line] || '', pos - before.lastIndexOf('\n') - 1);
    if (!w || !w.text) { toast('Place the caret on a symbol first'); return; }
    var hashLang = /^(python|py|ruby|rb|bash|sh|shell|zsh|yaml|yml|toml|perl|r|make|dockerfile|powershell|ps1)$/i.test(String(currentLang || ''));
    var mask = bracketCodeMask(v, hashLang), re = new RegExp('\\b' + escapeRe(w.text) + '\\b', 'g'), spans = [], m;
    while ((m = re.exec(mask)) !== null) spans.push({ start: m.index, end: m.index + m[0].length });
    if (!spans.length) { toast('No usages of ' + w.text); return; }
    var absStart = before.lastIndexOf('\n') + 1 + w.start;
    setUsageSpans(spans, absStart, absStart + w.text.length);
    renderEditor(); updateCaret();
    setStatusHint('Highlighted ' + spans.length + ' usage' + (spans.length === 1 ? '' : 's') + ' of ' + w.text);
  }
  function isDelWordChar(c) { return /[\w\u4e00-\u9fff]/.test(c); }
  function deleteWord(dir) {
    if (!CAN_EDIT()) { toast('Read-only buffer'); return; }
    var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    if (s !== e) { replaceRange(s, e, ''); renderEditor(); updateCaret(); return; }
    if (dir < 0) {
      var start = s;
      while (start > 0 && /\s/.test(v.charAt(start - 1))) start--;
      while (start > 0 && isDelWordChar(v.charAt(start - 1))) start--;
      while (start > 0 && /\s/.test(v.charAt(start - 1))) start--;
      replaceRange(start, s, '');
      ta.selectionStart = ta.selectionEnd = start;
    } else {
      var end = s;
      while (end < v.length && /\s/.test(v.charAt(end))) end++;
      while (end < v.length && isDelWordChar(v.charAt(end))) end++;
      replaceRange(s, end, '');
      ta.selectionStart = ta.selectionEnd = s;
    }
    renderEditor(); updateCaret();
  }
  // A tiny in-memory clipboard history. The browser owns the real clipboard;
  // this only remembers text the user copied in this session so the paste
  // picker can put it back without another round trip to the OS.
  var CLIP_HISTORY = [], CLIP_HISTORY_MAX = 12;
  function rememberClipboard(text) {
    var t = String(text || '');
    if (!t) return;
    var i = CLIP_HISTORY.indexOf(t);
    if (i >= 0) CLIP_HISTORY.splice(i, 1);
    CLIP_HISTORY.push(t);
    while (CLIP_HISTORY.length > CLIP_HISTORY_MAX) CLIP_HISTORY.shift();
  }
  document.addEventListener('copy', function () {
    var text = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (text) rememberClipboard(text);
  });
  document.addEventListener('paste', function (e) {
    var clip = e && e.clipboardData;
    if (!clip || typeof clip.getData !== 'function') return;
    var text = clip.getData('text/plain');
    if (text) rememberClipboard(text);
  });
  function pasteHistoryLabel(text) {
    var one = String(text).replace(/\r?\n/g, ' ↵ ').slice(0, 80);
    return one.length < String(text).length ? one + '…' : one;
  }
  function openPasteHistory() {
    if (!CLIP_HISTORY.length) { toast('Clipboard history is empty'); return; }
    showModal({
      title: 'Paste from History', icon: 'clipboard', message: 'Choose text to insert at the caret',
      radios: CLIP_HISTORY.map(function (t, i) {
        return { name: 'clip', value: String(i), def: i === CLIP_HISTORY.length - 1, label: pasteHistoryLabel(t) };
      }),
      buttons: [
        { label: 'Cancel' },
        { label: 'Paste', primary: true, onClick: function (v) {
          var t = CLIP_HISTORY[Number(v.clip)];
          if (t != null) insertText(t);
        } }
      ]
    });
  }
  // Extend / Shrink Selection walks fixed, predictable stages: word, line,
  // paragraph, whole file. The range is recomputed from the anchor on every
  // press, so editing or moving the caret silently resets the chain.
  var SEL_ANCHOR = 0, SEL_STAGE = 0, SEL_PATH = '', SEL_LAST = null;
  function selectionStageRange(stage, at) {
    var v = ta.value, before = v.slice(0, at), lineStart = before.lastIndexOf('\n') + 1;
    var lineEnd = v.indexOf('\n', lineStart); if (lineEnd < 0) lineEnd = v.length;
    if (stage === 1) {
      var s = at, e = at;
      while (s > 0 && isDelWordChar(v.charAt(s - 1))) s--;
      while (e < v.length && isDelWordChar(v.charAt(e))) e++;
      if (s === e) { s = Math.max(0, at - 1); e = Math.min(v.length, at + 1); }
      return { start: s, end: e };
    }
    if (stage === 2) return { start: lineStart, end: lineEnd };
    if (stage === 3) {
      var ps = lineStart, pe = lineEnd;
      while (ps > 0) {
        var prevEnd = ps - 1, prevStart = v.lastIndexOf('\n', prevEnd - 1) + 1;
        if (!v.slice(prevStart, prevEnd).trim()) break;
        ps = prevStart;
      }
      while (pe < v.length) {
        var nextStart = pe + 1, nextEnd = v.indexOf('\n', nextStart);
        if (nextEnd < 0) nextEnd = v.length;
        if (!v.slice(nextStart, nextEnd).trim()) break;
        pe = nextEnd;
      }
      return { start: ps, end: pe };
    }
    return { start: 0, end: v.length };
  }
  function extendSelection(delta) {
    if (!currentFile) return;
    var pos = ta.selectionStart;
    if (SEL_PATH !== currentFile || !SEL_LAST ||
        (delta > 0 && (ta.selectionStart !== SEL_LAST.start || ta.selectionEnd !== SEL_LAST.end))) {
      SEL_STAGE = 0; SEL_ANCHOR = pos; SEL_LAST = null; SEL_PATH = currentFile;
    }
    var next = Math.max(0, Math.min(4, SEL_STAGE + delta));
    if (next === SEL_STAGE && delta < 0) return;
    SEL_STAGE = next;
    if (!next) {
      ta.selectionStart = ta.selectionEnd = SEL_ANCHOR;
      SEL_LAST = null; updateCaret(); return;
    }
    var range = selectionStageRange(next, SEL_ANCHOR);
    SEL_LAST = range;
    ta.selectionStart = range.start; ta.selectionEnd = range.end;
    renderEditor(); updateCaret();
  }
  // Ctrl+Q shows the local answer immediately, then asks the active language
  // server and upgrades the same dialog in place. A server with no hover, or no
  // server at all, leaves the fallback visible instead of an empty box.
  var DOC_SEQ = 940000;
  var DOC_REQ = 0;
  var DOC_WORD = '';
  function localDocumentation(word) {
    var doc = '';
    if (CMP && CMP.items) {
      for (var i = 0; i < CMP.items.length; i++) {
        if (CMP.items[i].label === word) {
          doc = (CMP.docs && CMP.docs[word]) || CMP.items[i].documentation || '';
          break;
        }
      }
    }
    if (!doc) {
      var lines = ta.value.slice(0, ta.selectionStart).split('\n');
      for (var j = lines.length - 1; j >= 0; j--) {
        if (/^\s*(def|class|function|func|public|private|interface)\b/.test(lines[j])) { doc = lines[j].trim(); break; }
      }
    }
    return doc || 'No local documentation is available for this symbol.';
  }
  // Quick Definition is deliberately read-only: show the declaration, then
  // leave the caret exactly where the user left it. Quick Documentation may
  // upgrade the same dialog with LSP hover text; this one asks for definition.
  var QF_SEQ = 960000, QF_WAIT = 0, QF_WORD = '';
  function localDefinition(word) {
    var lines = ta.value.split('\n');
    var re = new RegExp('\\b(def|class|function|func|interface|struct|var|let|const)\\s+' + escapeRe(word) + '\\b');
    for (var i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return 'line ' + (i + 1) + ' · ' + lines[i].trim();
    }
    return '';
  }
  function quickDefinition() {
    var v = ta.value, pos = ta.selectionStart;
    var before = v.slice(0, pos), line = before.split('\n').length - 1;
    var col = pos - before.lastIndexOf('\n') - 1;
    var w = wordAt(v.split('\n')[line] || '', col);
    if (!w || !w.text) { toast('Place the caret on a symbol first'); return; }
    var snippet = localDefinition(w.text);
    showModal({
      title: 'Quick Definition', icon: 'file', message: w.text,
      detail: snippet || 'Looking for a definition…',
      sub: lspLang() ? 'Asking the language server…' : 'Local declaration only',
      buttons: [{ label: 'Close', primary: true }]
    });
    if (!lspLang()) return;
    QF_WAIT = ++QF_SEQ;
    QF_WORD = w.text;
    BRIDGE.send({ kind: 'definition', language: lspLang(), code: v, line: line,
      character: w.start, requestId: QF_WAIT });
  }
  function onQuickDefinition(m) {
    if (Number(m.requestId || 0) !== QF_WAIT) return;
    QF_WAIT = 0;
    var card = document.querySelector('.dlg-scrim .dlg');
    if (!card) return;
    var title = card.querySelector('.dlg-title'), msg = card.querySelector('.dlg-msg');
    if (!title || title.textContent.indexOf('Quick Definition') < 0) return;
    if (msg && msg.textContent.indexOf(QF_WORD) < 0) return;
    var detail = card.querySelector('.dlg-detail');
    if (!detail) return;
    if (m.unsupported) { detail.textContent = 'The language server does not provide definitions.'; return; }
    var loc = (m.locations || [])[0];
    if (!loc) { detail.textContent = 'No definition found.'; return; }
    var path = navEditPath(loc), text = navLabel(loc.uri, loc.line);
    if (navSameFile(currentFile, path)) {
      var lineText = (ta.value.split('\n')[Number(loc.line) || 0] || '').trim();
      detail.textContent = text + (lineText ? '\n' + lineText : '');
    } else detail.textContent = text;
    var sub = card.querySelector('.dlg-msg .sub');
    if (sub) sub.textContent = 'From the language server';
  }
  function quickDocumentation() {
    var v = ta.value, pos = ta.selectionStart;
    var before = v.slice(0, pos), line = before.split('\n').length - 1;
    var col = pos - before.lastIndexOf('\n') - 1;
    var w = wordAt((v.split('\n')[line] || ''), col);
    if (!w || !w.text) { toast('Place the caret on a symbol first'); return; }
    var word = w.text;
    showModal({
      title: 'Quick Documentation', icon: 'file', message: word,
      detail: localDocumentation(word),
      sub: lspLang() ? 'Asking the language server…' : '',
      buttons: [{ label: 'Close', primary: true }]
    });
    if (!lspLang()) return;
    DOC_REQ = ++DOC_SEQ;
    DOC_WORD = word;
    BRIDGE.send({ kind: 'hover', code: v, language: lspLang(), line: line, character: w.start + 1, requestId: DOC_REQ });
  }
  function onDocumentationHover(m) {
    if (m.requestId !== DOC_REQ) return;
    DOC_REQ = 0;
    var text = hoverText(m.hover);
    if (!text) return;
    var card = document.querySelector('.dlg-scrim .dlg');
    if (!card) return;
    var title = card.querySelector('.dlg-title'), msg = card.querySelector('.dlg-msg');
    if (!title || title.textContent.indexOf('Quick Documentation') < 0) return;
    if (!msg || msg.textContent.indexOf(DOC_WORD) < 0) return;
    var detail = card.querySelector('.dlg-detail');
    if (detail) detail.textContent = text;
    var sub = card.querySelector('.dlg-msg .sub');
    if (sub) sub.textContent = 'From the language server';
  }
  function openGotoLine() {
    var here = ta.value.slice(0, ta.selectionStart).split('\n').length;
    showModal({
      title: 'Go to Line', icon: 'file',
      fields: [{ name: 'line', label: 'Line', value: String(here), validator: function (v) { return /^\d+$/.test(v) ? null : 'Enter a line number'; } }],
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
    if (typeof noteEditLocation === 'function') noteEditLocation();
  }
  function toggleCase(mode) {
    if (!CAN_EDIT()) { toast('Read-only buffer'); return; }
    var s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e) { toast('Select text to change its case'); return; }
    var sel = ta.value.slice(s, e), out;
    if (mode === 'upper') out = sel.toUpperCase();
    else if (mode === 'lower') out = sel.toLowerCase();
    else if (mode === 'toggle') out = sel.replace(/[A-Za-z]/g, function (c) { return c >= 'A' && c <= 'Z' ? c.toLowerCase() : c.toUpperCase(); });
    else out = sel.replace(/\w\S*/g, function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); });
    ta.value = ta.value.slice(0, s) + out + ta.value.slice(e);
    ta.selectionStart = s; ta.selectionEnd = s + out.length;
    renderEditor(); updateCaret();
    if (typeof noteEditLocation === 'function') noteEditLocation();
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
    setStatusHint(dir < 0 ? 'Moved line up' : 'Moved line down');
    if (typeof noteEditLocation === 'function') noteEditLocation();
  }
  function indentBlock(dir) {
    if (!CAN_EDIT()) { toast('Read-only buffer'); return; }
    var b = lineBounds();
    var lines = ta.value.slice(b.start, b.end).split('\n');
    var unit = editorIndentUnit();
    if (dir > 0) lines = lines.map(function (l) { return l ? unit + l : l; });
    else lines = lines.map(function (l) {
      if (l.indexOf(unit) === 0) return l.slice(unit.length);
      return l.replace(/^ {1,8}/, '').replace(/^\t/, '');
    });
    replaceLines(lines);
    setStatusHint((dir > 0 ? 'Indented ' : 'Unindented ') + lines.length + ' line' + (lines.length === 1 ? '' : 's'));
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
  var AUTO_INTERP_REQ = 0; // requestId of the background discovery, if any
  var AUTO_INTERP_LAST = 0; // highest auto request issued; older replies are stale
  var AUTO_MATCH_ROOT = ''; // one discovery per root; a manual pin always wins
  /**
   * After a project opens, look once for a local environment and adopt it when
   * nothing is pinned. This is a request, not a guess: discovery is the same
   * code the picker uses, so parent/child .venv and conda envs are found by the
   * same rules. A user pin is never overwritten, and the whole behaviour can be
   * switched off in Preferences.
   */
  function savedProjectInterpreter(root) {
    var all = (PREFS.projectInterpreters && typeof PREFS.projectInterpreters === 'object') ? PREFS.projectInterpreters : {};
    return Object.prototype.hasOwnProperty.call(all, root) ? all[root] : undefined;
  }
  function rememberProjectInterpreter(root, path) {
    var all = (PREFS.projectInterpreters && typeof PREFS.projectInterpreters === 'object') ? PREFS.projectInterpreters : {};
    all[root] = path || '';
    updatePrefs({ projectInterpreters: all });
  }
  function applyProjectInterpreter() {
    var root = String(PROJECT_LAST_ROOT || '');
    if (!root) return;
    var saved = savedProjectInterpreter(root);
    // An explicit pin wins even when automatic matching is off: the preference
    // only decides whether to discover *new* environments, not whether to honour
    // one the user already chose.
    if (saved) {
      AUTO_MATCH_ROOT = root;
      BRIDGE.send({ kind: 'setInterpreter', language: currentLang || 'python', path: saved });
      return;
    }
    if (PREFS.autoVenv === false) return;
    if (AUTO_MATCH_ROOT === root) return;
    // '' means this project was explicitly set back to auto with no pin; do not
    // keep asking on every fsRoot frame, but leave a later discovery possible
    // when the user changes the preference in the same session.
    AUTO_MATCH_ROOT = root;
    if (saved === '') return;
    AUTO_INTERP_REQ = ++NAV_SEQ;
    AUTO_INTERP_LAST = AUTO_INTERP_REQ;
    BRIDGE.send({ kind: 'interpreters', language: currentLang || 'python', sdkName: LAST_SDK, requestId: AUTO_INTERP_REQ, auto: true });
  }
  function onAutoInterpreters(m) {
    // Two roots can be announced during a startup restore. A reply for the
    // default root must never pin the interpreter of the project that replaced
    // it, and an older request must never beat a newer one.
    var req = Number(m.requestId) || 0;
    if (req && AUTO_INTERP_LAST && req < AUTO_INTERP_LAST) return;
    if (req) AUTO_INTERP_LAST = Math.max(AUTO_INTERP_LAST, req);
    if (String(m.root || '') !== String(PROJECT_LAST_ROOT || '')) return;
    var list = m.candidates || [];
    // discoverInterpreters already ranks project venvs first; take the best
    // local one, never a bare PATH binary just because it was found.
    var best = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].kind === 'venv' || list[i].kind === 'conda') { best = list[i]; break; }
    }
    if (!best || !best.path) return;
    rememberProjectInterpreter(PROJECT_LAST_ROOT, best.path);
    BRIDGE.send({ kind: 'setInterpreter', language: m.language, path: best.path, auto: true });
    setStatusHint('Matched local ' + m.language + ' environment: ' + best.label);
  }
  /** Native file picker for a compiler that discovery did not find. */
  function chooseCompilerPath(typed, language) {
    var p = nativeOpen({ multiple: false, title: 'Select compiler executable', defaultPath: typed || '',
      filters: [{ name: 'Executable', extensions: ['exe', 'bin', 'sh', 'cmd', ''] }] });
    if (!p) { toast('The file picker is available in the desktop app. Enter the path above.'); return; }
    p.then(function (r) {
      var path = Array.isArray(r) ? r[0] : r;
      if (path) {
        rememberProjectInterpreter(PROJECT_LAST_ROOT, String(path));
        BRIDGE.send({ kind: 'setInterpreter', language: language, path: String(path) });
      }
    }, function (err) { pickerFailed('Select compiler', err); });
  }
  function openInterpreter() {
    var lang = currentLang || 'python';
    toast('Scanning ' + lang + ' interpreters…');
    BRIDGE.send({ kind: 'interpreters', language: lang, sdkName: LAST_SDK });
  }
  function showInterpreters(m) {
    var list = m.candidates || [];
    var creates = m.creates || [];
    // "No interpreter found" used to be the end of the road. When the plugin can
    // create one, the dialog is the place to say so.
    if (!list.length && !creates.length) {
      toast('No ' + m.language + ' interpreter found');
      return;
    }
    var radios = list.map(function (c) {
      // The version is the reason to open this dialog: show it for every
      // candidate, not just when a server happened to put it in the label.
      var ver = c.version ? '  · ' + c.version : '';
      var kind = c.kind ? '  · ' + c.kind : '';
      return {
        name: 'bin', value: c.path, def: c.path === m.active,
        label: c.label + ver + kind + (c.sdkMatch ? '  · SDK' : '') + (c.path === m.active ? '  · active' : '')
      };
    });
    // Only one radio in the group may start checked — the HTML parser keeps the
    // *last* checked one, so "Auto" must stay unchecked while an interpreter is
    // active, or the dialog would silently apply the unpinned state.
    radios.push({ name: 'bin', value: '', label: 'Auto (discovered, no pin)', def: !m.active && !m.pinned });
    var buttons = [{ label: 'Cancel' }];
    if (creates.length) {
      buttons.push({ label: 'New Environment…', onClick: function () { openNewEnvironment(m); } });
    }
    // A discovered list is never exhaustive: the compiler may live in a custom
    // location. The engine owns validation (existsSync) and reports a bad path
    // through interpreterSet, so the dialog can simply send what the user typed.
    buttons.push({ label: 'Browse…', onClick: function (v) {
      chooseCompilerPath(v.custom, m.language);
    } });
    buttons.push({ label: 'Apply', primary: true, onClick: function (v) {
      var custom = String(v.custom || '').trim();
      var bin = custom || v.bin || undefined;
      // Remember the choice for this folder. An empty value is an explicit
      // unpin: auto-match must not undo a decision the user just made.
      rememberProjectInterpreter(PROJECT_LAST_ROOT, bin || '');
      BRIDGE.send({ kind: 'setInterpreter', language: m.language, path: bin });
    } });
    showModal({
      title: 'Project interpreter — ' + m.language, icon: 'settings',
      message: m.root,
      sub: (list.length ? list.length + ' candidate' + (list.length === 1 ? '' : 's') : 'no candidate yet') +
        (creates.length ? ' · can create ' + creates.map(function (c) { return c.label; }).join(' / ') : ''),
      fields: [{ name: 'custom', label: 'Compiler path (leave empty to use a candidate)', value: '',
        placeholder: '/usr/bin/python3  or  C:\\Python313\\python.exe' }],
      radios: radios,
      buttons: buttons
    });
  }

  /**
   * Create an environment from the plugin's declared providers.
   *
   * The dialog is a *request*, not a form that runs anything: the engine validates
   * the target (inside the project, empty) and owns the spawn, so an invalid path
   * comes back as one sentence in the terminal instead of a half-built .venv.
   */
  function openNewEnvironment(m) {
    var creates = m.creates || [];
    if (!creates.length) { toast('This language declares no environment provider'); return; }
    var first = creates[0];
    showModal({
      title: 'New ' + m.language + ' environment', icon: 'settings',
      message: m.root,
      sub: 'Created inside the project. The interpreter switches to it when the command succeeds.',
      radios: creates.map(function (c, i) {
        return { name: 'prov', value: c.id, label: c.label + (c.defaultPath ? '   →  ' + c.defaultPath : ''), def: i === 0 };
      }),
      fields: [
        { name: 'path', label: 'Directory (project-relative)', value: first.defaultPath || '.venv', placeholder: '.venv' },
        { name: 'version', label: 'Version', value: '', placeholder: first.wantsVersion ? 'required, e.g. 3.12' : 'optional' }
      ],
      buttons: [
        { label: 'Cancel' },
        { label: 'Create', primary: true, onClick: function (v) {
          toggleWindow('terminal');
          termWrite('Creating ' + m.language + ' environment (' + String(v.prov || '') + ')\n', 'dim');
          renderTermOut();
          BRIDGE.send({ kind: 'envCreate', language: m.language, provider: v.prov, path: v.path, version: v.version });
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
  /** F2 / F3 belong to the editor; tree rows, dialogs and find inputs own them. */
  function shortcutInForm(e) {
    var t = e.target;
    if (t === FIND.input) return false;
    if (t && t.closest && t.closest('input, select, .tnode, .modal.open, .dlg-scrim, #searchModal.open')) return true;
    var a = document.activeElement;
    return !!(a && a.classList && (a.classList.contains('tnode') || a.classList.contains('mres')));
  }
  /** A modal or form owns its keys. Editor shortcuts must not fire behind it. */
  function shortcutInTypingContext(e) {
    var t = e.target;
    if (t === ta || (t && t.closest && t.closest('.CodeMirror'))) return false;
    var sel = 'input, select, textarea, .modal.open, .dlg-scrim, #searchModal.open';
    return !!(t && t.closest && t.closest(sel));
  }
  /** Symbol declarations in this file: LSP cache when fresh, local outline otherwise. */
  function methodSpans() {
    var out = [], seen = {};
    if (STRUCT.source === 'lsp' && STRUCT.file === currentFile && STRUCT.symbols.length) {
      STRUCT.symbols.forEach(function (s) {
        var line = Math.max(0, Number(s.line) || 0);
        if (seen[line]) return;
        seen[line] = true;
        out.push({ line: line, name: s.name || 'symbol' });
      });
    } else {
      ta.value.split('\n').forEach(function (l, i) {
        if (/^\s*(def|class|function|func|interface|struct|enum|public|private|protected)\b/.test(l)) {
          out.push({ line: i, name: l.trim() });
        }
      });
    }
    return out.sort(function (a, b) { return a.line - b.line; });
  }
  function stepMethod(dir) {
    var list = methodSpans();
    if (!list.length) { toast('No method declarations in this file'); return; }
    var here = caretSnapshot().line || 0, target = null;
    if (dir > 0) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].line > here) { target = list[i]; break; }
      }
      if (!target) target = list[0];
    } else {
      for (var j = list.length - 1; j >= 0; j--) {
        if (list[j].line < here) { target = list[j]; break; }
      }
      if (!target) target = list[list.length - 1];
    }
    gotoLine(target.line, 0);
    setStatusHint((dir > 0 ? 'Next' : 'Previous') + ' method · ' + target.name);
  }
  /** Jump to the next or previous diagnostic, wrapping at the document edge. */
  function gotoDiagnostic(dir) {
    if (!DIAGS || !DIAGS.length) { toast('No highlighted problems in this file'); return; }
    var list = DIAGS.slice().sort(function (a, b) {
      var la = a.line || 0, lb = b.line || 0;
      return la === lb ? ((a.character || 0) - (b.character || 0)) : la - lb;
    });
    var here = caretSnapshot().line || 0, target = null;
    if (dir > 0) {
      for (var i = 0; i < list.length; i++) {
        if ((list[i].line || 0) > here) { target = list[i]; break; }
      }
      if (!target) target = list[0];
    } else {
      for (var j = list.length - 1; j >= 0; j--) {
        if ((list[j].line || 0) < here) { target = list[j]; break; }
      }
      if (!target) target = list[list.length - 1];
    }
    gotoLine(target.line || 0, target.character || 0);
    setStatusHint((dir > 0 ? 'Next' : 'Previous') + ' problem · line ' + ((target.line || 0) + 1));
  }
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'F2' || e.key === 'F3') && !e.ctrlKey && !e.altKey && !shortcutInForm(e)) {
      e.preventDefault();
      if (e.key === 'F2') gotoDiagnostic(e.shiftKey ? -1 : 1);
      else repeatFind(e.shiftKey ? -1 : 1);
      return;
    }
    // Dialogs and form fields own their keys. The two exceptions are Escape
    // (handled below by every dialog) and Up/Down inside Search Everywhere,
    // which has its own result-list navigation later in this handler.
    if (shortcutInTypingContext(e) && e.key !== 'Escape' &&
        e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
        (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      stepMethod(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.key === 'F7') {
      e.preventDefault(); highlightUsages(); return;
    }
    var editorKey = e.target === ta || !!(e.target && e.target.closest && e.target.closest('.CodeMirror'));
    // Ctrl+Shift+Backspace is Last Edit Location, not word deletion. Keep the
    // plain word-delete branch free of Shift so that later handler can see it.
    if (editorKey && e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault(); deleteWord(e.key === 'Backspace' ? -1 : 1); return;
    }
    if (editorKey && e.ctrlKey && !e.altKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault(); extendSelection(e.shiftKey ? -1 : 1); return;
    }
    if (editorKey && e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault(); openPasteHistory(); return;
    }
    // F5 refreshes the project, not the WebView page. The context menu offers
    // the same command so mouse users can find it.
    if (e.key === 'F5' && !e.ctrlKey && !e.altKey && !e.shiftKey) { e.preventDefault(); refreshProjectTree(); return; }
    if (e.ctrlKey && e.altKey && e.shiftKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copyCodeReference(); return; }
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.key === 'Backspace') { e.preventDefault(); gotoLastEditLocation(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'F1') { e.preventDefault(); revealCurrentInTree(); return; }
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.shiftKey && e.key === 'Insert') { e.preventDefault(); newScratchFile(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); openRecentChanges(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openSearch(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); openFindAction(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'Tab') { e.preventDefault(); cycleTabSwitcher(e.shiftKey); return; }
    // Reference keymap: navigation, refactoring and debug-map bindings. Each is
    // attached to a real action in this shell (or an honest toast where the
    // product deliberately has no such feature), never a dead key.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'Left')) { e.preventDefault(); historyBack(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowRight' || e.key === 'Right')) { e.preventDefault(); historyForward(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); openGoToSymbol(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); openRecent(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'Insert') { e.preventDefault(); showNewPopup($('newBtn').getBoundingClientRect().left, 0, ''); return; }
    // F6 / Ctrl+F6 are deliberately unbound: Move and Change Signature need
    // semantic, project-wide edits this build cannot produce. Advertising a
    // key that only reports "not implemented" is worse than leaving it free.
    if (e.key === 'F7') { e.preventDefault(); if (DBG.active) BRIDGE.send({ kind: 'debugCmd', cmd: 'stepIn' }); else toast('Start a debug session first  (Shift+F9)'); return; }
    if (e.key === 'F8' && !e.ctrlKey && !e.altKey && !e.shiftKey) { e.preventDefault(); if (DBG.active) BRIDGE.send({ kind: 'debugCmd', cmd: 'next' }); else toast('Start a debug session first  (Shift+F9)'); return; }
    if (e.key === 'F9' && !e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); if (DBG.active) BRIDGE.send({ kind: 'debugCmd', cmd: 'continue' }); else toast('Start a debug session first  (Shift+F9)'); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F8') { e.preventDefault(); toggleWindow('debug'); return; }
    if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); profileCurrent(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F12') {
      e.preventDefault();
      $('leftPanel').classList.add('hidden'); $('dock').classList.add('hidden');
      var ap = $('assistantPanel'); if (ap && !ap.classList.contains('hidden')) assistantOpen();
      renderStrip(); saveLayout(); return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'F12') { e.preventDefault(); toggleWindow('structure'); return; }
    if (e.key === 'F12' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { e.preventDefault(); toggleWindow('terminal'); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'F12') { e.preventDefault(); toggleWindow('terminal'); return; }
    if (e.ctrlKey && e.shiftKey && e.key === '[') { e.preventDefault(); foldCommand('toggle'); return; }
    if (e.ctrlKey && e.shiftKey && e.key === ']') { e.preventDefault(); foldCommand('unfold'); return; }
    if (e.ctrlKey && e.shiftKey && e.code === 'NumpadSubtract') { e.preventDefault(); foldCommand('foldAll'); return; }
    if (e.ctrlKey && e.shiftKey && e.code === 'NumpadAdd') { e.preventDefault(); foldCommand('unfoldAll'); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); joinLines(); return; }
    if (e.altKey && e.shiftKey && e.key === 'ArrowUp') { e.preventDefault(); moveLine(-1); return; }
    if (e.altKey && e.shiftKey && e.key === 'ArrowDown') { e.preventDefault(); moveLine(1); return; }
    if (e.key === 'F1' && !e.ctrlKey && !e.altKey && !e.shiftKey) { e.preventDefault(); openAbout(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); docCmd('undo'); return; }
    if (e.key === 'Escape') { closeMenus(); closeTabSwitcher(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      var searchDialog = $('searchModal');
      if (searchDialog && searchDialog.classList.contains('open') && searchDialog.contains(e.target)) {
        var searchRows = $('searchBody').querySelectorAll('.mres');
        if (searchRows.length) {
          e.preventDefault();
          searchIndex = (searchIndex + (e.key === 'ArrowDown' ? 1 : searchRows.length - 1)) % searchRows.length;
          searchRows.forEach(function (row, i) { row.classList.toggle('sel', i === searchIndex); });
          if (searchRows[searchIndex] && searchRows[searchIndex].scrollIntoView) searchRows[searchIndex].scrollIntoView({ block: 'nearest' });
          return;
        }
      }
    }
    // Order matters: the Alt/Ctrl combos must be tested before the bare Ctrl+S,
    // otherwise Ctrl+Alt+S is swallowed by the save shortcut.
    if (e.ctrlKey && e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); openSettings(); return; }
    if (e.ctrlKey && e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFlame(); return; }
    if (e.ctrlKey && e.altKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); reformatCode(); return; }
    if (e.ctrlKey && e.altKey && e.shiftKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); impOpen(); return; }
    if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); optimizeImports(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault(); mdToggle(); return;
    }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'F4' && currentFile && !(e.target && e.target.closest && e.target.closest('.dlg-scrim, .modal.open'))) {
      e.preventDefault(); closeTab(currentFile); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault(); reopenClosedTab(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault(); gotoMatchingBracket(); return;
    }
    // PyCharm's editor keys. Ctrl+F must win over the browser's find bar, which
    // is why every one of these prevents the default.
    if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFindBar(false); return; }
    if (e.ctrlKey && !e.altKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); openFindBar(true); return; }
    if (e.ctrlKey && !e.altKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateLine(); return; }
    if (e.ctrlKey && !e.altKey && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); deleteLine(); return; }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === '/') { e.preventDefault(); toggleComment(); return; }
    if (e.ctrlKey && e.shiftKey && e.key === '/') { e.preventDefault(); toggleBlockComment(); return; }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'q' || e.key === 'Q')) { e.preventDefault(); quickDocumentation(); return; }
    if (e.ctrlKey && !e.altKey && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); openGotoLine(); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); docCmd('redo'); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); openFindInFiles(); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) { e.preventDefault(); openFindInFiles(true); return; }
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'I' || e.key === 'i')) { e.preventDefault(); quickDefinition(); return; }
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'U' || e.key === 'u')) { e.preventDefault(); toggleCase('toggle'); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveAsNative(); return; }
    if (e.ctrlKey && (e.key === 's' || e.key === 'S') && !e.shiftKey && !e.altKey) { e.preventDefault(); saveShortcut(); return; }
    if (e.ctrlKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); openNativeFile(); return; }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); openPalette(); return; }
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
    // Bookmarks follow the PyCharm keymap. Full screen moves to Ctrl+Shift+F11:
    // leaving a key bound to two actions would make one of them unreliable.
    if (e.ctrlKey && e.shiftKey && e.key === 'F11') { e.preventDefault(); toggleFullScreen(); return; }
    if (e.ctrlKey && !e.shiftKey && e.key === 'F11') { e.preventDefault(); promptMnemonicBookmark(); return; }
    if (e.shiftKey && !e.ctrlKey && e.key === 'F11') { e.preventDefault(); showLineBookmarks(); return; }
    if (e.key === 'F11' && !e.ctrlKey && !e.altKey && !e.shiftKey) { e.preventDefault(); setLineBookmark(''); return; }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomUi(1); return; }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === '-') { e.preventDefault(); zoomUi(-1); return; }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === '0') { e.preventDefault(); zoomUi(0); return; }
    if (e.key === 'Escape') { if (FLAME.open) closeFlame(); hideCtx(); return; }
    if (e.key === 'Shift' && !e.repeat) {
      var now = Date.now();
      if (now - lastShift < 400) { openSearch(); lastShift = 0; } else lastShift = now;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    var map = { '1': 'project', '9': 'vcs', '6': 'packages', '7': 'structure', 'a': 'ai', 'm': 'mcp', '4': 'run', '5': 'tests', '8': 'perf', '0': 'logs' };
    var k = e.key.toLowerCase();
    if (map[k]) { e.preventDefault(); toggleWindow(map[k]); }
  });
  var lastShift = 0;

  // ---------- draggable shell splitters ----------
  function wireShellSplitters() {
    var root = document.documentElement;
    var project = $('leftPanel'), dock = $('dock'), assistant = $('assistantPanel');
    var leftHandle = $('leftResize'), dockHandle = $('dockResize'), rightHandle = $('rightResize');
    var projectWidth = Math.max(176, Math.min(480, Number(PREFS.projectWidth) || 240));
    var dockHeight = Math.max(120, Math.min(560, Number(PREFS.dockHeight) || 205));
    var assistantWidth = Math.max(210, Math.min(390, Number(PREFS.assistantWidth) || 220));
    function setProjectWidth(value) {
      projectWidth = Math.max(176, Math.min(480, Math.round(value)));
      root.style.setProperty('--project-width', projectWidth + 'px');
      leftHandle.setAttribute('aria-valuenow', String(projectWidth));
    }
    function setDockHeight(value) {
      dockHeight = Math.max(120, Math.min(Math.min(560, window.innerHeight * .65), Math.round(value)));
      root.style.setProperty('--dock-height', dockHeight + 'px');
      dockHandle.setAttribute('aria-valuenow', String(dockHeight));
    }
    function maxAssistantWidth() { return Math.max(210, Math.min(390, window.innerWidth * .55)); }
    function setAssistantWidth(value) {
      assistantWidth = Math.max(210, Math.min(maxAssistantWidth(), Math.round(value)));
      root.style.setProperty('--right-width', assistantWidth + 'px');
      rightHandle.setAttribute('aria-valuenow', String(assistantWidth));
    }
    setProjectWidth(projectWidth); setDockHeight(dockHeight); setAssistantWidth(assistantWidth);
    function bind(handle, axis, getSize, setSize, min, max) {
      var start = 0, initial = 0, active = false;
      handle.addEventListener('pointerdown', function (event) {
        if (event.button !== 0 || (axis === 'x' && project.classList.contains('hidden')) || (axis === 'y' && dock.classList.contains('hidden'))) return;
        active = true; start = axis === 'x' ? event.clientX : event.clientY; initial = getSize();
        handle.classList.add('dragging'); document.body.classList.add(axis === 'x' ? 'resize-col' : 'resize-row');
        if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      handle.addEventListener('pointermove', function (event) {
        if (!active) return;
        var delta = (axis === 'x' ? event.clientX : event.clientY) - start;
        var next = axis === 'x' ? initial + delta : initial - delta;
        setSize(Math.max(min, Math.min(max(), next)));
      });
      function finish() {
        if (!active) return;
        active = false; handle.classList.remove('dragging');
        document.body.classList.remove('resize-col', 'resize-row');
        savePrefs({ projectWidth: projectWidth, dockHeight: dockHeight });
      }
      handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
      handle.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        if ((axis === 'x' && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || (axis === 'y' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        var sign = (event.key === 'ArrowRight' || event.key === 'ArrowUp') ? 1 : -1;
        setSize(getSize() + sign * (event.shiftKey ? 24 : 8));
        savePrefs({ projectWidth: projectWidth, dockHeight: dockHeight });
      });
    }
    bind(leftHandle, 'x', function () { return projectWidth; }, setProjectWidth, 176, function () { return 480; });
    bind(dockHandle, 'y', function () { return dockHeight; }, setDockHeight, 120, function () { return Math.min(560, window.innerHeight * .65); });

    // The AI drawer sits on the right side of the center column, so dragging its
    // handle left makes the drawer wider (the inverse of the project splitter).
    var rightStart = 0, rightInitial = 0, rightActive = false;
    rightHandle.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || assistant.classList.contains('hidden')) return;
      rightActive = true; rightStart = event.clientX; rightInitial = assistantWidth;
      rightHandle.classList.add('dragging'); document.body.classList.add('resize-col');
      if (rightHandle.setPointerCapture) {
        try { rightHandle.setPointerCapture(event.pointerId); } catch (err) { /* document listeners remain the fallback */ }
      }
      event.preventDefault();
    });
    rightHandle.addEventListener('pointermove', function (event) {
      if (!rightActive) return;
      setAssistantWidth(rightInitial - (event.clientX - rightStart));
    });
    function finishRightResize() {
      if (!rightActive) return;
      rightActive = false; rightHandle.classList.remove('dragging');
      document.body.classList.remove('resize-col');
      savePrefs({ assistantWidth: assistantWidth });
    }
    rightHandle.addEventListener('pointerup', finishRightResize);
    rightHandle.addEventListener('pointercancel', finishRightResize);
    rightHandle.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      var step = event.shiftKey ? 24 : 8;
      setAssistantWidth(assistantWidth + (event.key === 'ArrowLeft' ? step : -step));
      savePrefs({ assistantWidth: assistantWidth });
    });
  }

  // ---------- boot ----------
  // Restore persisted theme / layout / tabs before the first paint.
  if (PREFS.theme) document.documentElement.setAttribute('data-theme', PREFS.theme);
  // Zoom used to be written to localStorage but never restored on boot.
  try {
    var savedZoom = Number(localStorage.getItem('nl-zoom'));
    if (isFinite(savedZoom) && savedZoom >= 0.7 && savedZoom <= 1.6) {
      UI_ZOOM = savedZoom;
      document.documentElement.style.zoom = savedZoom === 1 ? '' : String(savedZoom);
    }
  } catch (e) { /* storage unavailable */ }
  wireShellSplitters();
  if (PREFS.left) activeLeft = PREFS.left;
  if (PREFS.bottom) activeBottom = PREFS.bottom;
  if (PREFS.leftHidden === true) $('leftPanel').classList.add('hidden');
  else $('leftPanel').classList.remove('hidden');
  if (PREFS.bottomHidden) $('dock').classList.add('hidden');
  if (PREFS.assistantHidden === false) {
    var savedAssistant = $('assistantPanel');
    if (savedAssistant && savedAssistant.classList.contains('hidden')) assistantOpen();
  }
  if (PREFS.restoreTabs === false) { TABS = []; currentFile = null; }
  else if (PREFS.tabs && PREFS.tabs.length) { TABS = PREFS.tabs.slice(); currentFile = PREFS.current || TABS[0]; }
  // Scratch content is IDE state and exists before the first fs round-trip.
  hydrateScratch();
  TAB_MRU = TABS.slice(); touchTabMru(currentFile);
  // A restored file that has neither bundled content nor a scratch buffer would
  // open empty before the engine answers; fall back to the first showable tab.
  if (!FILES[currentFile] && !BUFFERS[currentFile]) {
    currentFile = TABS.filter(function (p) { return FILES[p] != null || BUFFERS[p] != null; })[0] || 'main.py';
  }
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
  // The reference shell paints breadcrumbs and a minimap above/beside the
  // editor on first paint, not only after the first file click.
  renderBreadcrumbs(currentFile); renderMinimap(ta.value);
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
