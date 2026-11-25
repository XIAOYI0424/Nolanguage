  // ---------- extensions modal ----------
  function renderExtModal(list) {
    var body = $('extBody');
    if (!list.length) { body.innerHTML = '<div class="empty">No extensions discovered.</div>'; return; }
    body.innerHTML = list.map(function (e) {
      var st = e.state || (e.compatible ? 'idle' : 'incompatible');
      var h = '<div class="xrow"><div class="top"><span class="nm">' + esc(e.name) + '</span>' +
        '<span class="state ' + esc(st) + '">' + esc(st) + '</span></div>' +
        '<div class="meta">' + esc(e.id) + ' · v' + esc(e.version) + ' · engine ^' + esc(e.engine) + '</div>';
      if (e.pid != null) h += '<div class="meta">pid ' + esc(e.pid) + ' · crashes ' + esc(e.crashes) + ' · rss ' + Math.round((e.rssBytes || 0) / 1048576) + 'MB</div>';
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
      { label: 'Open Project...', sc: 'Ctrl+Alt+Shift+O', act: function () { impOpen(); } },
      { label: 'Add Dependency...', sc: 'Ctrl+Alt+D', act: function () { depOpen(); } },
      { label: 'Run Configuration...', sc: 'Ctrl+Alt+R', act: function () { rcOpen(); } },
      { sep: true },
      { label: 'Open...', sc: 'Ctrl+O', act: openNativeFile },
      { label: 'Open Folder...', act: openNativeFolder },
      { label: 'Save All', sc: 'Ctrl+S', act: saveShortcut },
      { label: 'Save Current File', act: saveFile },
      { label: 'Save As...', sc: 'Ctrl+Shift+S', act: saveAsNative },
      { label: 'Reload from Disk', act: reloadFile },
      { label: 'Compare with Saved Version', act: compareWithSaved },
      { label: 'Close Tab', sc: 'Ctrl+F4', act: function () { if (currentFile) closeTab(currentFile); } },
      { label: 'Reopen Closed Tab', sc: 'Ctrl+Shift+T', act: reopenClosedTab },
      { sep: true },
      { label: 'Import PyCharm Run Configurations...', act: importIdeaConfigs },
      { label: 'Open Recent', act: openRecent },
      { sep: true },
      { label: 'New Scratch File...', sc: 'Ctrl+Alt+Shift+Insert', act: newScratchFile },
      { label: 'New Scratch Buffer', act: newScratchBuffer },
      { label: 'Show Scratch Files', act: showScratchFiles },
      { sep: true },
      { label: 'Recent Changes...', sc: 'Ctrl+Shift+E', act: openRecentChanges },
      { label: 'Show History...', act: showCurrentFileHistory }
    ],
    'Edit': [
      { label: 'Undo', sc: 'Ctrl+Z', act: function () { docCmd('undo'); } },
      { label: 'Redo', sc: 'Ctrl+Shift+Z', act: function () { docCmd('redo'); } },
      { sep: true },
      { label: 'Cut', sc: 'Ctrl+X', act: function () { docCmd('cut'); } },
      { label: 'Copy', sc: 'Ctrl+C', act: function () { docCmd('copy'); } },
      { label: 'Copy Reference', sc: 'Ctrl+Alt+Shift+C', act: copyCodeReference },
      { label: 'Paste', sc: 'Ctrl+V', act: pasteAtCaret },
      { label: 'Paste from History...', sc: 'Ctrl+Shift+V', act: openPasteHistory },
      { sep: true },
      { label: 'Delete Word', sc: 'Ctrl+Backspace', act: function () { deleteWord(-1); } },
      { label: 'Delete Word Forward', sc: 'Ctrl+Delete', act: function () { deleteWord(1); } },
      { label: 'Extend Selection', sc: 'Ctrl+W', act: function () { extendSelection(1); } },
      { label: 'Shrink Selection', sc: 'Ctrl+Shift+W', act: function () { extendSelection(-1); } },
      { sep: true },
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
      { label: 'Toggle Full Screen', sc: 'Ctrl+Shift+F11', act: toggleFullScreen }
    ],
    'Navigate': [
      { label: 'Search Everywhere', sc: '⇧⇧', act: openSearch },
      { label: 'Find Action...', sc: 'Ctrl+Shift+A', act: function () { openFindAction(); } },
      { label: 'Go to File...', sc: 'Ctrl+Shift+N', act: openGoToFile },
      { label: 'Go to Symbol...', sc: 'Ctrl+Alt+Shift+N', act: openGoToSymbol },
      { label: 'Go to Definition', sc: 'Ctrl+B', act: navDefinition },
      { label: 'Quick Definition', sc: 'Ctrl+Shift+I', act: quickDefinition },
      { label: 'Find Usages', sc: 'Alt+F7', act: navReferences },
      { label: 'Highlight Usages in File', sc: 'Ctrl+Shift+F7', act: highlightUsages },
      { label: 'Next Method', sc: 'Alt+Down', act: function () { stepMethod(1); } },
      { label: 'Previous Method', sc: 'Alt+Up', act: function () { stepMethod(-1); } },
      { label: 'Find in Files...', sc: 'Ctrl+Shift+F', act: function () { openFindInFiles(); } },
      { label: 'Replace in Files...', sc: 'Ctrl+Shift+R', act: function () { openFindInFiles(true); } },
      { label: 'Next Problem', sc: 'F2', act: function () { gotoDiagnostic(1); } },
      { label: 'Previous Problem', sc: 'Shift+F2', act: function () { gotoDiagnostic(-1); } },
      { label: 'Last Edit Location', sc: 'Ctrl+Shift+Backspace', act: gotoLastEditLocation },
      { label: 'Select in Project View', sc: 'Alt+F1', act: revealCurrentInTree },
      { label: 'File Structure', sc: 'Ctrl+F12', act: function () { toggleWindow('structure'); } },
      { label: 'Go to Matching Bracket', sc: 'Ctrl+Shift+M', act: gotoMatchingBracket },
      { sep: true },
      { label: 'Toggle Bookmark', sc: 'F11', act: function () { setLineBookmark(''); } },
      { label: 'Mnemonic Bookmark...', sc: 'Ctrl+F11', act: promptMnemonicBookmark },
      { label: 'Show Bookmarks...', sc: 'Shift+F11', act: showLineBookmarks }
    ],
    'Code': [
      { label: 'Reformat Code', sc: 'Ctrl+Alt+L', act: reformatCode },
      { label: 'Optimize Imports', sc: 'Ctrl+Alt+O', act: optimizeImports },
      { sep: true },
      { label: 'Fold Code Block', sc: 'Ctrl+Shift+[', act: function () { foldCommand('toggle'); } },
      { label: 'Fold All', sc: 'Ctrl+Shift+NumPad-', act: function () { foldCommand('foldAll'); } },
      { label: 'Unfold All', sc: 'Ctrl+Shift+NumPad+', act: function () { foldCommand('unfoldAll'); } },
      { sep: true },
      { label: 'Toggle Case', sc: 'Ctrl+Shift+U', act: function () { toggleCase('toggle'); } },
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
      { label: 'Compare with Clipboard', act: compareWithClipboard },
      { sep: true },
      { label: 'Find...', sc: 'Ctrl+F', act: function () { openFindBar(false); } },
      { label: 'Replace...', sc: 'Ctrl+H', act: function () { openFindBar(true); } },
      { label: 'Go to Line...', sc: 'Ctrl+G', act: openGotoLine }
    ],
    // Only refactorings with a real implementation are listed here. Extract
    // Method / Variable / Constant, Move and Change Signature need semantic,
    // project-wide edits that this build does not produce; an item that only
    // says "not implemented" is worse than no item at all.
    'Refactor': [
      { label: 'Rename', sc: 'Shift+F6', act: navRename },
      { label: 'Quick Fix...', sc: 'Alt+Enter', act: navCodeActions }
    ],
    'Run': [
      { label: "Run 'main'", sc: 'Shift+F10', act: runCode },
      { label: "Debug 'main'", sc: 'Shift+F9', act: debugCurrent },
      { label: 'Run with Coverage', act: runCoverage },
      { sep: true },
      { label: 'Toggle Breakpoint', sc: 'Ctrl+F8', act: toggleBreakpointAtCaret },
      { label: 'Stop', act: stopRun }
    ],
    'Debug': [
      { label: "Debug 'main'", sc: 'Shift+F9', act: debugCurrent },
      { sep: true },
      { label: 'Step Over', sc: 'F8', act: function () { if (DBG.active) BRIDGE.send({ kind: 'debugCmd', cmd: 'next' }); else toast('Start a debug session first'); } },
      { label: 'Step Into', sc: 'F7', act: function () { if (DBG.active) BRIDGE.send({ kind: 'debugCmd', cmd: 'stepIn' }); else toast('Start a debug session first'); } },
      { label: 'Step Out', act: function () { if (DBG.active) BRIDGE.send({ kind: 'debugCmd', cmd: 'stepOut' }); else toast('Start a debug session first'); } },
      { label: 'Resume Program', sc: 'F9', act: function () { if (DBG.active) BRIDGE.send({ kind: 'debugCmd', cmd: 'continue' }); else toast('Start a debug session first'); } },
      { sep: true },
      { label: 'View Breakpoints...', sc: 'Ctrl+Shift+F8', act: function () { toggleWindow('debug'); } }
    ],
    'Tools': [
      { label: 'Project Interpreter...', act: openInterpreter },
      { label: 'Extensions', act: openExt },
      { label: 'Language Plugins', act: openPlugins },
      { sep: true },
      { label: 'Profile current file', sc: 'Ctrl+Alt+P', act: profileCurrent },
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
        var b = document.createElement('button');
        b.className = 'item' + (it.children ? ' sub' : '');
        b.innerHTML = '<span>' + esc(it.label) + '</span>' + (it.sc ? '<span class="sc">' + esc(it.sc) + '</span>' : '');
        if (it.children) {
          var sub = document.createElement('div'); sub.className = 'pop';
          it.children.forEach(function (child) {
            var cb = document.createElement('button'); cb.className = 'item';
            cb.innerHTML = '<span>' + esc(child.label) + '</span>';
            cb.addEventListener('click', function (e) { e.stopPropagation(); closeMenus(); if (child.act) child.act(); });
            sub.appendChild(cb);
          });
          b.appendChild(sub);
          b.addEventListener('click', function (e) { e.stopPropagation(); b.classList.toggle('open'); });
        } else {
          b.addEventListener('click', function () { closeMenus(); if (it.act) it.act(); });
        }
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
  function closeMenus() {
    document.querySelectorAll('.menu.open').forEach(function (m) { m.classList.remove('open'); });
    document.querySelectorAll('.menu .item.open').forEach(function (m) { m.classList.remove('open'); });
  }
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
  /** Ask the engine what the plugin index offers, for the open Plugins dialog. */
  function searchCatalog() {
    var q = $('catQ');
    BRIDGE.send({ kind: 'catalogSearch', query: q ? q.value.trim() : '' });
  }
  /** Repaint when a catalogue frame arrives (the whole dialog reads the state). */
  function paintCatalogDialog() { paintPluginDialog(); }

  /** Render the plugin catalogue into the open dialog (no-op when it is closed). */
  function paintPluginDialog() {
    if (DIALOG_KIND !== 'plugins') return;
    var root = $('dlgRoot');
    var body = root && root.querySelector('.dlg-body');
    if (!body) return;
    var list = (PLUGINS && PLUGINS.plugins) || [];
    var section = list.length ? pluginListHtml(list) : '<div class="dlg-msg">No language plugins reported yet.</div>';
    body.innerHTML = section + pluginIndexHtml();
    body.querySelectorAll('button[data-plug]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-plug');
        b.disabled = true;
        BRIDGE.send({ kind: b.getAttribute('data-on') === '1' ? 'langDisable' : 'langEnable', id: id });
      });
    });
    var go = body.querySelector('#catGo');
    if (go) go.addEventListener('click', searchCatalog);
    var q = body.querySelector('#catQ');
    if (q) q.addEventListener('keydown', function (e) { if (e.key === 'Enter') searchCatalog(); });
    body.querySelectorAll('button[data-cat]').forEach(function (b) {
      b.addEventListener('click', function () {
        b.disabled = true;
        // the version is echoed back so a changed index is refused rather than
        // silently installing something newer than what the row described.
        BRIDGE.send({ kind: 'langInstall', id: b.getAttribute('data-cat'), version: b.getAttribute('data-ver') });
      });
    });
  }

  /** One row per installed plugin: tier, capabilities, enable/uninstall. */
  function pluginListHtml(list) {
    return list.map(function (p) {
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
  }

  /**
   * The index section: search, then install by id.
   *
   * Nothing here is on disk yet, so this list is labelled as a download. Rows
   * without a published sha256 are refused by the installer, and the row says so
   * before the click instead of failing after it.
   */
  function pluginIndexHtml() {
    var cat = CATALOG;
    var rows = (cat && cat.entries) || [];
    // The index frame is a snapshot from search time; the installed set is
    // live. Re-checking it here keeps a just-installed row from offering
    // "Install" again after the repaint that follows the install.
    var have = {};
    ((PLUGINS && PLUGINS.plugins) || []).forEach(function (p) { have[p.id] = true; });
    var html = '<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">' +
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
        '<input id="catQ" placeholder="Search the plugin index (id, name, category)" value="' +
          esc(cat && cat.query ? cat.query : '') + '" style="flex:1;min-width:0;background:var(--bg-primary);' +
          'border:1px solid var(--border);border-radius:4px;padding:3px 6px;color:var(--text-primary)">' +
        '<button class="dlg-btn" id="catGo">Search</button>' +
      '</div>';
    if (cat && cat.unavailable) {
      html += '<div style="color:var(--warning);font-size:11px;margin-bottom:4px">index unavailable: ' + esc(cat.unavailable) + '</div>';
    }
    if (!cat) {
      html += '<div class="dlg-msg">Search the index to install a plugin by id.</div>';
    } else if (!rows.length) {
      html += '<div class="dlg-msg">' + (cat.unavailable ? '' : (cat.query ? 'No plugin in the index matches.' : 'The index is empty.')) + '</div>';
    }
    rows.forEach(function (e) {
      var isInstalled = e.installed || !!have[e.id];
      var badge = e.sha256 ? '' : '<div style="color:var(--warning);font-size:11px">no sha256 published — the installer refuses it</div>';
      html += '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">' +
        '<div style="flex:1;min-width:0">' +
          '<b>' + esc(e.displayName || e.id) + '</b> ' +
          '<span style="color:var(--text-secondary)">' + esc(e.id) + ' ' + esc(e.version || '') + '</span>' +
          (e.description ? '<div style="font-size:11px;color:var(--text-secondary)">' + esc(e.description) + '</div>' : '') +
          badge +
        '</div>' +
        '<button class="dlg-btn" data-cat="' + esc(e.id) + '" data-ver="' + esc(e.version || '') + '"' +
          (isInstalled || !e.sha256 ? ' disabled' : '') + '>' + (isInstalled ? 'Installed' : 'Install') + '</button>' +
      '</div>';
    });
    return html + '</div>';
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
  function openGoToFile() { openSearch('files'); }
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
  // Go to Symbol is no longer a local grep. The dialog paints the syntax outline
  // immediately so the click is never silent, then asks the language server for
  // the real symbol list. A server that does not implement workspace symbols
  // leaves the local outline in place and says so instead of faking a result.
  var GOTOSYM = {
    open: false, body: null, seq: 920000, reqId: 0, timer: 0,
    query: '', source: 'local', loading: false,
    local: [], remote: [], visible: []
  };
  function goSymAlive() {
    if (!GOTOSYM.open || !GOTOSYM.body) return false;
    var scrim = GOTOSYM.body.closest ? GOTOSYM.body.closest('.dlg-scrim') : null;
    if (!scrim || !scrim.parentNode) { GOTOSYM.open = false; GOTOSYM.reqId = 0; return false; }
    return true;
  }
  function goSymClose() {
    clearTimeout(GOTOSYM.timer);
    GOTOSYM.open = false;
    GOTOSYM.reqId = 0;
    if (GOTOSYM.body && GOTOSYM.body.closeDialog) GOTOSYM.body.closeDialog();
    else closeModals();
  }
  function goSymLocalSymbols() {
    return extractSymbols(ta.value, currentLang).map(function (s) {
      return navNormalSymbol({
        name: s.name,
        kind: s.kind === 'class' ? 'class' : (s.kind === 'def' || s.kind === 'func' ? 'function' : s.kind),
        uri: currentFile,
        line: Math.max(0, Number(s.line) - 1),
        character: 0,
        local: true
      });
    });
  }
  function goSymPaint() {
    if (!goSymAlive()) return;
    var body = GOTOSYM.body;
    var list = GOTOSYM.source === 'lsp' ? GOTOSYM.remote : GOTOSYM.local;
    var q = String(GOTOSYM.query || '').toLowerCase().trim();
    GOTOSYM.visible = list.filter(function (s) {
      if (!q) return true;
      return String(s.name).toLowerCase().indexOf(q) >= 0 ||
        String(s.kind).toLowerCase().indexOf(q) >= 0 ||
        String(s.containerName).toLowerCase().indexOf(q) >= 0;
    });
    var hint = body.querySelector('#goSymHint');
    if (hint) {
      if (GOTOSYM.source === 'lsp' && !GOTOSYM.loading) {
        hint.textContent = 'Language server symbols · ' + GOTOSYM.visible.length + ' match' + (GOTOSYM.visible.length === 1 ? '' : 'es');
      } else if (GOTOSYM.loading) {
        hint.textContent = 'Searching the language server… showing the local outline for now';
      } else {
        hint.textContent = 'Local syntax outline · no language server symbols for this file';
      }
    }
    var rows = body.querySelector('#goSymRows');
    if (!rows) return;
    rows.innerHTML = GOTOSYM.visible.length
      ? GOTOSYM.visible.map(function (s, i) {
          var loc = s.local ? currentFile + ':' + (s.line + 1) : navLabel(s.uri, s.line);
          return '<div class="gosym-row" data-gosym="' + i + '" tabindex="0" title="' + esc(s.name) + ' — ' + esc(loc) + '">' +
            '<span class="gosym-kind">' + esc(s.kind) + '</span>' +
            '<span class="gosym-name">' + esc(s.name) + '</span>' +
            '<span class="gosym-loc">' + esc(loc) + '</span></div>';
        }).join('')
      : '<div class="gosym-empty">' + (GOTOSYM.source === 'lsp' ? 'No symbols matched this query.' : 'No symbols in this file.') + '</div>';
    rows.querySelectorAll('[data-gosym]').forEach(function (el) {
      function pick() {
        var s = GOTOSYM.visible[+el.getAttribute('data-gosym')];
        if (!s) return;
        goSymClose();
        navOpen(s);
      }
      el.addEventListener('click', pick);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); pick(); } });
    });
  }
  function scheduleGoSymbolRequest() {
    if (!goSymAlive()) return;
    clearTimeout(GOTOSYM.timer);
    if (!lspLang()) { GOTOSYM.source = 'local'; GOTOSYM.loading = false; goSymPaint(); return; }
    GOTOSYM.loading = true;
    goSymPaint();
    GOTOSYM.timer = setTimeout(function () {
      if (!goSymAlive() || !lspLang()) return;
      var id = ++GOTOSYM.seq;
      GOTOSYM.reqId = id;
      BRIDGE.send({ kind: 'workspaceSymbol', language: lspLang(), query: GOTOSYM.query, requestId: id });
    }, 160);
  }
  function onSymbolDialogResult(m) {
    if (!goSymAlive() || Number(m.requestId || 0) !== GOTOSYM.reqId) return;
    GOTOSYM.reqId = 0;
    GOTOSYM.loading = false;
    if (m.unsupported) {
      GOTOSYM.source = 'local';
      GOTOSYM.remote = [];
    } else {
      GOTOSYM.remote = navSymbolSort((m.symbols || []).map(navNormalSymbol)).slice(0, 200);
      GOTOSYM.source = 'lsp';
    }
    goSymPaint();
  }
  function openGoToSymbol() {
    if (!currentFile) { toast('Open a file first'); return; }
    var locals = goSymLocalSymbols();
    if (!locals.length && !lspLang()) { toast('No symbols found in this file'); return; }
    var body = toolDialog('Go to Symbol', 'search',
      '<div class="gosym">' +
      '<input id="goSymQ" class="gosym-input" spellcheck="false" placeholder="Filter symbols — searched by the language server as you type" />' +
      '<div id="goSymHint" class="gosym-hint"></div>' +
      '<div id="goSymRows" class="gosym-rows"></div>' +
      '</div>');
    if (!body) return;
    GOTOSYM.open = true;
    GOTOSYM.body = body;
    GOTOSYM.reqId = 0;
    GOTOSYM.query = '';
    GOTOSYM.source = 'local';
    GOTOSYM.local = locals;
    GOTOSYM.remote = [];
    var inp = body.querySelector('#goSymQ');
    if (inp) {
      inp.addEventListener('input', function () {
        GOTOSYM.query = inp.value;
        goSymPaint();
        scheduleGoSymbolRequest();
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var first = GOTOSYM.visible.length ? body.querySelector('[data-gosym="0"]') : null;
          if (first) first.click();
        } else if (e.key === 'Escape') { e.preventDefault(); goSymClose(); }
      });
      inp.focus();
    }
    goSymPaint();
    scheduleGoSymbolRequest();
  }
  var UI_ZOOM = 1;
  function setUiZoom(percent) {
    var p = Math.min(160, Math.max(70, Number(percent) || 100));
    UI_ZOOM = p / 100;
    document.documentElement.style.zoom = UI_ZOOM === 1 ? '' : String(UI_ZOOM);
    try { localStorage.setItem('nl-zoom', String(UI_ZOOM)); } catch (e) { /* storage unavailable */ }
  }
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
  // A PyCharm/IDEA-style Preferences window: category tree on the left, real
  // controls on the right, Apply / OK / Cancel. Every row maps to a preference
  // the shell actually reads; none of it is decorative.
  var SETTINGS_CATS = [
    { id: 'appearance', label: 'Appearance & Behavior', icon: 'sun', keywords: 'theme darcula light language zoom status toolbar' },
    { id: 'behavior', label: 'Behavior', icon: 'more', keywords: 'startup recovery draft tabs close save assistant' },
    { id: 'editor', label: 'Editor', icon: 'file', keywords: 'wrap brackets tabs indentation line numbers reformat' },
    { id: 'interpreter', label: 'Project Interpreter', icon: 'database', keywords: 'python sdk venv environment packages' },
    { id: 'markdown', label: 'Markdown', icon: 'project', keywords: 'preview split outline' },
    { id: 'run', label: 'Run / Debug', icon: 'run', keywords: 'configuration launch import idea' }
  ];
  var SETTINGS_DEFAULTS = {
    theme: 'darcula', locale: 'en', zoom: 100, showBars: true, showStatus: true,
    draftDelay: 2, confirmDirtyClose: true, restoreTabs: true, restoreProject: true, showAssistant: false,
    autoVenv: true,
    lineNumbers: true, softWrap: false, activeLine: true, matchBrackets: true,
    autoCloseBrackets: true, useTabs: false, tabSize: 4, formatOnSave: false, mdWidth: 42
  };
  function setCheckRow(name, label, checked, hint) {
    return '<div class="set-row"><span class="set-label">' + esc(label) +
      (hint ? '<small>' + esc(hint) + '</small>' : '') + '</span>' +
      '<input type="checkbox" data-s="' + esc(name) + '"' + (checked ? ' checked' : '') + ' /></div>';
  }
  function setSelectRow(name, label, options, value, hint) {
    return '<div class="set-row"><span class="set-label">' + esc(label) +
      (hint ? '<small>' + esc(hint) + '</small>' : '') + '</span><select data-s="' + esc(name) + '">' +
      options.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (String(value) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select></div>';
  }
  function setNumberRow(name, label, value, min, max, hint) {
    return '<div class="set-row"><span class="set-label">' + esc(label) +
      (hint ? '<small>' + esc(hint) + '</small>' : '') + '</span>' +
      '<input type="number" data-s="' + esc(name) + '" value="' + esc(String(value)) +
      '" min="' + min + '" max="' + max + '" /></div>';
  }
  function settingsCurrent() {
    var status = document.querySelector('.status');
    var zoom = Number(document.documentElement.style.zoom);
    return {
      theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'darcula',
      locale: activeLocale(),
      zoom: isFinite(zoom) && zoom > 0 ? Math.round(zoom * 100) : 100,
      showBars: $('strip') ? $('strip').style.display !== 'none' : true,
      showStatus: status ? status.style.display !== 'none' : true,
      draftDelay: Math.min(30, Math.max(1, Number(PREFS.draftDelay) || 2)),
      confirmDirtyClose: PREFS.confirmDirtyClose !== false,
      restoreTabs: PREFS.restoreTabs !== false,
      restoreProject: PREFS.restoreProject !== false,
      autoVenv: PREFS.autoVenv !== false,
      showAssistant: PREFS.assistantHidden === false,
      lineNumbers: PREFS.lineNumbers !== false,
      softWrap: PREFS.softWrap === true,
      activeLine: PREFS.activeLine !== false,
      matchBrackets: PREFS.matchBrackets !== false,
      autoCloseBrackets: PREFS.autoCloseBrackets !== false,
      useTabs: PREFS.useTabs === true,
      tabSize: Math.min(8, Math.max(2, Number(PREFS.tabSize) || 4)),
      formatOnSave: PREFS.formatOnSave === true,
      mdWidth: Math.min(64, Math.max(24, Number(PREFS.mdPreviewWidth) || 42))
    };
  }
  function applySettings(v) {
    var theme = v.theme === 'light' ? 'light' : 'darcula';
    var locale = v.locale === 'zh-CN' ? 'zh-CN' : 'en';
    var localeChanged = locale !== activeLocale();
    document.documentElement.setAttribute('data-theme', theme);
    if ($('strip')) $('strip').style.display = v.showBars ? '' : 'none';
    var status = document.querySelector('.status');
    if (status) status.style.display = v.showStatus ? '' : 'none';
    updatePrefs({
      theme: theme, locale: locale,
      draftDelay: Math.min(30, Math.max(1, Number(v.draftDelay) || 2)),
      confirmDirtyClose: !!v.confirmDirtyClose,
      restoreTabs: !!v.restoreTabs,
      restoreProject: !!v.restoreProject,
      autoVenv: !!v.autoVenv,
      assistantHidden: !v.showAssistant,
      lineNumbers: !!v.lineNumbers,
      softWrap: !!v.softWrap,
      activeLine: !!v.activeLine,
      matchBrackets: !!v.matchBrackets,
      autoCloseBrackets: !!v.autoCloseBrackets,
      useTabs: !!v.useTabs,
      tabSize: Math.min(8, Math.max(2, Number(v.tabSize) || 4)),
      formatOnSave: !!v.formatOnSave,
      mdPreviewWidth: Math.min(64, Math.max(24, Number(v.mdWidth) || 42))
    });
    setUiZoom(v.zoom);
    if (localeChanged) applyTranslations();
    applyEditorPrefs();
    mdSetWidth(Math.min(64, Math.max(24, Number(v.mdWidth) || 42)), false);
    renderTabs();
  }
  function openSettings() {
    var root = $('dlgRoot'); if (!root) return;
    var previous = root.querySelector('.dlg-scrim'); if (previous) root.removeChild(previous);
    var cur = settingsCurrent();
    var scrim = document.createElement('div');
    scrim.className = 'dlg-scrim';
    var card = document.createElement('div');
    card.className = 'dlg settings-dlg';
    var pages = [
      { id: 'appearance', html:
        '<h3>Appearance</h3><div class="set-note">Theme, language and the chrome around the editor.</div>' +
        setSelectRow('theme', 'Theme', [['darcula', 'Darcula (dark)'], ['light', 'Light']], cur.theme) +
        setSelectRow('locale', 'UI language', [['en', 'English'], ['zh-CN', '简体中文']], cur.locale) +
        setNumberRow('zoom', 'UI scale (%)', cur.zoom, 70, 160, '100% is the default; persisted across restarts.') +
        setCheckRow('showBars', 'Show tool window bars', cur.showBars) +
        setCheckRow('showStatus', 'Show status bar', cur.showStatus) },
      { id: 'behavior', html:
        '<h3>Behavior</h3><div class="set-note">Startup, recovery copies and how unsaved files are handled.</div>' +
        setNumberRow('draftDelay', 'Recovery copy delay (seconds)', cur.draftDelay, 1, 30,
          'Unsaved work is copied after this much idle time.') +
        setCheckRow('confirmDirtyClose', 'Ask before closing a file with unsaved changes', cur.confirmDirtyClose) +
        setCheckRow('restoreTabs', 'Reopen files from the last session', cur.restoreTabs) +
        setCheckRow('restoreProject', 'Reopen the last project folder', cur.restoreProject) +
        setCheckRow('showAssistant', 'Show AI Assistant on startup', cur.showAssistant) },
      { id: 'editor', html:
        '<h3>Editor</h3><div class="set-note">These options are applied to CodeMirror immediately and on the next launch.</div>' +
        setCheckRow('lineNumbers', 'Show line numbers', cur.lineNumbers) +
        setCheckRow('softWrap', 'Soft wrap lines', cur.softWrap) +
        setCheckRow('activeLine', 'Highlight the caret line', cur.activeLine) +
        setCheckRow('matchBrackets', 'Highlight matching brackets', cur.matchBrackets) +
        setCheckRow('autoCloseBrackets', 'Auto-close brackets and quotes', cur.autoCloseBrackets) +
        setCheckRow('useTabs', 'Use tabs for indentation', cur.useTabs) +
        setSelectRow('tabSize', 'Tab size', [['2', '2'], ['4', '4'], ['8', '8']], String(cur.tabSize)) +
        setCheckRow('formatOnSave', 'Reformat code on save (language server)', cur.formatOnSave) },
      { id: 'interpreter', html:
        '<h3>Project Interpreter</h3><div class="set-note">Interpreters come from the active language plugin and the folder open in the Project tree. Parent and child .venv directories are discovered too.</div>' +
        setCheckRow('autoVenv', 'Match a local virtual environment automatically', cur.autoVenv,
          'On open, adopt the best local venv/conda environment unless an interpreter is pinned.') +
        '<div class="set-row"><span class="set-label">Current language<small>' + esc(currentLang || 'none') + '</small></span></div>' +
        '<div class="set-action"><button type="button" data-act="interpreter">Select Project Interpreter…</button>' +
        '<button type="button" data-act="packages">Open Packages…</button></div>' },
      { id: 'markdown', html:
        '<h3>Markdown</h3><div class="set-note">The preview is rendered by the engine, not by the page.</div>' +
        setNumberRow('mdWidth', 'Preview split (%)', cur.mdWidth, 24, 64,
          'Width of the rendered pane; the same value is used by the drag handle.') },
      { id: 'run', html:
        '<h3>Run / Debug</h3><div class="set-note">Configurations drive both the Run widget and the Debug menu.</div>' +
        '<div class="set-row"><span class="set-label">Active configuration<small>' + esc(activeConfig().name) + '</small></span></div>' +
        '<div class="set-action"><button type="button" data-act="configs">Edit Configurations…</button>' +
        '<button type="button" data-act="import">Import PyCharm Run Configurations…</button></div>' }
    ];
    card.innerHTML =
      '<div class="dlg-title"><span class="ic">' + ic('settings', 15) + '</span><span>Settings</span></div>' +
      '<div class="set-body"><div class="set-side">' +
      '<input class="set-search" type="text" placeholder="Search settings" spellcheck="false" aria-label="Search settings" />' +
      '<div class="set-tree">' + SETTINGS_CATS.map(function (c, i) {
        return '<button type="button" class="set-cat' + (i === 0 ? ' active' : '') + '" data-cat="' + c.id + '">' +
          '<span class="ic">' + ic(c.icon, 14) + '</span>' + esc(c.label) + '</button>';
      }).join('') + '</div><div class="set-empty" style="display:none">No matching settings.</div></div>' +
      '<div class="set-main">' + pages.map(function (p, i) {
        return '<div class="set-page" data-page="' + p.id + '"' + (i ? ' style="display:none"' : '') + '>' + p.html + '</div>';
      }).join('') + '</div></div>' +
      '<div class="dlg-foot">' +
      '<button type="button" class="dlg-btn" data-foot="reset">Reset</button>' +
      '<button type="button" class="dlg-btn" data-foot="cancel">Cancel</button>' +
      '<button type="button" class="dlg-btn" data-foot="apply">Apply</button>' +
      '<button type="button" class="dlg-btn primary" data-foot="ok">OK</button></div>';
    scrim.appendChild(card);
    root.appendChild(scrim);
    function close() { if (scrim.parentNode) scrim.parentNode.removeChild(scrim); }
    function selectCat(id) {
      card.querySelectorAll('.set-cat').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-cat') === id);
      });
      card.querySelectorAll('.set-page').forEach(function (p) {
        p.style.display = p.getAttribute('data-page') === id ? '' : 'none';
      });
    }
    function collect() {
      var values = {};
      Array.prototype.slice.call(card.querySelectorAll('[data-s]')).forEach(function (el) {
        var key = el.getAttribute('data-s');
        values[key] = el.type === 'checkbox' ? !!el.checked : el.type === 'number' ? Number(el.value) : el.value;
      });
      return values;
    }
    card.querySelectorAll('.set-cat').forEach(function (b) {
      b.addEventListener('click', function () { selectCat(b.getAttribute('data-cat')); });
    });
    var search = card.querySelector('.set-search');
    search.addEventListener('input', function () {
      var needle = search.value.trim().toLowerCase(), first = null;
      SETTINGS_CATS.forEach(function (c) {
        var b = card.querySelector('.set-cat[data-cat="' + c.id + '"]');
        var show = !needle || (c.label + ' ' + c.keywords).toLowerCase().indexOf(needle) !== -1;
        b.style.display = show ? '' : 'none';
        if (show && !first) first = c.id;
      });
      if (needle && first) selectCat(first);
      var empty = card.querySelector('.set-empty');
      if (empty) empty.style.display = first ? 'none' : '';
    });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); applySettings(collect()); close(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    card.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-act');
        var actions = {
          interpreter: function () { openInterpreter(); },
          packages: function () { toggleWindow('packages'); },
          configs: function () { rcOpen(); },
          import: function () { importIdeaConfigs(); }
        };
        close();
        if (actions[act]) actions[act]();
      });
    });
    card.querySelectorAll('[data-foot]').forEach(function (b) {
      b.addEventListener('click', function () {
        var what = b.getAttribute('data-foot');
        if (what === 'reset') {
          Array.prototype.slice.call(card.querySelectorAll('[data-s]')).forEach(function (el) {
            var def = SETTINGS_DEFAULTS[el.getAttribute('data-s')];
            if (def == null) return;
            if (el.type === 'checkbox') el.checked = !!def; else el.value = String(def);
          });
          setStatusHint('Settings reset — press OK or Apply');
        } else if (what === 'apply') {
          applySettings(collect());
          setStatusHint('Settings applied');
        } else if (what === 'ok') {
          applySettings(collect());
          close();
        } else close();
      });
    });
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });
    search.focus();
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
