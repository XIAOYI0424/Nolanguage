/**
 * Nolanguage · kernel performance analysis — Vue 3 application.
 *
 * A *deep* view of the perf spine, complementing the live `/monitor` panel.
 * Where `/monitor` answers "is anything on fire right now", this page answers
 * "where is the time going, and how is that changing":
 *
 *   - every metric with the full summary (count / min / max / avg / p50 / p95 / p99)
 *   - a 60-point trend per metric, on a shared time axis, hover-highlighted
 *   - grouping by the emitting subsystem (kernel command/event/service, RPC,
 *     LSP, execution, extension, store) so a regression is attributable
 *   - the slow-path table with the traceId that ties a span back to the record
 *     stream, so a slow command can be followed into its logs
 *   - the perf record mix (`perfSummary.byType`) as a distribution bar
 *
 * Reads the same panel WebSocket as the other pages: `hello`, `metrics` and
 * `slow`. Purely additive — it sends nothing but a ping.
 */
(function () {
  'use strict';

  var NL = window.NL;
  var Vue = window.Vue;
  var reactive = Vue.reactive;
  var computed = Vue.computed;
  var onMounted = Vue.onMounted;
  var onUnmounted = Vue.onUnmounted;
  var h = Vue.h;
  var createApp = Vue.createApp;

  var WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/';

  /** Trend history kept per metric name, in digests (1 Hz). */
  var TREND_LEN = 60;
  var MAX_SLOW = 500;

  /**
   * Metric name -> subsystem. The instrumentation naming convention documented
   * in the project memory is the source of truth here; ordering matters because
   * the first matching pattern wins.
   */
  var SCOPES = [
    { id: 'command', title: 'Commands', match: /^command\./ },
    { id: 'rpc', title: 'RPC round-trip', match: /^rpc\./ },
    { id: 'lsp', title: 'Language servers', match: /^lsp\./ },
    { id: 'exec', title: 'Execution', match: /^execution\./ },
    { id: 'event', title: 'Events', match: /^event\./ },
    { id: 'service', title: 'Services', match: /^service\./ },
    { id: 'store', title: 'Persistence', match: /^store\.|^log\.sink|^baseline\./ },
    { id: 'extension', title: 'Extensions', match: /^extension\./ },
  ];

  function scopeOf(name) {
    for (var i = 0; i < SCOPES.length; i++) if (SCOPES[i].match.test(name)) return SCOPES[i];
    return { id: 'other', title: 'Other' };
  }

  /**
   * Metric name -> unit.
   *
   * Not every metric is a duration: `memory.rss` is bytes, `extension.uptime`
   * is milliseconds-since-start, `extension.log.records` and `crash.count` are
   * counters, and `event.throughput` is events/second. Rendering those with an
   * "ms" suffix (and banding them by a latency budget) would be actively
   * misleading — a 78 MB RSS would read as "78,503,936 ms, HOT".
   *
   * This mirrors the project's existing `defaultHigherIsBetter` distinction in
   * BaselineStore: some numbers are not latencies.
   */
  var UNITS = [
    { unit: 'bytes', match: /rss|heap|memory|bytes|size/i, higherIsBetter: false },
    { unit: 'rate', match: /throughput|hit_rate|hitratio|\/s$/i, higherIsBetter: true },
    // Counters and host gauges. `extension.uptime` belongs here even though it
    // is measured in ms: it is a monotonic uptime, not a latency, so banding it
    // against the 50/200ms latency budget would mark every host as "hot".
    { unit: 'count', match: /\.count$|\.records$|\.hits?$|^crash\.|\.uptime$|^extension\./i, higherIsBetter: false },
    { unit: 'ms', match: /./, higherIsBetter: false },
  ];

  function unitOf(name) {
    for (var i = 0; i < UNITS.length; i++) if (UNITS[i].match.test(name)) return UNITS[i].unit;
    return 'ms';
  }

  /** Format a value for its unit. */
  function fmtUnit(v, unit) {
    if (v === undefined || v === null || !isFinite(v)) return '-';
    switch (unit) {
      case 'bytes':
        if (v >= 1073741824) return (v / 1073741824).toFixed(2) + 'GB';
        if (v >= 1048576) return (v / 1048576).toFixed(1) + 'MB';
        if (v >= 1024) return (v / 1024).toFixed(1) + 'KB';
        return v.toFixed(0) + 'B';
      case 'count':
      case 'rate':
        return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v));
      default:
        if (v >= 1000) return (v / 1000).toFixed(2) + 's';
        if (v >= 100) return v.toFixed(0);
        if (v >= 10) return v.toFixed(1);
        return v.toFixed(2);
    }
  }

  /**
   * Severity band for a p95 — only meaningful for durations, so gauges and
   * counters are never flagged as "hot" for being numerically large.
   */
  function bandOf(p95, unit) {
    if (unit !== 'ms') return 'ok';
    if (p95 >= 200) return 'bad';
    if (p95 >= 50) return 'warn';
    return 'ok';
  }

  var app = createApp({
    setup: function () {
      var st = reactive({
        conn: 'connecting',
        appVersion: '',
        os: '',
        arch: '',
        pushIntervalMs: 0,
        tick: 0,
        clients: 0,
        metrics: {},
        series: {},
        perfTotal: 0,
        byType: {},
        slow: [],
        commands: [],
        // Trends are accumulated client-side because the wire only carries the
        // last 60 digest values per metric, and a frozen view is more useful
        // than one that slides out from under the cursor.
        history: {},
        paused: false,
        sortKey: 'p95',
        sortDir: -1,
        selected: '',
        slowFilter: '',
        scopeFilter: 'all',
      });

      var socket = null;
      var pingTimer = null;

      // ---------------- derived: metric rows ----------------
      var rows = computed(function () {
        var out = [];
        var names = Object.keys(st.metrics);
        for (var i = 0; i < names.length; i++) {
          var name = names[i];
          var s = st.metrics[name];
          var unit = unitOf(name);
          out.push({
            name: name,
            scope: scopeOf(name),
            unit: unit,
            count: s.count,
            min: s.min,
            max: s.max,
            avg: s.avg,
            p50: s.p50,
            p95: s.p95,
            p99: s.p99,
            band: bandOf(s.p95, unit),
            series: st.history[name] || st.series[name] || [],
          });
        }
        var key = st.sortKey;
        var dir = st.sortDir;
        var numeric = key !== 'name';
        out.sort(function (a, b) {
          // Latency columns mix units — a byte gauge's p95 is numerically huge
          // but semantically incomparable. Group by unit first so durations
          // always rank together and gauges/counters sort after them.
          if (numeric && a.unit !== b.unit) {
            if (a.unit === 'ms') return -1;
            if (b.unit === 'ms') return 1;
            return a.unit < b.unit ? -1 : 1;
          }
          var av = a[key];
          var bv = b[key];
          if (typeof av === 'string') return dir * av.localeCompare(bv);
          return dir * (av - bv);
        });
        return out;
      });

      var visibleRows = computed(function () {
        if (st.scopeFilter === 'all') return rows.value;
        return rows.value.filter(function (r) { return r.scope.id === st.scopeFilter; });
      });

      /** Scope groups with aggregate p95, for the left-hand breakdown. */
      var scopeBreakdown = computed(function () {
        var byId = {};
        var all = rows.value;
        for (var i = 0; i < all.length; i++) {
          var r = all[i];
          var g = byId[r.scope.id];
          if (!g) {
            g = byId[r.scope.id] = {
              id: r.scope.id, title: r.scope.title, metrics: 0, records: 0,
              worstP95: 0, worstName: '', durations: 0,
            };
          }
          g.metrics++;
          g.records += r.count;
          // Only durations take part in the "worst" ranking — a byte gauge or a
          // counter would otherwise always win by sheer magnitude.
          if (r.unit === 'ms') {
            g.durations++;
            if (r.p95 > g.worstP95) { g.worstP95 = r.p95; g.worstName = r.name; }
          }
        }
        var out = [];
        for (var id in byId) if (Object.prototype.hasOwnProperty.call(byId, id)) out.push(byId[id]);
        out.sort(function (a, b) { return b.worstP95 - a.worstP95; });
        var max = 0;
        for (var j = 0; j < out.length; j++) if (out[j].worstP95 > max) max = out[j].worstP95;
        for (var k = 0; k < out.length; k++) {
          out[k].ratio = max > 0 ? out[k].worstP95 / max : 0;
          out[k].band = bandOf(out[k].worstP95, 'ms');
        }
        return out;
      });

      /** Record-type mix (`perfSummary.byType`) as proportional bars. */
      var typeMix = computed(function () {
        var out = [];
        for (var k in st.byType) if (Object.prototype.hasOwnProperty.call(st.byType, k)) out.push({ type: k, count: st.byType[k] });
        out.sort(function (a, b) { return b.count - a.count; });
        var total = 0;
        for (var i = 0; i < out.length; i++) total += out[i].count;
        for (var j = 0; j < out.length; j++) out[j].ratio = total > 0 ? out[j].count / total : 0;
        return out;
      });

      /** The highlighted metric's trend, in ms, ready to plot. */
      var selectedRow = computed(function () {
        if (!st.selected) return null;
        for (var i = 0; i < rows.value.length; i++) if (rows.value[i].name === st.selected) return rows.value[i];
        return null;
      });

      var slowRows = computed(function () {
        var needle = st.slowFilter.trim().toLowerCase();
        var out = [];
        for (var i = st.slow.length - 1; i >= 0; i--) {
          var s = st.slow[i];
          var label = s.commandId || s.name || '';
          if (needle && label.toLowerCase().indexOf(needle) < 0 && String(s.traceId).indexOf(needle) < 0) continue;
          out.push({
            key: s.spanId || String(i),
            label: label,
            trace: NL.shortId(s.traceId),
            traceId: s.traceId,
            durationMs: s.durationMs,
            at: s.at,
            band: bandOf(s.durationMs, 'ms'),
          });
        }
        return out;
      });

      /** Slow paths bucketed by duration, so the tail is visible at a glance. */
      var slowHistogram = computed(function () {
        var buckets = [
          { label: '<100ms', min: 0, max: 100, count: 0 },
          { label: '100-250', min: 100, max: 250, count: 0 },
          { label: '250-500', min: 250, max: 500, count: 0 },
          { label: '500ms-1s', min: 500, max: 1000, count: 0 },
          { label: '>1s', min: 1000, max: Infinity, count: 0 },
        ];
        for (var i = 0; i < st.slow.length; i++) {
          var d = st.slow[i].durationMs;
          for (var b = 0; b < buckets.length; b++) {
            if (d >= buckets[b].min && d < buckets[b].max) { buckets[b].count++; break; }
          }
        }
        var max = 0;
        for (var j = 0; j < buckets.length; j++) if (buckets[j].count > max) max = buckets[j].count;
        for (var k = 0; k < buckets.length; k++) buckets[k].ratio = max > 0 ? buckets[k].count / max : 0;
        return buckets;
      });

      var totals = computed(function () {
        var n = 0, count = 0, worst = 0, worstName = '', hot = 0, durations = 0;
        var all = rows.value;
        for (var i = 0; i < all.length; i++) {
          n++;
          count += all[i].count;
          // Latency KPIs must ignore gauges/counters — see `unitOf`.
          if (all[i].unit === 'ms') {
            durations++;
            if (all[i].p95 > worst) { worst = all[i].p95; worstName = all[i].name; }
            if (all[i].band === 'bad') hot++;
          }
        }
        return { metrics: n, samples: count, worstP95: worst, worstName: worstName, hot: hot, durations: durations };
      });

      // ---------------- sorting / selection ----------------
      function sortBy(key) {
        if (st.sortKey === key) { st.sortDir = -st.sortDir; return; }
        st.sortKey = key;
        // Latency columns are most useful worst-first; identity columns A-Z.
        st.sortDir = (key === 'name') ? 1 : -1;
      }

      function arrow(key) {
        if (st.sortKey !== key) return '';
        return st.sortDir < 0 ? ' \u25BC' : ' \u25B2';
      }

      function select(name) {
        st.selected = st.selected === name ? '' : name;
      }

      /** Format a duration in ms (used by KPI cards and the trend meta). */
      function fmt(v) {
        return fmtUnit(v, 'ms');
      }

      /** Format a value according to the row's own unit. */
      function fmtCell(v, unit) {
        return fmtUnit(v, unit);
      }

      function clockOf(ts) { return NL.clockOf(ts); }

      // ---------------- websocket ----------------
      function handle(msg) {
        if (msg.kind === 'hello') {
          st.appVersion = msg.appVersion;
          st.os = msg.os || '';
          st.arch = msg.arch;
          st.pushIntervalMs = msg.pushIntervalMs || 0;
          st.commands = msg.commands || [];
          return;
        }
        if (msg.kind === 'metrics') {
          if (st.paused) return;
          st.tick = msg.tick;
          st.clients = msg.clients || st.clients;
          st.metrics = msg.metrics || {};
          st.series = msg.series || {};
          st.perfTotal = (msg.perfSummary && msg.perfSummary.total) || 0;
          st.byType = (msg.perfSummary && msg.perfSummary.byType) || {};
          // Advance the client-side trend history by one point per digest.
          //
          // The server already keeps 60 digest values per metric, so on the
          // first frame — and after a reconnect — its array is longer than
          // ours. Seed from it and then append, otherwise the chart would open
          // with a single bar even though the server has a full minute of
          // history to show.
          var names = Object.keys(st.metrics);
          for (var i = 0; i < names.length; i++) {
            var name = names[i];
            var serverSeries = st.series[name];
            var arr = st.history[name];
            if (!arr) {
              arr = st.history[name] = serverSeries ? serverSeries.slice(-TREND_LEN) : [];
              if (arr.length) continue; // the server's tail already includes this digest
            }
            arr.push(st.metrics[name].avg);
            if (arr.length > TREND_LEN) arr.shift();
          }
          return;
        }
        if (msg.kind === 'slow') {
          if (st.paused) return;
          var spans = msg.spans || [];
          for (var j = 0; j < spans.length; j++) st.slow.push(spans[j]);
          if (st.slow.length > MAX_SLOW) st.slow.splice(0, st.slow.length - MAX_SLOW);
          return;
        }
        if (msg.kind === 'error') console.warn('perf page:', msg.message);
      }

      onMounted(function () {
        socket = NL.connectSocket({
          url: WS_URL,
          onOpen: function () { st.conn = 'on'; },
          onClose: function () { st.conn = 'off'; },
          onMessage: handle,
        });
        pingTimer = setInterval(function () { if (socket) socket.send({ kind: 'ping' }); }, 20000);
      });

      onUnmounted(function () {
        if (pingTimer) clearInterval(pingTimer);
        if (socket) socket.close();
      });

      return {
        st: st,
        rows: rows,
        visibleRows: visibleRows,
        scopeBreakdown: scopeBreakdown,
        typeMix: typeMix,
        selectedRow: selectedRow,
        slowRows: slowRows,
        slowHistogram: slowHistogram,
        totals: totals,
        scopes: SCOPES,
        sortBy: sortBy,
        arrow: arrow,
        select: select,
        fmt: fmt,
        fmtCell: fmtCell,
        clockOf: clockOf,
        togglePause: function () { st.paused = !st.paused; },
        clearSlow: function () { st.slow = []; },
      };
    },
  });

  /**
   * Trend chart for one metric: an area-ish bar series with a peak marker, so a
   * spike can be read against the tail it produced. Units come from the row, so
   * a byte gauge is not mislabelled as a duration.
   */
  app.component('trend-chart', {
    props: {
      values: { type: Array, default: function () { return []; } },
      p95: { type: Number, default: 0 },
      unit: { type: String, default: 'ms' },
      width: { type: Number, default: 560 },
      height: { type: Number, default: 120 },
    },
    setup: function (props) {
      return function () {
        var vals = props.values.slice(-TREND_LEN);
        // NB: these must not be named `h` — `h` is the hyperscript helper from
        // the enclosing scope, and shadowing it breaks every element created
        // below (Vue swallows the TypeError and renders a comment placeholder,
        // so the symptom is an empty chart rather than a crash).
        var boxW = props.width;
        var boxH = props.height;
        var pad = 4;
        var inner = boxH - pad * 2;

        var max = 1;
        for (var i = 0; i < vals.length; i++) if (vals[i] > max) max = vals[i];
        // Leave headroom so the tallest bar never touches the frame.
        max *= 1.15;

        var slot = boxW / TREND_LEN;
        var bars = [];
        var points = [];
        for (var j = 0; j < vals.length; j++) {
          var bh = Math.max(1, Math.round((vals[j] / max) * inner));
          var x = j * slot;
          bars.push(h('rect', {
            x: x.toFixed(1), y: (boxH - pad - bh).toFixed(1),
            width: Math.max(1, slot - 1.2).toFixed(1), height: bh,
          }));
          points.push(x.toFixed(1) + ',' + (boxH - pad - bh).toFixed(1));
        }

        var children = [
          // Frame + horizontal guides at the 25% and 50% marks.
          h('line', { class: 'grid', x1: 0, y1: pad, x2: boxW, y2: pad }),
          h('line', { class: 'grid', x1: 0, y1: boxH / 2, x2: boxW, y2: boxH / 2 }),
          h('line', { class: 'axis', x1: 0, y1: boxH - pad, x2: boxW, y2: boxH - pad }),
        ].concat(bars);

        if (points.length > 1) {
          children.push(h('polyline', { class: 'trendLine', points: points.join(' ') }));
        }

        return h('div', { class: 'trendWrap' }, [
          h('svg', { class: 'trend', width: boxW, height: boxH, viewBox: '0 0 ' + boxW + ' ' + boxH, 'aria-hidden': 'true' }, children),
          h('div', { class: 'trendMeta' }, [
            h('span', {}, 'avg over last ' + vals.length + ' digests'),
            h('span', { class: 'peak' }, 'peak ' + fmtUnit(props.p95, props.unit) + ' p95'),
          ]),
        ]);
      };
    },
  });

  /** Compact per-row sparkline, matching the monitor page's visual weight. */
  app.component('spark-line', {
    props: {
      values: { type: Array, default: function () { return []; } },
      band: { type: String, default: 'ok' },
    },
    setup: function (props) {
      return function () {
        var bars = NL.sparkBars(props.values, 28, 90, 18);
        return h(
          'svg',
          { class: 'spark ' + props.band, width: 90, height: 18, 'aria-hidden': 'true' },
          bars.map(function (b) { return h('rect', { x: b.x, y: b.y, width: b.width, height: b.height }); }),
        );
      };
    },
  });

  app.mount('#app');
})();
