  // ---------- extensions modal ----------
  function renderExtModal(list) {
    var body = $('extBody');
    if (!list.length) { body.innerHTML = '<div class="empty">No extensions discovered.</div>'; return; }
    body.innerHTML = list.map(function (e) {
      var st = e.state || (e.compatible ? 'idle' : 'incompatible');
      var h = '<div class="xrow"><div class="top"><span class="nm">' + esc(e.name) + '</span>' +
        '<span class="state ' + st + '">' + st + '</span></div>' +
        '<div class="meta">' + esc(e.id) + ' · v' + esc(e.version) + ' · engine ^' + esc(e.engine) + '</div>';
      if (e.pid != null) h += '<div class="meta">pid ' + e.pid + ' · crashes ' + e.crashes + ' · rss ' + Math.round((e.rssBytes || 0) / 1048576) + 'MB</div>';
      var cmds = e.commands || [];
      if (cmds.length) {
        h += '<div class="cmds">';
        cmds.forEach(function (c) {
          h += '<button data-cmd="' + esc(c.id) + '">' + esc(c.title || c.id) + '</button>';
        });
        h += '</div>';
      }
      return h + '</div>';
    }).join('');
    body.querySelectorAll('[data-cmd]').forEach(function (b) {
      b.addEventListener('click', function () {
        BRIDGE.send({ kind: 'runExtensionCommand', id: b.getAttribute('data-cmd'), args: [], reqId: Date.now() % 100000 });
        toast('ran ' + b.getAttribute('data-cmd'));
      });
    });
  }

  // ---------- menus ----------
  var MENUS = {
    'File': [
      { label: 'New Project from Template...', sc: 'Ctrl+Alt+N', act: function () { wizOpen(); } },
      { label: 'Open Project...', sc: 'Ctrl+Alt+O', act: function () { impOpen(); } },
      { label: 'Add Dependency...', sc: 'Ctrl+Alt+D', act: function () { depOpen(); } },
      { label: 'Run Configuration...', sc: 'Ctrl+Alt+R', act: function () { rcOpen(); } },
      { sep: true },
      { label: 'Open...', sc: 'Ctrl+O', act: openNativeFile },
      { label: 'Open Folder...', act: openNativeFolder },
      { label: 'Save', sc: 'Ctrl+S', act: saveFile },
      { label: 'Save As...', sc: 'Ctrl+Shift+S', act: saveAsNative },
      { label: 'Close Tab', sc: 'Ctrl+F4', act: function () { if (currentFile) closeTab(currentFile); } },
      { sep: true },
      { label: 'Import PyCharm Run Configurations...', act: importIdeaConfigs },
      { label: 'Open Recent', act: openRecent }
    ],
    'Edit': [
      { label: 'Undo', sc: 'Ctrl+Z', act: function () { docCmd('undo'); } },
      { label: 'Redo', sc: 'Ctrl+Shift+Z', act: function () { docCmd('redo'); } },
      { sep: true },
      { label: 'Cut', sc: 'Ctrl+X', act: function () { docCmd('cut'); } },
      { label: 'Copy', sc: 'Ctrl+C', act: function () { docCmd('copy'); } },
      { label: 'Paste', sc: 'Ctrl+V', act: pasteAtCaret },
      { label: 'Select All', sc: 'Ctrl+A', act: selectAllInEditor }
    ],
    'View': [
      { label: 'Appearance: Darcula', sc: '', act: function () { setTheme('darcula'); } },
      { label: 'Appearance: Light', sc: '', act: function () { setTheme('light'); } },
      { sep: true },
      { label: 'Markdown Preview', sc: 'Alt+P', act: function () { mdToggle(); } },
      { sep: true },
      { label: 'Tool Window Bars', act: function () { $('strip').style.display = ($('strip').style.display === 'none' ? '' : 'none'); } },
      { label: 'Status Bar', act: function () { var s = document.querySelector('.status'); s.style.display = (s.style.display === 'none' ? '' : 'none'); } },
      { sep: true },
      { label: 'Zoom In', sc: 'Ctrl+=', act: function () { zoomUi(1); } },
      { label: 'Zoom Out', sc: 'Ctrl+-', act: function () { zoomUi(-1); } },
      { label: 'Reset Zoom', sc: 'Ctrl+0', act: function () { zoomUi(0); } },
      { label: 'Toggle Full Screen', sc: 'F11', act: toggleFullScreen }
    ],
    'Navigate': [
      { label: 'Search Everywhere', sc: '⇧⇧', act: openSearch },
      { label: 'Go to File...', sc: 'Ctrl+Shift+N', act: openGoToFile },
      { label: 'Go to Symbol...', sc: 'Ctrl+Alt+Shift+N', act: openGoToSymbol },
      { label: 'File Structure', sc: 'Ctrl+F12', act: function () { toggleWindow('structure'); } }
    ],
    'Code': [
      { label: 'Reformat Code', sc: 'Ctrl+Alt+L', act: reformatCode },
      { label: 'Optimize Imports', sc: 'Ctrl+Alt+O', act: optimizeImports },
      { sep: true },
      { label: 'Toggle Case: UPPER', act: function () { toggleCase('upper'); } },
      { label: 'Toggle Case: lower', act: function () { toggleCase('lower'); } },
      { label: 'Toggle Case: Title', act: function () { toggleCase('title'); } },
      { sep: true },
      { label: 'Sort Lines Ascending', act: function () { sortLines('asc'); } },
      { label: 'Sort Lines Descending', act: function () { sortLines('desc'); } },
      { label: 'Remove Duplicate Lines', act: function () { sortLines('unique'); } },
      { label: 'Join Lines', sc: 'Ctrl+Shift+J', act: joinLines },
      { sep: true },
      { label: 'Move Line Up', sc: 'Alt+Shift+Up', act: function () { moveLine(-1); } },
      { label: 'Move Line Down', sc: 'Alt+Shift+Down', act: function () { moveLine(1); } },
      { label: 'Indent Selection', sc: 'Tab', act: function () { indentBlock(1); } },
      { label: 'Unindent Selection', sc: 'Shift+Tab', act: function () { indentBlock(-1); } },
      { sep: true },
      { label: 'Duplicate Line', sc: 'Ctrl+D', act: duplicateLine },
      { label: 'Delete Line', sc: 'Ctrl+Y', act: deleteLine },
      { label: 'Comment Line', sc: 'Ctrl+/', act: toggleComment },
      { sep: true },
      { label: 'Find...', sc: 'Ctrl+F', act: function () { openFindBar(false); } },
      { label: 'Replace...', sc: 'Ctrl+H', act: function () { openFindBar(true); } },
      { label: 'Go to Line...', sc: 'Ctrl+G', act: openGotoLine }
    ],
    'Run': [
      { label: "Run 'main'", sc: 'Shift+F10', act: runCode },
      { label: "Debug 'main'", sc: 'Shift+F9', act: debugCurrent },
      { label: 'Run with Coverage', act: runCoverage },
      { sep: true },
      { label: 'Toggle Breakpoint', sc: 'Ctrl+F8', act: toggleBreakpointAtCaret },
      { label: 'Stop', act: stopRun }
    ],
    'Tools': [
      { label: 'Project Interpreter...', act: openInterpreter },
      { label: 'Extensions', act: openExt },
      { label: 'Language Plugins', act: openPlugins },
      { sep: true },
      { label: 'Profile current file', sc: 'Alt+9', act: profileCurrent },
      { label: 'Explain Performance Change...', act: openAttribution },
      { label: 'Command Palette…', sc: 'Ctrl+P', act: openPalette },
      { sep: true },
      { label: 'JSON Formatter...', act: openJsonTool },
      { label: 'RegExp Tester...', act: openRegexTool },
      { label: 'Base64 / URL Encode...', act: openEncodeTool },
      { label: 'Hash Generator...', act: openHashTool },
      { label: 'UUID Generator', act: openUuidTool },
      { sep: true },
      { label: 'Kernel Flame Graph', sc: 'Ctrl+Alt+F', act: openFlame },
      { label: 'Performance', sc: 'Alt+8', act: function () { toggleWindow('perf'); } },
      { label: 'Logs', sc: 'Alt+0', act: function () { toggleWindow('logs'); } },
      { label: 'Packages', sc: 'Alt+6', act: function () { toggleWindow('packages'); } },
      { label: 'Terminal', act: function () { toggleWindow('terminal'); } }
    ],
    'VCS': [
      { label: 'Show Git Widget', act: function () { toggleWindow('vcs'); } },
      { sep: true },
      { label: 'Commit...', act: gitCommitDialog },
      { label: 'Refresh Status', act: function () { BRIDGE.send({ kind: 'gitStatus' }); } }
    ],
    'Window': [ { label: 'Minimize', act: function () { minimizeWindow(); } } ],
    'Help': [
      { label: 'System Info', act: openDiagnostics },
      { label: 'About', act: openAbout }
    ]
  };
  function renderMenus() {
    var bar = $('menubar');
    Object.keys(MENUS).forEach(function (name) {
      var m = document.createElement('div');
      m.className = 'menu'; m.textContent = t('menu.' + name, name);
      var pop = document.createElement('div'); pop.className = 'pop';
      MENUS[name].forEach(function (it) {
        if (it.sep) { var s = document.createElement('div'); s.className = 'sep'; pop.appendChild(s); return; }
        var b = document.createElement('button'); b.className = 'item';
        b.innerHTML = '<span>' + esc(it.label) + '</span>' + (it.sc ? '<span class="sc">' + esc(it.sc) + '</span>' : '');
        b.addEventListener('click', function () { closeMenus(); if (it.act) it.act(); });
        pop.appendChild(b);
      });
      m.appendChild(pop);
      m.addEventListener('click', function (e) {
        e.stopPropagation();
        var wasOpen = m.classList.contains('open');
        closeMenus();
        if (!wasOpen) m.classList.add('open');
      });
      m.addEventListener('mouseenter', function () {
        if (bar.querySelector('.menu.open')) { closeMenus(); m.classList.add('open'); }
      });
      bar.insertBefore(m, bar.querySelector('.spacer'));
    });
  }
  function closeMenus() { document.querySelectorAll('.menu.open').forEach(function (m) { m.classList.remove('open'); }); }
  document.addEventListener('click', closeMenus);
  // A click *inside* the context menu is handled by the item itself (which may
  // open a submenu), so the global closer must not swallow it.
  document.addEventListener('click', function (e) { if (!(e.target && e.target.closest && e.target.closest('#ctxMenu'))) hideCtx(); });

  // One right-click rule for the whole shell: every region has a PyCharm-style
  // menu, so the browser's own never appears. Inputs are deliberately not
  // covered (they need the native clipboard menu), and a region that handled the
  // event itself — a project-tree row — wins via defaultPrevented.
  var lastCtxX = 0, lastCtxY = 0;
  document.addEventListener('contextmenu', function (e) {
    lastCtxX = e.clientX; lastCtxY = e.clientY;
    var t = e.target;
    var region = t && t.closest ? t.closest('[data-ctx]') : null;
    if (!region) return;
    if (e.defaultPrevented) return;
    e.preventDefault();
    var kind = region.getAttribute('data-ctx');
    var items = null;
    if (kind === 'editor') items = editorMenu();
    else if (kind === 'tab') {
      var row = t.closest('.etab');
      items = tabMenu(row ? row.getAttribute('data-tab') : null);
    } else if (kind === 'dock') items = dockMenu(region.querySelector('.dock-pane.active'));
    else if (kind === 'panel') items = panelMenu();
    if (items && items.length) showCtx(e.clientX, e.clientY, items);
    else hideCtx();
  });

  // ---------- theme ----------
  function setTheme(t) { document.documentElement.setAttribute('data-theme', t); savePrefs({ theme: t }); toast('Theme: ' + t); }

  // ---------- language mode ----------
  // The default is the file type: a document's language is its extension. This
  // is the explicit override — the status bar cell mirrors PyCharm's language
  // selector, so the choice is always visible and always undoable (the "Auto"
  // row just drops the override). Switching re-tokenises, re-checks, and makes
  // Run use the chosen language instead of the extension.
  function renderStLang() {
    var el = $('stLang'); if (!el) return;
    var manual = !!(currentFile && LANGSET[currentFile]);
    var auto = currentFile ? (langOfName(currentFile) || 'python') : 'python';
    var label = currentFile ? langLabel(currentLang) : 'No file';
    el.innerHTML = ic('file', 14) + '<span class="lbl">' + esc(label + (manual ? ' · manual' : '')) + '</span>';
    el.title = !currentFile
      ? 'Language mode'
      : manual
        ? 'Language mode: ' + langLabel(currentLang) + ' — set manually. ' + currentFile + ' reads as ' + langLabel(auto) + ' by extension. Click to change.'
        : 'Language mode: ' + langLabel(currentLang) + ' — from the file type of ' + currentFile + '. Click to change.';
    el.classList.add('act');
    syncTestButton();
  }
  function openLangPicker() {
    var inp = $('langInput');
    if (inp) inp.value = '';
    renderLangs('');
    openModal('langModal');
    if (inp) inp.focus();
  }
  function langRow(id, name, hint, sel) {
    return '<div class="mres' + (sel ? ' sel' : '') + '" data-lang="' + esc(id) + '">' +
      '<span class="ic">' + ic('file', 16) + '</span>' +
      '<span class="nm">' + esc(name) + '</span>' +
      '<span class="path">' + esc(hint) + '</span></div>';
  }
  function renderLangs(q) {
    var body = $('langBody');
    if (!currentFile) {
      body.innerHTML = '<div class="empty" style="padding:14px">Open a file to choose its language mode.</div>';
      return;
    }
    var f = String(q || '').toLowerCase();
    var auto = langOfName(currentFile) || 'python';
    var manual = !!LANGSET[currentFile];
    var html = '';
    if (!f || 'auto'.indexOf(f) !== -1 || langLabel(auto).toLowerCase().indexOf(f) !== -1 || currentFile.toLowerCase().indexOf(f) !== -1) {
      html += '<div class="mgrp">Detected from the file name</div>' +
        langRow('', 'Auto — ' + langLabel(auto), currentFile, !manual);
    }
    var list = LANG_LIST.filter(function (l) {
      return !f || l.name.toLowerCase().indexOf(f) !== -1 || l.id.indexOf(f) !== -1;
    });
    if (list.length) {
      html += '<div class="mgrp">All languages</div>' + list.map(function (l) {
        return langRow(l.id, l.name, SERVER_LANGS[l.id] ? 'run · check' : 'highlight only', manual && LANGSET[currentFile] === l.id);
      }).join('');
    }
    body.innerHTML = html || '<div class="empty" style="padding:14px">No language matches "' + esc(q) + '".</div>';
    Array.prototype.slice.call(body.querySelectorAll('.mres')).forEach(function (el) {
      el.addEventListener('click', function () { setDocLang(el.getAttribute('data-lang') || ''); });
    });
  }
  /** lang empty means "go back to the file type". */
  function setDocLang(lang) {
    if (!currentFile) return;
    // Boot shows a document without having opened it, so make the buffer on
    // demand rather than letting the picker silently do nothing.
    if (!BUFFERS[currentFile]) BUFFERS[currentFile] = { content: ta.value, languageId: langOfDoc(currentFile), editable: !ta.readOnly, dirty: false };
    var chosen = lang || langOfName(currentFile) || 'python';
    setLangOverride(currentFile, lang);
    BUFFERS[currentFile].languageId = chosen;
    currentLang = chosen;
    // Documentation is cached by label, and the same label means different
    // things in different languages; a stale entry would show python's docstring
    // under a go symbol.
    CMP.docs = {};
    pkgSync();
    closeModals();
    renderStLang();
    renderEditor(); updateCaret();
    // Re-check under the new language; a language with no server has no
    // problems to show, so clear the previous language's list.
    requestCheck();
    toast('Language mode: ' + langLabel(chosen) + (lang ? ' (manual)' : ' (from file type)'));
  }

  // ---------- modals ----------
  function openModal(id) { $(id).classList.add('open'); $('scrim').classList.add('open'); }
  function closeModals() { document.querySelectorAll('.modal.open').forEach(function (m) { m.classList.remove('open'); }); $('scrim').classList.remove('open'); }
  $('scrim').addEventListener('click', closeModals);
  function openAbout() { openModal('aboutModal'); }
  function openExt() { openModal('extModal'); BRIDGE.send({ kind: 'listExtensions' }); }
  // The browser build has full /plugins and /profile pages served over HTTP.
  // The Tauri shell has no HTTP server at all (the engine runs over a pipe), so
  // window.open('/plugins') lands on a route that does not exist. Both views are
  // therefore rendered in-app from the very same bridge messages the pages use.
  function openPlugins() {
    if (!isTauriShell()) { window.open('/plugins', '_blank'); return; }
    showModal({
      title: 'Language Plugins', icon: 'database',
      message: 'Installed language plugins, their tier and validation state.',
      buttons: [{ label: 'Close', primary: true, onClick: function () {} }]
    });
    DIALOG_KIND = 'plugins';
    paintPluginDialog();
    BRIDGE.send({ kind: 'listPlugins' });
  }
  /** Render the plugin catalogue into the open dialog (no-op when it is closed). */
  function paintPluginDialog() {
    if (DIALOG_KIND !== 'plugins') return;
    var root = $('dlgRoot');
    var body = root && root.querySelector('.dlg-body');
    if (!body) return;
    var list = (PLUGINS && PLUGINS.plugins) || [];
    if (!list.length) { body.innerHTML = '<div class="dlg-msg">No language plugins reported yet.</div>'; return; }
    body.innerHTML = list.map(function (p) {
      var exts = (p.extensions || []).map(function (e) { return '.' + e; }).join(' ');
      var notes = '';
      if (p.runnerError) notes += '<div style="color:var(--warning);font-size:11px">' + esc(p.runnerError) + '</div>';
      if (p.validationOk === false) {
        notes += '<div style="color:var(--error);font-size:11px">' +
          esc((p.validation || []).map(function (i) { return (i.field || '') + ': ' + (i.message || ''); }).join('; ')) + '</div>';
      }
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">' +
        '<div style="flex:1;min-width:0">' +
          '<b>' + esc(p.displayName || p.id) + '</b> ' +
          '<span style="color:var(--text-secondary)">' + esc(p.version || '') + ' · ' + (p.enabled ? 'enabled' : 'disabled') + ' · ' + esc(p.kind || '') + '</span>' +
          '<div style="font-size:11px;color:var(--text-secondary)">' + esc(exts) + (p.runMode ? ' · ' + esc(p.runMode) : '') + '</div>' +
          notes +
        '</div>' +
        '<button class="dlg-btn" data-plug="' + esc(p.id) + '" data-on="' + (p.enabled ? '1' : '0') + '">' +
          (p.enabled ? 'Disable' : 'Enable') + '</button>' +
      '</div>';
    }).join('');
    body.querySelectorAll('button[data-plug]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-plug');
        b.disabled = true;
        BRIDGE.send({ kind: b.getAttribute('data-on') === '1' ? 'langDisable' : 'langEnable', id: id });
      });
    });
  }
  function openProfile() {
    if (!isTauriShell()) { window.open('/profile', '_blank'); return; }
    showModal({
      title: 'Profile', icon: 'perf', message: 'Waiting for the profiler…',
      buttons: [{ label: 'Close', primary: true, onClick: function () {} }]
    });
    DIALOG_KIND = 'profile';
  }
  /** Render a profile result into the open dialog (no-op when it is closed). */
  function paintProfileDialog(res) {
    if (DIALOG_KIND !== 'profile') return;
    var root = $('dlgRoot');
    var body = root && root.querySelector('.dlg-body');
    if (!body) return;
    if (!res || res.ok === false) {
      body.innerHTML = '<div class="dlg-msg">' + esc((res && res.error) || 'Profiler unavailable for this language.') + '</div>';
      return;
    }
    var rows = (res.hotspots || []).map(function (h) {
      return '<tr><td>' + esc(h.name || '') + '</td>' +
        '<td style="color:var(--text-secondary)">' + esc(h.file || '') + (h.line ? ':' + h.line : '') + '</td>' +
        '<td style="text-align:right">' + Math.round(h.tottimeMs || 0) + '</td>' +
        '<td style="text-align:right">' + Math.round(h.cumtimeMs || 0) + '</td></tr>';
    }).join('');
    body.innerHTML =
      '<div style="font-size:12px;margin-bottom:6px;color:var(--text-secondary)">' +
        esc(res.source || '') + ' · ' + esc(String(res.languageId || '')) + ' · ' +
        (res.sampleCount || 0) + ' functions · ' + Math.round(res.wallMs || 0) + ' ms</div>' +
      '<table style="width:100%;font-size:12px;border-collapse:collapse">' +
        '<thead><tr><th style="text-align:left">Function</th><th style="text-align:left">Location</th>' +
        '<th style="text-align:right">Self ms</th><th style="text-align:right">Cum ms</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>' +
      (res.stdout ? '<pre style="margin-top:8px;font-size:11px;white-space:pre-wrap">' + esc(res.stdout) + '</pre>' : '');
  }
  /** Profile the current editor buffer and show the result. */
  function profileCurrent() {
    if (!ta) return;
    var lg = currentLang;
    openProfile();
    BRIDGE.send({ kind: 'profile', code: ta.value, language: lg, timeoutMs: 60000 });
  }
  // ---------- command palette ----------
  // One box, two modes: "nlg ..." runs a script (the original surface); any
  // other text filters MENUS and Enter runs the first match. The list is
  // derived from MENUS, so a new menu item is searchable with no second
  // registry to keep in sync.
  function allCommands() {
    var out = [];
    Object.keys(MENUS).forEach(function (menu) {
      MENUS[menu].forEach(function (it) {
        if (it.sep || !it.act) return;
        out.push({ menu: menu, label: it.label, sc: it.sc || '', act: it.act });
      });
    });
    return out;
  }
  function commandMatches(q) {
    var f = String(q || '').toLowerCase();
    return allCommands().filter(function (c) {
      return !f || c.label.toLowerCase().indexOf(f) !== -1 || c.menu.toLowerCase().indexOf(f) !== -1;
    });
  }
  function renderCommandList(q) {
    var out = $('palOut');
    if (!out) return;
    var list = commandMatches(q);
    if (!list.length) { out.innerHTML = '<div style="padding:6px;color:var(--text-tertiary)">No matching command</div>'; return; }
    out.innerHTML = list.map(function (c, i) {
      return '<div data-pc="' + i + '" style="display:flex;gap:10px;padding:4px 6px;border-radius:4px;cursor:pointer">' +
        '<span style="color:var(--text-tertiary);min-width:76px">' + esc(c.menu) + '</span>' +
        '<span>' + esc(c.label) + '</span>' +
        '<span style="margin-left:auto;color:var(--text-tertiary)">' + esc(c.sc) + '</span></div>';
    }).join('');
    out.querySelectorAll('[data-pc]').forEach(function (el) {
      el.addEventListener('click', function () {
        var c = list[+el.getAttribute('data-pc')];
        closePalette();
        c.act();
      });
    });
  }
  function openPalette() {
    var p = $('palette');
    if (!p) return;
    p.classList.add('open');
    var inp = $('palInput');
    if (inp) {
      inp.value = '';
      inp.oninput = function () { if (!/^nlg\b/i.test(inp.value.trim())) renderCommandList(inp.value); };
      inp.focus();
    }
    renderCommandList('');
  }
  function closePalette() { var p = $('palette'); if (p) p.classList.remove('open'); }
  /** Enter: "nlg ..." runs the script; anything else runs the first match. */
  function runPalette() {
    var inp = $('palInput');
    if (!inp) return;
    var raw = inp.value.trim();
    if (!raw) return;
    if (/^nlg\b/i.test(raw)) { runPaletteScript(raw); return; }
    var list = commandMatches(raw);
    if (!list.length) { toast('No matching command'); return; }
    closePalette();
    list[0].act();
  }
  /** Parse nlg [run] <script> [--] <args…> and run it server-side. */
  function runPaletteScript(raw) {
    var toks = tokenize(raw);
    var i = 0;
    if (toks[i] === 'nlg') i++;
    if (toks[i] === 'run') i++;
    var script = toks[i++];
    if (!script) { appendPaletteOut('usage: nlg run <script> -- <args>\n', 'err'); return; }
    var args = [];
    if (toks[i] === '--') i++;
    for (; i < toks.length; i++) args.push(toks[i]);
    PAL_BUSY = true;
    var out = $('palOut');
    if (out) out.innerHTML = '';
    appendPaletteOut('$ ' + raw + '\n', 'dim');
    BRIDGE.send({ kind: 'runScript', script: script, args: args });
    closePalette();
  }
  /** Whitespace tokenizer that keeps double-quoted segments intact. */
  function tokenize(s) {
    var out = [], cur = '', q = false, i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      if (c === '"') { q = !q; i++; continue; }
      if (q || !/s/.test(c)) cur += c;
      else if (cur) { out.push(cur); cur = ''; }
      i++;
    }
    if (cur) out.push(cur);
    return out;
  }
  var PAL_BUSY = false;
  function appendPaletteOut(text, cls) {
    var o = $('palOut');
    if (!o) return;
    var span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    o.appendChild(span);
    o.scrollTop = o.scrollHeight;
  }
  function openRecent() { renderRecent(); openModal('recentModal'); }
  function renderRecent() {
    var b = $('recentBody');
    if (!RECENT.length) { b.innerHTML = '<div class="empty" style="padding:14px">No recent files yet.</div>'; return; }
    b.innerHTML = RECENT.map(function (p, i) { return '<button class="ritem" data-i="' + i + '">' + esc(p) + '</button>'; }).join('');
    b.querySelectorAll('.ritem').forEach(function (el) {
      el.addEventListener('click', function () { closeModals(); openFile(RECENT[+el.getAttribute('data-i')]); });
    });
  }
  $('recentClose').addEventListener('click', closeModals);

  // ---------- developer tools ----------
  // Pure client-side utilities. Each opens the shared modal and replaces its
  // body with a purpose-built form; the server is not involved, so they work
  // with no backend at all.
  function toolDialog(title, icon, html) {
    var dlg = showModal({ title: title, icon: icon, message: '', buttons: [{ label: 'Close', primary: true, onClick: function () {} }] });
    var root = $('dlgRoot');
    var body = root && root.querySelector('.dlg-body');
    if (body) {
      body.innerHTML = html;
      // showModal owns the scrim; a tool that must close itself (Go to Symbol
      // jumps on click) needs its internal close(), not closeModals().
      body.closeDialog = dlg && dlg.close ? dlg.close : function () {};
    }
    return body;
  }
  function taStyle(extra) {
    return 'width:100%;box-sizing:border-box;font:12px/1.5 var(--mono);background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border);border-radius:6px;padding:6px 8px;resize:vertical;' + (extra || '');
  }
  var fieldStyle = 'box-sizing:border-box;font:12px var(--mono);background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border);border-radius:6px;padding:6px 8px;';
  function openJsonTool() {
    var body = toolDialog('JSON Formatter', 'code',
      '<div style="display:flex;flex-direction:column;gap:8px">' +
      '<textarea id="jsonIn" spellcheck="false" placeholder="Paste JSON here" style="' + taStyle('height:160px') + '"></textarea>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '<button class="dlg-btn" data-j="format">Format</button>' +
      '<button class="dlg-btn" data-j="minify">Minify</button>' +
      '<button class="dlg-btn" data-j="validate">Validate</button>' +
      '<button class="dlg-btn" data-j="copy">Copy result</button>' +
      '</div>' +
      '<textarea id="jsonOut" readonly spellcheck="false" style="' + taStyle('height:160px') + '"></textarea>' +
      '<div id="jsonMsg" style="font-size:12px;color:var(--text-tertiary)"></div>' +
      '</div>');
    if (!body) return;
    var inp = body.querySelector('#jsonIn'), out = body.querySelector('#jsonOut'), msg = body.querySelector('#jsonMsg');
    function parsed() { try { return { ok: true, v: JSON.parse(inp.value) }; } catch (e) { return { ok: false, e: e }; } }
    body.querySelectorAll('[data-j]').forEach(function (b) {
      b.addEventListener('click', function () {
        var mode = b.getAttribute('data-j'), r = parsed();
        if (mode === 'copy') { copyText(out.value); return; }
        if (!r.ok) { out.value = ''; msg.textContent = 'Invalid JSON: ' + r.e.message; return; }
        if (mode === 'format') out.value = JSON.stringify(r.v, null, 2);
        else if (mode === 'minify') out.value = JSON.stringify(r.v);
        else out.value = '';
        msg.textContent = mode === 'validate' ? 'Valid JSON' : 'OK';
      });
    });
  }
  function openRegexTool() {
    var body = toolDialog('RegExp Tester', 'search',
      '<div style="display:flex;flex-direction:column;gap:8px">' +
      '<div style="display:flex;gap:6px">' +
      '<input id="rePat" spellcheck="false" placeholder="pattern, e.g. \\w+" style="flex:1;' + fieldStyle + '" />' +
      '<input id="reFlags" spellcheck="false" placeholder="flags" value="g" style="width:80px;' + fieldStyle + '" />' +
      '</div>' +
      '<textarea id="reText" spellcheck="false" placeholder="Test text" style="' + taStyle('height:120px') + '"></textarea>' +
      '<div id="reOut" style="font-size:12px;color:var(--text-secondary);max-height:160px;overflow:auto;white-space:pre-wrap"></div>' +
      '</div>');
    if (!body) return;
    var pat = body.querySelector('#rePat'), flags = body.querySelector('#reFlags'), text = body.querySelector('#reText'), out = body.querySelector('#reOut');
    function describeMatch(m) {
      var gs = [];
      for (var i = 1; i < m.length; i++) gs.push('$' + i + '=' + JSON.stringify(m[i]));
      return '[' + m.index + '] ' + JSON.stringify(m[0]) + (gs.length ? '  ' + gs.join(' ') : '');
    }
    function run() {
      out.textContent = '';
      if (!pat.value) return;
      var re;
      try { re = new RegExp(pat.value, flags.value.replace(/[gy]/g, '')); } catch (e) { out.textContent = 'Invalid pattern: ' + e.message; return; }
      var n = 0, lines = [], m;
      var g = flags.value.indexOf('g') !== -1;
      if (!g) { var one = re.exec(text.value); if (one) { lines.push(describeMatch(one)); n = 1; } }
      else { while ((m = re.exec(text.value)) && n < 500) { lines.push(describeMatch(m)); n++; if (m[0] === '') re.lastIndex++; } }
      out.textContent = n ? (n + ' match' + (n === 1 ? '' : 'es') + '\n' + lines.join('\n')) : 'No match';
    }
    pat.addEventListener('input', run);
    flags.addEventListener('input', run);
    text.addEventListener('input', run);
  }
  function openEncodeTool() {
    var body = toolDialog('Base64 / URL Encode', 'code',
      '<div style="display:flex;flex-direction:column;gap:8px">' +
      '<textarea id="encIn" spellcheck="false" placeholder="Text" style="' + taStyle('height:110px') + '"></textarea>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '<button class="dlg-btn" data-e="b64">Base64 encode</button>' +
      '<button class="dlg-btn" data-e="b64d">Base64 decode</button>' +
      '<button class="dlg-btn" data-e="url">URL encode</button>' +
      '<button class="dlg-btn" data-e="urld">URL decode</button>' +
      '<button class="dlg-btn" data-e="copy">Copy</button>' +
      '</div>' +
      '<textarea id="encOut" readonly spellcheck="false" style="' + taStyle('height:110px') + '"></textarea>' +
      '<div id="encMsg" style="font-size:12px;color:var(--text-tertiary)"></div>' +
      '</div>');
    if (!body) return;
    var inp = body.querySelector('#encIn'), out = body.querySelector('#encOut'), msg = body.querySelector('#encMsg');
    body.querySelectorAll('[data-e]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-e');
        try {
          if (k === 'copy') { copyText(out.value); return; }
          if (k === 'b64') out.value = btoa(unescape(encodeURIComponent(inp.value)));
          else if (k === 'b64d') out.value = decodeURIComponent(escape(atob(inp.value.trim())));
          else if (k === 'url') out.value = encodeURIComponent(inp.value);
          else out.value = decodeURIComponent(inp.value);
          msg.textContent = 'OK';
        } catch (e) { msg.textContent = 'Failed: ' + e.message; }
      });
    });
  }
  function openHashTool() {
    var body = toolDialog('Hash Generator', 'code',
      '<div style="display:flex;flex-direction:column;gap:8px">' +
      '<textarea id="hashIn" spellcheck="false" placeholder="Text to hash" style="' + taStyle('height:110px') + '"></textarea>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
      '<select id="hashAlg" style="background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:5px;padding:3px 6px">' +
      '<option value="SHA-256">SHA-256</option><option value="SHA-1">SHA-1</option><option value="SHA-512">SHA-512</option>' +
      '</select>' +
      '<button class="dlg-btn" data-h="go">Hash</button>' +
      '<button class="dlg-btn" data-h="copy">Copy</button>' +
      '</div>' +
      '<textarea id="hashOut" readonly spellcheck="false" style="' + taStyle('height:110px') + '"></textarea>' +
      '<div id="hashMsg" style="font-size:12px;color:var(--text-tertiary)"></div>' +
      '</div>');
    if (!body) return;
    var inp = body.querySelector('#hashIn'), alg = body.querySelector('#hashAlg'), out = body.querySelector('#hashOut'), msg = body.querySelector('#hashMsg');
    function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
    body.querySelectorAll('[data-h]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.getAttribute('data-h') === 'copy') { copyText(out.value); return; }
        if (!window.crypto || !window.crypto.subtle) { msg.textContent = 'WebCrypto unavailable'; return; }
        window.crypto.subtle.digest(alg.value, new TextEncoder().encode(inp.value)).then(function (buf) {
          out.value = hex(buf); msg.textContent = alg.value;
        }, function (e) { msg.textContent = 'Failed: ' + e.message; });
      });
    });
  }
  function openUuidTool() {
    var body = toolDialog('UUID Generator', 'code',
      '<div style="display:flex;flex-direction:column;gap:8px">' +
      '<textarea id="uuidOut" readonly spellcheck="false" style="' + taStyle('height:160px') + '"></textarea>' +
      '<div style="display:flex;gap:6px">' +
      '<button class="dlg-btn" data-u="one">Generate</button>' +
      '<button class="dlg-btn" data-u="five">Generate 5</button>' +
      '<button class="dlg-btn" data-u="copy">Copy</button>' +
      '</div></div>');
    if (!body) return;
    var out = body.querySelector('#uuidOut');
    function gen() {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
      if (window.crypto && window.crypto.getRandomValues) {
        var b = new Uint8Array(16); window.crypto.getRandomValues(b);
        b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
        var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
        return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
    }
    body.querySelectorAll('[data-u]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-u');
        if (k === 'copy') { copyText(out.value); return; }
        var n = k === 'five' ? 5 : 1, ids = [];
        for (var i = 0; i < n; i++) ids.push(gen());
        out.value = ids.join('\n');
      });
    });
  }
  function openGoToFile() {
    showModal({
      title: 'Go to File', icon: 'file',
      message: 'Open a file by path (relative to the workspace root).',
      fields: [{ name: 'path', label: 'File', value: '', placeholder: 'main.py' }],
      buttons: [
        { label: 'Cancel' },
        { label: 'Open', primary: true, onClick: function (v) { if (v.path) openFile(String(v.path)); } }
      ]
    });
  }
  function extractSymbols(code, lang) {
    var out = [], re, m;
    if (lang === 'python') {
      re = /^[ \t]*(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)/gm;
      while ((m = re.exec(code))) out.push({ kind: m[1], name: m[2], line: code.slice(0, m.index).split('\n').length });
    } else if (lang === 'go') {
      re = /^[ \t]*(func|type)[ \t]+(?:\([^)]*\)[ \t]*)?([A-Za-z_]\w*)/gm;
      while ((m = re.exec(code))) out.push({ kind: m[1], name: m[2], line: code.slice(0, m.index).split('\n').length });
    } else {
      re = /^[ \t]*(?:export[ \t]+)?(function|class|const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm;
      while ((m = re.exec(code))) out.push({ kind: m[1], name: m[2], line: code.slice(0, m.index).split('\n').length });
    }
    return out;
  }
  function openGoToSymbol() {
    if (!currentFile) { toast('Open a file first'); return; }
    var syms = extractSymbols(ta.value, currentLang);
    if (!syms.length) { toast('No symbols found in this file'); return; }
    syms.sort(function (a, b) { return a.line - b.line; });
    var body = toolDialog('Go to Symbol', 'search',
      '<div style="max-height:52vh;overflow:auto">' +
      syms.map(function (s, i) {
        return '<div data-sym="' + i + '" style="display:flex;gap:10px;padding:6px 8px;border-radius:5px;cursor:pointer;font-size:12.5px">' +
          '<span style="color:var(--accent);min-width:52px">' + esc(s.kind) + '</span>' +
          '<span>' + esc(s.name) + '</span>' +
          '<span style="margin-left:auto;color:var(--text-tertiary)">line ' + s.line + '</span></div>';
      }).join('') + '</div>');
    if (!body) return;
    body.querySelectorAll('[data-sym]').forEach(function (el) {
      el.addEventListener('click', function () {
        var s = syms[+el.getAttribute('data-sym')];
        if (body.closeDialog) body.closeDialog();
        gotoLine(s.line - 1, 0);
      });
    });
  }
  var UI_ZOOM = 1;
  function zoomUi(delta) {
    if (delta === 0) UI_ZOOM = 1;
    else UI_ZOOM = Math.min(1.6, Math.max(0.7, UI_ZOOM + delta * 0.1));
    document.documentElement.style.zoom = UI_ZOOM === 1 ? '' : String(UI_ZOOM);
    try { localStorage.setItem('nl-zoom', String(UI_ZOOM)); } catch (e) { /* ignore */ }
    toast('Zoom ' + Math.round(UI_ZOOM * 100) + '%');
  }
  function toggleFullScreen() {
    if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); return; }
    if (document.documentElement.requestFullscreen) {
      var p = document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(function () { toast('Full screen not allowed'); });
    } else { toast('Full screen is not available here'); }
  }
  function openDiagnostics() {
    var zoom = document.documentElement.style.zoom || '100%';
    var rows = [
      ['Editor', CMEDITOR ? 'CodeMirror' : 'textarea fallback'],
      ['File', currentFile || '(none)'],
      ['Language', currentLang || '(none)'],
      ['Buffers', String(Object.keys(BUFFERS).length)],
      ['Server languages', Object.keys(SERVER_LANGS).join(', ')],
      ['Zoom', zoom]
    ];
    toolDialog('System Info', 'info',
      '<table style="width:100%;font-size:12.5px;border-collapse:collapse">' +
      rows.map(function (r) { return '<tr><td style="color:var(--text-tertiary);padding:4px 8px 4px 0;width:120px">' + esc(r[0]) + '</td><td style="padding:4px 0">' + esc(r[1]) + '</td></tr>'; }).join('') +
      '</table>');
  }
  function gitCommitDialog() {
    showModal({
      title: 'Commit', icon: 'vcs',
      message: 'Commit the project with a message.',
      fields: [{ name: 'msg', label: 'Message', value: '', placeholder: 'Describe the change' }],
      buttons: [
        { label: 'Cancel' },
        { label: 'Commit', primary: true, onClick: function (v) {
          if (!v.msg) { toast('Commit message is required'); return; }
          BRIDGE.send({ kind: 'gitCommit', message: String(v.msg) });
        } }
      ]
    });
  }

  // ---------- Settings (Ctrl+Alt+S) ----------
  // The one page-level settings surface: appearance + which chrome is visible.
  // Changes apply immediately on OK and persist through the normal prefs path.
  function openSettings() {
    var dark = document.documentElement.getAttribute('data-theme') !== 'light';
    var bars = $('strip').style.display !== 'none';
    var sb = (function () { var s = document.querySelector('.status'); return s && s.style.display !== 'none'; })();
    var chinese = activeLocale() === 'zh-CN';
    showModal({
      title: t('modal.Settings', 'Settings'), icon: 'settings',
      checkboxes: [
        { name: 'dark', label: 'Darcula theme (dark)', def: dark },
        { name: 'bars', label: 'Show tool window bars', def: bars },
        { name: 'status', label: 'Show status bar', def: sb },
        { name: 'fmtSave', label: 'Format on save (language servers)', def: !!PREFS.formatOnSave },
        { name: 'zh', label: '界面语言：简体中文 (Chinese UI)', def: chinese }
      ],
      buttons: [
        { label: t('modal.Cancel', 'Cancel'), onClick: function () {} },
        { label: t('modal.OK', 'OK'), primary: true, onClick: function (v) {
          setTheme(v.dark ? 'darcula' : 'light');
          $('strip').style.display = v.bars ? '' : 'none';
          var st = document.querySelector('.status'); if (st) st.style.display = v.status ? '' : 'none';
          savePrefs({ theme: v.dark ? 'darcula' : 'light' });
          savePrefs({ formatOnSave: !!v.fmtSave });
          var next = v.zh ? 'zh-CN' : 'en';
          if (next !== activeLocale()) {
            savePrefs({ locale: next });
            applyTranslations();
          }
        } }
      ]
    });
  }

  // Re-render everything that carries a translatable string for the active locale.
  // Menus are rebuilt from MENUS; static markup with data-i18n is swept again.
  function applyTranslations() {
    document.documentElement.setAttribute('lang', activeLocale() === 'zh-CN' ? 'zh-CN' : 'en');
    renderMenus();
    applyI18n(document);
  }

  // ---------- Run / Debug configurations ----------
  // The toolbar's run-config button is a real selector, not a hardcoded label.
  // Configs persist; selecting one drives what Shift+F10 executes.
  var RUN_CONFIGS = (PREFS.runConfigs && PREFS.runConfigs.length) ? PREFS.runConfigs.slice() : [{ name: 'main', path: 'main.py' }];
  var ACTIVE_CFG = PREFS.activeConfig && RUN_CONFIGS.some(function (c) { return c.name === PREFS.activeConfig; })
    ? PREFS.activeConfig : RUN_CONFIGS[0].name;
  function activeConfig() {
    return RUN_CONFIGS.find(function (c) { return c.name === ACTIVE_CFG; }) || RUN_CONFIGS[0] || { name: 'main', path: 'main.py' };
  }
  // Mirrors VS Code's launch.json shape: the active configuration (not the open
  // tab) drives both Run and Debug. Every field is optional and falls back to a
  // sensible default, so old { name, path } configs keep working.
  /**
   * Split a PyCharm parameter string into argv.
   *
   * Whitespace-only splitting breaks the moment a path contains a space
   * (--data "C:/My Data"), which is exactly what imported .idea
   * configurations look like. Double quotes group; everything else is literal.
   */
  function splitArgs(s) {
    var out = [], cur = '', quoted = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '"') { quoted = !quoted; continue; }
      if (!quoted && (ch === ' ' || ch === '\t' || ch === '\n')) {
        if (cur) { out.push(cur); cur = ''; }
        continue;
      }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }
  function normCfg(c) {
    c = c || {};
    return {
      name: c.name || 'main',
      path: c.path || 'main.py',
      language: c.language || langOfName(c.path || 'main.py') || '',
      cwd: c.cwd || '',
      args: Array.isArray(c.args) ? c.args : (typeof c.args === 'string' && c.args ? splitArgs(c.args) : []),
      env: (c.env && typeof c.env === 'object') ? c.env : {},
      stopOnEntry: c.stopOnEntry !== false,
      request: c.request || 'launch',
      // Attach fields: how to reach a target that is already running. Ignored
      // by launch, so one configuration object covers both requests.
      host: typeof c.host === 'string' ? c.host : '',
      port: Number(c.port) || 0,
      processId: Number(c.processId) || 0
    };
  }
  function renderCfgLabel() {
    var b = $('cfgBtn'); if (b) { var v = b.querySelector('.val'); if (v) v.textContent = ACTIVE_CFG; }
  }
  function openRunConfig() {
    var btn = $('cfgBtn'); var r = btn ? btn.getBoundingClientRect() : { left: 0, bottom: 0 };
    var items = RUN_CONFIGS.map(function (c) {
      return { label: (c.name === ACTIVE_CFG ? '\u25cf  ' : '   ') + c.name, act: function () { ACTIVE_CFG = c.name; renderCfgLabel(); savePrefs({ activeConfig: ACTIVE_CFG }); } };
    });
    items.push({ sep: true });
    items.push({ label: 'Edit Configurations…', act: editRunConfigs });
    showCtx(r.left, r.bottom + 3, items);
  }
  function editRunConfigs() {
    var dirty = RUN_CONFIGS.map(function (c) {
      return {
        name: c.name, path: c.path,
        language: c.language || '', cwd: c.cwd || '',
        args: Array.isArray(c.args) ? c.args.join(' ') : (c.args || ''),
        env: c.env && typeof c.env === 'object' ? Object.keys(c.env).map(function (k) { return k + '=' + c.env[k]; }).join(' ') : (c.env || ''),
        stopOnEntry: c.stopOnEntry !== false,
        request: c.request || 'launch',
        host: c.host || '', port: c.port ? String(c.port) : '', processId: c.processId ? String(c.processId) : ''
      };
    });
    function draw() {
      showModal({
        title: 'Run/Debug Configurations', icon: 'run',
        message: 'Debug follows the active configuration (program, args, env, cwd); Run executes the open file.',
        buttons: [
          { label: 'Add', onClick: function () { dirty.push({ name: 'config' + (dirty.length + 1), path: 'main.py', language: '', cwd: '', args: '', env: '', stopOnEntry: true, request: 'launch', host: '', port: '', processId: '' }); draw(); } },
          { label: 'Cancel', onClick: function () {} },
          { label: 'OK', primary: true, onClick: function () {
            RUN_CONFIGS = dirty.map(function (c) {
              var o = { name: c.name || 'main', path: c.path || 'main.py' };
              if (c.language) o.language = c.language;
              if (c.cwd) o.cwd = c.cwd;
              if (c.args) o.args = splitArgs(String(c.args));
              if (c.env) {
                var envObj = {};
                // Whitespace, not the letter "s": /s+/ silently mangled every
                // env value containing an s (e.g. PATH=/usr/bin -> /u,r/bin).
                String(c.env).split(/\s+/).filter(Boolean).forEach(function (kv) {
                  var idx = kv.indexOf('='); if (idx > 0) envObj[kv.slice(0, idx)] = kv.slice(idx + 1);
                });
                if (Object.keys(envObj).length) o.env = envObj;
              }
              if (c.stopOnEntry === false) o.stopOnEntry = false;
              if (c.request && c.request !== 'launch') o.request = c.request;
              if (c.host) o.host = String(c.host).trim();
              if (Number(c.port) > 0) o.port = Number(c.port);
              if (Number(c.processId) > 0) o.processId = Number(c.processId);
              return o;
            });
            if (!dirty.some(function (c) { return c.name === ACTIVE_CFG; })) ACTIVE_CFG = RUN_CONFIGS.length ? RUN_CONFIGS[0].name : 'main';
            savePrefs({ runConfigs: RUN_CONFIGS, activeConfig: ACTIVE_CFG }); renderCfgLabel();
          } }
        ]
      });
      var body = $('dlgRoot').querySelector('.dlg-body');
      if (!body) return;
      body.innerHTML = dirty.map(function (c, i) {
        return '<div style="display:grid;grid-template-columns:84px 1fr;gap:4px 6px;margin-bottom:8px;align-items:center">' +
          '<label>Name</label><input data-cn="' + i + '" value="' + esc(c.name) + '" placeholder="name" />' +
          '<label>Script</label><input data-cp="' + i + '" value="' + esc(c.path) + '" placeholder="main.py" />' +
          '<label>Language</label><input data-cl="' + i + '" value="' + esc(c.language) + '" placeholder="auto from ext" />' +
          '<label>CWD</label><input data-cc="' + i + '" value="' + esc(c.cwd) + '" placeholder="project root" />' +
          '<label>Args</label><input data-ca="' + i + '" value="' + esc(c.args) + '" placeholder="space separated" />' +
          '<label>Env</label><input data-ce="' + i + '" value="' + esc(c.env) + '" placeholder="KEY=VAL space separated" />' +
          '<label>Stop on entry</label><input type="checkbox" data-cs="' + i + '"' + (c.stopOnEntry ? ' checked' : '') + ' />' +
          '<label>Request</label><select data-cr="' + i + '"><option value="launch"' + (c.request !== 'attach' ? ' selected' : '') + '>launch</option><option value="attach"' + (c.request === 'attach' ? ' selected' : '') + '>attach</option></select>' +
          '<label>Host</label><input data-ch="' + i + '" value="' + esc(c.host) + '" placeholder="localhost (attach)" />' +
          '<label>Port</label><input data-cpt="' + i + '" value="' + esc(c.port) + '" placeholder="attach port" />' +
          '<label>Process ID</label><input data-cpid="' + i + '" value="' + esc(c.processId) + '" placeholder="attach to pid" />' +
          '<label></label><button data-del="' + i + '" class="dlg-btn" style="padding:0 9px">' + ic('close', 10) + ' remove</button>' +
          '</div>';
      }).join('');
      body.querySelectorAll('input[data-cn]').forEach(function (inp) { inp.addEventListener('input', function () { dirty[+inp.getAttribute('data-cn')].name = inp.value; }); });
      body.querySelectorAll('input[data-cp]').forEach(function (inp) { inp.addEventListener('input', function () { dirty[+inp.getAttribute('data-cp')].path = inp.value; }); });
      body.querySelectorAll('input[data-cl]').forEach(function (inp) { inp.addEventListener('input', function () { dirty[+inp.getAttribute('data-cl')].language = inp.value.trim(); }); });
      body.querySelectorAll('input[data-cc]').forEach(function (inp) { inp.addEventListener('input', function () { dirty[+inp.getAttribute('data-cc')].cwd = inp.value.trim(); }); });
      body.querySelectorAll('input[data-ca]').forEach(function (inp) { inp.addEventListener('input', function () { dirty[+inp.getAttribute('data-ca')].args = inp.value; }); });
      body.querySelectorAll('input[data-ce]').forEach(function (inp) { inp.addEventListener('input', function () { dirty[+inp.getAttribute('data-ce')].env = inp.value; }); });
      body.querySelectorAll('input[data-cs]').forEach(function (inp) { inp.addEventListener('change', function () { dirty[+inp.getAttribute('data-cs')].stopOnEntry = inp.checked; }); });
      body.querySelectorAll('select[data-cr]').forEach(function (sel) { sel.addEventListener('change', function () { dirty[+sel.getAttribute('data-cr')].request = sel.value; }); });
      body.querySelectorAll('input[data-ch]').forEach(function (inp) { inp.addEventListener('input', function () { dirty[+inp.getAttribute('data-ch')].host = inp.value.trim(); }); });
      body.querySelectorAll('input[data-cpt]').forEach(function (inp) { inp.addEventListener('input', function () { dirty[+inp.getAttribute('data-cpt')].port = inp.value.trim(); }); });
      body.querySelectorAll('input[data-cpid]').forEach(function (inp) { inp.addEventListener('input', function () { dirty[+inp.getAttribute('data-cpid')].processId = inp.value.trim(); }); });
      body.querySelectorAll('button[data-del]').forEach(function (b) { b.addEventListener('click', function () { dirty.splice(+b.getAttribute('data-del'), 1); draw(); }); });
    }
    draw();
  }
