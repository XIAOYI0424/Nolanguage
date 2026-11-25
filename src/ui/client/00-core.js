
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
    // Browser reload/print, and nothing else. Ctrl+Alt+R is the run-configuration
    // shortcut: swallowing every Ctrl+R made that key unreachable, because this
    // runs in the capture phase and stops propagation before the editor sees it.
    if (k === 'f5' || (e.ctrlKey && !e.altKey && (k === 'r' || k === 'p'))) {
      e.preventDefault();
      // F5 and Ctrl+Shift+R still have to reach the app's own handlers; only
      // plain Ctrl+R / Ctrl+P are fully consumed as browser accelerators.
      if (k !== 'f5' && !(e.shiftKey && k === 'r')) e.stopPropagation();
    }
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
  // File-type badge: a 16px square with the extension, never an icon-font glyph.
  // The language stays generic here — the extension is the only thing a file
  // name tells us, and the real language comes from the manifest/plugin.
  function badgeHtml(name) {
    var dot = String(name || '').lastIndexOf('.');
    var ext = dot < 0 ? '' : String(name).slice(dot + 1).toLowerCase();
    var map = { py:['py','py'], pyi:['py','py'], java:['ja','java'], md:['md','md'],
      yaml:['ym','yaml'], yml:['ym','yaml'], xml:['xm','xml'], json:['js','json'],
      js:['js','js'], ts:['ts','ts'], go:['go','go'], rs:['rs','rs'], c:['c','c'],
      cpp:['cpp','cpp'], h:['h','h'], txt:['tx','generic'], toml:['to','generic'] };
    var pair = map[ext] || [ext.slice(0, 2) || 'fi', 'generic'];
    return '<span class="file-badge file-badge--' + pair[1] + '" title="' + esc(ext || 'file') + '">' + esc(pair[0]) + '</span>';
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
          { label: 'Copy', onClick: function () { copyText((o.message || '') + (o.detail ? '\n' + o.detail : '')); } },
          o.canRetry ? { label: 'Retry', primary: true, onClick: o.onRetry } : null,
          { label: 'OK', primary: !o.canRetry, onClick: function () {} },
        ].filter(Boolean),
      });
    } else {
      balloon({
        type: level === 'info' ? 'info' : 'warning',
        title: o.title || 'Warning',
        message: o.message + (o.detail ? '\n' + o.detail : ''),
      });
    }
  }

