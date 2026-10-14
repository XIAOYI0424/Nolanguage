/**
 * Nolanguage workspace (IDE) — Vue 3 application.
 *
 * Plain script (no module syntax, no bundler): the page inlines it verbatim,
 * together with the vendored Vue runtime, so the workspace stays a single
 * self-contained HTML document that works offline. Injected data arrives on
 * `window.__NOLANGUAGE_IDE__` (samples, languages, token tables).
 *
 * This is the Vue port of the original hand-written page: identical behaviour,
 * identical CSS, identical WebSocket protocol — the difference is that the DOM
 * is now derived from reactive state instead of being patched by hand.
 */
(function () {
  'use strict';

  var BOOT = window.__NOLANGUAGE_IDE__ || {};
  var SAMPLES = BOOT.samples || [];
  var LANGUAGES = BOOT.languages || [];
  var TOKEN_PATTERNS = BOOT.tokenPatterns || {};
  var HIGHLIGHT_CLASSES = BOOT.highlightClasses || {};
  var MAX_LOGS = 3000;

  var NL = window.NL;
  var esc = NL.esc;
  var Vue = window.Vue;
  var reactive = Vue.reactive;
  var ref = Vue.ref;
  var computed = Vue.computed;
  var nextTick = Vue.nextTick;
  var onMounted = Vue.onMounted;
  var onUnmounted = Vue.onUnmounted;
  var h = Vue.h;
  var createApp = Vue.createApp;

  var WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/';

  // ================= syntax highlighting =================
  // One compiled regex per language: a shared /g regex would have its
  // lastIndex clobbered when switching languages mid-scan.
  var TOKENS = {};
  for (var langKey in TOKEN_PATTERNS) TOKENS[langKey] = new RegExp(TOKEN_PATTERNS[langKey], 'g');

  function highlight(src, lang) {
    var re = TOKENS[lang] || TOKENS.python;
    var classes = HIGHLIGHT_CLASSES[lang] || HIGHLIGHT_CLASSES.python;
    var out = '';
    var last = 0;
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) out += esc(src.slice(last, m.index));
      var cls = '';
      for (var g = 1; g <= 8; g++) {
        if (m[g] !== undefined) {
          cls = classes[g - 1];
          break;
        }
      }
      out += '<span class="' + cls + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    out += esc(src.slice(last));
    // A trailing newline keeps the overlay height in sync with the textarea.
    return out + '\n';
  }

  var GROUPS = [
    { title: 'Execution', match: function (n) { return /^execution\./.test(n); } },
    { title: 'Language servers', match: function (n) { return /^lsp\.|^rpc\./.test(n); } },
    { title: 'Kernel', match: function (n) { return /^command\.|^event\.|^service\./.test(n); } },
    { title: 'Other', match: function () { return true; } },
  ];

  var app = createApp({
    setup: function () {
      var st = reactive({
        code: '',
        language: 'python',
        tab: 'out',
        logs: [],
        seen: {},
        filterLevel: 2,
        metrics: {},
        series: {},
        tick: 0,
        runs: 0,
        session: 'ide',
        problems: [],
        lastRun: null,
        busy: false,
        langStatus: {},
        sampleMode: 'run',
        sampleIndex: 0,
        conn: 'connecting',
        probNote: '',
      });

      // Template refs — populated after mount.
      var ta = ref(null);
      var hlEl = ref(null);
      var gutterEl = ref(null);
      var activeEl = ref(null);
      var cmpEl = ref(null);

      var caret = reactive({ line: 1, col: 1 });
      var cmp = reactive({ open: false, all: [], items: [], sel: 0, reqId: 0, prefix: '', hint: '' });

      var socket = null;
      var pingTimer = null;
      var charW = 7.8;
      var padY = 8;
      var PAD_X = 12;
      var LINE_H = 20;

      // ---------------- language routing ----------------
      function langDesc(id) {
        for (var i = 0; i < LANGUAGES.length; i++) if (LANGUAGES[i].id === id) return LANGUAGES[i];
        return LANGUAGES[0];
      }
      function statusOf(id) { return st.langStatus[id] || {}; }
      function currentStatus() { return statusOf(st.language); }
      function currentLsp() { return currentStatus().lsp || {}; }
      function samplesForLang(lang) {
        var out = [];
        for (var i = 0; i < SAMPLES.length; i++) if (SAMPLES[i].languageId === lang) out.push(SAMPLES[i]);
        return out;
      }
      var currentSamples = computed(function () { return samplesForLang(st.language); });

      // ---------------- derived: editor ----------------
      var highlighted = computed(function () { return highlight(st.code, st.language); });
      var lineCount = computed(function () { return st.code.split('\n').length; });

      function markLines(severity) {
        var out = {};
        for (var i = 0; i < st.problems.length; i++) {
          if (st.problems[i].severity === severity) out[st.problems[i].line] = 1;
        }
        return out;
      }
      var errLines = computed(function () { return markLines(1); });
      var warnLines = computed(function () { return markLines(2); });
      var gutterRows = computed(function () {
        var ls = st.code.split('\n');
        var rows = [];
        for (var n = 0; n < ls.length; n++) {
          rows.push({ n: n + 1, cls: errLines.value[n] ? 'err' : (warnLines.value[n] ? 'warn' : '') });
        }
        return rows;
      });

      // ---------------- derived: tabs ----------------
      var problemCounts = computed(function () {
        var errs = 0;
        var warns = 0;
        for (var i = 0; i < st.problems.length; i++) {
          if (st.problems[i].severity === 1) errs++;
          else if (st.problems[i].severity === 2) warns++;
        }
        return { errors: errs, warnings: warns, total: st.problems.length };
      });
      var pillClass = computed(function () {
        var c = problemCounts.value;
        return c.errors ? 'pill err' : c.warnings ? 'pill warn' : 'pill';
      });
      var toolPath = computed(function () { return currentStatus().binary || '—'; });
      function levelName(level) { return NL.LEVEL_NAME[level] || String(level); }
      var LEVEL_OPTIONS = [
        { v: 0, n: 'TRACE' }, { v: 1, n: 'DEBUG' }, { v: 2, n: 'INFO' },
        { v: 3, n: 'WARN' }, { v: 4, n: 'ERROR' },
      ];

      var metricGroups = computed(function () {
        var names = Object.keys(st.metrics).sort();
        var out = [];
        var used = {};
        for (var g = 0; g < GROUPS.length; g++) {
          var grp = GROUPS[g];
          var rows = [];
          for (var i = 0; i < names.length; i++) {
            if (used[names[i]] || !grp.match(names[i])) continue;
            used[names[i]] = 1;
            var s = st.metrics[names[i]];
            rows.push({
              name: names[i],
              p50: s.p50,
              p95: s.p95,
              p99: s.p99,
              count: s.count,
              slow: s.p95 > 50,
              bad: s.p95 > 200,
              series: st.series[names[i]] || [],
            });
          }
          if (rows.length) out.push({ title: grp.title, rows: rows });
        }
        return out;
      });

      var visibleLogs = computed(function () {
        return NL.visibleByLevel(st.logs, st.filterLevel).reverse();
      });
      var logCounts = computed(function () {
        var counts = {};
        for (var i = 0; i < st.logs.length; i++) {
          var name = NL.LEVEL_NAME[st.logs[i].level] || String(st.logs[i].level);
          counts[name] = (counts[name] || 0) + 1;
        }
        var out = [];
        for (var j = 0; j < NL.LEVEL_ORDER.length; j++) {
          var L = NL.LEVEL_ORDER[j];
          out.push({ level: L, count: counts[L] || 0 });
        }
        return out;
      });

      var outputHtml = computed(function () {
        var r = st.lastRun;
        if (!r) return '';
        var html = '';
        if (r.stdout) html += '<span class="ok">' + esc(String(r.stdout).replace(/\n$/, '')) + '</span>\n';
        if (r.stderr) html += '<span class="err">' + esc(String(r.stderr).replace(/\n$/, '')) + '</span>\n';
        if (!r.stdout && !r.stderr) html += '<span class="hdr">(no output)</span>\n';
        var ok = r.exitCode === 0 && !r.timedOut;
        var bits = [];
        bits.push('exit ' + r.exitCode + (r.timedOut ? ' (timed out)' : ''));
        bits.push(Math.round(r.durationMs) + 'ms');
        // Go compiles first, so showing the split explains an otherwise
        // puzzling "2s for a hello world".
        if (r.buildMs) bits.push('build ' + Math.round(r.buildMs) + 'ms');
        if (r.phase === 'build' && r.compileError) bits.push('COMPILE ERROR');
        else if (r.phase === 'test') bits.push('go test');
        bits.push('session ' + esc(r.sessionId));
        bits.push(r.logLines + ' output line(s)');
        bits.push(ok ? 'OK' : 'FAILED');
        html += '<span class="meta">' + bits.join('  ·  ') + '</span>';
        return html;
      });

      var emptyProblem = computed(function () {
        var fromLsp = st.problems.length === 0 && st.lastProblemsFromLsp;
        var message = fromLsp ? 'No problems reported.' : 'Language server unavailable — Check is disabled.';
        return { message: message, why: st.probNote || '' };
      });

      // ---------------- derived: badges ----------------
      var toolBadge = computed(function () {
        var s = currentStatus();
        var d = langDesc(st.language);
        if (s.available === false) {
          return {
            text: d.displayName + ' unavailable',
            title: 'toolchain not found (looked in ' + (s.binarySource || '?') + ')',
          };
        }
        return { text: s.version || s.binary || d.displayName, title: s.binary || '' };
      });
      var lspBadge = computed(function () {
        var lsp = currentLsp();
        var suffix = lsp.state === 'pending' ? ' (idle)' : lsp.state === 'unavailable' ? ' (off)' : '';
        return {
          text: 'lsp ' + (lsp.serverName || '…') + suffix,
          title: lsp.note || lsp.error || '',
        };
      });

      // ---------------- editor plumbing ----------------
      function placeCaret(pos) {
        var el = ta.value;
        if (!el) return;
        el.selectionStart = el.selectionEnd = pos;
        syncScroll();
        updateCaret();
      }

      function updateCaret() {
        var el = ta.value;
        if (!el) return;
        var upto = st.code.slice(0, el.selectionStart);
        var parts = upto.split('\n');
        caret.line = parts.length;
        caret.col = parts[parts.length - 1].length + 1;
      }

      function syncScroll() {
        var el = ta.value;
        if (!el) return;
        if (hlEl.value) {
          hlEl.value.scrollTop = el.scrollTop;
          hlEl.value.scrollLeft = el.scrollLeft;
        }
        if (gutterEl.value) gutterEl.value.scrollTop = el.scrollTop;
        if (activeEl.value) {
          activeEl.value.style.display = 'block';
          activeEl.value.style.top = (padY + (caret.line - 1) * LINE_H - el.scrollTop) + 'px';
        }
        if (cmp.open) positionCompletion();
      }

      function onCodeInput(e) {
        // The textarea is bound with :value + @input rather than v-model so
        // Vue never has to guess about caret position: it only writes back
        // when the model changes for its own reasons (sample load, indent).
        st.code = e.target.value;
        updateCaret();
        if (cmp.open) refilterCompletion();
        else if (st.code.charAt((ta.value ? ta.value.selectionStart : 0) - 1) === '.') requestCompletion(false);
      }

      function onCursor() { syncScroll(); updateCaret(); }

      function onKeydown(e) {
        // The completion popup owns the arrow / accept / dismiss keys while open.
        if (cmp.open) {
          if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); return; }
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptCompletion(); return; }
          if (e.key === 'Escape') { e.preventDefault(); closeCompletion(); return; }
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === ' ' || e.code === 'Space')) {
          e.preventDefault();
          requestCompletion(true);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          var el = ta.value;
          var s = el.selectionStart;
          var en = el.selectionEnd;
          st.code = st.code.slice(0, s) + '    ' + st.code.slice(en);
          nextTick(function () { placeCaret(s + 4); });
          return;
        }
        if (e.key === 'Enter') {
          var pos = ta.value.selectionStart;
          var before = st.code.slice(0, pos);
          var lineStart = before.lastIndexOf('\n') + 1;
          var curLine = before.slice(lineStart);
          var indent = (curLine.match(/^[ \t]*/) || [''])[0];
          var extra = /:\s*(#.*)?$/.test(curLine) ? '    ' : '';
          if (!indent && !extra) return;
          e.preventDefault();
          var ins = '\n' + indent + extra;
          st.code = st.code.slice(0, pos) + ins + st.code.slice(ta.value.selectionEnd);
          nextTick(function () { placeCaret(pos + ins.length); });
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doRun(); return; }
        if (e.key === 'F5') { e.preventDefault(); doRun(); return; }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doCheck(); }
      }

      // ---------------- completion popup ----------------
      function caretPos() {
        var el = ta.value;
        var upto = st.code.slice(0, el.selectionStart);
        var nl = upto.lastIndexOf('\n');
        return { line: upto.split('\n').length - 1, character: el.selectionStart - nl - 1 };
      }

      function wordPrefix() {
        var m = st.code.slice(0, ta.value.selectionStart).match(/[A-Za-z_][A-Za-z0-9_.]*$/);
        return m ? m[0] : '';
      }

      function requestCompletion(manual) {
        if (st.busy) return;
        var pos = caretPos();
        cmp.reqId++;
        cmp.prefix = wordPrefix();
        send({
          kind: 'complete',
          language: st.language,
          code: st.code,
          line: pos.line,
          character: pos.character,
          requestId: cmp.reqId,
        });
        if (manual && !currentLsp().running && currentLsp().state !== 'ready') {
          // No server: tell the user rather than silently doing nothing.
          cmp.hint = 'language server unavailable';
          cmp.open = true;
          cmp.items = [];
          nextTick(positionCompletion);
          setTimeout(closeCompletion, 1200);
        }
      }

      function openCompletion(items) {
        cmp.all = items || [];
        cmp.hint = '';
        if (!cmp.all.length) { closeCompletion(); return; }
        cmp.open = true;
        cmp.sel = 0;
        refilterCompletion();
      }

      /** Re-apply the typed prefix against the full candidate set. */
      function refilterCompletion() {
        var p = cmp.prefix.toLowerCase();
        var list = cmp.all;
        if (p) {
          var f = [];
          for (var i = 0; i < list.length; i++) {
            if (list[i].label.toLowerCase().indexOf(p) === 0) f.push(list[i]);
          }
          if (f.length) list = f;
        }
        cmp.items = list;
        if (cmp.sel >= list.length) cmp.sel = 0;
        nextTick(positionCompletion);
      }

      function positionCompletion() {
        var el = ta.value;
        if (!el) return;
        var pos = caretPos();
        var top = padY + (pos.line + 1) * LINE_H - el.scrollTop;
        var left = PAD_X + pos.character * charW - el.scrollLeft;
        var maxLeft = Math.max(PAD_X, el.clientWidth - 210);
        if (left > maxLeft) left = maxLeft;
        // Flip above the caret when there is not enough room below.
        var est = Math.min(cmp.items.length, 9) * 19 + 26;
        if (top + est > el.clientHeight) top = Math.max(2, top - LINE_H - est);
        var node = cmpEl.value;
        if (node) {
          node.style.top = top + 'px';
          node.style.left = left + 'px';
        }
      }

      function moveSel(d) {
        var n = cmp.items.length;
        if (!n) return;
        cmp.sel = (cmp.sel + d + n) % n;
        nextTick(function () {
          positionCompletion();
          var node = cmpEl.value;
          var sel = node ? node.querySelector('.item.sel') : null;
          if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
        });
      }

      function pickItem(i) {
        cmp.sel = i;
        acceptCompletion();
      }

      function acceptCompletion() {
        if (!cmp.open) return;
        var it = cmp.items[cmp.sel];
        if (!it) { closeCompletion(); return; }
        // Servers often append a call signature ("print(value)") — insert the name.
        var insert = String(it.label).replace(/\(.*$/, '');
        var el = ta.value;
        var end = el.selectionStart;
        var m = st.code.slice(0, end).match(/[A-Za-z_][A-Za-z0-9_.]*$/);
        var start = m ? end - m[0].length : end;
        st.code = st.code.slice(0, start) + insert + st.code.slice(el.selectionEnd);
        closeCompletion();
        nextTick(function () {
          placeCaret(start + insert.length);
          if (ta.value) ta.value.focus();
        });
      }

      function closeCompletion() {
        cmp.open = false;
        cmp.all = [];
        cmp.items = [];
        cmp.hint = '';
        cmp.prefix = '';
      }

      function onDocMouseDown(e) {
        var node = cmpEl.value;
        if (cmp.open && node && !node.contains(e.target)) closeCompletion();
      }

      // ---------------- languages & samples ----------------
      function loadSample(s) {
        st.code = s.code;
        st.problems = [];
        // A test-mode sample makes Test the primary action, so the obvious
        // button is also the correct one.
        st.sampleMode = s.mode || 'run';
        setProblems([], false);
      }

      /** Switch language: swap buffer, sample list, highlighter and toolbar. */
      function setLanguage(lang, opts) {
        var d = langDesc(lang);
        if (d.id !== lang) { lang = LANGUAGES[0].id; d = langDesc(lang); }
        var changed = lang !== st.language;
        st.language = lang;
        st.sampleIndex = 0;
        var own = samplesForLang(lang);
        if (!(opts && opts.keepCode) && own.length) loadSample(own[0]);
        if (changed) {
          st.problems = [];
          st.lastRun = null;
          setProblems([], false);
        }
      }

      function setProblems(items, fromLsp, note) {
        st.problems = items || [];
        st.lastProblemsFromLsp = !!fromLsp;
        st.probNote = note || currentLsp().error || '';
      }

      /** Move the caret to a diagnostic's position. */
      function jumpTo(p) {
        var el = ta.value;
        if (!el) return;
        var idx = 0;
        var ls = st.code.split('\n');
        for (var n = 0; n < p.line && n < ls.length; n++) idx += ls[n].length + 1;
        idx += p.character;
        el.focus();
        placeCaret(idx);
      }

      // ---------------- websocket ----------------
      function connect() {
        socket = NL.connectSocket({
          url: WS_URL,
          onOpen: function () { st.conn = 'on'; },
          onClose: function () {
            st.conn = 'off';
            setBusy(false);
          },
          onMessage: handle,
        });
      }

      function send(obj) { if (socket) socket.send(obj); }
      function setBusy(b) { st.busy = b; }

      function handle(msg) {
        switch (msg.kind) {
          case 'hello':
            return;
          case 'workspace': {
            var byId = {};
            var langs = (msg.status && msg.status.languages) || [];
            for (var i = 0; i < langs.length; i++) byId[langs[i].id] = langs[i];
            st.langStatus = byId;
            // A language whose server is missing must say so on the Problems tab.
            if (!currentLsp().running && currentLsp().state === 'unavailable') setProblems([], false);
            return;
          }
          case 'runStart':
            setBusy(true);
            st.session = msg.sessionId;
            return;
          case 'runResult':
            setBusy(false);
            if (msg.language && msg.language !== st.language) return; // stale
            st.runs++;
            st.lastRun = msg;
            st.session = msg.sessionId;
            st.tab = 'out';
            return;
          case 'diagnostics':
            if (msg.language && msg.language !== st.language) return; // stale
            setProblems(msg.items || [], msg.fromLsp, msg.note);
            if (msg.items && msg.items.length) st.tab = 'prob';
            return;
          case 'completion':
            if (msg.language && msg.language !== st.language) return; // stale
            if (msg.requestId !== cmp.reqId) return; // stale response
            openCompletion(msg.items || []);
            return;
          case 'hover':
            return;
          case 'metrics':
            st.metrics = msg.metrics;
            st.series = msg.series || {};
            st.tick = msg.tick;
            return;
          case 'log': {
            var records = msg.records || [];
            for (var j = 0; j < records.length; j++) {
              var r = records[j];
              if (st.seen[r.id]) continue;
              st.seen[r.id] = 1;
              st.logs.push(r);
            }
            if (st.logs.length > MAX_LOGS) st.logs.splice(0, st.logs.length - MAX_LOGS);
            return;
          }
          case 'logReset':
            st.logs = [];
            st.seen = {};
            return;
          case 'session':
            st.session = msg.sessionId;
            return;
          case 'error':
            console.warn('server:', msg.message);
            setBusy(false);
            return;
        }
      }

      // ---------------- actions ----------------
      function doRun(mode) {
        if (st.busy) return;
        setBusy(true);
        send({
          kind: 'run',
          language: st.language,
          code: st.code,
          sessionId: st.session,
          mode: mode || 'run',
        });
      }

      function doCheck() {
        if (st.busy) return;
        setBusy(true);
        send({ kind: 'check', language: st.language, code: st.code });
      }

      function doReset() {
        send({ kind: 'resetSession', language: st.language, sessionId: st.session });
      }

      function clearLogs() { send({ kind: 'clear' }); }

      // ---------------- lifecycle ----------------
      function measure() {
        try {
          var el = ta.value;
          if (el) {
            var ctx = document.createElement('canvas').getContext('2d');
            if (ctx) {
              ctx.font = getComputedStyle(el).font;
              charW = ctx.measureText('M').width || 7.8;
            }
          }
          var pad = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--pad-y'), 10);
          if (!isNaN(pad)) padY = pad;
        } catch (e) {
          /* defaults are fine */
        }
      }

      // Initial sample. No DOM access here, so it can safely run during setup
      // and the first paint already shows code rather than an empty editor.
      setLanguage(LANGUAGES[0].id, { keepCode: false });

      onMounted(function () {
        measure();
        updateCaret();
        document.addEventListener('mousedown', onDocMouseDown);
        connect();
        pingTimer = setInterval(function () { send({ kind: 'ping' }); }, 20000);
      });

      onUnmounted(function () {
        if (pingTimer) clearInterval(pingTimer);
        document.removeEventListener('mousedown', onDocMouseDown);
        if (socket) socket.close();
      });

      return {
        st: st,
        caret: caret,
        cmp: cmp,
        ta: ta,
        hlEl: hlEl,
        gutterEl: gutterEl,
        activeEl: activeEl,
        cmpEl: cmpEl,
        LANGUAGES: LANGUAGES,
        langDesc: langDesc,
        currentSamples: currentSamples,
        lineCount: lineCount,
        highlighted: highlighted,
        gutterRows: gutterRows,
        problemCounts: problemCounts,
        pillClass: pillClass,
        toolPath: toolPath,
        levelName: levelName,
        LEVEL_OPTIONS: LEVEL_OPTIONS,
        metricGroups: metricGroups,
        visibleLogs: visibleLogs,
        logCounts: logCounts,
        outputHtml: outputHtml,
        emptyProblem: emptyProblem,
        toolBadge: toolBadge,
        lspBadge: lspBadge,
        onCodeInput: onCodeInput,
        onKeydown: onKeydown,
        onScroll: function () { syncScroll(); },
        onCursor: onCursor,
        setLanguage: setLanguage,
        loadSample: loadSample,
        doRun: doRun,
        doCheck: doCheck,
        doReset: doReset,
        clearLogs: clearLogs,
        jumpTo: jumpTo,
        pickItem: pickItem,
        kindLabel: function (k) { return NL.KIND_LABEL[k] || ''; },
        clockOf: NL.clockOf,
        shortId: NL.shortId,
      };
    },
  });

  /**
   * Sparkline as a small render-function component: no template escaping, and
   * the geometry maths stays in one place. Colours come from CSS so the chart
   * follows the theme (an SVG presentation attribute cannot use var()).
   */
  app.component('spark-line', {
    props: {
      values: { type: Array, default: function () { return []; } },
      warn: { type: Boolean, default: false },
    },
    setup: function (props) {
      return function () {
        var bars = NL.sparkBars(props.values, 24, 74, 16);
        return h(
          'svg',
          { class: 'spark' + (props.warn ? ' warn' : ''), width: 74, height: 16, 'aria-hidden': 'true' },
          bars.map(function (b) {
            return h('rect', { x: b.x, y: b.y, width: b.width, height: b.height });
          }),
        );
      };
    },
  });

  app.mount('#app');
})();
