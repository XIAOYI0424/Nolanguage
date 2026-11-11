/**
 * Dev panel UI (Stage 2) — Vue 3 edition.
 *
 * One self-contained HTML page, like the workspace: the vendored Vue runtime,
 * the shared `nl-core` helpers and the `monitor-app` Vue application are
 * inlined verbatim as text imports (`?raw`), so no network access is needed to
 * open the page and the packaged exe serves the same bytes.
 *
 * Layout follows the design spec (二十八): header + two columns
 * (Performance | Logs), status bar at the bottom.
 */
import vueRuntime from '../vendor/vue.global.prod.js?raw';
import nlCoreSource from './assets/nl-core.js?raw';
import monitorAppSource from './assets/monitor-app.js?raw';

export function renderPanelHtml(port: number): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nolanguage · Dev Panel</title>
<style>
  :root {
    --bg-primary:#FFFFFF; --bg-secondary:#F7F8FA; --bg-elevated:#FFFFFF;
    --border:#EBECF0; --text-primary:#1E1F22; --text-secondary:#6C707E;
    --accent:#3574F0; --success:#499C54; --warning:#D6A545; --error:#DB5C5C;
    --trace:#9DA0A8; --debug:#2AACB8; --info:#499C54; --metric:#2A6DF4;
    --mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { height:100%; margin:0; }
  body {
    background: var(--bg-primary); color: var(--text-primary);
    font: 13px/1.45 var(--sans); overflow:hidden;
  }
  /* Vue mounts here: header, main and footer are its children. */
  #app { display:flex; flex-direction:column; height:100%; }
  /* ---------- header ---------- */
  header {
    display:flex; align-items:center; gap:12px; padding:8px 14px;
    background: var(--bg-secondary); border-bottom:1px solid var(--border); flex:0 0 auto;
  }
  header .logo { font-weight:600; letter-spacing:.2px; }
  header .badge {
    font-size:11px; padding:1px 7px; border-radius:9px; border:1px solid var(--border);
    color: var(--text-secondary); background: var(--bg-elevated);
  }
  header .spacer { flex:1; }
  .conn { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-secondary); }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--warning); }
  .dot.on { background: var(--success); }
  .dot.off { background: var(--error); }
  select, input, button { font: inherit; color:var(--text-primary); }
  select, input[type=text] {
    background: var(--bg-elevated); border:1px solid var(--border); border-radius:5px; padding:3px 7px;
  }
  button {
    background: var(--bg-elevated); border:1px solid var(--border); border-radius:5px;
    padding:3px 9px; cursor:pointer;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  /* ---------- layout ---------- */
  main {
    flex:1; display:grid; grid-template-columns: minmax(320px, 1fr) minmax(420px, 1.35fr);
    min-height:0;
  }
  section { display:flex; flex-direction:column; min-height:0; min-width:0; }
  #perfCol { border-right:1px solid var(--border); }
  .panelHead {
    display:flex; align-items:center; gap:8px; padding:7px 12px;
    background: var(--bg-secondary); border-bottom:1px solid var(--border); flex:0 0 auto;
  }
  .panelHead .title { font-weight:600; }
  .panelHead .spacer { flex:1; }
  .scroll { overflow:auto; flex:1; min-height:0; }
  /* ---------- metrics ---------- */
  .groupTitle {
    padding:7px 12px 3px; font-size:11px; text-transform:uppercase; letter-spacing:.6px;
    color: var(--text-secondary);
  }
  .metric {
    display:grid; grid-template-columns: 1fr auto auto; align-items:center; gap:10px;
    padding:4px 12px; border-bottom:1px solid var(--border);
  }
  .metric:hover { background: var(--bg-secondary); }
  .metric .name { font-family: var(--mono); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .metric .stat { font-family: var(--mono); font-size:11.5px; color:var(--text-secondary); white-space:nowrap; }
  .metric .stat b { color: var(--text-primary); font-weight:600; }
  .metric.warn .stat b { color: var(--warning); }
  .metric.err .stat b { color: var(--error); }
  .spark { display:block; }
  .spark rect { fill: var(--accent); opacity:.75; }
  .spark.warn rect { fill: var(--warning); }
  /* ---------- slow paths ---------- */
  .slow {
    display:grid; grid-template-columns: 1fr auto; gap:10px; padding:5px 12px;
    border-bottom:1px solid var(--border); font-family: var(--mono); font-size:11.5px;
  }
  .slow .dur { color: var(--warning); font-weight:600; }
  .slow .tid { color: var(--text-secondary); font-size:10.5px; }
  /* ---------- logs ---------- */
  #logToolbar { display:flex; align-items:center; gap:7px; padding:6px 10px;
    background: var(--bg-secondary); border-bottom:1px solid var(--border); flex-wrap:wrap; }
  #logToolbar .sep { width:1px; height:18px; background:var(--border); }
  .counts { font-size:11px; color:var(--text-secondary); font-family:var(--mono); }
  #logs { font-family: var(--mono); font-size:11.5px; }
  .logrow {
    display:grid; grid-template-columns: 74px 52px 120px 1fr; gap:8px;
    padding:2px 10px; border-bottom:1px solid rgba(0,0,0,.035); align-items:baseline;
  }
  .logrow:hover { background: var(--bg-secondary); }
  .logrow .t { color:var(--text-secondary); }
  .logrow .l { font-weight:600; }
  .logrow .c { color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .logrow .m { white-space:pre-wrap; word-break:break-word; }
  .logrow .fields { color:var(--text-secondary); }
  .lv-TRACE { color: var(--trace); } .lv-DEBUG { color: var(--debug); }
  .lv-INFO { color: var(--info); } .lv-WARN { color: var(--warning); }
  .lv-ERROR,.lv-FATAL { color: var(--error); font-weight:700; }
  .lv-AUDIT { color:#8A5CF6; } .lv-METRIC { color: var(--metric); }
  /* ---------- status bar ---------- */
  footer {
    display:flex; align-items:center; gap:14px; padding:0 12px; height:24px;
    background: var(--bg-secondary); border-top:1px solid var(--border);
    font-size:11.5px; color:var(--text-secondary); font-family: var(--mono); flex:0 0 auto;
  }
  footer .spacer { flex:1; }
  .empty { padding:18px 12px; color: var(--text-secondary); font-size:12px; }
</style>
</head>
<body>
<div id="app">
<header>
  <span class="logo">Nolanguage</span>
  <span class="badge">Dev Panel · monitor</span>
  <span class="badge" v-if="st.appVersion">v{{ st.appVersion }}</span>
  <span class="badge" v-if="st.arch">{{ st.arch }}<span v-if="st.os"> · {{ st.os }}</span></span>
  <span class="spacer"></span>
  <div class="conn">
    <span class="dot" :class="st.conn === 'on' ? 'on' : st.conn === 'off' ? 'off' : ''"></span>
    <span>{{ st.conn === 'on' ? 'connected' : st.conn === 'off' ? 'disconnected — retrying' : 'connecting…' }}</span>
  </div>
</header>

<main>
  <section id="perfCol">
    <div class="panelHead">
      <span class="title">Performance</span>
      <span class="spacer"></span>
      <span class="counts">{{ metricCount ? (metricCount + ' metrics · ' + st.perfTotal + ' records') : '' }}</span>
      <button @click="togglePausePerf()">{{ st.pausePerf ? 'resume' : 'pause' }}</button>
    </div>
    <div class="scroll" id="metrics">
      <div class="empty">Waiting for the first digest…</div>
      <template v-if="metricGroups.length">
        <template v-for="(g, gi) in metricGroups" :key="g.title">
          <div class="groupTitle">{{ g.title }}</div>
          <div class="metric" v-for="row in g.rows" :key="row.name" :class="{ warn: row.slow, err: row.bad }">
            <span class="name" :title="row.name">{{ row.name }}</span>
            <span class="stat">P50 <b>{{ row.p50.toFixed(1) }}</b> P95 <b>{{ row.p95.toFixed(1) }}</b> P99 {{ row.p99.toFixed(1) }} n={{ row.count }}</span>
            <spark-line :values="row.series" :warn="row.slow"></spark-line>
          </div>
        </template>
      </template>
    </div>
    <div class="panelHead">
      <span class="title">Slow paths</span>
      <span class="spacer"></span>
      <span class="counts" id="slowCount">{{ st.slow.length }}</span>
    </div>
    <div class="scroll" id="slow" style="flex:0 0 34%">
      <div class="empty">No slow path captured yet.</div>
      <div class="slow" v-for="s in slowRows" :key="s.key">
        <span>{{ s.label }} <span class="tid">trace {{ s.trace }}</span></span>
        <span class="dur">{{ s.durationMs.toFixed(1) }}ms</span>
      </div>
    </div>
  </section>

  <section>
    <div class="panelHead">
      <span class="title">Logs</span>
      <span class="spacer"></span>
      <span class="counts" id="logCount">{{ visibleLogs.length }} / {{ st.logs.length }}</span>
    </div>
    <div id="logToolbar">
      <label>level
        <select v-model="st.filterLevel" aria-label="Minimum log level">
          <option :value="0">TRACE</option>
          <option :value="1">DEBUG</option>
          <option :value="2">INFO</option>
          <option :value="3">WARN</option>
          <option :value="4">ERROR</option>
        </select>
      </label>
      <input type="text" v-model="st.filterComponents" placeholder="component filter (pyright,lsp)" size="22" @keydown="onFilterKeydown" />
      <input type="text" v-model="st.filterPattern" placeholder="message regex" size="18" @keydown="onFilterKeydown" />
      <button @click="applyFilter()">apply</button>
      <span class="sep"></span>
      <button @click="togglePauseLogs()">{{ st.pauseLogs ? 'resume' : 'pause' }}</button>
      <button id="clearLogs" @click="clearLogs()">clear</button>
      <span class="spacer" style="flex:1"></span>
    </div>
    <div class="scroll" id="logs">
      <div class="empty" v-if="!visibleLogs.length">No logs matching the current filter.</div>
      <div class="logrow" v-for="r in visibleLogs" :key="r.id">
        <span class="t">{{ clockOf(r.ts) }}</span>
        <span class="l" :class="'lv-' + levelName(r.level)">{{ levelName(r.level) }}</span>
        <span class="c" :title="r.component">{{ r.component }}</span>
        <span class="m">{{ r.message }}<span class="fields" v-if="r.fields"> {{ JSON.stringify(r.fields) }}</span><span class="lv-ERROR" v-if="r.errorMessage"> {{ r.errorType }}: {{ r.errorMessage }}</span><span class="fields" v-if="r.traceId"> #{{ shortId(r.traceId) }}</span></span>
      </div>
    </div>
    <div id="logFoot" style="padding:5px 10px;border-top:1px solid var(--border);background:var(--bg-secondary)">
      <span class="counts" id="levelCounts">
        <span v-for="c in levelCounts" :key="c.level" style="margin-right:8px;cursor:pointer" @click="setLevel(levelValue(c.level))">{{ c.level }} ({{ c.count }})</span>
      </span>
    </div>
  </section>
</main>

<footer>
  <span id="fClients">clients {{ st.clients }}</span>
  <span id="fTick">tick {{ st.tick }}</span>
  <span id="fPerf">perf {{ st.perfTotal }}</span>
  <span class="spacer"></span>
  <span id="fWs">ws://127.0.0.1:${port}/</span>
</footer>
</div>

<script>${vueRuntime}</script>
<script>${nlCoreSource}</script>
<script>${monitorAppSource}</script>
</body>
</html>`;
}
