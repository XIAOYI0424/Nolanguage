/**
 * User-code performance UI — Vue 3 edition.
 *
 * A self-contained page (like /perf) that renders a `ProfileResult`: a hotspot
 * table plus an interactive SVG flamegraph. The vendored Vue runtime, `nl-core`
 * and `profile-app.js` are inlined verbatim as `?raw` imports so the packaged
 * exe serves byte-identical output with no network.
 *
 * This is the *user's code* profile (Stage 10), deliberately separate from
 * `/perf`, which measures the kernel itself.
 */
import vueRuntime from './vendor/vue.global.prod.js?raw';
import nlCoreSource from './assets/nl-core.js?raw';
import profileAppSource from './assets/profile-app.js?raw';

export function renderProfileHtml(port: number): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nolanguage · Profile</title>
<style>
  :root {
    --bg-primary:#FFFFFF; --bg-secondary:#F7F8FA; --bg-elevated:#FFFFFF;
    --border:#EBECF0; --text-primary:#1E1F22; --text-secondary:#6C707E;
    --accent:#3574F0; --success:#499C54; --warning:#D6A545; --error:#DB5C5C;
    --mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { height:100%; margin:0; }
  body { background:var(--bg-primary); color:var(--text-primary); font:13px/1.45 var(--sans); overflow:hidden; }
  #app { display:flex; flex-direction:column; height:100%; }

  header { display:flex; align-items:center; gap:12px; padding:8px 14px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); flex:0 0 auto; }
  header .logo { font-weight:600; letter-spacing:.2px; }
  .badge { font-size:11px; padding:1px 7px; border-radius:9px; border:1px solid var(--border);
    color:var(--text-secondary); background:var(--bg-elevated); }
  header .spacer { flex:1; }
  .conn { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-secondary); }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--warning); }
  .dot.on { background:var(--success); } .dot.off { background:var(--error); }
  .nav { display:flex; gap:2px; }
  .nav a { font-size:12px; color:var(--text-secondary); text-decoration:none; padding:2px 8px;
    border-radius:5px; border:1px solid transparent; }
  .nav a:hover { color:var(--accent); border-color:var(--border); background:var(--bg-elevated); }
  .nav a.on { color:var(--accent); border-color:var(--border); background:var(--bg-elevated); font-weight:600; }

  .toolbar { display:flex; align-items:center; gap:10px; padding:8px 14px;
    background:var(--bg-primary); border-bottom:1px solid var(--border); flex:0 0 auto; }
  .toolbar label { display:flex; align-items:center; gap:5px; font-size:12px; color:var(--text-secondary); }
  .toolbar .spacer { flex:1; }
  button, select, input { font:inherit; color:var(--text-primary); background:var(--bg-elevated);
    border:1px solid var(--border); border-radius:5px; padding:3px 8px; }
  button { cursor:pointer; }
  button:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
  button:disabled { opacity:.55; cursor:default; }

  .err { margin:0 14px; padding:6px 10px; background:#FCEDED; color:var(--error);
    border:1px solid #F3C9C9; border-radius:5px; font-size:12px; }

  main { flex:1; display:flex; flex-direction:column; min-height:0; }
  section { display:flex; flex-direction:column; min-height:0; min-width:0; }
  .flameWrap { flex:1.25; border-bottom:1px solid var(--border); }
  .hotWrap { flex:1; border-bottom:1px solid var(--border); }
  .outWrap { flex:0 0 auto; max-height:30%; }
  .panelHead { display:flex; align-items:center; gap:8px; padding:6px 12px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); flex:0 0 auto; }
  .panelHead .title { font-weight:600; }
  .panelHead .spacer { flex:1; }
  .panelHead .c { font-family:var(--mono); font-size:11px; color:var(--text-secondary); }
  .scroll { overflow:auto; flex:1; min-height:0; }
  .flame { padding:4px; }
  .empty { padding:18px 12px; color:var(--text-secondary); font-size:12px; }

  table.hot { width:100%; border-collapse:collapse; font-size:12px; }
  table.hot th { position:sticky; top:0; background:var(--bg-secondary); text-align:left;
    font-size:10.5px; text-transform:uppercase; letter-spacing:.5px; color:var(--text-secondary);
    padding:5px 12px; border-bottom:1px solid var(--border); }
  table.hot td { padding:4px 12px; border-bottom:1px solid var(--border); font-family:var(--mono); }
  table.hot tr:hover { background:var(--bg-secondary); }
  table.hot td.loc { color:var(--text-secondary); }
  pre.out { margin:0; padding:8px 12px; font-family:var(--mono); font-size:11.5px; white-space:pre-wrap; }
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
  <span class="badge">User-code Profile</span>
  <nav class="nav">
    <a href="/">workspace</a>
    <a href="/monitor">monitor</a>
    <a href="/perf">perf</a>
    <a href="/profile" class="on">profile</a>
    <a href="/extensions">extensions</a>
  </nav>
  <span class="spacer"></span>
  <div class="conn">
    <span class="dot" :class="conn === 'on' ? 'on' : conn === 'off' ? 'off' : ''"></span>
    <span>{{ conn === 'on' ? 'connected' : conn === 'off' ? 'disconnected' : 'connecting…' }}</span>
  </div>
