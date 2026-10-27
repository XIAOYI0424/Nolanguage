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
  i18nJson: string;
}

export function pyCharmClientScript(d: PanelClientData): string {
  const { iconsJson, patternJson, mainJson, utilsJson, jsJson, readmeJson, i18nJson } = d;
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
  // Translation bundles gathered from localization plugins, keyed by locale
  // (e.g. { "zh-CN": { "menu.File": "文件", ... } }). Null/empty when no such
  // plugin is installed — every UI string then falls back to its English source.
  var I18N = ${i18nJson};
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

  // ---------- i18n (built-in localization plugins) ----------
  // A localization plugin contributes a { locale, messages } bundle (see
  // collectI18nBundles on the server). t() resolves the active locale's map
  // and falls back to the English string baked into the page when a key is
  // missing or no plugin is installed — so the UI is always coherent.
  function activeLocale() {
    try { return (PREFS && PREFS.locale) || 'en'; } catch (e) { return 'en'; }
  }
  function t(key, fallback) {
    var m = (typeof I18N === 'object' && I18N) ? I18N[activeLocale()] : null;
    return (m && m[key] != null) ? m[key] : fallback;
  }
  // Translate every [data-i18n] element. With data-i18n-title the tooltip is
  // targeted instead (for elements that mix an icon and visible text); otherwise
  // the element's own text is the target. Calling it again is idempotent.
  function applyI18n(root) {
    (root || document).querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (!key) return;
      if (el.hasAttribute('data-i18n-title')) {
        el.setAttribute('title', t(key, el.getAttribute('title') || ''));
      } else {
        el.textContent = t(key, el.textContent);
      }
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
    DIALOG_KIND = null; // a new dialog owns the body; stale paint targets are void
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
    // Single-choice rows. Used by the interpreter picker: a select would hide
    // the versions, and the version is the whole reason to look.
    if (o.radios && o.radios.length) {
      html += '<div class="dlg-radios">' + o.radios.map(function (r) {
        return '<label class="dlg-check"><input type="radio" name="r-' + esc(r.name) + '" data-r="' + esc(r.name) +
          '" value="' + esc(r.value == null ? '' : r.value) + '"' + (r.def ? ' checked' : '') + ' />' +
          esc(r.label) + '</label>';
      }).join('') + '</div>';
    }
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
      card.querySelectorAll('input[data-r]:checked').forEach(function (r) { v[r.getAttribute('data-r')] = r.value; });
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
        //
        // target is REQUIRED by the command even for an app-wide listener:
        // omitting it fails with "missing required key target", the listen never
        // registers, and the page silently receives no engine events at all — the
        // whole inbound half of the bridge is dead while engine_send still works.
        // Any matches app.emit(...), which is how the Rust relay sends.
        T.invoke('plugin:event|listen', {
          event: name,
          target: { kind: 'Any' },
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

  // A launch that replaced an older build arrives as ?updated=<old version>.
  // Without this the upgrade is invisible: the window looks exactly like the
  // one it just replaced, so "I installed it and nothing changed" is the only
  // possible reading. Announce once, then strip the param so a reload is quiet.
  (function announceUpdate() {
    var m = /[?&]updated=([^&]*)/.exec(location.search || '');
    if (!m) return;
    var from = '';
    try { from = decodeURIComponent(m[1]); } catch (e) { from = ''; }
    setTimeout(function () {
      toast(from && from !== 'unknown' ? 'Updated from ' + from + ' - new build loaded' : 'Updated to a new build');
    }, 700);
    try { history.replaceState({}, '', location.pathname); } catch (e) { /* file: URLs */ }
  })();

  // True inside the Tauri shell. It matters because the shell has **no HTTP
  // server**: its engine runs over a pipe (--panel-stdio), so URLs like
  // /plugins and /profile do not exist there — those views are rendered
  // in-app from bridge messages instead of window.open.
  function isTauriShell() {
    var T = window.__TAURI_INTERNALS__;
    return !!(T && typeof T.invoke === 'function');
  }
  /** Latest "plugins" frame (sent on connect and after every plugin operation). */
  var PLUGINS = null;
  /** Which in-app dialog is on screen, so async replies know where to paint. */
  var DIALOG_KIND = null;

  // ---------- editor ----------
  var ta = $('ta'), hlCode = $('hlCode'), hl = $('hl'), glines = $('glines');
  var currentFile = 'main.py';
  var currentLang = 'python';
  var BREAKPOINTS = {}; // file (rel path) -> { line(1-based): true }
  function bpsFor(file) { return BREAKPOINTS[file] || (BREAKPOINTS[file] = {}); }
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
  function lineIndent(line) { var m = /^[ \\t]*/.exec(line); return m ? m[0].length : 0; }
  function isDefLine(line) { return /^[ \\t]*(def|class)\\b/.test(line); }

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
        renderEditor();
      });
    }
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
      // A file switch lands here right after the adapter's value setter ran
      // cm.setValue(), which drops every gutter marker. Repaint this file's
      // breakpoints once — not on every keystroke, since markers follow lines.
      if (CM_BP_FILE !== currentFile) { CM_BP_FILE = currentFile; paintCmBreakpoints(); }
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
      HOV.cx = e.clientX; HOV.cy = e.clientY;
      // A diagnostic on the line under the pointer wins over an LSP hover: it is
      // already local, so it answers "why is this red?" instantly, with no
      // round-trip. Only fall back to hover when the line is clean.
      var ds = diagsOnLine(p.line);
      if (ds.length) {
        var tip = $('hoverTip');
        if (tip) {
          tip.textContent = ds.map(function (d) {
            return (d.severity === 1 ? 'Error' : d.severity === 2 ? 'Warning' : 'Info') + ': ' + d.message;
          }).join(NLc + NLc);
          showTipAt(HOV.cx, HOV.cy, tip);
        }
        return;
      }
      var t0 = $('hoverTip'); if (t0) t0.classList.remove('open');
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
  /** Position an open hover tip near the pointer, clamped inside its host. */
  function showTipAt(cx, cy, tip) {
    var host = tip.parentNode ? tip.parentNode : document.body;
    var hr = host.getBoundingClientRect();
    tip.style.left = Math.max(0, Math.min(cx - hr.left + 12, host.clientWidth - 340)) + 'px';
    tip.style.top = (cy - hr.top + 16) + 'px';
    tip.classList.add('open');
  }
  function onHover(m) {
    if (m.requestId !== HOV.reqId) return;
    var tip = $('hoverTip'), text = hoverText(m.hover);
    if (!text) { tip.classList.remove('open'); return; }
    tip.textContent = text;
    showTipAt(HOV.cx, HOV.cy, tip);
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
    if (currentFile !== name) clearCoverage();
    currentFile = name; currentLang = buf.languageId || 'python';
    ta.value = buf.content;
    ta.readOnly = !buf.editable;
    $('stFile').textContent = name;
    renderStLang();
    renderTabs(); renderEditor(); updateCaret();
    // Stale marks from the previous document must not follow the caret here.
    clearDiags();
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
    // L3: a save is a natural checkpoint — check the file we just wrote and, if
    // it still has errors, say so once instead of letting Run be the first to
    // find out. (setDiags turns pendingSaveCheck into the balloon.)
    if (lspLang()) { pendingSaveCheck = true; requestCheck(); }
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
    { id: 'ai', title: 'AI Assistant', icon: 'ai', key: 'Alt+A' },
    { id: 'mcp', title: 'MCP', icon: 'mcp', key: 'Alt+M' }
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
  var STRIP = ['project', 'vcs', 'commit', 'terminal', 'run', 'structure', 'perf', 'logs', 'ai', 'mcp'];

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
      // Opening the panel asks for a fresh catalogue (the engine may have
      // restarted, or the config file changed on disk).
      if (id === 'mcp' && !panel.classList.contains('hidden')) BRIDGE.send({ kind: 'mcpList' });
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
    else if (activeLeft === 'vcs') body.innerHTML = vcsPane();
    else if (activeLeft === 'commit') body.innerHTML = commitPane();
    else if (activeLeft === 'ai') body.innerHTML = aiPane();
    else if (activeLeft === 'mcp') { body.innerHTML = mcpPane(); wireMcp(body); }
    else body.innerHTML = '';
    if (activeLeft === 'commit') wireCommit(body);
    if (activeLeft === 'vcs') wireVcs(body);
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
  // The Commit panel is a projection of "git status --porcelain"; pressing
  // Commit asks the engine to stage tracked changes and commit them. Nothing
  // here invents a clean tree.
  var GIT = { status: null, error: '', loading: false };
  function gitChangeRow(c) {
    var s = c.status || '  ';
    var kind = s.indexOf('??') >= 0 ? 'new' : s.indexOf('D') >= 0 ? 'del' : 'mod';
    return '<div class="git-row"><span class="git-st ' + kind + '">' + esc(s.replace(/ /g, '·')) + '</span>' +
      '<span class="git-path" title="' + esc(c.path) + '">' + esc(c.path) + '</span></div>';
  }
  function gitListHtml() {
    if (GIT.error) return '<div class="git-err">' + esc(GIT.error) + '</div>';
    if (!GIT.status) return '<div class="empty">Reading git status…</div>';
    if (!GIT.status.changes.length) {
      return '<div class="empty">Working tree clean on <b>' + esc(GIT.status.branch || 'HEAD') + '</b>.</div>';
    }
    return GIT.status.changes.map(gitChangeRow).join('');
  }
  function commitPane() {
    return '<div class="commit-pane">' +
      '<textarea id="commitMsg" placeholder="Commit message" spellcheck="false"></textarea>' +
      '<div class="commit-actions"><button class="tbtn primary" id="commitBtn">Commit</button>' +
      '<button class="tbtn" id="gitRefresh" title="Refresh git status">Refresh</button></div>' +
      '<div class="commit-branch">' +
      (GIT.status ? 'Changes on <b>' + esc(GIT.status.branch || 'HEAD') + '</b>' : 'Git status') +
      '</div><div class="git-list">' + gitListHtml() + '</div></div>';
  }
  function wireCommit(body) {
    var b = body.querySelector('#commitBtn');
    if (b) b.addEventListener('click', function () {
      var msgEl = body.querySelector('#commitMsg');
      var text = msgEl ? msgEl.value.trim() : '';
      if (!text) { toast('A commit message is required'); if (msgEl) msgEl.focus(); return; }
      b.disabled = true;
      BRIDGE.send({ kind: 'gitCommit', message: text });
    });
    var r = body.querySelector('#gitRefresh');
    if (r) r.addEventListener('click', function () { GIT.status = null; GIT.loading = true; BRIDGE.send({ kind: 'gitStatus' }); });
    if (!GIT.status && !GIT.loading) { GIT.loading = true; BRIDGE.send({ kind: 'gitStatus' }); }
  }
  function vcsPane() {
    return '<div class="commit-pane">' +
      '<div class="commit-branch">' +
      (GIT.status ? 'On <b>' + esc(GIT.status.branch || 'HEAD') + '</b>' : 'Git status') +
      ' · <a id="vcsCommit" style="color:var(--accent);cursor:pointer">Commit…</a></div>' +
      '<div class="git-list">' + gitListHtml() + '</div></div>';
  }
  function wireVcs(body) {
    var c = body.querySelector('#vcsCommit');
    if (c) c.addEventListener('click', function () { toggleWindow('commit'); });
    if (!GIT.status && !GIT.loading) { GIT.loading = true; BRIDGE.send({ kind: 'gitStatus' }); }
  }
  function aiPane() {
    return '<div style="padding:12px;display:flex;flex-direction:column;gap:10px">' +
      '<div style="color:var(--text-secondary);font-size:12px">Ask about the current file.</div>' +
      '<div style="display:flex;gap:6px"><input id="aiInput" placeholder="Explain this function…" style="flex:1;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text-primary)"/>' +
      '<button class="tbtn" id="aiAsk">Ask</button></div>' +
      '<div id="aiOut" class="console dim">—</div></div>';
  }

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
      pane('run', '<div class="dbg-bar" id="dbgBar"><span class="dbg-state" id="dbgState">debug</span>' +
        '<button class="tbtn" data-dbg="continue">Continue</button>' +
        '<button class="tbtn" data-dbg="next">Step Over</button>' +
        '<button class="tbtn" data-dbg="stepIn">Step In</button>' +
        '<button class="tbtn" data-dbg="stepOut">Step Out</button>' +
        '<button class="tbtn" data-dbg="stop">Stop</button></div>' +
        '<div class="console" id="runOut"><span class="dim">Click Run (Shift+F10) to execute main.py in the sandbox.</span></div>' +
        '<div class="term-line" id="runLine"><span class="prompt" id="runPrompt">input&gt;</span>' +
        '<input class="term-in" id="runIn" disabled spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="program asks for input? type here, then Enter" /></div>') +
      pane('terminal', termPane()) +
      pane('perf', perfPane()) +
      pane('logs', logsPane()) +
      pane('find', findPane()) +
      pane('problems', '<div id="probOut"><div class="empty">No problems.</div></div>');
    wirePerf(); wireLogs(); wireTerm(); wireFind(); wireDbg();
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
  function wirePerf() { if (activeBottom !== 'perf') return; }

  // ---------- kernel flame graph window ----------
  // A separate, draggable window rather than a dock pane: the point is to watch
  // the kernel while a program runs, so the editor and the run output must stay
  // usable behind it. Data arrives as "flame" frames pushed by the engine
  // (V8 CPU samples of the kernel process, aggregated into a call tree).
  var FLAME = { open: false, paused: false, last: null, drag: null, mem: [] };
  function shortFlameUrl(u) {
    if (!u) return '';
    var s = String(u).replace(/^file:\\/\\/\\/?/, '');
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
    out.innerHTML = '<span class="cmd">&gt; ' + lg + ' ' + esc(currentFile) + '</span>\\n';
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
  var DBG = { active: false, state: '', frames: [], reason: '' };
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
      // While the program runs only Continue/Stop make sense; the step buttons
      // need a stopped thread to act on.
      b.disabled = !DBG.active || (cmd !== 'continue' && cmd !== 'stop' && DBG.state !== 'stopped');
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
    appendRun('\\n[debug] starting ' + cfg.name + ' → ' + cfg.path + ' (' + cfg.language + ' adapter)…\\n', 'dim');
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
      request: cfg.request
    });
  }
  function applyDebugState(m) {
    if (m.ok === false) {
      DBG.active = false; DBG.state = '';
      appendRun('\\n[debug] ' + String(m.error || 'session failed') +
        (m.hint ? '\\n[debug] ' + m.hint : '') + '\\n', 'err');
      renderDbgBar();
      if (m.install) appendRun('\\n[debug] install:  ' + m.install + '\\n', 'warn');
      var dbgDetail = (m.install ? (m.install + '\\n') : '') + (m.hint || '');
      reportError({ level: 'warn', title: 'Debug unavailable', message: String(m.error || 'session failed'), detail: dbgDetail || undefined });
      return;
    }
    var state = String(m.state || '');
    if (state === 'running') {
      DBG.active = true; DBG.state = 'running';
      appendRun('[debug] running' + (m.adapter ? ' · ' + m.adapter : '') + '\\n', 'dim');
      RUN_ACTIVE = true;
    } else if (state === 'stopped') {
      DBG.active = true; DBG.state = 'stopped';
      DBG.frames = m.frames || [];
      DBG.reason = String(m.reason || '');
      appendRun('\\n[debug] stopped · ' + (DBG.reason || 'breakpoint') + '\\n', 'warn');
      DBG.frames.slice(0, 8).forEach(function (f) {
        appendRun('    at ' + f.name + (f.file ? '  (' + f.file + (f.line ? ':' + f.line : '') + ')' : '') + '\\n', 'dim');
      });
    } else if (state === 'terminated') {
      DBG.active = false; DBG.state = '';
      RUN_ACTIVE = false;
      appendRun('[debug] session terminated\\n', 'dim');
    }
    renderDbgBar();
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
    appendRun('\\n[coverage] running the file under the Python tracer…\\n', 'dim');
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
      appendRun('[coverage] ' + String((r && r.error) || 'failed') + '\\n', 'err');
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
      (miss ? '\\n[coverage] missing: ' + miss : '') + '\\n', pct >= 80 ? 'ok' : 'warn');
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
    var eol = text.indexOf('\\r\\n') >= 0 ? '\\r\\n' : '\\n';
    var lines = text.replace(/^\\uFEFF/, '').split(/\\r?\\n/);
    var out = [], blank = 0;
    lines.forEach(function (line) {
      var s = line.replace(/[ \\t]+$/, '').replace(/^\\t+/, function (m) { return '    '.repeat(m.length); });
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
    var x = a.split(/\\r?\\n/), y = b.split(/\\r?\\n/), n = 0;
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
    var eol = text.indexOf('\\r\\n') >= 0 ? '\\r\\n' : '\\n';
    var lines = text.split(/\\r?\\n/);
    if (lang !== 'python' && lang !== 'javascript' && lang !== 'typescript') return null;
    var re = lang === 'python'
      ? /^\\s*(import\\s+\\S|from\\s+\\S+\\s+import\\s+)/
      : /^\\s*import\\s.+from\\s+['"]/;
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
        var m = /^\\s*from\\s+(\\S+)/.exec(s);
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
        paintProfileDialog(m);
        break;
      case 'mcp':
        // The catalogue arrives on connect and after every connect/disconnect, so
        // an open sidebar stays current without polling.
        MCP = m;
        if (activeLeft === 'mcp') renderPanel();
        break;
      case 'mcpCallResult':
        MCP_OUT = (m.ok ? 'OK ' : 'ERROR ') + (m.id || '') + ' / ' + (m.tool || '') + '\\n' +
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
          appendRun('\\n[stopped by user]\\n', 'warn');
          break;
        }
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
      case 'stopped':
        RUN_ACTIVE = false;
        DBG.active = false; DBG.state = '';
        appendRun('\\n[stopped]\\n', 'dim');
        renderDbgBar();
        toast(m.cancelled ? 'Run stopped' : (m.debugStopped ? 'Debug session stopped' : 'Nothing was running'));
        break;
      case 'debugState':
        applyDebugState(m);
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
      { label: 'Import PyCharm Run Configurations...', act: importIdeaConfigs },
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
      { label: 'Reformat Code', sc: 'Ctrl+Alt+L', act: reformatCode },
      { label: 'Optimize Imports', sc: 'Ctrl+Alt+O', act: optimizeImports },
      { sep: true },
      { label: 'Duplicate Line', sc: 'Ctrl+D', act: duplicateLine },
      { label: 'Delete Line', sc: 'Ctrl+Y', act: deleteLine },
      { label: 'Comment Line', sc: 'Ctrl+/', act: toggleComment },
      { label: 'Find...', sc: 'Ctrl+F', act: function () { openFindBar(false); } },
      { label: 'Replace...', sc: 'Ctrl+H', act: function () { openFindBar(true); } },
      { label: 'Go to Line...', sc: 'Ctrl+G', act: openGotoLine }
    ],
    'Run': [
      { label: "Run 'main'", sc: 'Shift+F10', act: runCode },
      { label: "Debug 'main'", sc: 'Shift+F9', act: debugCurrent },
      { label: 'Run with Coverage', act: runCoverage },
      { sep: true },
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
      { label: 'Kernel Flame Graph', sc: 'Ctrl+Alt+F', act: openFlame },
      { label: 'Performance', sc: 'Alt+8', act: function () { toggleWindow('perf'); } },
      { label: 'Logs', sc: 'Alt+0', act: function () { toggleWindow('logs'); } }
    ],
    'VCS': [ { label: 'Show Git Widget', act: function () { toggleWindow('vcs'); } } ],
    'Window': [ { label: 'Minimize', act: function () { minimizeWindow(); } } ],
    'Help': [ { label: 'About', act: openAbout } ]
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
    else clearDiags();
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
    var chinese = activeLocale() === 'zh-CN';
    showModal({
      title: t('modal.Settings', 'Settings'), icon: 'settings',
      checkboxes: [
        { name: 'dark', label: 'Darcula theme (dark)', def: dark },
        { name: 'bars', label: 'Show tool window bars', def: bars },
        { name: 'status', label: 'Show status bar', def: sb },
        { name: 'zh', label: '界面语言：简体中文 (Chinese UI)', def: chinese }
      ],
      buttons: [
        { label: t('modal.Cancel', 'Cancel'), onClick: function () {} },
        { label: t('modal.OK', 'OK'), primary: true, onClick: function (v) {
          setTheme(v.dark ? 'darcula' : 'light');
          $('strip').style.display = v.bars ? '' : 'none';
          var st = document.querySelector('.status'); if (st) st.style.display = v.status ? '' : 'none';
          savePrefs({ theme: v.dark ? 'darcula' : 'light' });
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
  function normCfg(c) {
    c = c || {};
    return {
      name: c.name || 'main',
      path: c.path || 'main.py',
      language: c.language || langOfName(c.path || 'main.py') || '',
      cwd: c.cwd || '',
      args: Array.isArray(c.args) ? c.args : (typeof c.args === 'string' && c.args ? c.args.split(/\s+/).filter(Boolean) : []),
      env: (c.env && typeof c.env === 'object') ? c.env : {},
      stopOnEntry: c.stopOnEntry !== false,
      request: c.request || 'launch'
    };
  }
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
    var dirty = RUN_CONFIGS.map(function (c) {
      return {
        name: c.name, path: c.path,
        language: c.language || '', cwd: c.cwd || '',
        args: Array.isArray(c.args) ? c.args.join(' ') : (c.args || ''),
        env: c.env && typeof c.env === 'object' ? Object.keys(c.env).map(function (k) { return k + '=' + c.env[k]; }).join(' ') : (c.env || ''),
        stopOnEntry: c.stopOnEntry !== false,
        request: c.request || 'launch'
      };
    });
    function draw() {
      showModal({
        title: 'Run/Debug Configurations', icon: 'run',
        message: 'Mirrors VS Code launch.json: the active configuration drives Run and Debug, not the open tab.',
        buttons: [
          { label: 'Add', onClick: function () { dirty.push({ name: 'config' + (dirty.length + 1), path: 'main.py', language: '', cwd: '', args: '', env: '', stopOnEntry: true, request: 'launch' }); draw(); } },
          { label: 'Cancel', onClick: function () {} },
          { label: 'OK', primary: true, onClick: function () {
            RUN_CONFIGS = dirty.map(function (c) {
              var o = { name: c.name || 'main', path: c.path || 'main.py' };
              if (c.language) o.language = c.language;
              if (c.cwd) o.cwd = c.cwd;
              if (c.args) o.args = String(c.args).split(/\s+/).filter(Boolean);
              if (c.env) {
                var envObj = {};
                String(c.env).split(/\s+/).filter(Boolean).forEach(function (kv) {
                  var idx = kv.indexOf('='); if (idx > 0) envObj[kv.slice(0, idx)] = kv.slice(idx + 1);
                });
                if (Object.keys(envObj).length) o.env = envObj;
              }
              if (c.stopOnEntry === false) o.stopOnEntry = false;
              if (c.request && c.request !== 'launch') o.request = c.request;
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
          '<label></label><button data-del="' + i + '" class="dlg-btn" style="padding:0 9px">✕ remove</button>' +
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
      body.querySelectorAll('button[data-del]').forEach(function (b) { b.addEventListener('click', function () { dirty.splice(+b.getAttribute('data-del'), 1); draw(); }); });
    }
    draw();
  }

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
    { name: "Run 'main'", sc: 'Shift+F10', act: runCode },
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
  $('runBtn').addEventListener('click', runCode);
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
  function escapeRe(s) { return String(s).replace(/[.*+?^$()|[\]{}\\-]/g, '\\$&'); }
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
    if (sel && sel.indexOf('\\n') === -1 && sel.length < 120) FIND.input.value = sel;
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
    var start = v.lastIndexOf('\\n', s - 1) + 1;
    var end = v.indexOf('\\n', e);
    if (end === -1) end = v.length;
    return { start: start, end: end };
  }
  function duplicateLine() {
    if (!CAN_EDIT()) { toast('Read-only buffer'); return; }
    var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    var b = lineBounds();
    var block = v.slice(b.start, b.end);
    ta.value = v.slice(0, b.end) + '\\n' + block + v.slice(b.end);
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
    var lines = block.split('\\n');
    var allCommented = lines.every(function (l) {
      return !l.trim() || l.replace(/^\\s+/, '').indexOf(prefix) === 0;
    });
    var out = lines.map(function (l) {
      if (!l.trim()) return l;
      if (allCommented) return l.replace(new RegExp('^(\\\\s*)' + escapeRe(prefix) + ' ?'), '$1');
      return l.replace(/^(\\s*)/, '$1' + prefix + ' ');
    }).join('\\n');
    ta.value = v.slice(0, b.start) + out + v.slice(b.end);
    ta.selectionStart = b.start;
    ta.selectionEnd = b.start + out.length;
    renderEditor(); updateCaret();
  }
  function openGotoLine() {
    showModal({
      title: 'Go to Line', icon: 'file',
      fields: [{ name: 'line', label: 'Line', value: '1', validator: function (v) { return /^\\d+$/.test(v) ? null : 'Enter a line number'; } }],
      buttons: [
        { label: 'Cancel' },
        { label: 'Go', primary: true, onClick: function (v) { gotoLine(Math.max(0, Number(v.line) - 1), 0); } }
      ]
    });
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
      RUN_CONFIGS.push({ name: c.name, path: c.script, params: c.parameters || '', workdir: c.workdir || '', env: c.env || {} });
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
    if (e.shiftKey && e.key === 'F10') { e.preventDefault(); runCode(); return; }
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
`;
}
