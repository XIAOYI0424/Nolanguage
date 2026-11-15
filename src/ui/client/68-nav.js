  // ---------- navigation: definition / references / rename / quick fix / symbols ----------
  // Five requests the engine could already send but nothing could trigger. The
  // results come back as frames (see 50-runtime) and land here.
  //
  // Two rules the UI must not break:
  //   - 'unsupported' is not "no results". One says "install gopls", the other
  //     says "nothing here", and they must look different.
  //   - an edit that cannot be applied is reported, never applied partially.

  var NAV_SEQ = 0;
  var NAV_WAIT = {}; // requestId -> { kind, apply }

  function navNextId() { return ++NAV_SEQ; }

  /** Caret position in the current buffer, 0-based line/character. */
  function navCaret() {
    var pos = ta.selectionStart;
    var before = ta.value.slice(0, pos);
    var line = before.split(NLc).length - 1;
    return { line: line, character: pos - (before.lastIndexOf(NLc) + 1) };
  }

  function navClose() {
    var old = $('navPick');
    if (!old || !old.parentNode) return;
    old.parentNode.removeChild(old);
    // Removing a focused node drops focus to <body>, and then the next keystroke
    // goes to the document instead of the editor - the user is stranded with a
    // dead keyboard. Hand focus back to wherever the caret was.
    try {
      if (CMEDITOR) CMEDITOR.cm.focus();
      else ta.focus();
    } catch (e) { /* the editor may be gone */ }
  }

  /**
   * A keyboard-navigable result list. Built in JS rather than in the HTML shell
   * because the shell is a template string with a backtick guard, and a list
   * that only appears on demand has no business being static markup.
   */
  function navList(title, items, onPick, emptyText) {
    navClose();
    var wrap = document.createElement('div');
    wrap.id = 'navPick';
    wrap.tabIndex = 0;
    wrap.style.cssText = [
      'position:fixed', 'z-index:9999', 'left:50%', 'top:16%', 'transform:translateX(-50%)',
      'width:min(720px,88vw)', 'max-height:56vh', 'overflow:auto', 'padding:6px',
      'background:var(--bg2,#252b36)', 'border:1px solid var(--line,#3a4250)', 'border-radius:8px',
      'box-shadow:0 16px 40px rgba(0,0,0,.5)', 'font:12px/1.5 var(--mono,ui-monospace,monospace)',
      'color:var(--fg,#d8dee9)',
    ].join(';');

    var head = document.createElement('div');
    head.textContent = title + (items.length ? '  (' + items.length + ')' : '');
    head.style.cssText = 'padding:4px 8px 8px;opacity:.65;border-bottom:1px solid var(--line,#3a4250);margin-bottom:4px';
    wrap.appendChild(head);

    if (!items.length) {
      var none = document.createElement('div');
      none.textContent = emptyText || 'Nothing found.';
      none.style.cssText = 'padding:8px;opacity:.6';
      wrap.appendChild(none);
    }

    var sel = 0;
    var rows = [];
    items.forEach(function (it, i) {
      var row = document.createElement('div');
      row.setAttribute('data-nav-row', '1');
      row.style.cssText = 'padding:3px 8px;border-radius:4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      var main = document.createElement('span');
      main.textContent = it.label;
      row.appendChild(main);
      if (it.detail) {
        var d = document.createElement('span');
        d.textContent = '  ' + it.detail;
        d.style.cssText = 'opacity:.5';
        row.appendChild(d);
      }
      row.addEventListener('mouseenter', function () { sel = i; paint(); });
      row.addEventListener('click', function () { pick(i); });
      rows.push(row);
      wrap.appendChild(row);
    });

    function paint() {
      rows.forEach(function (r, i) {
        r.style.background = i === sel ? 'var(--sel,#2f3a4d)' : 'transparent';
      });
    }
    function pick(i) {
      var it = items[i];
      navClose();
      if (it && it.onPick) it.onPick();
    }
    paint();

    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); navClose(); ta.focus(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); rows[sel].scrollIntoView({ block: 'nearest' }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); rows[sel].scrollIntoView({ block: 'nearest' }); return; }
      if (e.key === 'Enter') { e.preventDefault(); if (items.length) pick(sel); }
    });
    wrap.addEventListener('blur', function () { setTimeout(navClose, 120); });

    document.body.appendChild(wrap);
    wrap.focus();
  }

  /** Human label for a uri: the last path segment, plus ':line'. */
  function navLabel(uri, line) {
    var path = String(uri || '').replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
    var parts = path.split('/');
    return parts[parts.length - 1] + ':' + ((line || 0) + 1);
  }

  /** True when the uri names the buffer already open (absolute vs relative). */
  function navSameFile(current, path) {
    if (!current || !path) return true;
    var a = String(current).replace(/\\/g, '/').replace(/^\.\//, '');
    var b = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
    return a === b || a.slice(-(b.length + 1)) === '/' + b || b.slice(-(a.length + 1)) === '/' + a;
  }

  /** Open a location: same file → caret, other file → switch then caret. */
  function navOpen(loc) {
    var path = String(loc.uri || '').replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
    if (!navSameFile(currentFile, path)) {
      openFile(path);
      // The buffer loads asynchronously; place the caret once it is there.
      setTimeout(function () { gotoLine(loc.line, loc.character); }, 260);
      return;
    }
    gotoLine(loc.line, loc.character);
  }

  function navError(message) { reportError({ title: 'Navigation', message: message }); }

  /** Send one navigation request; 'apply' runs with the reply frame. */
  function navRequest(kind, payload, apply) {
    var id = navNextId();
    NAV_WAIT[id] = { kind: kind, apply: apply };
    payload.kind = kind;
    payload.requestId = id;
    BRIDGE.send(payload);
  }

  /** Called from the message switch in 50-runtime. */
  function navOnFrame(m) {
    var wait = NAV_WAIT[m.requestId];
    if (!wait) return;
    delete NAV_WAIT[m.requestId];
    if (m.unsupported) {
      navError(m.unsupported);
      return;
    }
    wait.apply(m);
  }

  function navDefinition() {
    if (!lspLang()) { navError('No language server for ' + currentLang + ' — nothing to navigate.'); return; }
    var at = navCaret();
    navRequest('definition', { language: currentLang, code: ta.value, line: at.line, character: at.character }, function (m) {
      var locs = m.locations || [];
      if (!locs.length) { navError('No definition found for the symbol under the caret.'); return; }
      if (locs.length === 1) { navOpen(locs[0]); return; }
      navList('Definitions', locs.map(function (l) {
        return { label: navLabel(l.uri, l.line), detail: 'line ' + (l.line + 1), onPick: function () { navOpen(l); } };
      }));
    });
  }

  function navReferences() {
    if (!lspLang()) { navError('No language server for ' + currentLang + ' — nothing to search.'); return; }
    var at = navCaret();
    navRequest('references', {
      language: currentLang, code: ta.value, line: at.line, character: at.character, includeDeclaration: true,
    }, function (m) {
      var locs = m.locations || [];
      if (!locs.length) { navError('No references found.'); return; }
      navList(m.truncated ? 'References (truncated)' : 'References', locs.map(function (l) {
        return { label: navLabel(l.uri, l.line), detail: 'line ' + (l.line + 1), onPick: function () { navOpen(l); } };
      }), null, 'No references.');
    });
  }

  /**
   * Apply same-file edits bottom-up so earlier offsets stay valid.
   *
   * Only the current buffer is editable here: an edit for another file would
   * need that file loaded and saved, and silently doing half a rename is worse
   * than refusing.
   */
  function navApplyEdits(edits) {
    var mine = (edits || []).filter(function (e) { return true; });
    if (!mine.length) return 0;
    var lines = ta.value.split(NLc);
    function offset(line, character) {
      var idx = 0;
      for (var i = 0; i < line && i < lines.length; i++) idx += lines[i].length + 1;
      return idx + (character || 0);
    }
    var spans = mine.map(function (e) {
      return { start: offset(e.line, e.character), end: offset(e.endLine, e.endCharacter), text: e.newText };
    }).sort(function (a, b) { return b.start - a.start; });
    var text = ta.value;
    spans.forEach(function (s) {
      text = text.slice(0, s.start) + s.text + text.slice(s.end);
    });
    ta.value = text;
    renderEditor();
    updateCaret();
    scheduleCheck();
    return spans.length;
  }

  function navRename() {
    if (!lspLang()) { navError('No language server for ' + currentLang + ' — cannot rename.'); return; }
    var at = navCaret();
    inputDialog({
      title: 'Rename Symbol',
      label: 'New name',
      okLabel: 'Rename',
      onSubmit: function (value) {
        var name = String(value || '').trim();
        if (!name) return;
        navRequest('renameSymbol', {
          language: currentLang, code: ta.value, line: at.line, character: at.character, newName: name,
        }, function (m) {
          var n = navApplyEdits(m.edits || []);
          if (!n) navError('Nothing to rename here.');
        });
      },
    });
  }

  function navCodeActions() {
    if (!lspLang()) { navError('No language server for ' + currentLang + ' — no quick fixes.'); return; }
    var at = navCaret();
    navRequest('codeAction', {
      language: currentLang, code: ta.value, line: at.line, character: at.character,
    }, function (m) {
      var actions = m.actions || [];
      if (!actions.length) { navError('No quick fixes available at this position.'); return; }
      navList('Quick Fixes', actions.map(function (a) {
        return {
          label: a.title,
          detail: a.kind || '',
          onPick: function () {
            if (!a.edits || !a.edits.length) { navError('That action has no local edit.'); return; }
            navApplyEdits(a.edits);
          },
        };
      }));
    });
  }

  function navWorkspaceSymbols() {
    if (!lspLang()) { navError('No language server for ' + currentLang + ' — no symbols.'); return; }
    inputDialog({
      title: 'Go to Symbol',
      label: 'Query',
      placeholder: 'symbol name',
      okLabel: 'Search',
      onSubmit: function (value) {
        navRequest('workspaceSymbol', { language: currentLang, query: String(value || '') }, function (m) {
          var syms = m.symbols || [];
          if (!syms.length) { navError('No symbols matched.'); return; }
          navList(m.truncated ? 'Symbols (truncated)' : 'Symbols', syms.map(function (s) {
            return {
              label: s.name,
              detail: (s.kind || '') + ' · ' + navLabel(s.uri, s.line),
              onPick: function () { navOpen(s); },
            };
          }));
        });
      },
    });
  }

  // Ctrl+click jumps to the definition, the way every IDE does it.
  ta.addEventListener('click', function (e) {
    if (!e.ctrlKey || !lspLang()) return;
    e.preventDefault();
    navDefinition();
  });

  // Ctrl+T is workspace-wide, so it lives on the document rather than the editor.
  document.addEventListener('keydown', function (e) {
    if (!e.ctrlKey || e.altKey || e.shiftKey) return;
    if ((e.key || '').toLowerCase() !== 't') return;
    e.preventDefault();
    e.stopPropagation();
    navWorkspaceSymbols();
  }, true);
