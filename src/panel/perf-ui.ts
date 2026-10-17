/**
 * Kernel performance analysis UI — Vue 3 edition.
 *
 * A self-contained HTML page like the workspace and monitor: the vendored Vue
 * runtime, the shared `nl-core` helpers and the `perf-app` application are
 * inlined verbatim as text imports (`?raw`), so nothing is fetched over the
 * network and the packaged exe serves byte-identical output.
 *
 * Where `/monitor` is the live operational view (is it on fire right now),
 * this page is the analytical one: full metric summaries, per-subsystem
 * attribution, trend history and slow-path correlation.
 */
import vueRuntime from './vendor/vue.global.prod.js?raw';
import nlCoreSource from './assets/nl-core.js?raw';
import perfAppSource from './assets/perf-app.js?raw';

export function renderPerfHtml(port: number): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nolanguage · Kernel Performance</title>
<style>
  :root {
    --bg-primary:#FFFFFF; --bg-secondary:#F7F8FA; --bg-elevated:#FFFFFF;
    --border:#EBECF0; --text-primary:#1E1F22; --text-secondary:#6C707E;
    --accent:#3574F0; --success:#499C54; --warning:#D6A545; --error:#DB5C5C;
    --ok:#499C54; --warn:#D6A545; --bad:#DB5C5C;
    --mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { height:100%; margin:0; }
  body { background:var(--bg-primary); color:var(--text-primary); font:13px/1.45 var(--sans); overflow:hidden; }
  #app { display:flex; flex-direction:column; height:100%; }

  /* ---------- header ---------- */
  header { display:flex; align-items:center; gap:12px; padding:8px 14px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); flex:0 0 auto; }
  header .logo { font-weight:600; letter-spacing:.2px; }
  .badge { font-size:11px; padding:1px 7px; border-radius:9px; border:1px solid var(--border);
    color:var(--text-secondary); background:var(--bg-elevated); }
  header .spacer { flex:1; }
  .conn { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-secondary); }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--warning); }
  .dot.on { background:var(--success); }
  .dot.off { background:var(--error); }
  .nav { display:flex; gap:2px; }
  .nav a { font-size:12px; color:var(--text-secondary); text-decoration:none; padding:2px 8px;
    border-radius:5px; border:1px solid transparent; }
  .nav a:hover { color:var(--accent); border-color:var(--border); background:var(--bg-elevated); }
  .nav a.on { color:var(--accent); border-color:var(--border); background:var(--bg-elevated); font-weight:600; }

  /* ---------- kpi strip ---------- */
  #kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));
    gap:1px; background:var(--border); border-bottom:1px solid var(--border); flex:0 0 auto; }
  .kpi { background:var(--bg-secondary); padding:8px 13px; min-width:0; }
  .kpi .k { font-size:10.5px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-secondary); }
  .kpi .v { font-family:var(--mono); font-size:19px; font-weight:600; margin-top:1px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .kpi .v.warn { color:var(--warn); } .kpi .v.bad { color:var(--bad); }
  .kpi .s { font-size:11px; color:var(--text-secondary); font-family:var(--mono);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* ---------- layout ---------- */
  main { flex:1; display:grid; grid-template-columns:250px minmax(0,1fr) 320px; min-height:0; }
  section { display:flex; flex-direction:column; min-height:0; min-width:0; }
  #scopeCol { border-right:1px solid var(--border); }
  #mainCol { border-right:1px solid var(--border); }
  .panelHead { display:flex; align-items:center; gap:8px; padding:7px 12px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); flex:0 0 auto; }
  .panelHead .title { font-weight:600; }
  .panelHead .spacer { flex:1; }
  .scroll { overflow:auto; flex:1; min-height:0; }
  button, select, input { font:inherit; color:var(--text-primary); }
  button, select, input[type=text] { background:var(--bg-elevated); border:1px solid var(--border);
    border-radius:5px; padding:3px 7px; }
  button { cursor:pointer; }
  button:hover { border-color:var(--accent); color:var(--accent); }
  input[type=text] { width:100%; }

  /* ---------- scope breakdown ---------- */
  .scope { padding:7px 12px; border-bottom:1px solid var(--border); cursor:pointer; }
  .scope:hover { background:var(--bg-secondary); }
  .scope.on { background:var(--bg-secondary); box-shadow:inset 2px 0 0 var(--accent); }
  .scope .top { display:flex; align-items:baseline; gap:8px; }
  .scope .name { font-weight:600; font-size:12px; flex:1; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  .scope .p95 { font-family:var(--mono); font-size:12px; }
  .scope .p95.ok { color:var(--ok); } .scope .p95.warn { color:var(--warn); } .scope .p95.bad { color:var(--bad); }
  .scope .sub { font-size:10.5px; color:var(--text-secondary); font-family:var(--mono); margin-top:1px; }
  .scope .bar { height:3px; border-radius:2px; background:var(--border); margin-top:4px; overflow:hidden; }
  .scope .bar i { display:block; height:100%; }
  .scope .bar i.ok { background:var(--ok); } .scope .bar i.warn { background:var(--warn); } .scope .bar i.bad { background:var(--bad); }

  /* ---------- metric table ---------- */
  #metricHead, .mrow { display:grid;
    grid-template-columns:minmax(160px,1.7fr) 62px 62px 62px 62px 62px 62px 90px;
    gap:6px; align-items:center; padding:4px 12px; }
  #metricHead { position:sticky; top:0; z-index:2; background:var(--bg-secondary);
    border-bottom:1px solid var(--border); font-size:10.5px; text-transform:uppercase;
    letter-spacing:.5px; color:var(--text-secondary); }
  #metricHead span { cursor:pointer; user-select:none; white-space:nowrap; }
  #metricHead span:hover { color:var(--accent); }
  #metricHead span.num, .mrow span.num { text-align:right; }
  .mrow { border-bottom:1px solid var(--border); cursor:pointer; }
  .mrow:hover { background:var(--bg-secondary); }
  .mrow.on { background:var(--bg-secondary); box-shadow:inset 2px 0 0 var(--accent); }
  .mrow .name { font-family:var(--mono); font-size:12px; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; display:flex; align-items:center; gap:6px; }
  .mrow .name b { font-weight:500; overflow:hidden; text-overflow:ellipsis; }
  .chip { font-size:9.5px; padding:0 5px; border-radius:8px; border:1px solid var(--border);
    color:var(--text-secondary); background:var(--bg-elevated); flex:0 0 auto; text-transform:uppercase;
    letter-spacing:.4px; }
  .mrow .n { font-family:var(--mono); font-size:11.5px; text-align:right; color:var(--text-secondary); }
  .mrow .n.lead { color:var(--text-primary); font-weight:600; }
  .mrow .n.ok { color:var(--ok); } .mrow .n.warn { color:var(--warn); } .mrow .n.bad { color:var(--bad); }
  .spark rect { fill:var(--accent); opacity:.75; }
  .spark.ok rect { fill:var(--ok); } .spark.warn rect { fill:var(--warn); } .spark.bad rect { fill:var(--bad); }

  /* ---------- trend detail ---------- */
  #detail { border-top:1px solid var(--border); flex:0 0 auto; background:var(--bg-primary); }
  #detail .head { display:flex; align-items:baseline; gap:10px; padding:7px 12px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); }
  #detail .head .t { font-family:var(--mono); font-weight:600; font-size:12px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #detail .head .spacer { flex:1; }
  #detail .head .hint { font-size:11px; color:var(--text-secondary); }
  .trendWrap { padding:8px 12px 4px; }
  .trend { display:block; width:100%; height:auto; }
  .trend rect { fill:var(--accent); opacity:.55; }
  .trend .grid { stroke:var(--border); stroke-width:1; }
  .trend .axis { stroke:var(--border); stroke-width:1; }
  .trend .trendLine { fill:none; stroke:var(--accent); stroke-width:1.5; opacity:.9; }
  .trendMeta { display:flex; gap:14px; font-size:11px; color:var(--text-secondary);
    font-family:var(--mono); padding-top:3px; }
  .trendMeta .peak { color:var(--warn); }
  .empty { padding:18px 12px; color:var(--text-secondary); font-size:12px; }

  /* ---------- right column ---------- */
  .miniHead { display:flex; align-items:center; gap:6px; padding:6px 12px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); flex:0 0 auto; }
  .miniHead .t { font-weight:600; font-size:12px; }
  .miniHead .spacer { flex:1; }
  .miniHead .c { font-family:var(--mono); font-size:11px; color:var(--text-secondary); }
  .mix { padding:6px 12px; border-bottom:1px solid var(--border); }
  .mix .r { display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:11px; padding:1.5px 0; }
  .mix .r .l { flex:0 0 78px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mix .r .b { flex:1; height:6px; border-radius:3px; background:var(--border); overflow:hidden; }
  .mix .r .b i { display:block; height:100%; background:var(--accent); opacity:.8; }
  .mix .r .v { flex:0 0 42px; text-align:right; color:var(--text-secondary); }
  .slow { display:grid; grid-template-columns:1fr auto; gap:8px; padding:4px 12px;
    border-bottom:1px solid var(--border); font-family:var(--mono); font-size:11px; }
  .slow:hover { background:var(--bg-secondary); }
  .slow .tid { color:var(--text-secondary); font-size:10px; }
  .slow .lbl { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .slow .dur.ok { color:var(--text-secondary); } .slow .dur.warn { color:var(--warn); font-weight:600; }
  .slow .dur.bad { color:var(--bad); font-weight:700; }
  .hist { padding:6px 12px 10px; }
  .hist .r { display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:11px; padding:1.5px 0; }
  .hist .r .l { flex:0 0 66px; color:var(--text-secondary); }
  .hist .r .b { flex:1; height:8px; border-radius:2px; background:var(--border); overflow:hidden; }
  .hist .r .b i { display:block; height:100%; background:var(--warn); }
  .hist .r .v { flex:0 0 34px; text-align:right; }

  /* ---------- footer ---------- */
  footer { display:flex; align-items:center; gap:14px; padding:0 12px; height:24px;
    background:var(--bg-secondary); border-top:1px solid var(--border); font-size:11.5px;
    color:var(--text-secondary); font-family:var(--mono); flex:0 0 auto; }
  footer .spacer { flex:1; }
</style>
</head>
<body>
<div id="app">
<header>
  <span class="logo">Nolanguage</span>
  <span class="badge">Kernel Performance</span>
  <span class="badge" v-if="st.appVersion">v{{ st.appVersion }}</span>
  <span class="badge" v-if="st.arch">{{ st.arch }}<span v-if="st.os"> · {{ st.os }}</span></span>
  <nav class="nav">
    <a href="/">workspace</a>
    <a href="/monitor">monitor</a>
    <a href="/perf" class="on">perf</a>
    <a href="/extensions">extensions</a>
  </nav>
  <span class="spacer"></span>
  <div class="conn">
    <span class="dot" :class="st.conn === 'on' ? 'on' : st.conn === 'off' ? 'off' : ''"></span>
    <span>{{ st.conn === 'on' ? 'connected' : st.conn === 'off' ? 'disconnected — retrying' : 'connecting…' }}</span>
  </div>
</header>

<div id="kpis">
  <div class="kpi">
    <div class="k">metrics tracked</div>
    <div class="v">{{ totals.metrics }}</div>
    <div class="s">{{ totals.samples }} samples in window</div>
  </div>
  <div class="kpi">
    <div class="k">worst p95 (latency)</div>
    <div class="v" :class="totals.worstP95 >= 200 ? 'bad' : totals.worstP95 >= 50 ? 'warn' : ''">{{ fmt(totals.worstP95) }}<span style="font-size:12px">ms</span></div>
    <div class="s" :title="totals.worstName">{{ totals.worstName || '—' }}</div>
  </div>
  <div class="kpi">
    <div class="k">hot metrics (p95 ≥ 200ms)</div>
    <div class="v" :class="totals.hot ? 'bad' : ''">{{ totals.hot }}</div>
    <div class="s">of {{ totals.durations }} timed</div>
  </div>
  <div class="kpi">
    <div class="k">perf records</div>
    <div class="v">{{ st.perfTotal }}</div>
    <div class="s">in the last digest window</div>
  </div>
  <div class="kpi">
    <div class="k">slow paths captured</div>
    <div class="v" :class="st.slow.length ? 'warn' : ''">{{ st.slow.length }}</div>
    <div class="s">crossing the slow threshold</div>
  </div>
  <div class="kpi">
    <div class="k">digest</div>
    <div class="v">{{ st.tick }}</div>
    <div class="s">{{ st.pushIntervalMs }}ms · {{ st.clients }} client(s)</div>
  </div>
</div>

<main>
  <!-- ---------- left: subsystem attribution ---------- -->
  <section id="scopeCol">
    <div class="panelHead">
      <span class="title">By subsystem</span>
      <span class="spacer"></span>
      <span class="c" style="font-family:var(--mono);font-size:11px;color:var(--text-secondary)">{{ scopeBreakdown.length }}</span>
    </div>
    <div class="scroll">
      <div class="scope" :class="{ on: st.scopeFilter === 'all' }" @click="st.scopeFilter = 'all'">
        <div class="top"><span class="name">All subsystems</span><span class="p95">{{ fmt(totals.worstP95) }}ms</span></div>
        <div class="sub">{{ totals.metrics }} metrics · {{ totals.samples }} samples</div>
      </div>
      <div class="scope" v-for="g in scopeBreakdown" :key="g.id" :class="{ on: st.scopeFilter === g.id }" @click="st.scopeFilter = g.id">
        <div class="top">
          <span class="name">{{ g.title }}</span>
          <span class="p95" :class="g.band" v-if="g.durations">{{ fmt(g.worstP95) }}ms</span>
          <span class="p95" v-else style="color:var(--text-secondary)">—</span>
        </div>
        <div class="sub">{{ g.metrics }} metrics · {{ g.records }} samples</div>
        <div class="bar"><i :class="g.band" :style="{ width: (g.ratio * 100).toFixed(1) + '%' }"></i></div>
      </div>
      <div class="empty" v-if="!scopeBreakdown.length">Waiting for the first digest…</div>
    </div>
  </section>

  <!-- ---------- centre: metric table + trend ---------- -->
  <section id="mainCol">
    <div class="panelHead">
      <span class="title">Metrics</span>
      <span class="spacer"></span>
      <span style="font-family:var(--mono);font-size:11px;color:var(--text-secondary)">{{ visibleRows.length }} / {{ rows.length }}</span>
      <button @click="togglePause()">{{ st.paused ? 'resume' : 'pause' }}</button>
    </div>
    <div id="metricHead">
      <span @click="sortBy('name')">metric{{ arrow('name') }}</span>
      <span class="num" @click="sortBy('count')">count{{ arrow('count') }}</span>
      <span class="num" @click="sortBy('min')">min{{ arrow('min') }}</span>
      <span class="num" @click="sortBy('avg')">avg{{ arrow('avg') }}</span>
      <span class="num" @click="sortBy('p50')">p50{{ arrow('p50') }}</span>
      <span class="num" @click="sortBy('p95')">p95{{ arrow('p95') }}</span>
      <span class="num" @click="sortBy('max')">max{{ arrow('max') }}</span>
      <span style="cursor:default">trend (60 digests)</span>
    </div>
    <div class="scroll" id="metricBody">
      <div class="empty" v-if="!visibleRows.length">No metrics in this subsystem yet.</div>
      <div class="mrow" v-for="r in visibleRows" :key="r.name" :class="{ on: st.selected === r.name }" @click="select(r.name)">
        <span class="name" :title="r.name"><span class="chip">{{ r.scope.id }}</span><b>{{ r.name }}</b></span>
        <span class="n">{{ r.count }}</span>
        <span class="n">{{ fmtCell(r.min, r.unit) }}</span>
        <span class="n lead" :class="r.band">{{ fmtCell(r.avg, r.unit) }}</span>
        <span class="n" :class="r.band">{{ fmtCell(r.p50, r.unit) }}</span>
        <span class="n" :class="r.band">{{ fmtCell(r.p95, r.unit) }}</span>
        <span class="n">{{ fmtCell(r.max, r.unit) }}</span>
        <spark-line :values="r.series" :band="r.band"></spark-line>
      </div>
    </div>
    <div id="detail">
      <div class="head">
        <span class="t">{{ selectedRow ? selectedRow.name : 'no metric selected' }}</span>
        <span class="badge" v-if="selectedRow">{{ selectedRow.scope.title }}</span>
        <span class="spacer"></span>
        <span class="hint" v-if="selectedRow">count {{ selectedRow.count }} · avg {{ fmtCell(selectedRow.avg, selectedRow.unit) }} · p50 {{ fmtCell(selectedRow.p50, selectedRow.unit) }} · p95 {{ fmtCell(selectedRow.p95, selectedRow.unit) }} · p99 {{ fmtCell(selectedRow.p99, selectedRow.unit) }} · max {{ fmtCell(selectedRow.max, selectedRow.unit) }}</span>
        <span class="hint" v-else>select a metric row to plot its history</span>
      </div>
      <div v-if="selectedRow">
        <trend-chart :values="selectedRow.series" :p95="selectedRow.p95" :unit="selectedRow.unit"></trend-chart>
      </div>
      <div class="empty" v-else>Each row plots the average latency of the last 60 digests, with a p95 marker.</div>
    </div>
  </section>

  <!-- ---------- right: slow paths + record mix ---------- -->
  <section>
    <div class="miniHead">
      <span class="t">Slow paths</span>
      <span class="spacer"></span>
      <button @click="clearSlow()">clear</button>
    </div>
    <div style="padding:6px 12px;border-bottom:1px solid var(--border);background:var(--bg-primary)">
      <input type="text" v-model="st.slowFilter" placeholder="filter by command or trace id" />
    </div>
    <div class="hist">
      <div class="r" v-for="b in slowHistogram" :key="b.label">
        <span class="l">{{ b.label }}</span>
        <span class="b"><i :style="{ width: (b.ratio * 100).toFixed(1) + '%' }"></i></span>
        <span class="v">{{ b.count }}</span>
      </div>
    </div>
    <div class="scroll" style="flex:1 1 auto;border-top:1px solid var(--border)">
      <div class="empty" v-if="!slowRows.length">No slow path captured yet.</div>
      <div class="slow" v-for="s in slowRows" :key="s.key">
        <span class="lbl"><span :title="s.traceId">{{ s.label }}</span> <span class="tid">{{ clockOf(s.at) }} · #{{ s.trace }}</span></span>
        <span class="dur" :class="s.band">{{ s.durationMs.toFixed(1) }}ms</span>
      </div>
    </div>
    <div class="miniHead">
      <span class="t">Record mix</span>
      <span class="spacer"></span>
      <span class="c">{{ st.perfTotal }}</span>
    </div>
    <div class="mix">
      <div class="r" v-for="t in typeMix" :key="t.type">
        <span class="l" :title="t.type">{{ t.type }}</span>
        <span class="b"><i :style="{ width: (t.ratio * 100).toFixed(1) + '%' }"></i></span>
        <span class="v">{{ t.count }}</span>
      </div>
      <div class="empty" v-if="!typeMix.length" style="padding:6px 0">No perf records yet.</div>
    </div>
  </section>
</main>

<footer>
  <span>clients {{ st.clients }}</span>
  <span>tick {{ st.tick }}</span>
  <span>metrics {{ totals.metrics }}</span>
  <span>{{ st.paused ? 'PAUSED' : 'live' }}</span>
  <span class="spacer"></span>
  <span>ws://127.0.0.1:${port}/</span>
</footer>
</div>

<script>${vueRuntime}</script>
<script>${nlCoreSource}</script>
<script>${perfAppSource}</script>
</body>
</html>`;
}
