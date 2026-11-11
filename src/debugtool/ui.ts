/**
 * The observatory page — one self-contained HTML document.
 *
 * Same shape as the other pages in this repo (`/perf`, `/monitor`): the vendored
 * Vue runtime and the app source are imported as text and inlined, so the page
 * works with no network, no bundler and no CDN, and the packaged build serves
 * byte-identical output.
 *
 * Dark by default, unlike the panel pages: this is a standalone developer tool
 * that people keep open next to their editor, not a page inside the IDE shell.
 */
import vueRuntime from '../vendor/vue.global.prod.js?raw';
import appSource from './assets/debug-app.js?raw';

export interface DebugPageOptions {
  port: number;
  /** Shown in the header; the program being observed. */
  target: string;
  lang: string;
  /** `python 3.13.14`, when known. */
  runtime?: string;
  /**
   * Base URL of a running Nolanguage engine, when one answered `/health`.
   *
   * Absent is the normal case for a standalone tool, and the page then shows no
   * link rather than one that 404s.
   */
  engineUrl?: string;
}

export function renderDebugHtml(opts: DebugPageOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nolanguage Debug · ${escapeHtml(opts.target)}</title>
<style>
  :root {
    --bg:#17181C; --bg2:#1E1F24; --bg3:#25272E; --line:#2E3138;
    --fg:#E6E8EC; --fg2:#9DA3AE; --fg3:#6C727E;
    --accent:#4C9AFF; --ok:#3FB950; --warn:#D29922; --bad:#F85149; --purple:#B392F0;
    --mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  * { box-sizing:border-box; }
  html, body { height:100%; margin:0; }
  body { background:var(--bg); color:var(--fg); font:13px/1.5 var(--sans); overflow:hidden; }
  #app { display:flex; flex-direction:column; height:100%; }

  header { display:flex; align-items:center; gap:10px; padding:8px 14px;
    background:var(--bg2); border-bottom:1px solid var(--line); flex:0 0 auto; }
  header .logo { font-weight:600; letter-spacing:.2px; }
  header .logo span { color:var(--accent); }
  .badge { font-size:11px; padding:1px 7px; border-radius:9px; border:1px solid var(--line);
    color:var(--fg2); background:var(--bg3); white-space:nowrap; }
  .badge.on { color:var(--ok); border-color:#1F4429; }
  .badge.warn { color:var(--warn); border-color:#4A3A12; }
  .badge.bad { color:var(--bad); border-color:#4E2320; }
  header .spacer { flex:1; }
  header .stat { font-family:var(--mono); font-size:11px; color:var(--fg3); }
  header .stat b { color:var(--fg2); font-weight:500; }

  main { display:grid; grid-template-columns:300px minmax(320px, 1fr) minmax(340px, 1.1fr);
    gap:1px; background:var(--line); flex:1 1 auto; min-height:0; }
  section { background:var(--bg); display:flex; flex-direction:column; min-width:0; min-height:0; }
  .head { display:flex; align-items:center; gap:8px; padding:7px 11px; background:var(--bg2);
    border-bottom:1px solid var(--line); flex:0 0 auto; }
  .head .t { font-size:11px; text-transform:uppercase; letter-spacing:.7px; color:var(--fg2); font-weight:600; }
  .head .spacer { flex:1; }
  .body { flex:1 1 auto; overflow:auto; min-height:0; }

  /* ---- watches ---- */
  .watchAdd { display:flex; gap:6px; padding:7px 9px; border-bottom:1px solid var(--line); }
  .watchNote { padding:0 10px 6px; font-size:10.5px; color:var(--fg3); border-bottom:1px solid var(--line); }
  input[type=text] { flex:1; min-width:0; background:var(--bg3); border:1px solid var(--line);
    color:var(--fg); border-radius:5px; padding:3px 7px; font-family:var(--mono); font-size:12px; }
  input[type=text]:focus { outline:none; border-color:var(--accent); }
  button { background:var(--bg3); border:1px solid var(--line); color:var(--fg2);
    border-radius:5px; padding:2px 8px; font-size:11px; cursor:pointer; font-family:var(--sans); }
  button:hover:not(:disabled) { color:var(--fg); border-color:var(--fg3); }
  button:disabled { opacity:.45; cursor:default; }
  button.primary { color:var(--accent); border-color:#243B5C; }
  .w { display:flex; align-items:baseline; gap:7px; padding:5px 10px; border-bottom:1px solid var(--line); }
  .w .e { font-family:var(--mono); font-size:11.5px; color:var(--purple); white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; flex:0 0 auto; max-width:46%; }
  .w .v { font-family:var(--mono); font-size:11.5px; color:var(--fg); flex:1; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  .w .v.err { color:var(--bad); }
  .w .x { color:var(--fg3); cursor:pointer; font-size:12px; }
  .w .x:hover { color:var(--bad); }
  .empty { padding:14px 12px; color:var(--fg3); font-size:12px; }

  /* ---- stacks ---- */
  .hs { display:grid; grid-template-columns:1fr 52px 54px; gap:6px; padding:6px 11px;
    border-bottom:1px solid var(--line); cursor:pointer; align-items:center; }
  .hs:hover { background:var(--bg2); }
  .hs.on { background:#1B2333; }
  .hs .name { font-family:var(--mono); font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .hs .name i { color:var(--fg3); font-style:normal; }
  .hs .bar { height:4px; background:var(--bg3); border-radius:2px; overflow:hidden; margin-top:3px; }
  .hs .bar b { display:block; height:100%; background:var(--accent); }
  .hs.stalled .bar b { background:var(--warn); }
  .hs .pct { font-family:var(--mono); font-size:11.5px; color:var(--fg2); text-align:right; }
  .hs .hits { font-family:var(--mono); font-size:11px; color:var(--fg3); text-align:right; }
  .stalls { padding:8px 11px; border-top:1px solid var(--line); }
  .stalls .row { display:flex; gap:8px; font-family:var(--mono); font-size:11px; color:var(--fg2); padding:2px 0; }
  .stalls .row b { color:var(--warn); font-weight:500; }

  /* ---- inspector ---- */
  .tree { padding:4px 6px 12px; font-family:var(--mono); font-size:12px; }
  .tn { padding-left:13px; position:relative; }
  .tn > .line { display:flex; align-items:baseline; gap:5px; padding:1px 0; white-space:nowrap; }
  .tn .tw { position:absolute; left:2px; color:var(--fg3); cursor:pointer; user-select:none; width:11px; }
  .tn .k { color:var(--fg2); }
  .tn .k.cycle { color:var(--warn); }
  .tn .ty { color:var(--fg3); font-size:10.5px; }
  .tn .s { color:#9ECBFF; }
  .tn .n { color:#79C0FF; }
  .tn .b { color:var(--purple); }
  .tn .none { color:var(--fg3); }
  .tn .tr { color:var(--warn); font-size:11px; }
  .tn .more { color:var(--fg3); font-size:11px; font-style:italic; }

  /* ---- diff ---- */
  .df { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 8px; padding:5px 11px;
    border-bottom:1px solid var(--line); font-family:var(--mono); font-size:11.5px; }
  .df .p { color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .df .k { font-size:10px; padding:0 5px; border-radius:7px; border:1px solid var(--line); color:var(--fg2); }
  .df.added .k { color:var(--ok); border-color:#1F4429; }
  .df.removed .k { color:var(--bad); border-color:#4E2320; }
  .df.changed .k { color:var(--warn); border-color:#4A3A12; }
  .df.unavailable .k { color:var(--fg3); }
  .df .v { grid-column:1 / -1; color:var(--fg2); font-size:11px; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  .df .v s { color:var(--bad); text-decoration:line-through; }
  .df .v b { color:var(--ok); font-weight:500; }
  .df .v i { color:var(--fg3); font-style:normal; }
  .replayNote { padding:6px 11px; font-size:10.5px; color:var(--warn); border-bottom:1px solid var(--line); }

  footer { display:flex; align-items:center; gap:14px; padding:4px 12px; background:var(--bg2);
    border-top:1px solid var(--line); font-family:var(--mono); font-size:11px; color:var(--fg3); flex:0 0 auto; }
  footer .spacer { flex:1; }
  footer b { color:var(--fg2); font-weight:500; }
  .pill { padding:0 6px; border-radius:8px; border:1px solid var(--line); }
  .perfLink { color:var(--accent); text-decoration:none; border-bottom:1px dotted var(--accent); }
  .perfLink:hover { color:var(--fg); }
</style>
</head>
<body>
<div id="app">
  <header>
    <span class="logo">Nolanguage <span>Debug</span></span>
    <span class="badge">{{ st.view.target || 'waiting for agent' }}</span>
    <span class="badge">{{ st.view.lang || '—' }}</span>
    <span class="badge" v-if="st.view.agentVersion">agent {{ st.view.agentVersion }}</span>
    <span class="spacer"></span>
    <span class="stat">sampling <b>{{ hzText }}</b></span>
    <span class="stat">samples <b>{{ st.view.samples || 0 }}</b></span>
    <span class="stat" v-if="st.view.dropped">dropped <b>{{ st.view.dropped }}</b></span>
    <span class="stat" v-if="st.view.oversized" title="values refused for exceeding the wire ceiling">oversized <b>{{ st.view.oversized }}</b></span>
    <span class="badge warn" v-if="st.view.replay" title="playing a recording, not a live process">replay {{ replayPct }}</span>
    <button :class="{ primary: st.paused }" @click="togglePause()">{{ st.paused ? 'resume' : 'pause' }}</button>
    <span class="badge" :class="stateClass">{{ stateText }}</span>
  </header>

  <main>
    <!-- watches + exceptions -->
    <section>
      <div class="head"><span class="t">Watch</span><span class="spacer"></span>
        <button @click="refresh()" title="Ask the agent for the current locals">snapshot</button>
      </div>
      <div class="watchAdd">
        <input type="text" v-model="st.draft" placeholder="order.items[0].price" @keydown.enter="addWatch()"
               spellcheck="false" :disabled="!canWatch" />
        <button class="primary" @click="addWatch()" :disabled="!canWatch">add</button>
      </div>
      <div class="watchNote" v-if="!watchBlockedReason">表达式在目标进程里求值（相当于 eval），写副作用就会真的产生副作用。</div>
      <div class="replayNote" v-else>{{ watchBlockedReason }}</div>
      <div class="body">
        <div class="w" v-for="w in st.view.watches" :key="w.expr">
          <span class="e" :title="w.expr">{{ w.expr }}</span>
          <span class="v" :class="{ err: !w.ok }">{{ w.ok ? summary(w.value) : w.error }}</span>
          <span class="x" @click="removeWatch(w.expr)" title="remove">×</span>
        </div>
        <div class="empty" v-if="!st.view.watches || !st.view.watches.length">
          No expressions yet. Type one above — it is evaluated in the target's
          innermost frame, so self.items works while it runs.
        </div>
      </div>
      <div class="head" v-if="st.view.exceptions && st.view.exceptions.length">
        <span class="t">Exceptions</span><span class="spacer"></span>
        <span class="badge bad">{{ st.view.exceptions.length }}</span>
      </div>
      <div class="body" v-if="st.view.exceptions && st.view.exceptions.length" style="max-height:120px">
        <div class="w" v-for="(e, i) in st.view.exceptions" :key="i">
          <span class="e">{{ e.type }}</span>
          <span class="v err" :title="e.message">{{ e.message }}</span>
        </div>
      </div>
    </section>

    <!-- live stacks -->
    <section>
      <div class="head"><span class="t">Live stacks</span><span class="spacer"></span>
        <span class="badge" :class="st.view.stalls && st.view.stalls.length ? 'warn' : ''">
          {{ st.view.stalls ? st.view.stalls.length : 0 }} stalls
        </span>
      </div>
      <div class="body">
        <div class="hs" v-for="h in st.view.hot" :key="h.stack" :class="{ on: st.selected === h.stack, stalled: h.stalled }"
             @click="select(h.stack)">
          <div>
            <div class="name" :title="h.stack"><i v-for="(f, i) in h.frames" :key="i">{{ i ? ' › ' : '' }}{{ f.fn }}</i></div>
            <div class="bar"><b :style="{ width: pct(h.share) }"></b></div>
          </div>
          <div class="pct">{{ pct(h.share) }}</div>
          <div class="hits">{{ h.hits }}×</div>
        </div>
        <div class="empty" v-if="!st.view.hot || !st.view.hot.length">
          Waiting for samples. If this stays empty, the agent is not attached —
          check the state badge and the terminal output.
        </div>
      </div>
      <div class="stalls" v-if="st.view.stalls && st.view.stalls.length">
        <div class="row" v-for="(s, i) in st.view.stalls.slice(-5)" :key="i">
          <b>{{ s.durationMs }}ms</b><span>{{ s.stack }}</span>
        </div>
      </div>
    </section>

    <!-- inspector -->
    <section>
      <div class="head">
        <span class="t">Inspector</span>
        <span class="badge" v-if="current && !st.diff">{{ current.path }}</span>
        <span class="badge" :class="st.diff && st.diff.result.entries.length ? 'warn' : 'on'" v-if="st.diff">{{ st.diff.summary || 'no visible change' }}</span>
        <span class="spacer"></span>
        <template v-if="!st.diff">
          <button v-if="canSnapshot" @click="takeSnapshot()">snapshot now</button>
          <button @click="markBaseline()" :disabled="!current" title="remember the value now, to compare against later">baseline</button>
          <button class="primary" @click="showDiff()" :disabled="!canDiff" title="what changed since the baseline">diff</button>
        </template>
        <button v-else @click="closeDiff()">value</button>
      </div>

      <div class="body" v-if="st.diff">
        <div class="df" v-for="(e, i) in st.diff.result.entries" :key="i" :class="e.kind">
          <span class="p" :title="e.pathBefore ? e.path + ' — was ' + e.pathBefore : e.path">{{ e.path }}</span>
          <span class="k">{{ e.kind }}</span>
          <span class="v"><s v-if="e.before">{{ e.before }}</s><b v-if="e.after">{{ e.after }}</b><i v-if="e.note"> {{ e.note }}</i></span>
        </div>
        <!-- Truncation has to be stated even when there *are* entries: otherwise
             the list reads as "this is everything that changed", and the changes
             hiding inside the truncated branch are silently omitted. -->
        <div class="empty" v-if="st.diff.result.incomplete && st.diff.result.entries.length">
          Part of the value was truncated, so changes inside it are not in this list.
        </div>
        <div class="empty" v-if="!st.diff.result.entries.length">
          Nothing visible changed since the baseline<span v-if="st.diff.result.incomplete"> — but part of the value was truncated, so that is not proof of equality</span>.
        </div>
        <div class="empty" v-if="st.diff.result.suppressed">
          {{ st.diff.result.suppressed }} more changes not listed (the list is capped).
        </div>
      </div>
      <div class="body tree" v-else-if="current">
        <snode :node="current.value" path="$"></snode>
      </div>
      <div class="empty" v-else-if="st.view.state === 'attached' && !hasLocals">
        {{ st.view.lang }} has no live locals here — {{ noLocalsReason }}.
      </div>
      <div class="empty" v-else>
        Select a stack to see its live locals, or press “snapshot now”.
      </div>
    </section>
  </main>

  <footer>
    <span class="pill">{{ st.conn }}</span>
    <span v-if="st.view.replay">recording <b>{{ st.view.replay.file }}</b> · {{ st.view.replay.position }}/{{ st.view.replay.total }}</span>
    <span>target <b>{{ st.view.target || '—' }}</b></span>
    <span>pid <b>{{ st.view.pid || '—' }}</b></span>
    <a class="perfLink" v-if="perfHref" :href="perfHref" target="_blank" rel="noopener"
       title="open the engine's Performance page for this session's time window">perf &#8599;</a>
    <span class="spacer"></span>
    <span>ws://127.0.0.1:${opts.port}/</span>
  </footer>
</div>

<script>window.__NLG_ENGINE__ = ${JSON.stringify(opts.engineUrl ?? '')};</script>
<script>${vueRuntime}</script>
<script>${appSource}</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