</header>

<div class="toolbar">
  <label>language
    <select v-model="lang">
      <option v-for="c in caps" :value="c.id">{{ c.displayName }}{{ c.available ? '' : ' (unavailable)' }}</option>
    </select>
  </label>
  <label>topN
    <input type="number" v-model.number="topN" min="5" max="100" style="width:62px" />
  </label>
  <button @click="run()" :disabled="running">{{ running ? 'profiling…' : 'Run profile' }}</button>
  <button @click="resetZoom()" v-if="zoom">Reset zoom</button>
  <span class="spacer"></span>
  <span class="badge" v-if="zoom">zoomed: {{ zoom.name }}</span>
</div>

<div class="err" v-if="error">{{ error }}</div>

<main>
  <section class="flameWrap">
    <div class="panelHead">
      <span class="title">Flamegraph</span>
      <span class="spacer"></span>
      <span class="c" v-if="hasFlame">{{ totalMs.toFixed(1) }}ms total · click a frame to zoom</span>
    </div>
    <div class="scroll flame" v-html="flameSvg" @click="onFlameClick"></div>
    <div class="empty" v-if="!hasFlame">No call tree yet — click “Run profile”, or use the IDE “Tools → Profile current file” action.</div>
  </section>

  <section class="hotWrap">
    <div class="panelHead">
      <span class="title">Hotspots</span>
      <span class="spacer"></span>
      <span class="c" v-if="result">{{ result.source }} · {{ result.sampleCount }} fns · {{ result.wallMs }}ms wall</span>
    </div>
    <div class="scroll">
      <table class="hot">
        <thead><tr><th>function</th><th>location</th><th>calls</th><th>self ms</th><th>total ms</th></tr></thead>
        <tbody>
          <tr v-for="h in (result ? result.hotspots : [])" :key="h.name + h.line" @click="focusHotspot(h.name)" style="cursor:pointer">
            <td>{{ h.name }}</td>
            <td class="loc">{{ h.file }}:{{ h.line }}</td>
            <td>{{ h.calls }}</td>
            <td>{{ h.tottimeMs.toFixed(2) }}</td>
            <td>{{ h.cumtimeMs.toFixed(2) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="empty" v-if="result && !result.hotspots.length">No hotspots (or profiling was skipped).</div>
    </div>
  </section>

  <section class="outWrap" v-if="result && (result.stdout || result.stderr)">
    <div class="panelHead"><span class="title">Output</span></div>
    <pre class="out">{{ result.stdout }}{{ result.stderr }}</pre>
  </section>
</main>

<footer>
  <span>ws://127.0.0.1:${port}/</span>
  <span class="spacer"></span>
  <span>flamegraph · Stage 10</span>
</footer>
</div>

<script>${vueRuntime}</script>
<script>${nlCoreSource}</script>
<script>${profileAppSource}</script>
<script>Vue.createApp(window.ProfileApp).mount('#app');</script>
</body>
</html>`;
}
