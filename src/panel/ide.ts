/**
 * IDE UI (the "write and run code" workspace) — Vue 3 edition.
 *
 * The page is still one self-contained HTML document (no build step, no CDN,
 * no network): the vendored Vue runtime, the shared `nl-core` helpers and the
 * `ide-app` Vue application are inlined verbatim as text imports (`?raw`), so
 * both the dev server and the packaged exe serve the exact same bytes.
 *
 * What Vue replaces here is the hand-written DOM patching: the page used to
 * rebuild `innerHTML` on every digest, keystroke and websocket frame. Now the
 * markup is a template derived from reactive state, and only what actually
 * changed is patched. The editor itself (textarea + highlight overlay +
 * gutter + completion popup) keeps its imperative core — caret position and
 * scroll sync are not things you want a virtual DOM guessing at.
 *
 * Light theme, CSS variables, no emoji (design spec 二十五 / 三十 / 三十四).
 */
import type { Sample, LanguageDescriptor } from './samples.js';
import vueRuntime from './vendor/vue.global.prod.js?raw';
import nlCoreSource from './assets/nl-core.js?raw';
import ideAppSource from './assets/ide-app.js?raw';

/**
 * The Python token pattern, built *here* rather than inside the HTML template.
 *
 * Escaping a regex through a template literal means every backslash needs
 * doubling twice (once for the template, once for the string literal it
 * produces) — which is exactly how the single-quote alternative silently broke
 * the whole page script. Keeping the pattern in TypeScript means it is written
 * with normal string escaping, can be unit-tested, and is injected verbatim
 * with `JSON.stringify`.
 *
 * Capture groups (in order): comment, string, decorator, keyword, number,
 * builtin, call name, class-ish name.
 */
export const PY_PATTERN = [
  '(#[^\\n]*)',
  '|("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')',
  '|(@[A-Za-z_]\\w*)',
  '|\\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|raise|with|lambda|yield|global|nonlocal|pass|break|continue|and|or|not|in|is|None|True|False|assert|del|async|await|match|case)\\b',
  '|\\b(\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|0[xX][0-9a-fA-F]+|0[bB][01]+)\\b',
  '|\\b(print|len|range|enumerate|zip|sorted|sum|min|max|dict|list|set|tuple|str|int|float|bool|open|isinstance|getattr|setattr|hasattr|super|type|abs|round|any|all|map|filter|repr|input|format|id|hash|iter|next|dir|vars|callable|staticmethod|classmethod|property|Exception|ValueError|TypeError|KeyError|IndexError|RuntimeError|StopIteration|AssertionError|ZeroDivisionError|AttributeError|NameError|self|cls)\\b',
  '|\\b([A-Za-z_]\\w*)(?=\\s*\\()',
  '|\\b([A-Z][A-Za-z0-9_]*)\\b',
].join('');

/**
 * The Go token pattern. Same reasoning as `PY_PATTERN` — built here so the
 * escaping is testable, injected with `JSON.stringify`.
 *
 * One Go-specific trap: raw string literals are delimited by backticks, and a
 * literal backtick inside the emitted `<script>` would terminate the surrounding
 * template literal. The pattern therefore spells them `\x60`, which is the same
 * character to the regex engine but never appears literally in the page source.
 *
 * Capture groups (in order): comment, string, keyword, builtin type,
 * builtin func, number, call name, exported name.
 */
export const GO_PATTERN = [
  '(//[^\\n]*|/\\*[\\s\\S]*?\\*/)',
  '|("(?:\\\\.|[^"\\\\\\n])*"|\\x60[^\\x60]*\\x60|\'(?:\\\\.|[^\'\\\\\\n])*\')',
  '|\\b(break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\\b',
  '|\\b(bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr|any|comparable)\\b',
  '|\\b(append|cap|clear|close|complex|copy|delete|imag|len|make|max|min|new|panic|print|println|real|recover)\\b',
  '|\\b(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)\\b',
  '|\\b([a-z_]\\w*)(?=\\s*\\()',
  '|\\b([A-Z]\\w*)\\b',
].join('');

