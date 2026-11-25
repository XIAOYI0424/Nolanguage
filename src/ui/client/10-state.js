  // ---------- preferences (localStorage) ----------
  // One key holds theme, open tabs, layout and recent files, so a single parse
  // restores the whole session. Storage may be unavailable (private mode / no
  // origin), so every access is guarded and persistence simply no-ops then.
  var LSKEY = 'nolanguage.pycharm.v1';
  function loadPrefs() { try { return JSON.parse(localStorage.getItem(LSKEY) || '{}') || {}; } catch (e) { return {}; } }
  var PREFS = loadPrefs();
  var RECENT = (PREFS.recent && PREFS.recent.length) ? PREFS.recent.slice(0, 10) : [];
  function savePrefs(patch) {
    try {
      var cur = loadPrefs();
      Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
      localStorage.setItem(LSKEY, JSON.stringify(cur));
    } catch (e) { /* storage unavailable */ }
  }
  /** Persist and update the live copy: settings changed in a dialog must take effect now. */
  function updatePrefs(patch) {
    Object.keys(patch).forEach(function (k) { PREFS[k] = patch[k]; });
    savePrefs(patch);
  }
  // The last folder the user opened is session state, like tabs: it belongs in
  // the browser's own store, not in a project file or a server-side setting.
  // openProject is the single sender so every path into openFolder (native
  // picker, wizard, startup restore) carries the same reqId and persistence.
  var PROJECT_SEQ = 900000; // a separate range from fsWrite/draft reqIds
  var PROJECT_PENDING = Object.create(null); // reqId -> { path, restore }
  var PROJECT_LAST_ROOT = '';
  // The engine announces its default root on every connection. While a saved
  // project is being restored, that frame must not boot the default folder or
  // trigger discovery for it: the reply for the saved root follows immediately.
  var PROJECT_AWAIT_RESTORE = !!(PREFS.lastProjectRoot && PREFS.restoreProject !== false);
  function openProject(path, restore) {
    if (!path) return;
    var reqId = ++PROJECT_SEQ;
    PROJECT_PENDING[reqId] = { path: String(path), restore: !!restore };
    BRIDGE.send({ kind: 'openFolder', path: String(path), reqId: reqId });
  }
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
  BRIDGE.onOpen(function () {
    BRIDGE.send({ kind: 'listExtensions' });
    // Ask for anything a previous session left behind before the first paint, so
    // the recovery offer and the restored tabs appear together.
    BRIDGE.send({ kind: 'draftList' });
    // Reopen the last folder when the user allowed it. The engine answers with
    // fsRoot; onFsRoot persists the successful path and boots that project.
    // A stale path is refused by FsService.setRoot, and onFsError falls back
    // to the engine's default root instead of leaving an empty shell.
    var last = PREFS.lastProjectRoot;
    PROJECT_AWAIT_RESTORE = !!(last && PREFS.restoreProject !== false);
    if (PROJECT_AWAIT_RESTORE) openProject(last, true);
    else bootProject();
  });
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
  /**
   * Latest "catalog" frame: what the plugin index offers, as of the last search.
   * A null value means "not asked yet", which the dialog renders differently from
   * an index that answered with nothing.
   */
  var CATALOG = null;
  /** Which in-app dialog is on screen, so async replies know where to paint. */
  var DIALOG_KIND = null;

  // ---------- crash recovery (drafts) ----------
  // A dirty buffer is copied *out* of the workspace after a short pause, so a
  // crash, a killed window or a power cut cannot take unsaved text with it. It is
  // not a save: the file is never touched, and deleting the copy is the job of a
  // disk ACK (or an explicit "Don't Save") — never of a successful restore, or a
  // second crash would lose the text that was just recovered.
  //
  // Debounced: writing on every keystroke would flush a megabyte per word. Two
  // seconds is long enough to coalesce typing and short enough that the window
  // between "last edit" and "recoverable" stays small. The Settings page can
  // widen or shorten that window; the default is unchanged.
  function draftDelay() {
    var n = Number(PREFS.draftDelay);
    return isFinite(n) && n >= 1 && n <= 30 ? n * 1000 : 2000;
  }
  var DRAFT_TIMER = Object.create(null);
  var DRAFT_WRITTEN = Object.create(null); // path -> Date.now() of the copy on disk

  function draftPending() { return Object.keys(DRAFT_WRITTEN).length; }

  /** Queue a copy of this buffer; a buffer that is no longer dirty drops it. */
  function draftTouch(path) {
    if (!path) return;
    if (DRAFT_TIMER[path]) { clearTimeout(DRAFT_TIMER[path]); delete DRAFT_TIMER[path]; }
    var buf = BUFFERS[path];
    if (!buf || !buf.dirty) return;
    DRAFT_TIMER[path] = setTimeout(function () {
      delete DRAFT_TIMER[path];
      var live = BUFFERS[path];
      if (!live || !live.dirty) return;
      DRAFT_WRITTEN[path] = Date.now();
      BRIDGE.send({ kind: 'draftSave', path: path, content: String(live.content == null ? '' : live.content) });
      paintDraftState();
    }, draftDelay());
  }

  /** Forget a buffer's recovery copy (disk ACK, explicit discard, or a tab closed). */
  function draftDrop(path) {
    if (!path) return;
    if (DRAFT_TIMER[path]) { clearTimeout(DRAFT_TIMER[path]); delete DRAFT_TIMER[path]; }
    if (!DRAFT_WRITTEN[path]) return;
    delete DRAFT_WRITTEN[path];
    BRIDGE.send({ kind: 'draftDrop', path: path });
    paintDraftState();
  }

  /**
   * "Draft 12:03" in the status bar while at least one copy exists.
   *
   * Without it the recovery copy is invisible state: the user would learn about
   * it only after a crash, which is exactly the moment they cannot ask questions.
   */
  function paintDraftState() {
    var el = $('stDraft');
    if (!el) return;
    var paths = Object.keys(DRAFT_WRITTEN);
    if (!paths.length) {
      el.textContent = '';
      el.removeAttribute('title');
      el.classList.remove('on');
      return;
    }
    var at = 0;
    paths.forEach(function (p) { if (DRAFT_WRITTEN[p] > at) at = DRAFT_WRITTEN[p]; });
    var d = new Date(at);
    var hh = ('0' + d.getHours()).slice(-2);
    var mm = ('0' + d.getMinutes()).slice(-2);
    el.textContent = 'Draft ' + hh + ':' + mm + (paths.length > 1 ? ' (' + paths.length + ' files)' : '');
    el.title = 'Unsaved copies kept outside the workspace: ' + paths.join(', ');
    el.classList.add('on');
  }
