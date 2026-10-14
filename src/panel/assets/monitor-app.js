/**
 * Nolanguage dev panel (monitor) — Vue 3 application.
 *
 * Plain script inlined into a single self-contained page, like the workspace
 * app. Live metrics, slow paths and the log stream over the panel WebSocket,
 * with pause / filter / clear controls.
 */
(function () {
  'use strict';

  var NL = window.NL;
  var esc = NL.esc;
  var Vue = window.Vue;
  var reactive = Vue.reactive;
  var ref = Vue.ref;
  var computed = Vue.computed;
  var onMounted = Vue.onMounted;
  var onUnmounted = Vue.onUnmounted;
  var h = Vue.h;
  var createApp = Vue.createApp;

  var WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/';
  var MAX_LOGS = 3000;
  var MAX_SLOW = 200;

  var GROUPS = [
    { title: 'Kernel', match: function (n) { return /^command\.|^event\.|^service\./.test(n); } },
    { title: 'Language servers', match: function (n) { return /^lsp\.|pyright/.test(n); } },
    { title: 'Other', match: function () { return true; } },
  ];

  var app = createApp({
    setup: function () {
      var st = reactive({
        appVersion: '',
        arch: '',
        os: '',
        metrics: {},
        series: {},
        slow: [],
        logs: [],
        seen: {},
        filterLevel: 2,
        filterComponents: '',
        filterPattern: '',
        pausePerf: false,
        pauseLogs: false,
        tick: 0,
        clients: 0,
        perfTotal: 0,
        conn: 'connecting',
      });

      var socket = null;
      var pingTimer = null;

      // ---------------- derived ----------------
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

      var levelCounts = computed(function () {
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

      var slowRows = computed(function () {
        var out = [];
        for (var i = st.slow.length - 1; i >= 0; i--) {
          var s = st.slow[i];
          out.push({
            key: i,
            label: s.commandId || s.name || '',
            trace: NL.shortId(s.traceId),
            durationMs: s.durationMs,
          });
        }
        return out;
      });

      var metricCount = computed(function () { return Object.keys(st.metrics).length; });
      function levelName(level) { return NL.LEVEL_NAME[level] || String(level); }
      function levelValue(name) {
        var v = NL.LEVEL_VALUE[name];
        return v === undefined ? st.filterLevel : v;
      }

      // ---------------- websocket ----------------
      function connect() {
        socket = NL.connectSocket({
          url: WS_URL,
          onOpen: function () { st.conn = 'on'; },
          onClose: function () { st.conn = 'off'; },
          onMessage: handle,
        });
      }

      function send(obj) { if (socket) socket.send(obj); }

      function handle(msg) {
        if (msg.kind === 'hello') {
          st.appVersion = msg.appVersion;
          st.arch = msg.arch;
          st.os = msg.os || '';
          return;
        }
        if (msg.kind === 'metrics') {
          if (st.pausePerf) return;
          st.metrics = msg.metrics;
          st.series = msg.series || {};
          st.tick = msg.tick;
          st.perfTotal = (msg.perfSummary && msg.perfSummary.total) || 0;
          st.clients = msg.clients || st.clients;
          return;
        }
        if (msg.kind === 'slow') {
          if (st.pausePerf) return;
          var spans = msg.spans || [];
          for (var i = 0; i < spans.length; i++) st.slow.push(spans[i]);
          if (st.slow.length > MAX_SLOW) st.slow.splice(0, st.slow.length - MAX_SLOW);
          return;
        }
        if (msg.kind === 'log') {
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
        if (msg.kind === 'logReset') {
          st.logs = [];
          st.seen = {};
          return;
        }
        if (msg.kind === 'filter') {
          // The server echoes the normalised filter back; mirror at least the
          // level so the selector always shows what is actually in force.
          if (msg.filter) st.filterLevel = msg.filter.minLevel;
          return;
        }
        if (msg.kind === 'error') {
          console.warn('panel error:', msg.message);
        }
      }

      // ---------------- controls ----------------
      function applyFilter() {
        var comps = st.filterComponents
          .split(',')
          .map(function (s) { return s.trim(); })
          .filter(Boolean);
        send({
          kind: 'filter',
          minLevel: Number(st.filterLevel),
          components: comps,
          pattern: st.filterPattern.trim(),
        });
      }

      function setLevel(level) {
        st.filterLevel = level;
      }

      function onFilterKeydown(e) {
        if (e.key === 'Enter') applyFilter();
      }

      function togglePauseLogs() {
        st.pauseLogs = !st.pauseLogs;
      }

      function togglePausePerf() {
        st.pausePerf = !st.pausePerf;
      }

      onMounted(function () {
        connect();
        pingTimer = setInterval(function () { send({ kind: 'ping' }); }, 20000);
      });

      onUnmounted(function () {
        if (pingTimer) clearInterval(pingTimer);
        if (socket) socket.close();
      });

      return {
        st: st,
        metricGroups: metricGroups,
        metricCount: metricCount,
        visibleLogs: visibleLogs,
        levelCounts: levelCounts,
        slowRows: slowRows,
        applyFilter: applyFilter,
        setLevel: setLevel,
        levelName: levelName,
        levelValue: levelValue,
        onFilterKeydown: onFilterKeydown,
        togglePauseLogs: togglePauseLogs,
        togglePausePerf: togglePausePerf,
        clearLogs: function () { send({ kind: 'clear' }); },
        clockOf: NL.clockOf,
        shortId: NL.shortId,
      };
    },
  });

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