/**
 * Which CSS class each capture group maps to, per language.
 *
 * The group *order* is the same in both patterns (comment, string, …) but the
 * meaning of groups 3+ differs — Python's group 3 is a decorator, Go's is a
 * keyword — so the mapping has to be per language rather than shared.
 */
export const HIGHLIGHT_CLASSES: Record<string, string[]> = {
  python: ['t-com', 't-str', 't-dec', 't-kw', 't-num', 't-bi', 't-fn', 't-fn'],
  go: ['t-com', 't-str', 't-kw', 't-bi', 't-fn', 't-num', 't-fn', 't-dec'],
};

export const TOKEN_PATTERNS: Record<string, string> = {
  python: PY_PATTERN,
  go: GO_PATTERN,
};

/** JSON that is safe to embed inside an inline `<script>` block. */
function scriptJson(value: unknown): string {
  // `<` must not appear literally: `</script>` would close the block early and
  // `<!--` would start an escaped script-data state.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderIdeHtml(port: number, samples: Sample[], languages: LanguageDescriptor[]): string {
  const boot = scriptJson({
    samples,
    languages,
    tokenPatterns: TOKEN_PATTERNS,
    highlightClasses: HIGHLIGHT_CLASSES,
  });
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nolanguage · Workspace</title>
<style>
  :root {
    --bg-primary:#FFFFFF; --bg-secondary:#F7F8FA; --bg-elevated:#FFFFFF;
    --border:#EBECF0; --text-primary:#1E1F22; --text-secondary:#6C707E;
    --accent:#3574F0; --accent-soft:#E8F0FE;
    --success:#499C54; --warning:#D6A545; --error:#DB5C5C;
    --gutter:#9DA0A8; --gutter-active:#1E1F22;
    --kw:#0033B3; --str:#067D17; --num:#1750EB; --com:#8C8C8C;
    --fn:#00627A; --bi:#7A3E9D; --dec:#9E880D;
    --mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    --line: 20px; --pad-y: 8px; --pad-x: 12px;
  }
  * { box-sizing: border-box; }
  html, body { height:100%; margin:0; }
  body { background:var(--bg-primary); color:var(--text-primary); font:13px/1.45 var(--sans);
         overflow:hidden; }
  /* Vue mounts on this wrapper: the three layout regions are its children. */
  #app { display:flex; flex-direction:column; height:100%; }

  /* ---------- header ---------- */
  header { display:flex; align-items:center; gap:10px; padding:7px 12px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); flex:0 0 auto; }
  header .logo { font-weight:600; }
  .badge { font-size:11px; padding:1px 7px; border-radius:9px; border:1px solid var(--border);
    color:var(--text-secondary); background:var(--bg-elevated); white-space:nowrap; }
  header .spacer { flex:1; }
  select, input[type=text] { font:inherit; color:var(--text-primary); background:var(--bg-elevated);
    border:1px solid var(--border); border-radius:5px; padding:3px 7px; }
  button { font:inherit; color:var(--text-primary); background:var(--bg-elevated);
    border:1px solid var(--border); border-radius:5px; padding:3px 10px; cursor:pointer; }
  button:hover { border-color:var(--accent); color:var(--accent); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  button.primary:hover { filter:brightness(1.06); color:#fff; }
  button:disabled { opacity:.45; cursor:default; }
  .conn { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-secondary); }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--warning); }
  .dot.on { background:var(--success); } .dot.off { background:var(--error); }
  .dot.busy { background:var(--accent); animation:pulse 1s infinite; }
  @keyframes pulse { 50% { opacity:.3; } }

  /* ---------- layout ---------- */
  main { flex:1; display:grid; grid-template-columns: minmax(380px, 1.15fr) minmax(360px, 1fr);
    min-height:0; }
  #editorCol { display:flex; flex-direction:column; min-width:0; min-height:0;
    border-right:1px solid var(--border); }
  #sideCol { display:flex; flex-direction:column; min-width:0; min-height:0; }

  /* ---------- editor ---------- */
  .editorWrap { flex:1; display:flex; min-height:0; background:var(--bg-primary); }
  .gutter { flex:0 0 auto; padding:var(--pad-y) 6px var(--pad-y) 10px; text-align:right;
    font:12px/var(--line) var(--mono); color:var(--gutter); user-select:none;
    overflow:hidden; background:var(--bg-secondary); border-right:1px solid var(--border); }
  .gutter .ln { position:relative; }
  .gutter .ln.err { color:var(--error); font-weight:700; }
  .gutter .ln.warn { color:var(--warning); font-weight:700; }
  /* overflow:visible so the completion popup can spill past the editor box;
     the overlay and textarea are absolutely inset, so nothing else escapes. */
  .codeArea { position:relative; flex:1; min-width:0; overflow:visible; }
  .codeArea pre, .codeArea textarea {
    margin:0; padding:var(--pad-y) var(--pad-x);
    font:13px/var(--line) var(--mono);
    white-space:pre; tab-size:4; border:0; outline:0;
  }
  .codeArea pre { position:absolute; inset:0; overflow:hidden; pointer-events:none;
    color:var(--text-primary); }
  .codeArea textarea { position:absolute; inset:0; resize:none; overflow:auto;
    background:transparent; color:transparent; caret-color:var(--text-primary); }
  .codeArea textarea::selection { background:var(--accent-soft); }
  .codeArea .activeLine { position:absolute; left:0; right:0; height:var(--line);
    background:rgba(53,116,240,.06); pointer-events:none; display:none; }
  /* completion popup */
  .completion { position:absolute; z-index:5; min-width:190px; max-height:220px; overflow:auto;
    background:var(--bg-elevated); border:1px solid var(--border); border-radius:6px;
    box-shadow:0 6px 20px rgba(0,0,0,.14); padding:3px 0; display:none; }
  .completion.open { display:block; }
  .completion .item { padding:3px 10px; font:12px var(--mono); cursor:pointer;
    display:flex; justify-content:space-between; gap:14px; white-space:nowrap; }
  .completion .item .k { color:var(--text-secondary); font-size:10.5px; }
  .completion .item.sel { background:var(--accent-soft); }
  .completion .hd { padding:3px 10px 4px; font-size:10.5px; color:var(--text-secondary);
    border-bottom:1px solid var(--border); margin-bottom:3px; }
  .t-kw { color:var(--kw); font-weight:600; }
  .t-str { color:var(--str); }
  .t-num { color:var(--num); }
  .t-com { color:var(--com); font-style:italic; }
  .t-fn  { color:var(--fn); }
  .t-bi  { color:var(--bi); }
  .t-dec { color:var(--dec); }

  /* ---------- tabs ---------- */
  .tabs { display:flex; align-items:center; gap:2px; padding:0 8px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); flex:0 0 auto; }
  .tab { padding:7px 11px; cursor:pointer; border-bottom:2px solid transparent;
    color:var(--text-secondary); font-size:12.5px; background:none; border-radius:0; border-top:0;
    border-left:0; border-right:0; }
  .tab:hover { color:var(--text-primary); border-color:transparent; }
  .tab.active { color:var(--text-primary); border-bottom-color:var(--accent); font-weight:600; }
  .tab .pill { display:inline-block; margin-left:5px; font-size:10.5px; padding:0 5px;
    border-radius:8px; background:var(--border); color:var(--text-secondary); }
  .tab .pill.err { background:#FBE4E4; color:var(--error); }
  .tab .pill.warn { background:#FAF0DA; color:#8A6A15; }
  .tabBar { display:flex; align-items:center; gap:6px; margin-left:auto; padding-right:2px; }

  .tabPanel { flex:1; min-height:0; overflow:auto; display:none; }
  .tabPanel.active { display:block; }
  .empty { padding:18px 14px; color:var(--text-secondary); font-size:12px; }

  /* ---------- output ---------- */
  #out { font:12px/1.5 var(--mono); padding:8px 12px; white-space:pre-wrap; word-break:break-word; }
  #out .hdr { color:var(--text-secondary); }
  #out .err { color:var(--error); }
  #out .ok { color:var(--success); }
  #out .meta { display:block; margin:8px 0 2px; padding-top:6px;
    border-top:1px dashed var(--border); color:var(--text-secondary); }

  /* ---------- problems ---------- */
  .prob { display:grid; grid-template-columns:64px 62px 1fr; gap:9px; padding:6px 12px;
    border-bottom:1px solid var(--border); cursor:pointer; align-items:baseline; }
  .prob:hover { background:var(--bg-secondary); }
  .prob .loc { font:11.5px var(--mono); color:var(--text-secondary); }
  .prob .sev { font-size:11px; font-weight:600; }
  .prob .sev.error { color:var(--error); } .prob .sev.warning { color:var(--warning); }
  .prob .sev.info { color:var(--text-secondary); }
  .prob .msg { font-size:12.5px; }
  .prob .src { color:var(--text-secondary); font-size:11px; margin-left:6px; }

  /* ---------- performance ---------- */
  .groupTitle { padding:8px 12px 3px; font-size:11px; text-transform:uppercase;
    letter-spacing:.6px; color:var(--text-secondary); }
  .metric { display:grid; grid-template-columns:1fr auto auto; align-items:center; gap:10px;
    padding:4px 12px; border-bottom:1px solid var(--border); }
  .metric .name { font:12px var(--mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .metric .stat { font:11.5px var(--mono); color:var(--text-secondary); white-space:nowrap; }
  .metric .stat b { color:var(--text-primary); }
  .metric.warn .stat b { color:var(--warning); } .metric.err .stat b { color:var(--error); }
  .spark { display:block; }
  /* An SVG presentation attribute cannot use var(), so the bars are coloured
     through CSS: the sparkline follows the theme like everything else. */
  .spark rect { fill:var(--accent); opacity:.75; }
  .spark.warn rect { fill:var(--warning); }

  /* ---------- logs ---------- */
  #logBar { display:flex; align-items:center; gap:7px; padding:6px 10px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); flex-wrap:wrap; }
  .logrow { display:grid; grid-template-columns:70px 48px 118px 1fr; gap:8px;
    padding:2px 10px; border-bottom:1px solid rgba(0,0,0,.035); font:11.5px var(--mono);
    align-items:baseline; }
  .logrow .t { color:var(--text-secondary); }
  .logrow .l { font-weight:600; }
  .logrow .c { color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .logrow .m { white-space:pre-wrap; word-break:break-word; }
  .logrow .fields { color:var(--text-secondary); }
  .lv-TRACE { color:var(--gutter); } .lv-DEBUG { color:#2AACB8; }
  .lv-INFO { color:var(--success); } .lv-WARN { color:var(--warning); }
  .lv-ERROR,.lv-FATAL { color:var(--error); font-weight:700; }
  .lv-AUDIT { color:#8A5CF6; } .lv-METRIC { color:var(--accent); }

  /* ---------- status bar ---------- */
  footer { display:flex; align-items:center; gap:14px; height:24px; padding:0 12px;
    background:var(--bg-secondary); border-top:1px solid var(--border);
    font:11.5px var(--mono); color:var(--text-secondary); flex:0 0 auto; }
  footer .spacer { flex:1; }
  footer .ok { color:var(--success); } footer .err { color:var(--error); }
</style>
</head>
<body>
<div id="app">
<header>
  <span class="logo">Nolanguage</span>
  <select :value="st.language" title="Language" aria-label="Language"
    @change="setLanguage($event.target.value, { keepCode: false })">
    <option v-for="l in LANGUAGES" :key="l.id" :value="l.id">{{ l.displayName }}</option>
  </select>
  <select :value="st.sampleIndex" title="Load a sample" aria-label="Load a sample"
    @change="loadSample(currentSamples[Number($event.target.value)])">
    <option v-for="(s, i) in currentSamples" :key="s.id" :value="i">{{ s.name }}</option>
  </select>
  <button class="primary" :disabled="st.busy" title="Ctrl+Enter" @click="doRun('run')">{{ st.busy ? 'Running…' : 'Run' }}</button>
  <button v-show="langDesc(st.language).supportsTest" :disabled="st.busy" title="go test -v" @click="doRun('test')">{{ st.busy ? 'Testing…' : 'Test' }}</button>
  <button :disabled="st.busy" title="Ask the language server for problems" @click="doCheck()">Check</button>
  <button title="Drop the execution session" @click="doReset()">Reset session</button>
  <span class="spacer"></span>
  <span class="badge" :title="toolBadge.title">{{ toolBadge.text }}</span>
  <span class="badge" :title="lspBadge.title">{{ lspBadge.text }}</span>
  <div class="conn">
    <span class="dot" :class="st.busy ? 'busy' : (st.conn === 'on' ? 'on' : st.conn === 'off' ? 'off' : '')"></span>
    <span>{{ st.conn === 'on' ? 'connected' : st.conn === 'off' ? 'disconnected — retrying' : 'connecting…' }}</span>
  </div>
</header>

<main>
  <section id="editorCol">
    <div class="tabs">
      <span class="tab active" style="cursor:default">{{ langDesc(st.language).fileName }}</span>
      <div class="tabBar">
        <span class="badge">{{ lineCount }} lines</span>
      </div>
    </div>
    <div class="editorWrap">
      <div class="gutter" id="gutter" ref="gutterEl">
        <div class="ln" v-for="row in gutterRows" :key="row.n" :class="row.cls">{{ row.n }}</div>
      </div>
      <div class="codeArea">
        <div class="activeLine" id="activeLine" ref="activeEl"></div>
        <pre id="highlight" ref="hlEl" aria-hidden="true" v-html="highlighted"></pre>
        <textarea id="code" ref="ta" spellcheck="false" autocomplete="off"
          autocapitalize="off" wrap="off" :value="st.code"
          @input="onCodeInput" @scroll="onScroll" @keyup="onCursor"
          @click="onCursor" @keydown="onKeydown"></textarea>
        <div class="completion" id="completion" ref="cmpEl" :class="{ open: cmp.open }" v-show="cmp.open">
          <div class="hd">{{ cmp.hint || (cmp.items.length + ' suggestion' + (cmp.items.length === 1 ? '' : 's')) }}</div>
          <div class="item" v-for="(it, i) in cmp.items" :key="i" :class="{ sel: i === cmp.sel }"
            :title="it.detail || ''" @mousedown.prevent="pickItem(i)">
            <span>{{ it.label }}</span>
            <span class="k" v-if="kindLabel(it.kind)">{{ kindLabel(it.kind) }}</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section id="sideCol">
    <div class="tabs">
      <button class="tab" :class="{ active: st.tab === 'out' }" @click="st.tab = 'out'">Output</button>
      <button class="tab" :class="{ active: st.tab === 'prob' }" @click="st.tab = 'prob'">Problems<span :class="pillClass">{{ problemCounts.total }}</span></button>
      <button class="tab" :class="{ active: st.tab === 'perf' }" @click="st.tab = 'perf'">Performance</button>
      <button class="tab" :class="{ active: st.tab === 'logs' }" @click="st.tab = 'logs'">Logs</button>
      <div class="tabBar">
        <select v-model="st.filterLevel" title="Minimum log level" aria-label="Minimum log level">
          <option v-for="l in LEVEL_OPTIONS" :key="l.v" :value="l.v">{{ l.n }}</option>
        </select>
        <button title="Clear the log buffer" @click="clearLogs()">clear</button>
      </div>
    </div>
    <div class="tabPanel" :class="{ active: st.tab === 'out' }" id="panel-out" v-if="st.tab === 'out'">
      <div class="empty" v-if="!st.lastRun">Press Run (Ctrl+Enter) to execute the buffer.</div>
      <div id="out" v-else v-html="outputHtml"></div>
    </div>
    <div class="tabPanel" :class="{ active: st.tab === 'prob' }" id="panel-prob" v-if="st.tab === 'prob'">
      <div class="empty" v-if="!st.problems.length">
        {{ emptyProblem.message }}
        <template v-if="emptyProblem.why"><br><br>{{ emptyProblem.why }}</template>
      </div>
      <div class="prob" v-for="(p, i) in st.problems" :key="i" @click="jumpTo(p)">
        <span class="loc">L{{ p.line + 1 }}:{{ p.character + 1 }}</span>
        <span class="sev" :class="p.severityName">{{ p.severityName }}</span>
        <span class="msg">{{ p.message }}<span class="src" v-if="p.code">[{{ p.code }}]</span></span>
      </div>
    </div>
    <div class="tabPanel" :class="{ active: st.tab === 'perf' }" id="panel-perf" v-if="st.tab === 'perf'">
      <div class="empty" v-if="!metricGroups.length">Waiting for the first metric digest…</div>
      <template v-else>
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
    <div class="tabPanel" :class="{ active: st.tab === 'logs' }" id="panel-logs" v-if="st.tab === 'logs'">
      <div id="logBar">
        <span id="logCount">{{ visibleLogs.length }} / {{ st.logs.length }} records</span>
        <span class="spacer" style="flex:1"></span>
        <span id="levelCounts"><span v-for="c in logCounts" :key="c.level" style="margin-right:8px">{{ c.level }} {{ c.count }}</span></span>
      </div>
      <div id="logs">
        <div class="empty" v-if="!visibleLogs.length">No logs at this level.</div>
        <div class="logrow" v-for="r in visibleLogs" :key="r.id">
          <span class="t">{{ clockOf(r.ts) }}</span>
          <span class="l" :class="'lv-' + levelName(r.level)">{{ levelName(r.level) }}</span>
          <span class="c" :title="r.component">{{ r.component }}</span>
          <span class="m">{{ r.message }}<span class="fields" v-if="r.fields"> {{ JSON.stringify(r.fields) }}</span><span class="lv-ERROR" v-if="r.errorMessage"> {{ r.errorType }}: {{ r.errorMessage }}</span></span>
        </div>
      </div>
    </div>
  </section>
</main>

<footer>
  <span id="fSession">session {{ st.session }}</span>
  <span id="fRuns">runs {{ st.runs }}</span>
  <span id="fLast">last <span v-if="st.lastRun" :class="st.lastRun.exitCode === 0 ? 'ok' : 'err'">{{ st.lastRun.exitCode }}</span><span v-if="st.lastRun"> {{ Math.round(st.lastRun.durationMs) }}ms</span><span v-if="!st.lastRun">—</span></span>
  <span class="spacer"></span>
  <span id="fCursor">Ln {{ caret.line }}, Col {{ caret.col }}</span>
  <span id="fTool">{{ toolPath }}</span>
  <span id="fWs">ws://127.0.0.1:${port}/</span>
</footer>
</div>

<script>${vueRuntime}</script>
<script>${nlCoreSource}</script>
<script>window.__NOLANGUAGE_IDE__ = ${boot};</script>
<script>${ideAppSource}</script>
</body>
</html>`;
}
