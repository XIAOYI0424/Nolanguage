/**
 * The browser half of the PyCharm shell — one IIFE, served inline.
 *
 * Sections (in order): hardening, helpers, interaction layer, preferences,
 * transport bridge, editor + tokeniser, language catalogue, context menus,
 * buffers/tabs, tool windows, project tree, docks (find/performance/logs/
 * problems/run/terminal), message handling, extensions, menus, theme, modals,
 * settings, run configurations, native pickers, search everywhere, toolbar,
 * Tauri window controls, shortcuts, boot.
 *
 * It is a single function rather than more modules on purpose: the script
 * shares one closure (state, helpers, event wiring), so splitting it further
 * would mean threading that state through parameters for no readability win.
 * The seed data (`iconsJson` …) is interpolated at render time.
 */
export interface PanelClientData {
  iconsJson: string;
  patternJson: string;
  mainJson: string;
  utilsJson: string;
  jsJson: string;
  readmeJson: string;
}

export function pyCharmClientScript(d: PanelClientData): string {
  const { iconsJson, patternJson, mainJson, utilsJson, jsJson, readmeJson } = d;
  return `
/* ---------- native-app hardening (double insurance) ----------
   The Tauri shell disables these at the WebView2 level (context menu, DevTools,
   browser accelerator keys, zoom, script dialogs). This block covers the
   browser-hosted form and any setting the engine ignores. The editor and text
   inputs keep their native behaviour.

   The shell draws its own context menus on [data-ctx] regions, so the capture
   handler must leave those alone — its listener checks defaultPrevented. */
(function hardenWebView() {
  "use strict";
  function editable(t) {
    return !!(t && t.closest && t.closest('input, textarea, [contenteditable], #ta, .selectable'));
  }
  // 1. Native dialogs never appear; the shell uses its own modal/balloon.
  window.alert = function () {};
  window.confirm = function () { return false; };
  window.prompt = function () { return null; };
  // 2. Right-click / drag / selection outside editable surfaces.
  document.addEventListener('contextmenu', function (e) {
    if (editable(e.target)) return;
    if (e.target && e.target.closest && e.target.closest('[data-ctx]')) return;
    e.preventDefault();
  }, true);
  document.addEventListener('dragstart', function (e) { if (!editable(e.target)) e.preventDefault(); }, true);
  document.addEventListener('dragover', function (e) { e.preventDefault(); }, true);
  document.addEventListener('drop', function (e) { e.preventDefault(); }, true);
  document.addEventListener('selectstart', function (e) { if (!editable(e.target)) e.preventDefault(); }, true);
  document.addEventListener('dblclick', function (e) { if (!editable(e.target)) e.preventDefault(); }, true);
  // 3. Ctrl+wheel zoom and browser refresh/print accelerators.
  document.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false, capture: true });
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    if (k === 'f5' || (e.ctrlKey && (k === 'r' || k === 'p'))) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('submit', function (e) { e.preventDefault(); }, true);
})();

/* The window is created hidden (visible: false in tauri.conf.json) so there is
   no white flash. It is revealed by the Rust shell on the webview's
   PageLoadEvent::Finished — deliberately *not* from here: the page keeps
   exactly one IPC call (engine_send), which verify-pycharm.ts asserts. */

(function () {
  "use strict";
  var ICONS = ${iconsJson};
  var PY_PATTERN = ${patternJson};
  var FILES = {
    "main.py": ${mainJson},
    "utils.py": ${utilsJson},
    "main.js": ${jsJson},
    "README.md": ${readmeJson}
  };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function ic(name, size) {
    var d = ICONS[name]; if (!d) return "";
    return '<svg class="ic" viewBox="' + d.vb + '" width="' + size + '" height="' + size +
      '" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d.d + '</svg>';
  }
  function paintIcons(root) {
    (root || document).querySelectorAll('[data-ic]').forEach(function (el) {
      el.innerHTML = ic(el.getAttribute('data-ic'), el.getAttribute('data-size') || 16);
    });
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  var toastT;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 1800); }

  // ---------- PyCharm-style interaction layer ----------
  // Three rules, applied everywhere:
  //   1. the browser's own dialogs are disabled outright (they are a web page's
  //      vocabulary, and a native IDE never shows them);
  //   2. anything that must ask the user goes through showModal — one
  //      component behind the naming dialog, delete confirmation, settings, run
  //      configurations and error reporting;
  //   3. anything that merely informs goes through balloon — bottom-right,
  //      typed, auto-dismissing, never blocking.
  // toast() is kept as the internal one-line shorthand over balloon.
  (function disableBrowserDialogs() {
    // Safety net: a missed call site degrades to a balloon instead of a browser
    // popup. Returning false/null (rather than throwing) keeps a stale caller
    // from crashing the shell.
    window.alert = function (msg) { balloon({ type: 'warning', title: 'Notice', message: String(msg) }); };
    window.confirm = function (msg) { balloon({ type: 'warning', title: 'Confirm', message: String(msg) + ' (cancelled)' }); return false; };
    window.prompt = function (msg) { balloon({ type: 'warning', title: 'Input', message: String(msg) }); return null; };
  })();

  /** Bottom-right balloon. type is info | success | warning | error. */
  function balloon(o) {
    var host = $('balloons'); if (!host) return;
    var el = document.createElement('div');
    el.className = 'balloon ' + (o.type || 'info');
    var body = '<div style="flex:1;min-width:0">' +
      '<div class="bt">' + esc(o.title || '') + '</div>' +
      (o.message ? '<div class="bm">' + esc(o.message) + '</div>' : '') +
      (o.actions && o.actions.length
        ? '<div class="ba">' + o.actions.map(function (a, i) { return '<a data-i="' + i + '">' + esc(a.label) + '</a>'; }).join('') + '</div>'
        : '') +
      '</div><div class="bx" data-close="1">&#x2715;</div>';
    el.innerHTML = body;
    el.querySelectorAll('.ba a').forEach(function (a) {
      a.addEventListener('click', function () { var i = +a.getAttribute('data-i'); var act = o.actions[i]; if (act && act.onClick) act.onClick(); dismiss(); });
    });
    el.querySelector('[data-close]').addEventListener('click', dismiss);
    host.appendChild(el);
    var timer = setTimeout(dismiss, o.duration || (o.type === 'error' ? 8000 : 4000));
    function dismiss() { clearTimeout(timer); if (el.parentNode) el.parentNode.removeChild(el); }
  }

  /**
   * The one dialog. Options: title, icon, message, sub, list[{icon,label}],
   * fields[{name,label,value,placeholder,validator}], checkboxes[{name,label,default}],
   * detail, buttons[{label,primary,danger,onClick(values)}].
   * Enter submits the primary button; Escape cancels. Focus starts on the first
   * field (PyCharm selects the whole name so typing replaces it).
   */
  function showModal(o) {
    var root = $('dlgRoot'); if (!root) return null;
    var prev = root.querySelector('.dlg-scrim'); if (prev) root.removeChild(prev);
    var scrim = document.createElement('div');
    scrim.className = 'dlg-scrim';
    var card = document.createElement('div');
    card.className = 'dlg';
    var html = '<div class="dlg-title">' + (o.icon ? '<span class="ic">' + ic(o.icon, 15) + '</span>' : '') +
      '<span>' + esc(o.title || '') + '</span></div><div class="dlg-body">';
    if (o.message) html += '<div class="dlg-msg">' + esc(o.message) + (o.sub ? '<div class="sub">' + esc(o.sub) + '</div>' : '') + '</div>';
    if (o.list && o.list.length) {
      html += '<div class="dlg-list">' + o.list.map(function (r) {
        return '<div class="row"><span class="ic">' + ic(r.icon || 'file', 14) + '</span><span class="nm">' + esc(r.label) + '</span></div>';
      }).join('') + '</div>';
    }
    (o.fields || []).forEach(function (f) {
      html += '<div class="dlg-field"><label>' + esc(f.label || '') + '</label>' +
        '<input data-f="' + esc(f.name) + '" type="text" value="' + esc(f.value == null ? '' : f.value) + '"' +
        ' placeholder="' + esc(f.placeholder || '') + '" spellcheck="false" />' +
        '<div class="err" data-err="' + esc(f.name) + '"></div></div>';
    });
    (o.checkboxes || []).forEach(function (c) {
      html += '<label class="dlg-check"><input type="checkbox" data-c="' + esc(c.name) + '"' + (c.def ? ' checked' : '') + ' />' + esc(c.label) + '</label>';
    });
    if (o.detail) html += '<div class="dlg-detail">' + esc(o.detail) + '</div>';
    html += '</div><div class="dlg-foot"></div>';
    card.innerHTML = html;
    var foot = card.querySelector('.dlg-foot');
    var primaryBtn = null;
    (o.buttons || [{ label: 'OK', primary: true }]).forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'dlg-btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', function () { submit(b); });
      foot.appendChild(btn);
      if (b.primary && !primaryBtn) primaryBtn = btn;
    });
    scrim.appendChild(card);
    root.appendChild(scrim);

    var inputs = Array.prototype.slice.call(card.querySelectorAll('input[data-f]'));
    function values() {
      var v = {};
      inputs.forEach(function (i) { v[i.getAttribute('data-f')] = i.value; });
      card.querySelectorAll('input[data-c]').forEach(function (c) { v[c.getAttribute('data-c')] = c.checked; });
      return v;
    }
    function validate() {
      var ok = true;
      (o.fields || []).forEach(function (f) {
        var err = f.validator ? f.validator(values()[f.name]) : null;
        var slot = card.querySelector('[data-err="' + f.name + '"]');
        if (slot) slot.textContent = err || '';
        if (err) ok = false;
      });
      return ok;
    }
    function submit(b) {
      if (!validate()) return;
      close();
      if (b && b.onClick) b.onClick(values());
    }
    function close() { if (scrim.parentNode) scrim.parentNode.removeChild(scrim); }
    inputs.forEach(function (i) {
      i.addEventListener('input', validate);
      i.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); if (primaryBtn) primaryBtn.click(); }
        if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
    });
    scrim.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });
    // PyCharm selects the whole default name so typing replaces it.
    if (inputs.length) { inputs[0].focus(); inputs[0].select(); }
    else if (primaryBtn) primaryBtn.focus();
    return { close: close, values: values };
  }

  /** Confirm with typed buttons; buttons default to Cancel / OK. */
  function confirmDialog(o) {
    var btns = o.buttons || [
      { label: 'Cancel', onClick: function () {} },
      { label: o.okLabel || 'OK', primary: true, onClick: function () {} },
    ];
    return showModal({
      title: o.title || 'Confirm',
      icon: o.icon || 'warn',
      message: o.message,
      sub: o.sub,
      list: o.list,
      detail: o.detail,
      buttons: btns,
    });
  }
  /** Input with optional validation; resolves through the caller's callback. */
  function inputDialog(o) {
    return showModal({
      title: o.title || 'Input',
      icon: o.icon,
      message: o.message,
      fields: [{ name: 'value', label: o.label || 'Value', value: o.value, placeholder: o.placeholder, validator: o.validator }],
      buttons: [
        { label: 'Cancel', onClick: function () {} },
        { label: o.okLabel || 'OK', primary: true, onClick: function (v) { if (o.onSubmit) o.onSubmit(v.value); } },
      ],
    });
  }
  /** Error report: modal for real errors, balloon for warnings, nothing for info. */
  function reportError(o) {
    var level = o.level || 'error';
    if (level === 'error' || level === 'fatal') {
      showModal({
        title: o.title || 'Error',
        icon: 'close',
        message: o.message,
        detail: o.detail,
        buttons: [
          { label: 'Copy', onClick: function () { copyText((o.message || '') + (o.detail ? '\\n' + o.detail : '')); } },
          o.canRetry ? { label: 'Retry', primary: true, onClick: o.onRetry } : null,
          { label: 'OK', primary: !o.canRetry, onClick: function () {} },
        ].filter(Boolean),
      });
    } else {
      balloon({
        type: level === 'info' ? 'info' : 'warning',
        title: o.title || 'Warning',
        message: o.message + (o.detail ? '\\n' + o.detail : ''),
      });
    }
  }


  // ---------- preferences (localStorage) ----------
  // One key holds theme, open tabs, layout and recent files, so a single parse
  // restores the whole session. Storage may be unavailable (private mode / no
  // origin), so every access is guarded and persistence simply no-ops then.
  var LSKEY = 'nolanguage.pycharm.v1';
  function loadPrefs() { try { return JSON.parse(localStorage.getItem(LSKEY) || '{}') || {}; } catch (e) { return {}; } }
  var PREFS = loadPrefs();
  function savePrefs(patch) {
    try {
      var cur = loadPrefs();
      Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
      localStorage.setItem(LSKEY, JSON.stringify(cur));
    } catch (e) { /* storage unavailable */ }
  }
  var RECENT = (PREFS.recent && PREFS.recent.length) ? PREFS.recent.slice(0, 10) : [];
  function pushRecent(p) {
    if (!p) return;
    var i = RECENT.indexOf(p);
    if (i >= 0) RECENT.splice(i, 1);
    RECENT.unshift(p);
    if (RECENT.length > 10) RECENT.length = 10;
    savePrefs({ recent: RECENT });
  }

  // Explicit language overrides, per document path. A document's language is
  // the file type unless the user said otherwise, so only the exceptions are
  // stored — deleting a key is exactly "back to the file type". Persisted for
  // the same reason the open tabs are: coming back to a file should come back
  // to how you left it.
  var LANGSET = (PREFS.langs && typeof PREFS.langs === 'object') ? PREFS.langs : {};
  /**
   * A document's language: an explicit choice wins, else what the file says.
   * \fromServer\ is the backend's own extension mapping, which knows more
   * extensions than the local table but must still yield to the user.
   */
  function langOfDoc(name, fromServer) {
    return LANGSET[name] || fromServer || langOfName(name) || 'python';
  }
  function setLangOverride(name, lang) {
    if (lang) LANGSET[name] = lang; else delete LANGSET[name];
    savePrefs({ langs: LANGSET });
  }

  // ---------- transport bridge ----------
  // One page, two hosts. The Node dev server (and the packaged WebView window)
  // speaks WebSocket; the Tauri build reaches the engine through IPC — the Rust
  // core relays invoke('engine_send') to a Node sidecar pipe and pushes replies
  // back as engine_message events. Everything downstream is identical: the shell
  // never learns which one is in use.
  //
  // Note *which* global: Tauri v2 injects window.__TAURI_INTERNALS__ (invoke +
  // transformCallback). The friendlier window.__TAURI__ comes from the
  // @tauri-apps/api package, which this page deliberately does not bundle — so
  // the bridge talks to the internals directly. Verified by probing a running
  // window: __TAURI__ is undefined, __TAURI_INTERNALS__.invoke is a function.
  var BRIDGE = (function () {
    var T = window.__TAURI_INTERNALS__;
    if (T && typeof T.invoke === 'function') {
      var listen = function (name, fn) {
        // v2 events are a plugin command taking a callback id; transformCallback
        // allocates it. The handler receives { event, payload, id }.
        T.invoke('plugin:event|listen', {
          event: name,
          handler: T.transformCallback(function (e) { fn(e); })
        });
      };
      return {
        send: function (msg) { T.invoke('engine_send', { msg: msg }); },
        onMessage: function (fn) { listen('engine_message', function (e) { fn(e && e.payload); }); },
        // Even IPC is asynchronous in Tauri (the listen call resolves on a later
        // tick), so the shell's "ready" moment must not be synchronous — the
        // rest of the page is still being defined at this point.
        onOpen: function (fn) { setTimeout(fn, 0); },
        onClose: function (fn) { listen('engine_exit', function () { fn(); }); },
        ready: function () { return true; } // IPC is always connected
      };
    }
    var sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/');
    return {
      send: function (msg) { sock.send(JSON.stringify(msg)); },
      onMessage: function (fn) {
        sock.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } fn(m); };
      },
      onOpen: function (fn) { sock.onopen = fn; },
      onClose: function (fn) { sock.onclose = fn; },
      ready: function () { return sock.readyState === 1; }
    };
  })();
  var KCOMMANDS = [];
  BRIDGE.onMessage(handle);
  BRIDGE.onOpen(function () { BRIDGE.send({ kind: 'listExtensions' }); bootProject(); });
  BRIDGE.onClose(function () {
    // The engine went away (tab closed, sidecar died). The shell keeps working
    // for what it already holds; say so instead of failing silently.
    toast('Workspace disconnected');
  });

  // ---------- editor ----------
  var ta = $('ta'), hlCode = $('hlCode'), hl = $('hl'), glines = $('glines');
  var currentFile = 'main.py';
  var currentLang = 'python';
  var BREAKPOINTS = { 9: true }; // 1-based line numbers with a breakpoint
  var folded = {}; // line -> collapsed

  // ---------- CodeMirror (vendored, optional) ----------
  // When the vendored CodeMirror is present the textarea becomes a thin adapter
  // over a real CM instance. The adapter mirrors the textarea API, so the rest
  // of this file, written against a textarea, keeps working unchanged. jsdom
  // has no layout, so the test harness stays on the textarea.
  var CMEDITOR = null;
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
  function lineIndent(line) { var m = /^[ \\t]*/.exec(line); return m ? m[0].length : 0; }
  function isDefLine(line) { return /^[ \\t]*(def|class)\\b/.test(line); }

  function renderGutter(lines) {
    var html = '';
    for (var i = 0; i < lines.length; i++) {
      var n = i + 1;
      var cls = 'gline';
      if (BREAKPOINTS[n]) cls += ' hasbp';
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
      if (BREAKPOINTS[n]) inner = '<span class="bp" data-bp="' + n + '"></span>' + inner;
      if (cls.indexOf('foldable') >= 0) inner = '<span class="fold" data-fold="' + n + '">' + (folded[n] ? ic('chevR', 12) : ic('chevD', 12)) + '</span>' + inner;
      html += '<div class="' + cls + '">' + inner + '</div>';
    }
    glines.innerHTML = html;
    glines.querySelectorAll('[data-bp]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); var n = +el.getAttribute('data-bp'); delete BREAKPOINTS[n]; renderEditor(); });
    });
    glines.querySelectorAll('[data-fold]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); var n = +el.getAttribute('data-fold'); if (folded[n]) delete folded[n]; else folded[n] = true; renderEditor(); });
    });
  }

  function visibleLines(code) {
    if (!Object.keys(folded).length) return code.split('\\n');
    var lines = code.split('\\n'), out = [], skipIndent = -1;
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
      return;
    }
    var code = ta.value;
    var vis = visibleLines(code);
    hlCode.innerHTML = highlight(vis.join('\\n')) + '\\n';
    renderGutter(code.split('\\n'));
    syncScroll();
  }
  function syncScroll() {
    glines.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
    var cl = $('curline'); if (cl) cl.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
  }
  function updateCaret() {
    var pos = ta.selectionStart, before = ta.value.slice(0, pos);
    var line = before.split('\\n').length, col = pos - before.lastIndexOf('\\n');
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

  ta.addEventListener('input', function () { renderEditor(); scheduleComplete(); });
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
  // ---------- tab context menu ----------
  function closeAllTabs() { TABS.slice().forEach(function (p) { closeTab(p); }); }
  function tabMenu(name) {
    if (!name) return [{ label: 'Close All', act: closeAllTabs }];
    return [
      { label: 'Close', sc: 'Ctrl+F4', act: function () { closeTab(name); } },
      { label: 'Close Others', act: function () { TABS.slice().forEach(function (p) { if (p !== name) closeTab(p); }); } },
      { label: 'Close All', act: closeAllTabs }
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
    if (CMP.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); cmpMove(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); cmpMove(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); cmpAccept(); return; }
      if (e.key === 'Escape') { e.preventDefault(); CMP.dismissed = true; cmpClose(); return; }
    }
    if (e.ctrlKey && (e.key === ' ' || e.key === 'Spacebar')) { e.preventDefault(); requestComplete(); return; }
    if (e.key === 'Tab') { e.preventDefault(); insertText('    '); scheduleComplete(); return; }
    if (e.key === 'Enter') { e.preventDefault(); autoIndentEnter(); scheduleComplete(); return; }
    if (e.key === 'Escape') { CMP.dismissed = true; cmpClose(); return; }
    var close = CLOSERS[e.key];
    if (close) { e.preventDefault(); autoPair(e.key, close); scheduleComplete(); return; }
  }
  function autoIndentEnter() {
    var pos = ta.selectionStart, val = ta.value;
    var ls = val.lastIndexOf(NLc, pos - 1) + 1;
    var lineText = val.slice(ls, pos);
    var indent = leadWs(lineText);
    var trimmed = lineText.replace(/[ ]+$/, '');
    var last = trimmed.charAt(trimmed.length - 1);
    var grow = (':{(['.indexOf(last) >= 0);
    var nextCh = val.charAt(pos);
    if (grow && (')]}'.indexOf(nextCh) >= 0)) {
      replaceRange(pos, pos, NLc + indent + '    ' + NLc + indent);
      ta.selectionStart = ta.selectionEnd = pos + 1 + indent.length + 4;
    } else {
      var add = grow ? '    ' : '';
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
        if (ch !== ' ' && ch !== '\\t') break;
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
    el.querySelectorAll('.row').forEach(function (row) {
      row.addEventListener('mousedown', function (ev) { ev.preventDefault(); CMP.sel = +row.getAttribute('data-i'); cmpAccept(); });
    });
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
  function cmpAccept() {
    if (!CMP.open) return;
    var it = CMP.items[CMP.sel]; CMP.dismissed = true; cmpClose();
    if (!it) return;
    var pos = ta.selectionStart, pref = wordPrefix(), start = pos - pref.length;
    ta.value = ta.value.slice(0, start) + it.label + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = start + it.label.length;
    renderEditor(); updateCaret();
  }
  function cmpClose() { CMP.open = false; var el = $('cmp'); if (el) el.classList.remove('open'); }
  function onCodeMouseMove(e) {
    clearTimeout(HOV.timer);
    if (CMEDITOR) {
      var p = CMEDITOR.cm.coordsChar({ left: e.clientX, top: e.clientY });
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
  function onHover(m) {
    if (m.requestId !== HOV.reqId) return;
    var tip = $('hoverTip'), text = hoverText(m.hover);
    if (!text) { tip.classList.remove('open'); return; }
    tip.textContent = text;
    var host = tip.parentNode ? tip.parentNode : document.body;
    var hr = host.getBoundingClientRect();
    tip.style.left = Math.max(0, Math.min(HOV.cx - hr.left + 12, host.clientWidth - 340)) + 'px';
    tip.style.top = (HOV.cy - hr.top + 16) + 'px';
    tip.classList.add('open');
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
  var TABS = ['main.py', 'utils.py', 'README.md']; // open rel-paths (seeded with samples)
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
      b.className = 'etab' + (p === currentFile ? ' active' : '');
      b.setAttribute('data-tab', p); // the right-click menu needs to know which tab
      b.innerHTML = '<span class="ic">' + ic('file', 16) + '</span><span class="nm">' + esc(p) + '</span>' +
        (p === currentFile && bufferDirty(p) ? '<span class="dirty">●</span>' : '') +
        '<span class="x" data-close="' + esc(p) + '">' + ic('close', 12) + '</span>';
      b.addEventListener('click', function (e) {
        if (e.target.closest('[data-close]')) { e.stopPropagation(); closeTab(p); return; }
        openFile(p);
      });
      el.appendChild(b);
    });
    var more = document.createElement('button');
    more.className = 'more'; more.innerHTML = ic('chevD', 16); more.title = 'Show hidden tabs';
    el.appendChild(more);
  }
  function closeTab(p) {
    var i = TABS.indexOf(p); if (i < 0) return;
    TABS.splice(i, 1); delete BUFFERS[p];
    if (currentFile === p) {
      var next = TABS[TABS.length - 1];
      if (next) openFile(next);
      else { currentFile = null; currentLang = 'python'; ta.value = ''; ta.readOnly = true; $('stFile').textContent = ''; renderStLang(); renderTabs(); renderEditor(); }
    } else { renderTabs(); }
    savePrefs({ tabs: TABS, current: currentFile });
  }
  function openFile(name) {
    if (BUFFERS[name]) { showBuffer(name); return; }
    // Load from the real filesystem; fall back to the bundled sample for offline boot.
    BRIDGE.send({ kind: 'fsRead', path: name });
    if (FILES[name] != null) showBuffer(name, FILES[name]);
  }
  function showBuffer(name, fallback) {
    var buf = BUFFERS[name];
    if (!buf) {
      if (fallback == null) { toast('no content for ' + name); return; }
      buf = BUFFERS[name] = { content: fallback, languageId: langOfDoc(name), editable: true, dirty: false };
    }
    if (!isOpen(name)) TABS.push(name);
    currentFile = name; currentLang = buf.languageId || 'python';
    ta.value = buf.content;
    ta.readOnly = !buf.editable;
    $('stFile').textContent = name;
    renderStLang();
    renderTabs(); renderEditor(); updateCaret();
    if (lspLang()) BRIDGE.send({ kind: 'check', code: ta.value, language: lspLang() });
    pushRecent(name);
    savePrefs({ tabs: TABS, current: currentFile });
  }
  function saveFile() {
    if (!currentFile || !BUFFERS[currentFile]) { reportError({ level: 'warn', title: 'Nothing to save', message: 'No document is open.' }); return; }
    if (ta.readOnly) { reportError({ level: 'warn', title: 'Read-only', message: currentFile + ' cannot be modified.' }); return; }
    var p = currentFile, content = ta.value;
    BRIDGE.send({ kind: 'fsWrite', path: p, content: content });
    // No dialog: PyCharm writes straight to disk and only shows a transient
    // status-bar hint. The failure path is the one that talks.
    setStatusHint('Saving ' + p + ' …');
  }
  function onFsFile(f) {
    var name = f.path;
    BUFFERS[name] = { content: f.content, languageId: langOfDoc(name, f.languageId), editable: f.truncated ? false : f.editable !== false, dirty: false, mtime: f.mtime };
    if (!isOpen(name)) TABS.push(name);
    if (currentFile === name || currentFile == null) showBuffer(name);
    else renderTabs();
  }
  function onFsSaved(m) {
    if (BUFFERS[m.path]) { BUFFERS[m.path].dirty = false; BUFFERS[m.path].content = ta.value; }
    renderTabs();
    setStatusHint('Saved ' + m.path);
  }
  function onFsError(m) {
    // A read of an embedded-sample path (e.g. boot's main.py) legitimately has
    // no on-disk file; we already loaded the bundled fallback, so stay quiet.
    if (m.path && BUFFERS[m.path]) return;
    reportError({ level: 'error', title: 'File system error', message: String(m.message || m.code || 'unknown'), detail: m.path });
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
    if (currentFile && BUFFERS[currentFile]) BUFFERS[currentFile].dirty = true;
    renderTabs();
  });

  // ---------- tool strip + tool windows ----------
  // Scope note: this shell is a *language* IDE. Database / Docker / remote / HTTP
  // client tooling is deliberately out of scope, so there is no database window
  // or strip entry — only the language-relevant tool windows live here.
  var LEFT_WINDOWS = [
    { id: 'project', title: 'Project', icon: 'project', key: 'Alt+1' },
    { id: 'structure', title: 'Structure', icon: 'structure', key: 'Alt+7' },
    { id: 'vcs', title: 'Version Control', icon: 'vcs', key: 'Alt+9' },
    { id: 'commit', title: 'Commit', icon: 'commit', key: 'Ctrl+K' },
    { id: 'ai', title: 'AI Assistant', icon: 'ai', key: 'Alt+A' }
  ];
  var BOTTOM_WINDOWS = [
    { id: 'run', title: 'Run', icon: 'run', key: 'Alt+4' },
    { id: 'terminal', title: 'Terminal', icon: 'terminal', key: 'Alt+F12' },
    { id: 'perf', title: 'Performance', icon: 'perf', key: 'Alt+8' },
    { id: 'logs', title: 'Logs', icon: 'logs', key: 'Alt+0' },
    { id: 'find', title: 'Find', icon: 'search', key: 'Ctrl+Shift+F' }
  ];
  var PROBLEMS = { id: 'problems', title: 'Problems', icon: 'warn', key: '' };
  // strip order per PyCharm New UI
  var STRIP = ['project', 'vcs', 'commit', 'terminal', 'run', 'structure', 'perf', 'logs', 'ai'];

  var activeLeft = 'project';
  var activeBottom = 'run';
  var pinned = true;

  function windowById(id) {
    var all = LEFT_WINDOWS.concat(BOTTOM_WINDOWS).concat([PROBLEMS]);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function isBottom(id) { return id === 'run' || id === 'terminal' || id === 'perf' || id === 'logs' || id === 'problems' || id === 'find'; }

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
    else if (activeLeft === 'vcs') body.innerHTML = '<div class="empty">No local changes.<br/>Working tree clean on <b>main</b>.</div>';
    else if (activeLeft === 'commit') body.innerHTML = commitPane();
    else if (activeLeft === 'ai') body.innerHTML = aiPane();
    else body.innerHTML = '';
    if (activeLeft === 'commit') wireCommit(body);
  }
  function treeHtml(nodes) {
    var h = '<div style="padding:6px 4px;font-size:12.5px">';
    nodes.forEach(function (n) {
      h += '<div style="display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:5px;margin-left:' + (n.d * 14) + 'px" class="tnode">';
      h += '<span class="ic" style="color:var(--icon-default)">' + ic(n.dir ? 'project' : 'file', 16) + '</span>';
      h += '<span>' + esc(n.name) + '</span></div>';
    });
    return h + '</div>';
  }
  // ---------- project tree (real filesystem) ----------
  var TREE = {};        // dir relPath -> FsEntry[] (one level, cached)
  var TREE_LOADING = {};// dir relPath -> true while a listing is in flight
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
        h += '<div class="tnode dir ' + (EXPANDED[e.path] ? 'open' : '') + '" data-path="' + esc(e.path) + '" data-kind="dir" style="padding-left:' + (6 + depth * 14) + 'px">' +
          '<span class="chev">' + ic(EXPANDED[e.path] ? 'chevD' : 'chevR', 14) + '</span>' +
          '<span class="ic">' + ic('project', 16) + '</span><span class="nm">' + esc(e.name) + '</span></div>';
        h += renderNodes(e.path, depth + 1);
      } else {
        h += '<div class="tnode file ' + (e.path === currentFile ? 'active' : '') + (e.editable ? '' : ' ro') + '" data-path="' + esc(e.path) + '" data-kind="file" style="padding-left:' + (6 + (depth + 1) * 14) + 'px">' +
          '<span class="chev"></span><span class="ic">' + ic('file', 16) + '</span><span class="nm">' + esc(e.name) + '</span></div>';
      }
    });
    return h;
  }
  function wireTree(scope) {
    scope.querySelectorAll('.tnode').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.button !== 0) return;
        var path = row.getAttribute('data-path'), kind = row.getAttribute('data-kind');
        if (kind === 'dir') { var was = EXPANDED[path]; if (was) delete EXPANDED[path]; else EXPANDED[path] = true; loadDir(path); renderTree(); }
        else openFile(path);
      });
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var rp = row.getAttribute('data-path'), dir = parentDir(rp), isDir = row.getAttribute('data-kind') === 'dir';
        var target = isDir ? rp : dir;
        showCtx(e.clientX, e.clientY, [
          { label: 'New', sc: 'Alt+Ins', act: function () { showNewPopup(e.clientX, e.clientY, target); } },
          { sep: true },
          { label: 'Open', act: function () { openFile(rp); } },
          { label: 'Copy Path', act: function () { copyText(rp); } },
          { sep: true },
          { label: 'Rename…', sc: 'Shift+F6', act: function () { startInlineRename(row, rp); } },
          { label: 'Delete…', sc: 'Del', act: function () { deleteEntry([rp]); } }
        ]);
      });
      // PyCharm renames on F2 / a slow second click as well as from the menu.
      row.addEventListener('dblclick', function () {
        var rp = row.getAttribute('data-path');
        if (rp) startInlineRename(row, rp);
      });
    });
  }
  function onFsListing(m) {
    TREE[m.path] = m.entries || []; TREE_LOADING[m.path] = false;
    if (activeLeft === 'project') renderTree();
  }
  function onFsChanged(m) {
    if (m.op === 'create') refreshDir(parentDir(m.path));
    else if (m.op === 'rename') { refreshDir(parentDir(m.from)); refreshDir(parentDir(m.path)); }
    else if (m.op === 'delete') refreshDir(parentDir(m.path));
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
          if (/[\\/:*?"<>|]/.test(n)) return 'These characters are not allowed: \\ / : * ? " < > |';
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
   * Show a context menu. Items are \{label, sc?, act?, dis?}\ or \{sep:true}\.
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
      el.className = 'citem' + (it.dis ? ' dis' : '');
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
  function structureTree(code) {
    var lines = code.split('\\n'), nodes = [];
    lines.forEach(function (l, i) {
      var m = /^(\\s*)(def|class)\\s+([A-Za-z_]\\w*)/.exec(l);
      if (m) nodes.push({ name: m[3] + (m[2] === 'class' ? ' (class)' : '()'), d: Math.floor(m[1].length / 4), line: i + 1 });
    });
    if (!nodes.length) return '<div class="empty">No symbols in this file.</div>';
    return treeHtml(nodes.map(function (n) { return { name: n.name, d: n.d }; }));
  }
  function commitPane() {
    return '<div style="padding:10px;display:flex;flex-direction:column;gap:8px;height:100%">' +
      '<textarea id="commitMsg" placeholder="Commit message" style="flex:1;min-height:90px;resize:none;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:8px;font:12px var(--sans)"></textarea>' +
      '<div style="display:flex;gap:8px"><button class="tbtn" id="commitBtn" style="flex:1;justify-content:center">Commit</button></div>' +
      '<div class="empty">Unversioned files · nothing staged (demo)</div></div>';
  }
  function wireCommit(body) {
    var b = body.querySelector('#commitBtn');
    if (b) b.addEventListener('click', function () { toast('Committed (demo)'); });
  }
  function aiPane() {
    return '<div style="padding:12px;display:flex;flex-direction:column;gap:10px">' +
      '<div style="color:var(--text-secondary);font-size:12px">Ask about the current file.</div>' +
      '<div style="display:flex;gap:6px"><input id="aiInput" placeholder="Explain this function…" style="flex:1;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text-primary)"/>' +
      '<button class="tbtn" id="aiAsk">Ask</button></div>' +
      '<div id="aiOut" class="console dim">—</div></div>';
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
      pane('run', '<div class="console" id="runOut"><span class="dim">Click Run (Shift+F10) to execute main.py in the sandbox.</span></div>' +
        '<div class="term-line" id="runLine"><span class="prompt" id="runPrompt">input&gt;</span>' +
        '<input class="term-in" id="runIn" disabled spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="program asks for input? type here, then Enter" /></div>') +
      pane('terminal', termPane()) +
      pane('perf', perfPane()) +
      pane('logs', logsPane()) +
      pane('find', findPane()) +
      pane('problems', '<div id="probOut"><div class="empty">No problems.</div></div>');
    wirePerf(); wireLogs(); wireTerm(); wireFind();
    var ri = $('runIn');
    if (ri) ri.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var v = ri.value; ri.value = '';
        if (RUN_ACTIVE) { BRIDGE.send({ kind: 'runInput', text: v + '\\n' }); appendRun(v + '\\n'); }
      }
    });
    if (activeBottom === 'logs') renderLogs();
    if (activeBottom === 'perf') renderPerf(lastMetrics);
    if (activeBottom === 'terminal') { renderTermOut(); var ti = $('termIn'); if (ti) ti.focus(); }
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
  function wireFind() {
    var inp = $('findIn'); if (!inp) return;
    inp.addEventListener('input', function () { renderFind(inp.value, $('findCS') && $('findCS').checked); });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { inp.value = ''; renderFind('', false); } });
    var cs = $('findCS'); if (cs) cs.addEventListener('change', function () { renderFind(inp.value, cs.checked); });
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
    var total = 0;
    Object.keys(BUFFERS).forEach(function (path) {
      var content = BUFFERS[path].content || '';
      var lines = content.split('\\n');
      var hits = [];
      lines.forEach(function (ln, i) {
        var hay = cs ? ln : ln.toLowerCase();
        var idx = hay.indexOf(needle);
        if (idx >= 0) hits.push({ line: i + 1, text: ln });
      });
      if (!hits.length) return;
      total += hits.length;
      html += '<div class="fgroup" data-path="' + esc(path) + '"><div class="fhead">' + esc(path) + ' <span class="dim">(' + hits.length + ')</span></div>';
      hits.forEach(function (h) {
        html += '<div class="fhit" data-path="' + esc(path) + '" data-line="' + h.line + '">' +
          '<span class="fl">Ln ' + h.line + '</span>' + esc(h.text.slice(0, 200)) + '</div>';
      });
      html += '</div>';
    });
    out.innerHTML = total ? html : '<div class="empty">No matches in open files.</div>';
    out.querySelectorAll('.fhit').forEach(function (el) {
      el.addEventListener('dblclick', function () { gotoLineInFile(el.getAttribute('data-path'), +el.getAttribute('data-line')); });
    });
  }
  function gotoLineInFile(path, line) {
    if (!BUFFERS[path]) { openFile(path); }
    else showBuffer(path);
    var target = path, n = line;
    setTimeout(function () {
      var lines = ta.value.split('\\n');
      var pos = 0; for (var i = 0; i < n - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      ta.focus(); ta.setSelectionRange(pos, pos); updateCaret();
    }, 0);
  }
  function pane(id, inner) {
    return '<div class="dock-pane' + (activeBottom === id ? ' active' : '') + '" data-pane="' + id + '">' + inner + '</div>';
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
  function wirePerf() { if (activeBottom !== 'perf') return; }

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
        label: (it.checked ? '✓  ' : '    ') + it.label,
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

  // ---------- problems ----------
  var problems = [];
  function renderProblems(items) {
    problems = items || [];
    var out = $('probOut');
    $('stProblems').textContent = problems.length + (problems.length === 1 ? ' problem' : ' problems');
    if (!out) return;
    if (!problems.length) { out.innerHTML = '<div class="empty">No problems detected.</div>'; return; }
    out.innerHTML = problems.map(function (p) {
      var sev = p.severity === 1 ? 'error' : 'warn';
      return '<div class="prob ' + sev + '"><span class="ic">' + ic(sev === 'error' ? 'close' : 'warn', 14) + '</span>' +
        '<span class="loc">' + (p.line + 1) + ':' + (p.character + 1) + '</span>' +
        '<span class="msg">' + esc(p.message) + '</span></div>';
    }).join('');
  }

  // ---------- run ----------
  function runCode() {
    activeBottom = 'run'; $('dock').classList.remove('hidden'); renderDock();
    var out = $('runOut');
    out.innerHTML = '<span class="cmd">&gt; ' + currentLang + ' ' + esc(currentFile) + '</span>\\n';
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
    var parts = cmd.split(/\s+/), head = parts[0], rest = cmd.slice(head.length).trim();
    switch (head) {
      case 'clear': TERM_LINES = []; renderTermOut(); return true;
      case 'help':
        termWrite('Built-ins: help, clear, echo, date, pwd, whoami, history, theme [dark|light]\\n', 'dim');
        termWrite('Everything else runs as a shell command in the project root (ls, git status, python main.py …).\\n', 'dim');
        return true;
      case 'echo': termWrite(rest + '\\n'); return true;
      case 'date': termWrite(new Date().toString() + '\\n'); return true;
      case 'pwd': termWrite('/Nolanguage\\n', 'acc'); return true;
      case 'whoami': termWrite('developer\\n', 'acc'); return true;
      case 'theme':
        setTheme(rest === 'light' ? 'light' : 'darcula');
        termWrite('theme -> ' + (rest === 'light' ? 'light' : 'darcula') + '\\n', 'dim');
        return true;
      case 'history':
        TERM_HIST.forEach(function (h, i) { termWrite((i + 1) + '  ' + h + '\\n', 'dim'); });
        return true;
      default: return false;
    }
  }
  function termSubmit(raw) {
    var cmd = raw.replace(/\s+$/, '');
    termWrite(TERM_PROMPT + ' ' + cmd + '\\n');
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
      termWrite('Nolanguage terminal — type "help" for built-ins; other commands run in the project root.\\n', 'dim');
    }
    renderTermOut();
    var inp = $('termIn'); if (!inp) return;
    var out = $('termOut');
    if (out) out.addEventListener('click', function () { inp.focus(); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var v = inp.value; inp.value = '';
        if (TERM_ATTACHED) {
          BRIDGE.send({ kind: 'termInput', text: v + '\\n' });
          termWrite(v + '\\n'); renderTermOut();
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
        $('aboutBody').innerHTML = 'Nolanguage · PyCharm-style shell<br/>app ' + esc(m.appVersion) +
          '<br/>' + esc(m.os) + ' / ' + esc(m.arch) + '<br/><span class="dim">kernel commands: ' + KCOMMANDS.length + '</span>';
        break;
      case 'workspace':
        // The plugin catalogue: languages, extensions, grammar and capabilities.
        applyLanguageCatalog(m.languages || []);
        break;
      case 'metrics':
        lastMetrics = m; if (activeBottom === 'perf') renderPerf(m);
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
        renderProblems(m.items || []);
        break;
      case 'runResult':
        appendRun('\\nProcess finished with exit code ' + (m.exitCode == null ? '?' : m.exitCode) +
          '  (' + fmtMs(m.durationMs) + ')\\n', m.exitCode === 0 ? 'ok' : 'err');
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
      case 'termResult':
        TERM_ATTACHED = false;
        if (m.code !== 0 && m.code !== null) termWrite('[exit ' + m.code + ' · ' + fmtMs(m.ms) + ']\\n', 'dim');
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
      case 'profileResult':
        // Stash it so a freshly opened /profile page can render immediately
        // without the engine relaying state.
        try { localStorage.setItem('nl-profile', JSON.stringify(m)); } catch (e) { /* ignore */ }
        toast(m.ok ? ('profile ready · ' + (m.source || '') + ' · ' + (m.sampleCount || 0) + ' fns') : ('profile failed: ' + (m.error || 'unknown')));
        break;
      case 'scriptOut':
        appendPaletteOut(m.text, m.stream === 'stderr' ? 'err' : '');
        break;
      case 'scriptResult':
        PAL_BUSY = false;
        appendPaletteOut('\\n[exit ' + (m.code == null ? '?' : m.code) + (m.error ? ' · ' + m.error : '') + ']\\n', m.ok ? 'ok' : 'err');
        break;
    }
  }

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
      { label: 'Open...', sc: 'Ctrl+O', act: openNativeFile },
      { label: 'Open Folder...', act: openNativeFolder },
      { label: 'Save', sc: 'Ctrl+S', act: saveFile },
      { label: 'Save As...', sc: 'Ctrl+Shift+S', act: saveAsNative },
      { sep: true },
      { label: 'Open Recent', act: openRecent }
    ],
    'Edit': [
      { label: 'Undo', sc: 'Ctrl+Z', act: function () { document.execCommand('undo'); } },
      { label: 'Redo', sc: 'Ctrl+Shift+Z', act: function () { document.execCommand('redo'); } }
    ],
    'View': [
      { label: 'Appearance: Darcula', sc: '', act: function () { setTheme('darcula'); } },
      { label: 'Appearance: Light', sc: '', act: function () { setTheme('light'); } },
      { sep: true },
      { label: 'Tool Window Bars', act: function () { $('strip').style.display = ($('strip').style.display === 'none' ? '' : 'none'); } },
      { label: 'Status Bar', act: function () { var s = document.querySelector('.status'); s.style.display = (s.style.display === 'none' ? '' : 'none'); } }
    ],
    'Navigate': [
      { label: 'Search Everywhere', sc: '⇧⇧', act: openSearch },
      { label: 'File Structure', sc: 'Ctrl+F12', act: function () { toggleWindow('structure'); } }
    ],
    'Code': [
      { label: 'Reformat Code', sc: 'Ctrl+Alt+L', act: function () { toast('Reformatted (demo)'); } },
      { label: 'Optimize Imports', sc: 'Ctrl+Alt+O', act: function () { toast('Optimized imports (demo)'); } }
    ],
    'Run': [
      { label: "Run 'main'", sc: 'Shift+F10', act: runCode },
      { label: "Debug 'main'", sc: 'Shift+F9', act: function () { runCode(); toast('Debug (demo)'); } },
      { sep: true },
      { label: 'Stop', act: function () { appendRun('\\n[stopped]\\n', 'dim'); } }
    ],
    'Tools': [
      { label: 'Extensions', act: openExt },
      { label: 'Language Plugins', act: openPlugins },
      { sep: true },
      { label: 'Profile current file', sc: 'Alt+9', act: profileCurrent },
      { label: 'Command Palette…', sc: 'Ctrl+P', act: openPalette },
      { sep: true },
      { label: 'Performance', sc: 'Alt+8', act: function () { toggleWindow('perf'); } },
      { label: 'Logs', sc: 'Alt+0', act: function () { toggleWindow('logs'); } }
    ],
    'VCS': [ { label: 'Show Git Widget', act: function () { toast('Git: main (clean)'); } } ],
    'Window': [ { label: 'Minimize', act: function () { toast('minimize (demo)'); } } ],
    'Help': [ { label: 'About', act: openAbout } ]
  };
  function renderMenus() {
    var bar = $('menubar');
    Object.keys(MENUS).forEach(function (name) {
      var m = document.createElement('div');
      m.className = 'menu'; m.textContent = name;
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
  /** \lang\ empty means "go back to the file type". */
  function setDocLang(lang) {
    if (!currentFile) return;
    // Boot shows a document without having opened it, so make the buffer on
    // demand rather than letting the picker silently do nothing.
    if (!BUFFERS[currentFile]) BUFFERS[currentFile] = { content: ta.value, languageId: langOfDoc(currentFile), editable: !ta.readOnly, dirty: false };
    var chosen = lang || langOfName(currentFile) || 'python';
    setLangOverride(currentFile, lang);
    BUFFERS[currentFile].languageId = chosen;
    currentLang = chosen;
    closeModals();
    renderStLang();
    renderEditor(); updateCaret();
    // Re-check under the new language; a language with no server has no
    // problems to show, so clear the previous language's list.
    if (lspLang()) BRIDGE.send({ kind: 'check', code: ta.value, language: lspLang() });
    else renderProblems([]);
    toast('Language mode: ' + langLabel(chosen) + (lang ? ' (manual)' : ' (from file type)'));
  }

  // ---------- modals ----------
  function openModal(id) { $(id).classList.add('open'); $('scrim').classList.add('open'); }
  function closeModals() { document.querySelectorAll('.modal.open').forEach(function (m) { m.classList.remove('open'); }); $('scrim').classList.remove('open'); }
  $('scrim').addEventListener('click', closeModals);
  function openAbout() { openModal('aboutModal'); }
  function openExt() { openModal('extModal'); BRIDGE.send({ kind: 'listExtensions' }); }
  // Plugins live in their own page because managing them means typing a path,
  // reading a validation report and watching a budget — a modal is too small
  // for that, and the IDE already has a place for "the whole picture": a tab.
  function openPlugins() { window.open('/plugins', '_blank'); }
  function openProfile() { window.open('/profile', '_blank'); }
  /** Profile the current editor buffer and open the flamegraph page. */
  function profileCurrent() {
    if (!ta) return;
    var lg = currentLang;
    BRIDGE.send({ kind: 'profile', code: ta.value, language: lg, timeoutMs: 60000 });
    openProfile();
  }
  /** Open the command palette (the UI surface for nlg run <script> -- <args>). */
  function openPalette() {
    var p = $('palette');
    if (!p) return;
    p.classList.add('open');
    var inp = $('palInput');
    if (inp) { inp.value = 'nlg run '; inp.focus(); inp.select(); }
  }
  function closePalette() { var p = $('palette'); if (p) p.classList.remove('open'); }
  /** Parse nlg [run] <script> [--] <args…> and run it server-side. */
  function runPalette() {
    var inp = $('palInput');
    if (!inp) return;
    var raw = inp.value.trim();
    if (!raw) return;
    var toks = tokenize(raw);
    var i = 0;
    if (toks[i] === 'nlg') i++;
    if (toks[i] === 'run') i++;
    var script = toks[i++];
    if (!script) { appendPaletteOut('usage: nlg run <script> -- <args>\\n', 'err'); return; }
    var args = [];
    if (toks[i] === '--') i++;
    for (; i < toks.length; i++) args.push(toks[i]);
    PAL_BUSY = true;
    appendPaletteOut('$ ' + raw + '\\n', 'dim');
    BRIDGE.send({ kind: 'runScript', script: script, args: args });
    closePalette();
  }
  /** Whitespace tokenizer that keeps double-quoted segments intact. */
  function tokenize(s) {
    var out = [], cur = '', q = false, i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      if (c === '"') { q = !q; i++; continue; }
      if (q || !/\s/.test(c)) cur += c;
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

  // ---------- Settings (Ctrl+Alt+S) ----------
  // The one page-level settings surface: appearance + which chrome is visible.
  // Changes apply immediately on OK and persist through the normal prefs path.
  function openSettings() {
    var dark = document.documentElement.getAttribute('data-theme') !== 'light';
    var bars = $('strip').style.display !== 'none';
    var sb = (function () { var s = document.querySelector('.status'); return s && s.style.display !== 'none'; })();
    showModal({
      title: 'Settings', icon: 'settings',
      checkboxes: [
        { name: 'dark', label: 'Darcula theme (dark)', def: dark },
        { name: 'bars', label: 'Show tool window bars', def: bars },
        { name: 'status', label: 'Show status bar', def: sb }
      ],
      buttons: [
        { label: 'Cancel', onClick: function () {} },
        { label: 'OK', primary: true, onClick: function (v) {
          setTheme(v.dark ? 'darcula' : 'light');
          $('strip').style.display = v.bars ? '' : 'none';
          var st = document.querySelector('.status'); if (st) st.style.display = v.status ? '' : 'none';
          savePrefs({ theme: v.dark ? 'darcula' : 'light' });
        } }
      ]
    });
  }

  // ---------- Run / Debug configurations ----------
  // The toolbar's run-config button is a real selector, not a hardcoded label.
  // Configs persist; selecting one drives what Shift+F10 executes.
  var RUN_CONFIGS = (PREFS.runConfigs && PREFS.runConfigs.length) ? PREFS.runConfigs.slice() : [{ name: 'main', path: 'main.py' }];
  var ACTIVE_CFG = PREFS.activeConfig && RUN_CONFIGS.some(function (c) { return c.name === PREFS.activeConfig; })
    ? PREFS.activeConfig : RUN_CONFIGS[0].name;
  function renderCfgLabel() {
    var b = $('cfgBtn'); if (b) { var v = b.querySelector('.val'); if (v) v.textContent = ACTIVE_CFG; }
  }
  function openRunConfig() {
    var btn = $('cfgBtn'); var r = btn ? btn.getBoundingClientRect() : { left: 0, bottom: 0 };
    var items = RUN_CONFIGS.map(function (c) {
      return { label: (c.name === ACTIVE_CFG ? '✓  ' : '    ') + c.name, act: function () { ACTIVE_CFG = c.name; renderCfgLabel(); savePrefs({ activeConfig: ACTIVE_CFG }); } };
    });
    items.push({ sep: true });
    items.push({ label: 'Edit Configurations…', act: editRunConfigs });
    showCtx(r.left, r.bottom + 3, items);
  }
  function editRunConfigs() {
    var dirty = RUN_CONFIGS.map(function (c) { return { name: c.name, path: c.path }; });
    function draw() {
      showModal({
        title: 'Run/Debug Configurations', icon: 'run',
        message: 'Each configuration names a script entry point for the selected language.',
        buttons: [
          { label: 'Add', onClick: function () { dirty.push({ name: 'config' + (dirty.length + 1), path: 'main.py' }); draw(); } },
          { label: 'Cancel', onClick: function () {} },
          { label: 'OK', primary: true, onClick: function () {
            RUN_CONFIGS = dirty;
            if (!dirty.some(function (c) { return c.name === ACTIVE_CFG; })) ACTIVE_CFG = dirty.length ? dirty[0].name : 'main';
            savePrefs({ runConfigs: RUN_CONFIGS, activeConfig: ACTIVE_CFG }); renderCfgLabel();
          } }
        ]
      });
      var body = $('dlgRoot').querySelector('.dlg-body');
      if (!body) return;
      body.innerHTML = dirty.map(function (c, i) {
        return '<div style="display:flex;gap:6px;margin-bottom:6px">' +
          '<input data-cn="' + i + '" value="' + esc(c.name) + '" style="width:38%" placeholder="name" />' +
          '<input data-cp="' + i + '" value="' + esc(c.path) + '" style="flex:1" placeholder="script path" />' +
          '<button data-del="' + i + '" class="dlg-btn" style="padding:0 9px">✕</button></div>';
      }).join('');
      body.querySelectorAll('input[data-cn]').forEach(function (inp) {
        inp.addEventListener('input', function () { dirty[+inp.getAttribute('data-cn')].name = inp.value; });
      });
      body.querySelectorAll('input[data-cp]').forEach(function (inp) {
        inp.addEventListener('input', function () { dirty[+inp.getAttribute('data-cp')].path = inp.value; });
      });
      body.querySelectorAll('button[data-del]').forEach(function (b) {
        b.addEventListener('click', function () { dirty.splice(+b.getAttribute('data-del'), 1); draw(); });
      });
    }
    draw();
  }

  // ---------- native file pickers (Tauri only) ----------
  // These are the one allowed piece of OS-native UI: Open / Open Folder / Save As
  // are real system dialogs. In the web preview there is no OS picker, so we fall
  // back to a balloon and the Project tool window still opens files.
  function tauriDialog() {
    var T = window.__TAURI__;
    return (T && T.dialog) ? T.dialog : null;
  }
  function openNativeFile() {
    var d = tauriDialog();
    if (!d) { balloon({ type: 'info', title: 'Open', message: 'The native file picker is available in the desktop app. In the web preview, open files from the Project tool window.' }); return; }
    d.open({
      multiple: false, directory: false,
      filters: [{ name: 'Source', extensions: ['py', 'js', 'ts', 'go', 'md', 'json', 'yaml', 'html', 'css'] }],
      title: 'Open File'
    }).then(function (p) { if (p) BRIDGE.send({ kind: 'fsRead', path: p }); });
  }
  function openNativeFolder() {
    var d = tauriDialog();
    if (!d) { balloon({ type: 'info', title: 'Open Folder', message: 'The native folder picker is available in the desktop app.' }); return; }
    d.open({ directory: true, multiple: false, title: 'Open Folder' }).then(function (p) { if (p) BRIDGE.send({ kind: 'openFolder', path: p }); });
  }
  function saveAsNative() {
    var d = tauriDialog();
    if (!d) { balloon({ type: 'info', title: 'Save As', message: 'The native save dialog is available in the desktop app.' }); return; }
    d.save({ defaultPath: currentFile || 'untitled.py', filters: [{ name: 'Source', extensions: ['py', 'js', 'ts', 'go', 'md'] }], title: 'Save As' })
      .then(function (p) { if (p) BRIDGE.send({ kind: 'fsWrite', path: p, content: ta.value }); });
  }

  // ---------- language mode wiring ----------
  $('stLang').addEventListener('click', openLangPicker);
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
    { name: "Run 'main'", sc: 'Shift+F10', act: runCode },
    { name: 'Toggle Theme', act: function () { setTheme(document.documentElement.getAttribute('data-theme') === 'darcula' ? 'light' : 'darcula'); } },
    { name: 'Change Language Mode', act: openLangPicker },
    { name: 'Open Extensions', act: openExt }
  ];
  function openSearch() { openModal('searchModal'); renderSearch(''); setTimeout(function () { $('searchInput').focus(); }, 0); }
  function searchResults(q) {
    q = q.toLowerCase();
    var files = Object.keys(FILES).filter(function (f) { return f.toLowerCase().indexOf(q) >= 0; }).map(function (f) { return { group: 'Files', name: f, path: 'src', icon: 'file', act: function () { openFile(f); } }; });
    var syms = SYMBOLS.filter(function (s) { return s.name.toLowerCase().indexOf(q) >= 0; }).map(function (s) { return { group: 'Symbols', name: s.name, path: s.path, icon: 'structure', act: function () { openFile(s.path.split(':')[0]); } }; });
    var acts = KCOMMANDS.filter(function (c) { return c.id.toLowerCase().indexOf(q) >= 0; }).slice(0, 6).map(function (c) { return { group: 'Actions', name: c.title || c.id, path: c.id, icon: 'settings', act: function () { toast('command: ' + c.id); } }; });
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
  $('runBtn').addEventListener('click', runCode);
  $('debugBtn').addEventListener('click', function () { runCode(); toast('Debug (demo)'); });
  $('covBtn').addEventListener('click', function () { toast('Coverage (demo)'); });
  $('stopBtn').addEventListener('click', function () { appendRun('\\n[stopped]\\n', 'dim'); toast('Stopped'); });
  $('cfgBtn').addEventListener('click', function (e) { e.stopPropagation(); openRunConfig(); });
  $('projWidget').addEventListener('click', function () { toggleWindow('project'); });
  $('newBtn').addEventListener('click', function () { var r = $('newBtn').getBoundingClientRect(); showNewPopup(r.left, r.bottom + 3, ''); });
  $('vcsWidget').addEventListener('click', function () { toast('Git: main · up to date'); });
  $('themeBtn').addEventListener('click', function () { setTheme(document.documentElement.getAttribute('data-theme') === 'darcula' ? 'light' : 'darcula'); });
  $('settingsBtn').addEventListener('click', openSettings);
  $('panelCloseBtn').addEventListener('click', function () { $('leftPanel').classList.add('hidden'); renderStrip(); saveLayout(); });
  $('collapseBtn').addEventListener('click', function () { if (activeLeft === 'structure') { folded = {}; renderEditor(); } toast('Collapsed'); });
  $('pinBtn').addEventListener('click', function () { pinned = !pinned; this.style.color = pinned ? '' : 'var(--text-tertiary)'; toast(pinned ? 'Pinned' : 'Unpinned'); });
  $('dockHide').addEventListener('click', function () { $('dock').classList.add('hidden'); saveLayout(); });

  // ---------- Tauri window controls (the desktop app turns OS chrome off) ----------
  if (window.__TAURI__ && window.__TAURI__.window) {
    document.documentElement.setAttribute('data-tauri', '1');
    var win = window.__TAURI__.window.getCurrentWindow();
    var tbMin = $('tbMin'), tbMax = $('tbMax'), tbClose = $('tbClose');
    if (tbMin) tbMin.addEventListener('click', function () { win.minimize(); });
    if (tbMax) tbMax.addEventListener('click', function () { win.toggleMaximize(); });
    if (tbClose) tbClose.addEventListener('click', function () { win.close(); });
  }

  // ---------- keyboard shortcuts ----------
  document.addEventListener('keydown', function (e) {
    // Order matters: the Alt/Ctrl combos must be tested before the bare Ctrl+S,
    // otherwise Ctrl+Alt+S is swallowed by the save shortcut.
    if (e.ctrlKey && e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); openSettings(); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); openFindInFiles(); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveAsNative(); return; }
    if (e.ctrlKey && (e.key === 's' || e.key === 'S') && !e.shiftKey && !e.altKey) { e.preventDefault(); saveFile(); return; }
    if (e.ctrlKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); openNativeFile(); return; }
    if (e.ctrlKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); openPalette(); return; }
    if (e.key === 'Escape') { hideCtx(); return; }
    if (e.key === 'Shift' && !e.repeat) {
      var now = Date.now();
      if (now - lastShift < 400) { openSearch(); lastShift = 0; } else lastShift = now;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    var map = { '1': 'project', '9': 'vcs', 'k': 'commit', '7': 'structure', 'a': 'ai', '4': 'run', '8': 'perf', '0': 'logs' };
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
})();
`;
}
