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
   * romServer is the backend's own extension mapping, which knows more
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
