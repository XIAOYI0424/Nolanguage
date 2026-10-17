/**
 * PyCharm New UI shell (design: 复刻 PyCharm 2024.1+ New UI).
 *
 * One self-contained HTML page in the same spirit as the other panels: no build
 * step, no CDN, no network — it talks to the very same WebSocket the monitor and
 * IDE pages use, so the tool windows show *real* platform data:
 *
 *   - Logs        <- `log` records (kernel log pipeline)
 *   - Performance <- `metrics` / `series` (perf spine, live P95)
 *   - Problems    <- `diagnostics` (LSP)
 *   - Run         <- `run` / `runResult` (sandboxed executor)
 *   - Extensions  <- `extensions` / `extension` / `extensionResult` (host process)
 *
 * Layout, spacing, colors and icon grammar follow JetBrains' New UI / expui spec
 * (see the design doc). Everything is rendered from CSS variables so Darcula and
 * Light are a single `data-theme` flip on <html>.
 */
// Python token pattern, built here (not inside the template) so escaping stays
// testable; injected verbatim with JSON.stringify. Group order matters — the
// highlighter maps group index -> token class.
export const PY_PATTERN = [
  '(#[^\\n]*)',
  '|("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')',
  '|(@[A-Za-z_]\\w*)',
  '|\\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|raise|with|lambda|yield|global|nonlocal|pass|break|continue|and|or|not|in|is|None|True|False|assert|del|async|await|match|case)\\b',
  '|\\b(\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|0[xX][0-9a-fA-F]+|0[bB][01]+)\\b',
  '|\\b(print|len|range|enumerate|zip|sorted|sum|min|max|dict|list|set|tuple|str|int|float|bool|open|isinstance|getattr|setattr|hasattr|super|type|abs|round|any|all|map|filter|repr|input|format|id|hash|iter|next|dir|vars|callable|staticmethod|classmethod|property|Exception|ValueError|TypeError|KeyError|IndexError|RuntimeError|StopIteration|AssertionError|ZeroDivisionError|AttributeError|NameError)\\b',
  '|\\b([A-Za-z_]\\w*)(?=\\s*\\()',
  '|\\b([A-Z][A-Za-z0-9_]*)\\b',
].join('');

const SAMPLE_MAIN = 'import os\nimport sys\n\n\ndef fib(n):\n    """Return the n-th Fibonacci number."""\n    if n <= 1:\n        return n\n    return fib(n - 1) + fib(n - 2)\n\n\ndef main():\n    print("hello from fib(10) =", fib(10))\n    print("cwd:", os.getcwd())\n\n\nif __name__ == "__main__":\n    main()\n';

const SAMPLE_UTILS = 'from dataclasses import dataclass\n\n\n@dataclass\nclass Point:\n    x: int\n    y: int\n\n    def norm(self) -> float:\n        return (self.x ** 2 + self.y ** 2) ** 0.5\n';

const SAMPLE_README = '# Nolanguage\n\nA tiny language workbench.\n\n- kernel: perf + log spine\n- extensions: isolated host processes\n- panel: this PyCharm-style shell\n\n```python\nprint("hi")\n```\n';

// Open me with Search Everywhere (double Shift) > "main.js" to switch the editor
// to JavaScript: highlighting, Check and Run all follow the file extension.
const SAMPLE_JS = '// JavaScript — the sandbox runs this on a shared node worker.\n// console.log is captured; an uncaught throw is the non-zero exit code.\n\nconst nums = [1, 2, 3, 4, 5];\n\nfunction sum(values) {\n  return values.reduce((a, b) => a + b, 0);\n}\n\nclass Report {\n  constructor(title) {\n    this.title = title;\n  }\n\n  render(rows) {\n    return [this.title].concat(rows.map((r) => `  ${r}`)).join("\\n");\n  }\n}\n\nconst report = new Report("sum of " + nums.length + " numbers");\nconsole.log(report.render(["total = " + sum(nums), "node " + process.version]));\n\n// Each Run starts from a fresh context, so this is always 1.\nconsole.log("fresh context: runs visible = " + ((globalThis.runs || 0) + 1));\n';

// expui-style icon geometry: 20-grid for strip/toolbar/tool-windows, 16-grid for
// inline actions. Stroke grammar (width 1.4, round caps) lives on the <svg>;
// individual paths only carry `d`, inheriting `currentColor`.
const ICONS: Record<string, { vb: string; d: string }> = {
  project: { vb: '0 0 20 20', d: '<path d="M3 5.6A1.6 1.6 0 0 1 4.6 4h3.1l1.6 2h6.1A1.6 1.6 0 0 1 17 7.6v7.8A1.6 1.6 0 0 1 15.4 17H4.6A1.6 1.6 0 0 1 3 15.4z"/>' },
  vcs: { vb: '0 0 20 20', d: '<circle cx="6" cy="5" r="1.9"/><circle cx="6" cy="15" r="1.9"/><circle cx="15" cy="9.5" r="1.9"/><path d="M6 6.9v6.2M7.9 5h2.6a2 2 0 0 1 2 2v.6M7.9 15h2.6a2 2 0 0 0 2-2v-.6"/>' },
  commit: { vb: '0 0 20 20', d: '<circle cx="10" cy="10" r="2.6"/><path d="M10 1.6v3.2M10 15.2v3.2M1.6 10h3.2M15.2 10h3.2"/>' },
  terminal: { vb: '0 0 20 20', d: '<rect x="2.5" y="3.5" width="15" height="13" rx="1.6"/><path d="M6.2 8.2l2.6 2-2.6 2M11.4 12.2h3"/>' },
  database: { vb: '0 0 20 20', d: '<ellipse cx="10" cy="5" rx="6.8" ry="2.5"/><path d="M3.2 5v10c0 1.4 3 2.5 6.8 2.5s6.8-1.1 6.8-2.5V5"/><path d="M3.2 10c0 1.4 3 2.5 6.8 2.5s6.8-1.1 6.8-2.5"/>' },
  run: { vb: '0 0 20 20', d: '<path d="M6.6 4.2l9 5.8-9 5.8z" fill="currentColor" stroke="none"/>' },
  debug: { vb: '0 0 20 20', d: '<path d="M6.6 4.2l9 5.8-9 5.8z"/><path d="M6.6 16.6h9"/>' },
  stop: { vb: '0 0 20 20', d: '<rect x="5.5" y="5.5" width="9" height="9" rx="1" fill="currentColor" stroke="none"/>' },
  coverage: { vb: '0 0 20 20', d: '<path d="M3 16.5h14"/><path d="M4 13.5l3.5-4 3 2.5L14 6"/><circle cx="4" cy="13.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="14" cy="6" r="1.1" fill="currentColor" stroke="none"/>' },
  structure: { vb: '0 0 20 20', d: '<rect x="7.6" y="2.6" width="4.8" height="3" rx="0.7"/><rect x="2.6" y="14" width="4.8" height="3" rx="0.7"/><rect x="12.6" y="14" width="4.8" height="3" rx="0.7"/><path d="M10 5.6v4.4M10 10l-4.8 4M10 10l4.8 4"/>' },
  perf: { vb: '0 0 20 20', d: '<path d="M2.6 16.6h14.8"/><path d="M5 16.6V11M8.6 16.6V6.4M12.2 16.6V9M15.8 16.6V3.8"/>' },
  logs: { vb: '0 0 20 20', d: '<path d="M4 5h12M4 9h12M4 13h8M4 17h6"/>' },
  ai: { vb: '0 0 20 20', d: '<path d="M10 2.2l1.7 4.6 4.6 1.7-4.6 1.7L10 14.8 8.3 10.2 3.7 8.5l4.6-1.7z" fill="currentColor" stroke="none"/>' },
  settings: { vb: '0 0 20 20', d: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2v2.3M10 15.7V18M2 10h2.3M15.7 10H18M4.3 4.3l1.6 1.6M14.1 14.1l1.6 1.6M15.7 4.3l-1.6 1.6M5.9 14.1l-1.6 1.6"/>' },
  search: { vb: '0 0 20 20', d: '<circle cx="8.7" cy="8.7" r="4.5"/><path d="M12.1 12.1l3.6 3.6"/>' },
  more: { vb: '0 0 20 20', d: '<circle cx="10" cy="4.4" r="1.1" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="10" cy="15.6" r="1.1" fill="currentColor" stroke="none"/>' },
  pin: { vb: '0 0 20 20', d: '<path d="M7.6 3.2h4.8v3.4l1.9 2v1.6H5.7V8.6l1.9-2z"/><path d="M10 10.2v6.6"/>' },
  collapse: { vb: '0 0 20 20', d: '<path d="M3.6 5h12.8M3.6 9.4h8.8M3.6 13.8h12.8"/>' },
  warn: { vb: '0 0 20 20', d: '<path d="M10 3.4l7.6 13.2H2.4z"/><path d="M10 8v4M10 14.1v.1"/>' },
  file: { vb: '0 0 20 20', d: '<path d="M5 2.6h5l1.5 2H15a1 1 0 0 1 1 1v10.8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1z"/>' },
  close: { vb: '0 0 16 16', d: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>' },
  min: { vb: '0 0 16 16', d: '<rect x="3.5" y="11" width="9" height="2" rx="1" fill="currentColor" stroke="none"/>' },
  max: { vb: '0 0 16 16', d: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/>' },
  chevD: { vb: '0 0 16 16', d: '<path d="M4.5 6.5l3.5 3.5 3.5-3.5"/>' },
  chevR: { vb: '0 0 16 16', d: '<path d="M6.5 4.5l3.5 3.5-3.5 3.5"/>' },
  check: { vb: '0 0 16 16', d: '<path d="M3.5 8.5l3 3 6-7"/>' },
};

export function renderPyCharmHtml(_port: number): string {
  const iconsJson = JSON.stringify(ICONS);
  const patternJson = JSON.stringify(PY_PATTERN);
  const mainJson = JSON.stringify(SAMPLE_MAIN);
  const utilsJson = JSON.stringify(SAMPLE_UTILS);
  const jsJson = JSON.stringify(SAMPLE_JS);
  const readmeJson = JSON.stringify(SAMPLE_README);

  return `<!doctype html>
<html lang="en" data-theme="darcula">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nolanguage · PyCharm UI</title>
<style>
  :root, :root[data-theme="darcula"] {
    --bg-primary:#1E1F22; --bg-secondary:#2B2D30; --bg-tertiary:#393B40;
    --bg-editor:#1E1F22; --bg-gutter:#1E1F22; --bg-toolbar:#2B2D30;
    --bg-hover:#26282E; --bg-active:#2E3136; --border:#393B40; --border-soft:#2B2D30;
    --text-primary:#DFE1E5; --text-secondary:#9DA0A8; --text-tertiary:#6F737A;
    --accent:#3574F0; --success:#499C54; --warning:#D6A545; --error:#DB5C5C;
    --icon-default:#9DA0A8; --icon-active:#DFE1E5;
    --sel:#214283; --sel-text:#FFFFFF;
    --syn-keyword:#CF8E6D; --syn-string:#6AAB73; --syn-number:#2AACB8; --syn-comment:#7A7E85;
    --syn-func:#56A8F5; --syn-class:#B5B6E3; --syn-var:#BCBEC4; --syn-const:#6A8759; --syn-deco:#B99CCF;
    --shadow: 0 8px 28px rgba(0,0,0,.5);
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: -apple-system, "Segoe UI", Inter, "PingFang SC", system-ui, sans-serif;
  }
  :root[data-theme="light"] {
    --bg-primary:#FFFFFF; --bg-secondary:#F7F8FA; --bg-tertiary:#FFFFFF;
    --bg-editor:#FFFFFF; --bg-gutter:#F7F8FA; --bg-toolbar:#FFFFFF;
    --bg-hover:#EAECF0; --bg-active:#E3E5E8; --border:#E1E2E6; --border-soft:#EBECF0;
    --text-primary:#1E1F22; --text-secondary:#6C707E; --text-tertiary:#9DA0A8;
    --accent:#3574F0; --success:#5B9E56; --warning:#C8872B; --error:#DB5C5C;
    --icon-default:#6C707E; --icon-active:#1E1F22;
    --sel:#CFE2FF; --sel-text:#1E1F22;
    --syn-keyword:#0033B3; --syn-string:#067D17; --syn-number:#1750EB; --syn-comment:#8C8C8C;
    --syn-func:#00627A; --syn-class:#1E1F22; --syn-var:#1E1F22; --syn-const:#1750EB; --syn-deco:#9C2BB8;
    --shadow: 0 8px 28px rgba(0,0,0,.18);
  }
  * { box-sizing:border-box; }
  html, body { height:100%; margin:0; }
  body {
    background:var(--bg-primary); color:var(--text-primary);
    font:13px/1.45 var(--sans); overflow:hidden; -webkit-font-smoothing:antialiased;
  }
  button { font:inherit; color:inherit; background:none; border:0; padding:0; cursor:pointer; }
  .ic { display:inline-block; vertical-align:middle; flex:0 0 auto; }
  ::selection { background:var(--sel); color:var(--sel-text); }

  /* ---------- shell grid: menu / toolbar / work / status ---------- */
  .ide { display:grid; grid-template-rows:28px 40px 1fr 24px; height:100vh; }

  /* menu bar */
  .menubar { display:flex; align-items:center; gap:2px; padding:0 8px; background:var(--bg-primary);
    border-bottom:1px solid var(--border-soft); font-size:12.5px; position:relative; z-index:40; }
  .menubar .brand { font-weight:600; color:var(--accent); margin-right:10px; letter-spacing:.3px; }
  .menu { padding:3px 9px; border-radius:5px; color:var(--text-secondary); position:relative; }
  .menu:hover, .menu.open { background:var(--bg-hover); color:var(--text-primary); }
  .menubar .spacer { flex:1; }

  /* dropdown popover shared by menus */
  .pop { position:absolute; top:26px; left:0; min-width:230px; background:var(--bg-tertiary);
    border:1px solid var(--border); border-radius:8px; box-shadow:var(--shadow); padding:5px; display:none; z-index:60; }
  .menu.open .pop { display:block; }
  .pop .item { display:flex; align-items:center; gap:10px; width:100%; text-align:left;
    padding:6px 9px; border-radius:5px; color:var(--text-primary); font-size:12.5px; }
  .pop .item:hover { background:var(--accent); color:#fff; }
  .pop .item .sc { margin-left:auto; color:var(--text-tertiary); font-size:11.5px; }
  .pop .item:hover .sc { color:rgba(255,255,255,.8); }
  .pop .sep { height:1px; background:var(--border); margin:5px 6px; }
  .pop .grp { padding:5px 9px 3px; font-size:10.5px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-tertiary); }

  /* main toolbar */
  .toolbar { display:flex; align-items:center; gap:10px; padding:0 10px; background:var(--bg-toolbar);
    border-bottom:1px solid var(--border); }
  .widget { display:flex; align-items:center; gap:6px; height:26px; padding:0 9px; border-radius:6px;
    border:1px solid var(--border); background:var(--bg-secondary); color:var(--text-primary); font-size:12px; max-width:280px; }
  .widget:hover { background:var(--bg-hover); }
  .widget .lbl { color:var(--text-tertiary); }
  .widget .val { font-weight:500; }
  .widget .ic { color:var(--icon-default); }
  .run-group { display:flex; align-items:center; gap:4px; }
  .tbtn { display:flex; align-items:center; gap:6px; height:26px; padding:0 9px; border-radius:6px;
    border:1px solid var(--border); background:var(--bg-secondary); color:var(--text-primary); font-size:12px; }
  .tbtn:hover { background:var(--bg-hover); border-color:var(--accent); }
  .tbtn.iconly { padding:0 7px; }
  .tbtn .ic { color:var(--icon-default); }
  .tbtn:hover .ic { color:var(--icon-active); }
  .tbtn.primary { background:var(--success); border-color:var(--success); color:#fff; }
  .tbtn.primary .ic { color:#fff; }
  .toolbar .spacer { flex:1; }

  /* work area */
  .work { display:flex; min-height:0; }

  /* left tool strip */
  .strip { width:40px; flex:0 0 auto; background:var(--bg-secondary); border-right:1px solid var(--border);
    display:flex; flex-direction:column; align-items:center; padding:4px 0; gap:2px; }
  .strip .sbtn { width:32px; height:32px; border-radius:6px; display:flex; align-items:center; justify-content:center;
    color:var(--icon-default); position:relative; }
  .strip .sbtn:hover { background:var(--bg-hover); color:var(--icon-active); }
  .strip .sbtn.active { color:var(--accent); }
  .strip .sbtn.active::before { content:""; position:absolute; left:-4px; top:6px; bottom:6px; width:2px;
    border-radius:2px; background:var(--accent); }
  .strip .grow { flex:1; }

  /* docked tool window (left) */
  .panel { width:300px; flex:0 0 auto; background:var(--bg-primary); border-right:1px solid var(--border);
    display:flex; flex-direction:column; min-width:0; }
  .panel.hidden { display:none; }
  .tw-head { height:30px; flex:0 0 auto; display:flex; align-items:center; gap:4px; padding:0 6px 0 12px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); font-size:11.5px; font-weight:600;
    color:var(--text-secondary); letter-spacing:.3px; }
  .tw-head .title { flex:1; text-transform:uppercase; }
  .tw-head .tbtn { width:22px; height:22px; padding:0; justify-content:center; border:0; background:none; border-radius:4px; }
  .tw-head .tbtn:hover { background:var(--bg-hover); }
  .tw-body { flex:1; overflow:auto; min-height:0; }
  .ptree { padding:4px 0; font-size:12.5px; user-select:none; }
  .tnode { display:flex; align-items:center; gap:5px; padding:2px 8px; cursor:pointer; border-radius:4px; color:var(--text-primary); }
  .tnode:hover { background:var(--bg-hover); }
  .tnode.active { background:var(--bg-active); }
  .tnode .chev { width:14px; height:14px; flex:0 0 auto; display:flex; align-items:center; justify-content:center; color:var(--text-tertiary); }
  .tnode .ic { color:var(--icon-default); flex:0 0 auto; }
  .tnode .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tnode.ro .nm { color:var(--text-tertiary); font-style:italic; }
  .pempty { padding:6px 14px; color:var(--text-tertiary); font-size:12px; }
  .ctxmenu { position:fixed; z-index:90; min-width:220px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:6px; padding:4px; box-shadow:0 6px 20px rgba(0,0,0,.35); display:none; }
  .ctxmenu.open { display:block; }
  .ctxmenu .citem { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:12.5px; white-space:nowrap; }
  .ctxmenu .citem:hover { background:var(--accent); color:#fff; }
  .ctxmenu .citem:hover .csc { color:#eef; }
  .ctxmenu .citem .csc { color:var(--text-tertiary); font-size:11.5px; }
  .ctxmenu .citem.dis { color:var(--text-tertiary); pointer-events:none; }
  .ctxmenu .csep { height:1px; margin:4px 6px; background:var(--border-soft); }

  /* center column */
  .center { flex:1; display:flex; flex-direction:column; min-width:0; background:var(--bg-primary); }

  /* editor tabs */
  .etabs { height:36px; flex:0 0 auto; display:flex; align-items:flex-end; gap:1px; padding:0 8px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); overflow-x:auto; }
  .etab { display:flex; align-items:center; gap:7px; height:30px; padding:0 8px 0 10px; border-radius:6px 6px 0 0;
    color:var(--text-secondary); font-size:12.5px; max-width:200px; position:relative; }
  .etab:hover { background:var(--bg-hover); }
  .etab.active { background:var(--bg-editor); color:var(--text-primary); }
  .etab.active::after { content:""; position:absolute; left:8px; right:8px; top:0; height:2px; background:var(--accent); border-radius:2px; }
  .etab .nm { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .etab .dirty { color:var(--accent); font-size:14px; line-height:0; }
  .etab .x { width:16px; height:16px; border-radius:4px; display:none; align-items:center; justify-content:center; color:var(--icon-default); }
  .etab:hover .x, .etab.active .x { display:flex; }
  .etab .x:hover { background:var(--bg-tertiary); color:var(--icon-active); }
  .etabs .more { margin-left:auto; align-self:center; width:24px; height:24px; border-radius:5px; display:flex; align-items:center; justify-content:center; color:var(--icon-default); }
  .etabs .more:hover { background:var(--bg-hover); }

  /* editor: gutter + code overlay */
  .edwrap { flex:1; display:flex; min-height:0; background:var(--bg-editor); position:relative; }
  .gutter { width:56px; flex:0 0 auto; overflow:hidden; background:var(--bg-gutter); position:relative;
    border-right:1px solid var(--border-soft); }
  .gutter .glines { position:absolute; left:0; right:0; top:0; padding:10px 0; will-change:transform; }
  .gline { position:relative; height:20px; display:flex; align-items:center; justify-content:flex-end;
    padding-right:10px; font:12px/20px var(--mono); color:var(--text-tertiary); }
  .gline.cur { color:var(--text-primary); }
  .gline .bp { position:absolute; left:7px; top:5px; width:10px; height:10px; border-radius:50%;
    background:var(--error); border:1px solid rgba(0,0,0,.25); cursor:pointer; }
  .gline .fold { position:absolute; left:26px; top:3px; width:14px; height:14px; border-radius:3px;
    display:flex; align-items:center; justify-content:center; color:var(--text-tertiary); opacity:0; cursor:pointer; }
  .gline.foldable:hover .fold { opacity:1; }
  .gline .fold:hover { background:var(--bg-hover); color:var(--icon-active); }
  .codewrap { position:relative; flex:1; min-width:0; overflow:hidden; }
  .codewrap pre, .codewrap textarea {
    position:absolute; inset:0; margin:0; padding:10px 14px; border:0;
    font:13px/20px var(--mono); white-space:pre; word-wrap:normal; tab-size:4; }
  .codewrap pre { z-index:1; overflow:auto; color:var(--text-primary); pointer-events:none; }
  .codewrap pre code { font:inherit; }
  .codewrap textarea { z-index:2; overflow:auto; background:transparent; color:transparent;
    caret-color:var(--accent); resize:none; outline:none; }
  .tok-c { color:var(--syn-comment); font-style:italic; }
  .tok-s { color:var(--syn-string); }
  .tok-d { color:var(--syn-deco); }
  .tok-k { color:var(--syn-keyword); }
  .tok-n { color:var(--syn-number); }
  .tok-b { color:var(--syn-const); }
  .tok-f { color:var(--syn-func); }
  .tok-cl { color:var(--syn-class); }
  .curline { position:absolute; left:0; right:0; height:20px; background:var(--bg-active); pointer-events:none; display:none; }
  .cmp { position:absolute; z-index:12; min-width:220px; max-width:460px; max-height:220px; overflow:auto;
    background:var(--bg-secondary); border:1px solid var(--border); border-radius:6px;
    box-shadow:0 8px 24px rgba(0,0,0,.4); display:none; padding:3px; }
  .cmp.open { display:block; }
  .cmp .row { display:flex; align-items:center; gap:8px; padding:3px 8px; border-radius:4px; cursor:pointer;
    font:12.5px/18px var(--mono); white-space:nowrap; }
  .cmp .row.sel { background:var(--accent); color:#fff; }
  .cmp .row .k { color:var(--syn-keyword); flex:0 0 auto; width:16px; text-align:center; }
  .cmp .row.sel .k { color:#eef; }
  .cmp .row .d { color:var(--text-tertiary); overflow:hidden; text-overflow:ellipsis; }
  .cmp .row.sel .d { color:#dde; }
  .hover-tip { position:absolute; z-index:13; max-width:520px; max-height:300px; overflow:auto; display:none;
    background:var(--bg-secondary); border:1px solid var(--border); border-radius:6px;
    box-shadow:0 8px 24px rgba(0,0,0,.4); padding:8px 10px; font:12px/1.5 var(--mono);
    color:var(--text-primary); white-space:pre-wrap; }
  .hover-tip.open { display:block; }
  .ritem { display:block; width:100%; text-align:left; padding:7px 10px; border-radius:5px; cursor:pointer;
    background:transparent; border:0; color:var(--text-primary); font:12.5px/1.6 var(--mono); }
  .ritem:hover { background:var(--bg-hover); }

  /* bottom dock */
  .dock { height:240px; flex:0 0 auto; background:var(--bg-primary); border-top:1px solid var(--border);
    display:flex; flex-direction:column; min-height:0; }
  .dock.hidden { display:none; }
  .dock-tabs { height:30px; flex:0 0 auto; display:flex; align-items:center; gap:2px; padding:0 8px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); }
  .dtab { display:flex; align-items:center; gap:6px; height:24px; padding:0 9px; border-radius:5px;
    color:var(--text-secondary); font-size:12px; }
  .dtab:hover { background:var(--bg-hover); color:var(--text-primary); }
  .dtab.active { color:var(--text-primary); background:var(--bg-active); }
  .dtab .ic { color:var(--icon-default); }
  .dtab.active .ic { color:var(--accent); }
  .dock-tabs .spacer { flex:1; }
  .dock-body { flex:1; overflow:auto; min-height:0; padding:8px 12px; }
  .dock-pane { display:none; height:100%; }
  .dock-pane.active { display:block; }

  /* console (run / terminal) */
  .console { font:12px/1.55 var(--mono); white-space:pre-wrap; word-break:break-word; }
  .console .cmd { color:var(--syn-func); }
  .console .err { color:var(--error); }
  .console .ok { color:var(--success); }
  .console .dim { color:var(--text-tertiary); }

  /* interactive terminal */
  .term { display:flex; flex-direction:column; height:100%; font:12px/1.5 var(--mono); }
  .term-out { flex:1; overflow:auto; white-space:pre-wrap; word-break:break-word; padding-bottom:4px; }
  .term-out .err { color:var(--error); }
  .term-out .dim { color:var(--text-tertiary); }
  .term-out .ok { color:var(--success); }
  .term-out .acc { color:var(--accent); }
  .term-line { display:flex; align-items:center; gap:8px; border-top:1px solid var(--border-soft); padding-top:5px; flex:0 0 auto; }
  .term-line .prompt { color:var(--success); flex:0 0 auto; white-space:nowrap; }
  .term-in { flex:1; min-width:0; background:transparent; border:0; outline:none; color:var(--text-primary); font:inherit; caret-color:var(--accent); }

  /* Find in Files (bottom dock) */
  .find-bar { display:flex; align-items:center; gap:6px; margin-bottom:8px; }
  .find-bar input { flex:1; max-width:420px; background:var(--bg-primary); border:1px solid var(--border); border-radius:6px;
    padding:5px 9px; color:var(--text-primary); font:12.5px var(--mono); outline:none; }
  .find-bar input:focus { border-color:var(--accent); }
  .find-out { font-size:12px; }
  .find-out .empty { color:var(--text-tertiary); }
  .fgroup { margin-bottom:10px; }
  .fhead { font-weight:600; color:var(--text-secondary); padding:2px 0; position:sticky; top:0; background:var(--bg-secondary); }
  .fhit { display:flex; gap:8px; padding:2px 6px; border-radius:4px; cursor:default; align-items:baseline; }
  .fhit:hover { background:var(--bg-hover); }
  .fhit .fl { color:var(--text-tertiary); flex:0 0 auto; font:11px var(--mono); }
  .fhit .dim { color:var(--text-tertiary); }

  /* problems */
  .prob { display:flex; gap:8px; align-items:flex-start; padding:5px 4px; border-bottom:1px solid var(--border-soft); font-size:12.5px; }
  .prob .ic { margin-top:1px; }
  .prob.error .ic { color:var(--error); }
  .prob.warn .ic { color:var(--warning); }
  .prob .loc { color:var(--text-tertiary); font-family:var(--mono); font-size:11.5px; }
  .prob .msg { flex:1; }
  .empty { color:var(--text-tertiary); font-size:12px; padding:8px 2px; }

  /* performance cards */
  .perf-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; }
  .pcard { border:1px solid var(--border); border-radius:8px; padding:9px 11px; background:var(--bg-secondary); }
  .pcard .nm { font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:.4px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pcard .big { font:600 19px/1.2 var(--mono); margin:3px 0 5px; }
  .pcard .row { display:flex; justify-content:space-between; font-size:11px; color:var(--text-tertiary); font-family:var(--mono); }
  .spark { display:block; width:100%; height:34px; margin-top:6px; }

  /* logs */
  .logs-toolbar { display:flex; align-items:center; gap:8px; margin-bottom:6px; position:sticky; top:-8px;
    background:var(--bg-primary); padding:4px 0; z-index:2; }
  .logs-toolbar select { background:var(--bg-tertiary); color:var(--text-primary); border:1px solid var(--border);
    border-radius:5px; padding:2px 6px; font-size:12px; }
  .logline { font:12px/1.5 var(--mono); padding:2px 4px; border-radius:4px; display:flex; gap:8px; }
  .logline:hover { background:var(--bg-hover); }
  .logline .t { color:var(--text-tertiary); flex:0 0 auto; }
  .logline .lv { flex:0 0 52px; font-weight:600; }
  .logline .cp { flex:0 0 150px; color:var(--syn-class); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .logline .ms { flex:1; word-break:break-word; }
  .lv-TRACE,.lv-DEBUG { color:var(--text-tertiary); }
  .lv-INFO { color:var(--success); }
  .lv-WARN { color:var(--warning); }
  .lv-ERROR,.lv-FATAL { color:var(--error); }
  .lv-AUDIT,.lv-METRIC { color:var(--accent); }

  /* status bar */
  .status { display:flex; align-items:center; gap:0; background:var(--bg-secondary); border-top:1px solid var(--border);
    font-size:11.5px; color:var(--text-secondary); padding:0 4px; }
  .status .cell { display:flex; align-items:center; gap:5px; padding:0 9px; height:100%; border-radius:4px; white-space:nowrap; }
  .status .cell:hover { background:var(--bg-hover); color:var(--text-primary); }
  /* Only the language-mode cell is a control; the rest are read-only readouts. */
  .status .cell.act { cursor:pointer; }
  .status .cell .ic { color:var(--icon-default); }
  .status .grow { flex:1; }
  .status .mem.ok { color:var(--success); }
  .status .mem.warn { color:var(--warning); }

  /* modal (search everywhere / extensions / about) */
  .scrim { position:fixed; inset:0; background:rgba(0,0,0,.35); display:none; z-index:80; }
  .scrim.open { display:block; }
  .modal { position:fixed; z-index:90; left:50%; top:12%; transform:translateX(-50%); width:min(680px,92vw);
    background:var(--bg-tertiary); border:1px solid var(--border); border-radius:12px; box-shadow:var(--shadow);
    display:none; overflow:hidden; }
  .modal.open { display:block; }
  .modal .mtop { display:flex; align-items:center; gap:10px; padding:12px 14px; border-bottom:1px solid var(--border); }
  .modal .mtop input { flex:1; background:transparent; border:0; outline:none; color:var(--text-primary); font:14px var(--sans); }
  .modal .chips { display:flex; gap:6px; padding:8px 14px; border-bottom:1px solid var(--border); }
  .modal .chip { font-size:11.5px; padding:2px 9px; border-radius:9px; border:1px solid var(--border); color:var(--text-secondary); }
  .modal .chip.on { color:#fff; background:var(--accent); border-color:var(--accent); }
  .modal .mbody { max-height:52vh; overflow:auto; padding:6px; }
  .mres { display:flex; align-items:center; gap:10px; padding:7px 10px; border-radius:6px; cursor:pointer; }
  .mres:hover, .mres.sel { background:var(--accent); color:#fff; }
  .mres .nm { flex:1; }
  .mres .path { color:var(--text-tertiary); font-size:11.5px; font-family:var(--mono); }
  .mres:hover .path, .mres.sel .path { color:rgba(255,255,255,.8); }
  .mres .ic { color:var(--icon-default); }
  .mres:hover .ic, .mres.sel .ic { color:#fff; }
  .mgrp { padding:8px 12px 3px; font-size:10.5px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-tertiary); }

  /* extensions modal list */
  .xrow { border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:8px; }
  .xrow .top { display:flex; align-items:center; gap:8px; }
  .xrow .nm { font-weight:600; }
  .xrow .state { margin-left:auto; font-size:11px; padding:1px 8px; border-radius:8px; border:1px solid var(--border); color:var(--text-secondary); }
  .xrow .state.ready { color:var(--success); border-color:var(--success); }
  .xrow .state.crashed { color:var(--error); border-color:var(--error); }
  .xrow .meta { color:var(--text-tertiary); font-size:11.5px; font-family:var(--mono); margin-top:2px; }
  .xrow .cmds { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .xrow .cmds button { font-size:11.5px; padding:3px 9px; border:1px solid var(--border); border-radius:5px; }
  .xrow .cmds button:hover { border-color:var(--accent); color:var(--accent); }

  .toast { position:fixed; left:50%; bottom:36px; transform:translateX(-50%); background:var(--bg-tertiary);
    border:1px solid var(--border); border-radius:8px; padding:8px 14px; font-size:12.5px; box-shadow:var(--shadow);
    opacity:0; transition:opacity .18s; pointer-events:none; z-index:120; }
  .toast.show { opacity:1; }

  /* PyCharm-style dialog (one component behind every modal in the shell) */
  .dlg-scrim { position:fixed; inset:0; background:rgba(0,0,0,.42); z-index:130; display:flex;
    align-items:center; justify-content:center; padding:24px; }
  .dlg { width:min(460px,94vw); background:var(--bg-secondary); border:1px solid var(--border);
    border-radius:10px; box-shadow:0 12px 40px rgba(0,0,0,.5); overflow:hidden; }
  .dlg-title { display:flex; align-items:center; gap:8px; padding:10px 14px; font-size:13px; font-weight:600;
    border-bottom:1px solid var(--border-soft); }
  .dlg-body { padding:14px; display:flex; flex-direction:column; gap:10px; max-height:56vh; overflow:auto; }
  .dlg-msg { font-size:12.5px; line-height:1.6; color:var(--text-primary); }
  .dlg-msg .sub { color:var(--text-secondary); }
  .dlg-list { border:1px solid var(--border-soft); border-radius:6px; max-height:180px; overflow:auto; }
  .dlg-list .row { display:flex; align-items:center; gap:8px; padding:5px 10px; font-size:12px; }
  .dlg-list .row + .row { border-top:1px solid var(--border-soft); }
  .dlg-list .row .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dlg-field { display:flex; flex-direction:column; gap:4px; }
  .dlg-field label { font-size:11.5px; color:var(--text-secondary); }
  .dlg-field input { background:var(--bg-primary); border:1px solid var(--border); border-radius:6px;
    padding:6px 9px; color:var(--text-primary); font:12.5px var(--mono); outline:none; }
  .dlg-field input:focus { border-color:var(--accent); }
  .dlg-field .err { font-size:11px; color:var(--error); min-height:13px; }
  .dlg-check { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--text-secondary); }
  .dlg-detail { background:var(--bg-primary); border:1px solid var(--border-soft); border-radius:6px;
    padding:8px 10px; font:11.5px/1.5 var(--mono); white-space:pre-wrap; max-height:180px; overflow:auto; }
  .dlg-foot { display:flex; justify-content:flex-end; gap:8px; padding:10px 14px; border-top:1px solid var(--border-soft); }
  .dlg-btn { height:26px; padding:0 14px; border-radius:6px; border:1px solid var(--border);
    background:var(--bg-tertiary); color:var(--text-primary); font-size:12px; cursor:default; }
  .dlg-btn:hover { border-color:var(--accent); }
  .dlg-btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .dlg-btn.danger { background:var(--error); border-color:var(--error); color:#fff; }
  .dlg-btn:disabled { opacity:.45; }

  /* PyCharm balloon (bottom-right, never a page toast) */
  #balloons { position:fixed; right:14px; bottom:30px; z-index:140; display:flex; flex-direction:column-reverse;
    gap:8px; pointer-events:none; }
  .balloon { pointer-events:auto; display:flex; gap:9px; align-items:flex-start; min-width:260px; max-width:380px;
    background:var(--bg-secondary); border:1px solid var(--border); border-left:3px solid var(--accent);
    border-radius:8px; padding:9px 11px; box-shadow:0 6px 20px rgba(0,0,0,.35); }
  .balloon.warning { border-left-color:var(--warn, #e2b93d); }
  .balloon.error { border-left-color:var(--error); }
  .balloon.success { border-left-color:#4ec9b0; }
  .balloon .bt { font-size:12.5px; font-weight:600; }
  .balloon .bm { font-size:11.5px; color:var(--text-secondary); line-height:1.5; }
  .balloon .ba { display:flex; gap:10px; margin-top:4px; }
  .balloon .ba a { font-size:11.5px; color:var(--accent); cursor:pointer; }
  .balloon .bx { margin-left:auto; color:var(--text-tertiary); cursor:pointer; font-size:13px; line-height:1; }

  /* inline rename (project tree / tabs) — PyCharm renames in place */
  .inline-rename { background:var(--bg-primary); border:1px solid var(--accent); border-radius:4px;
    color:var(--text-primary); font:12.5px var(--mono); padding:1px 4px; outline:none; width:100%; min-width:60px; }
  /* self-drawn dropdown (replaces <select>) */
  .dd { display:inline-flex; align-items:center; gap:5px; height:22px; padding:0 7px; border-radius:5px;
    border:1px solid var(--border); background:var(--bg-primary); color:var(--text-primary); font-size:11.5px; }
  .dd:hover { border-color:var(--accent); }
  .dd .ic { color:var(--text-tertiary); }
  /* self-drawn title bar (Tauri only — OS chrome is off) */
  .titlebar { display:none; height:32px; flex:0 0 auto; align-items:center; gap:6px; padding:0 2px 0 10px;
    background:var(--bg-secondary); border-bottom:1px solid var(--border); -webkit-app-region:drag; user-select:none; }
  html[data-tauri="1"] .titlebar { display:flex; }
  .titlebar .tb-title { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-secondary); }
  .titlebar .tb-spacer { flex:1; -webkit-app-region:drag; }
  .titlebar .tb-btn { -webkit-app-region:no-drag; width:38px; height:26px; border:none; background:transparent;
    color:var(--text-secondary); display:flex; align-items:center; justify-content:center; cursor:default; }
  .titlebar .tb-btn:hover { background:var(--bg-hover); }
  .titlebar .tb-close:hover { background:var(--error); color:#fff; }
  /* transient status-bar hint (save feedback) */
  .status .cell.hint { color:var(--text-tertiary); opacity:0; transition:opacity .15s; }
  .status .cell.hint.on { opacity:1; color:var(--accent); }
</style>
</head>
<body>
<div class="ide">
  <!-- self-drawn title bar (Tauri only: the OS chrome is off, so the shell owns
       dragging and the window controls). Hidden in the web preview. -->
  <div class="titlebar" data-tauri-only>
    <span class="tb-title"><span class="ic" data-ic="project" data-size="14"></span>Nolanguage</span>
    <span class="tb-spacer"></span>
    <button class="tb-btn" id="tbMin" title="Minimize" aria-label="Minimize"><span class="ic" data-ic="min" data-size="14"></span></button>
    <button class="tb-btn" id="tbMax" title="Maximize" aria-label="Maximize"><span class="ic" data-ic="max" data-size="14"></span></button>
    <button class="tb-btn tb-close" id="tbClose" title="Close" aria-label="Close"><span class="ic" data-ic="close" data-size="14"></span></button>
  </div>
  <!-- menu bar -->
  <div class="menubar" id="menubar">
    <span class="brand">Nolanguage</span>
    <!-- menus injected -->
    <span class="spacer"></span>
  </div>

  <!-- main toolbar -->
  <div class="toolbar">
    <button class="widget" id="projWidget" title="Project"><span class="ic" data-ic="project" data-size="16"></span><span class="lbl">Project:</span><span class="val">Nolanguage</span><span class="ic" data-ic="chevD" data-size="14"></span></button>
    <button class="widget" id="vcsWidget" title="Version Control"><span class="ic" data-ic="vcs" data-size="16"></span><span class="lbl">Git:</span><span class="val" id="branchVal">main</span><span class="ic" data-ic="chevD" data-size="14"></span></button>
    <div class="widget" style="gap:4px">
      <button class="tbtn iconly" id="cfgBtn" title="Run configurations"><span class="val" style="padding:0 2px">main</span><span class="ic" data-ic="chevD" data-size="14"></span></button>
    </div>
    <div class="run-group">
      <button class="tbtn primary" id="runBtn" title="Run 'main'  (Shift+F10)"><span class="ic" data-ic="run" data-size="16"></span>Run</button>
      <button class="tbtn" id="debugBtn" title="Debug 'main'  (Shift+F9)"><span class="ic" data-ic="debug" data-size="16"></span>Debug</button>
      <button class="tbtn iconly" id="covBtn" title="Run with coverage"><span class="ic" data-ic="coverage" data-size="16"></span></button>
      <button class="tbtn iconly" id="stopBtn" title="Stop"><span class="ic" data-ic="stop" data-size="16"></span></button>
    </div>
    <span class="spacer"></span>
    <button class="tbtn iconly" id="searchBtn" title="Search Everywhere  (double Shift)"><span class="ic" data-ic="search" data-size="16"></span></button>
    <button class="tbtn iconly" id="themeBtn" title="Toggle theme"><span class="ic" data-ic="ai" data-size="16"></span></button>
    <button class="tbtn iconly" id="settingsBtn" title="Settings  (Ctrl+Alt+S)"><span class="ic" data-ic="settings" data-size="16"></span></button>
  </div>

  <!-- work area -->
  <div class="work">
    <div class="strip" id="strip"></div>
    <div class="panel hidden" id="leftPanel">
      <div class="tw-head">
        <span class="title" id="panelTitle">Project</span>
        <button class="tbtn" id="collapseBtn" title="Collapse all"><span class="ic" data-ic="collapse" data-size="16"></span></button>
        <button class="tbtn" id="newBtn" title="New file in project root">+</button>
        <button class="tbtn" title="View options"><span class="ic" data-ic="settings" data-size="16"></span></button>
        <button class="tbtn" title="More"><span class="ic" data-ic="more" data-size="16"></span></button>
        <button class="tbtn" id="pinBtn" title="Pin / unpin"><span class="ic" data-ic="pin" data-size="16"></span></button>
        <button class="tbtn" id="panelCloseBtn" title="Hide"><span class="ic" data-ic="close" data-size="16"></span></button>
      </div>
      <div class="tw-body" id="panelBody" data-ctx="panel"></div>
    </div>
    <div class="center">
      <div class="etabs" id="etabs" data-ctx="tab"></div>
      <div class="edwrap" data-ctx="editor">
        <div class="gutter" id="gutter"><div class="glines" id="glines"></div></div>
        <div class="codewrap">
          <div class="curline" id="curline"></div>
          <pre id="hl" aria-hidden="true"><code id="hlCode"></code></pre>
          <textarea id="ta" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea>
        </div>
        <div class="cmp" id="cmp"></div>
        <div class="hover-tip" id="hoverTip"></div>
      </div>
      <div class="dock" id="dock" data-ctx="dock">
        <div class="dock-tabs" id="dockTabs">
          <span class="spacer"></span>
          <button class="tbtn iconly" id="dockHide" title="Hide"><span class="ic" data-ic="close" data-size="14"></span></button>
        </div>
        <div class="dock-body" id="dockBody"></div>
      </div>
    </div>
  </div>

  <!-- status bar -->
  <div class="status">
    <span class="cell" id="stFile">main.py</span>
    <span class="cell" id="stLang"><span class="ic" data-ic="file" data-size="14"></span>Python 3.11</span>
    <span class="cell hint" id="stHint"></span>
    <span class="cell" id="stPos">Ln 1, Col 1</span>
    <span class="cell" id="stEnc">UTF-8</span>
    <span class="cell" id="stEol">LF</span>
    <span class="cell" id="stProblems" title="Problems">0 problems</span>
    <span class="grow"></span>
    <span class="cell mem ok" id="stPerf" title="Performance"><span class="ic" data-ic="perf" data-size="14"></span><span id="stPerfVal">P95 —</span></span>
    <span class="cell" id="stGit"><span class="ic" data-ic="vcs" data-size="14"></span>Git: main</span>
  </div>
</div>

<!-- search everywhere -->
<div class="scrim" id="scrim"></div>
<div class="ctxmenu" id="ctxMenu"></div>
<div class="modal" id="searchModal">
  <div class="mtop"><span class="ic" data-ic="search" data-size="18"></span><input id="searchInput" placeholder="Search Everything (files, symbols, actions)…" /><button class="tbtn iconly" id="searchClose"><span class="ic" data-ic="close" data-size="16"></span></button></div>
  <div class="chips" id="searchChips">
    <button class="chip on" data-tab="all">All</button>
    <button class="chip" data-tab="files">Files</button>
    <button class="chip" data-tab="symbols">Symbols</button>
    <button class="chip" data-tab="actions">Actions</button>
  </div>
  <div class="mbody" id="searchBody"></div>
</div>

<!-- extensions -->
<div class="modal" id="extModal" style="top:16%; width:min(560px,92vw)">
  <div class="mtop"><span class="ic" data-ic="database" data-size="18"></span><b>Extensions</b><span class="grow" style="flex:1"></span><button class="tbtn iconly" id="extClose"><span class="ic" data-ic="close" data-size="16"></span></button></div>
  <div class="mbody" id="extBody"></div>
</div>

<!-- about -->
<div class="modal" id="aboutModal" style="top:20%; width:min(440px,92vw)">
  <div class="mtop"><span class="ic" data-ic="ai" data-size="18"></span><b>About</b><span style="flex:1"></span><button class="tbtn iconly" id="aboutClose"><span class="ic" data-ic="close" data-size="16"></span></button></div>
  <div class="mbody" id="aboutBody" style="padding:16px; font-size:13px"></div>
</div>

<!-- recent files -->
<div class="modal" id="recentModal" style="top:18%; width:min(520px,92vw)">
  <div class="mtop"><span class="ic" data-ic="file" data-size="18"></span><b>Recent Files</b><span style="flex:1"></span><button class="tbtn iconly" id="recentClose"><span class="ic" data-ic="close" data-size="16"></span></button></div>
  <div class="mbody" id="recentBody"></div>
</div>

<!-- language mode: the default is the file type, this is the explicit override -->
<div class="modal" id="langModal" style="top:16%; width:min(460px,92vw)">
  <div class="mtop"><span class="ic" data-ic="file" data-size="18"></span><input id="langInput" placeholder="Change language mode (default: file type)…" /><button class="tbtn iconly" id="langClose"><span class="ic" data-ic="close" data-size="16"></span></button></div>
  <div class="mbody" id="langBody"></div>
</div>

<div class="toast" id="toast"></div>

<!-- PyCharm-style dialogs and balloons are built here at runtime -->
<div id="dlgRoot"></div>
<div id="balloons"></div>
<script>
(function () {
  "use strict";
  var ICONS = ${iconsJson};
  var PY_PATTERN = ${patternJson};
  var FILES = {
    "main.py": ${mainJson},
    "utils.py": ${utilsJson},
    "main.js": ${jsJson},
    "README.md": ${readmeJson}
  };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function ic(name, size) {
    var d = ICONS[name]; if (!d) return "";
    return '<svg class="ic" viewBox="' + d.vb + '" width="' + size + '" height="' + size +
      '" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d.d + '</svg>';
  }
  function paintIcons(root) {
    (root || document).querySelectorAll('[data-ic]').forEach(function (el) {
      el.innerHTML = ic(el.getAttribute('data-ic'), el.getAttribute('data-size') || 16);
    });
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  var toastT;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 1800); }

  // ---------- PyCharm-style interaction layer ----------
  // Three rules, applied everywhere:
  //   1. the browser's own dialogs are disabled outright (they are a web page's
  //      vocabulary, and a native IDE never shows them);
  //   2. anything that must ask the user goes through showModal — one
  //      component behind the naming dialog, delete confirmation, settings, run
  //      configurations and error reporting;
  //   3. anything that merely informs goes through balloon — bottom-right,
  //      typed, auto-dismissing, never blocking.
  // toast() is kept as the internal one-line shorthand over balloon.
  (function disableBrowserDialogs() {
    // Safety net: a missed call site degrades to a balloon instead of a browser
    // popup. Returning false/null (rather than throwing) keeps a stale caller
    // from crashing the shell.
    window.alert = function (msg) { balloon({ type: 'warning', title: 'Notice', message: String(msg) }); };
    window.confirm = function (msg) { balloon({ type: 'warning', title: 'Confirm', message: String(msg) + ' (cancelled)' }); return false; };
    window.prompt = function (msg) { balloon({ type: 'warning', title: 'Input', message: String(msg) }); return null; };
  })();

  /** Bottom-right balloon. type is info | success | warning | error. */
  function balloon(o) {
    var host = $('balloons'); if (!host) return;
    var el = document.createElement('div');
    el.className = 'balloon ' + (o.type || 'info');
    var body = '<div style="flex:1;min-width:0">' +
      '<div class="bt">' + esc(o.title || '') + '</div>' +
      (o.message ? '<div class="bm">' + esc(o.message) + '</div>' : '') +
      (o.actions && o.actions.length
        ? '<div class="ba">' + o.actions.map(function (a, i) { return '<a data-i="' + i + '">' + esc(a.label) + '</a>'; }).join('') + '</div>'
        : '') +
      '</div><div class="bx" data-close="1">&#x2715;</div>';
    el.innerHTML = body;
    el.querySelectorAll('.ba a').forEach(function (a) {
      a.addEventListener('click', function () { var i = +a.getAttribute('data-i'); var act = o.actions[i]; if (act && act.onClick) act.onClick(); dismiss(); });
    });
    el.querySelector('[data-close]').addEventListener('click', dismiss);
    host.appendChild(el);
    var timer = setTimeout(dismiss, o.duration || (o.type === 'error' ? 8000 : 4000));
    function dismiss() { clearTimeout(timer); if (el.parentNode) el.parentNode.removeChild(el); }
  }

  /**
   * The one dialog. Options: title, icon, message, sub, list[{icon,label}],
   * fields[{name,label,value,placeholder,validator}], checkboxes[{name,label,default}],
   * detail, buttons[{label,primary,danger,onClick(values)}].
   * Enter submits the primary button; Escape cancels. Focus starts on the first
   * field (PyCharm selects the whole name so typing replaces it).
   */
  function showModal(o) {
    var root = $('dlgRoot'); if (!root) return null;
    var prev = root.querySelector('.dlg-scrim'); if (prev) root.removeChild(prev);
    var scrim = document.createElement('div');
    scrim.className = 'dlg-scrim';
    var card = document.createElement('div');
    card.className = 'dlg';
    var html = '<div class="dlg-title">' + (o.icon ? '<span class="ic">' + ic(o.icon, 15) + '</span>' : '') +
      '<span>' + esc(o.title || '') + '</span></div><div class="dlg-body">';
    if (o.message) html += '<div class="dlg-msg">' + esc(o.message) + (o.sub ? '<div class="sub">' + esc(o.sub) + '</div>' : '') + '</div>';
    if (o.list && o.list.length) {
      html += '<div class="dlg-list">' + o.list.map(function (r) {
        return '<div class="row"><span class="ic">' + ic(r.icon || 'file', 14) + '</span><span class="nm">' + esc(r.label) + '</span></div>';
      }).join('') + '</div>';
    }
    (o.fields || []).forEach(function (f) {
      html += '<div class="dlg-field"><label>' + esc(f.label || '') + '</label>' +
        '<input data-f="' + esc(f.name) + '" type="text" value="' + esc(f.value == null ? '' : f.value) + '"' +
        ' placeholder="' + esc(f.placeholder || '') + '" spellcheck="false" />' +
        '<div class="err" data-err="' + esc(f.name) + '"></div></div>';
    });
    (o.checkboxes || []).forEach(function (c) {
      html += '<label class="dlg-check"><input type="checkbox" data-c="' + esc(c.name) + '"' + (c.def ? ' checked' : '') + ' />' + esc(c.label) + '</label>';
    });
    if (o.detail) html += '<div class="dlg-detail">' + esc(o.detail) + '</div>';
    html += '</div><div class="dlg-foot"></div>';
    card.innerHTML = html;
    var foot = card.querySelector('.dlg-foot');
    var primaryBtn = null;
    (o.buttons || [{ label: 'OK', primary: true }]).forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'dlg-btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', function () { submit(b); });
      foot.appendChild(btn);
      if (b.primary && !primaryBtn) primaryBtn = btn;
    });
    scrim.appendChild(card);
    root.appendChild(scrim);

    var inputs = Array.prototype.slice.call(card.querySelectorAll('input[data-f]'));
    function values() {
      var v = {};
      inputs.forEach(function (i) { v[i.getAttribute('data-f')] = i.value; });
      card.querySelectorAll('input[data-c]').forEach(function (c) { v[c.getAttribute('data-c')] = c.checked; });
      return v;
    }
    function validate() {
      var ok = true;
      (o.fields || []).forEach(function (f) {
        var err = f.validator ? f.validator(values()[f.name]) : null;
        var slot = card.querySelector('[data-err="' + f.name + '"]');
        if (slot) slot.textContent = err || '';
        if (err) ok = false;
      });
      return ok;
    }
    function submit(b) {
      if (!validate()) return;
      close();
      if (b && b.onClick) b.onClick(values());
    }
    function close() { if (scrim.parentNode) scrim.parentNode.removeChild(scrim); }
    inputs.forEach(function (i) {
      i.addEventListener('input', validate);
      i.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); if (primaryBtn) primaryBtn.click(); }
        if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
    });
    scrim.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });
    // PyCharm selects the whole default name so typing replaces it.
    if (inputs.length) { inputs[0].focus(); inputs[0].select(); }
    else if (primaryBtn) primaryBtn.focus();
    return { close: close, values: values };
  }

  /** Confirm with typed buttons; buttons default to Cancel / OK. */
  function confirmDialog(o) {
    var btns = o.buttons || [
      { label: 'Cancel', onClick: function () {} },
      { label: o.okLabel || 'OK', primary: true, onClick: function () {} },
    ];
    return showModal({
      title: o.title || 'Confirm',
      icon: o.icon || 'warn',
      message: o.message,
      sub: o.sub,
      list: o.list,
      detail: o.detail,
      buttons: btns,
    });
  }
  /** Input with optional validation; resolves through the caller's callback. */
  function inputDialog(o) {
    return showModal({
      title: o.title || 'Input',
      icon: o.icon,
      message: o.message,
      fields: [{ name: 'value', label: o.label || 'Value', value: o.value, placeholder: o.placeholder, validator: o.validator }],
      buttons: [
        { label: 'Cancel', onClick: function () {} },
        { label: o.okLabel || 'OK', primary: true, onClick: function (v) { if (o.onSubmit) o.onSubmit(v.value); } },
      ],
    });
  }
  /** Error report: modal for real errors, balloon for warnings, nothing for info. */
  function reportError(o) {
    var level = o.level || 'error';
    if (level === 'error' || level === 'fatal') {
      showModal({
        title: o.title || 'Error',
        icon: 'close',
        message: o.message,
        detail: o.detail,
        buttons: [
          { label: 'Copy', onClick: function () { copyText((o.message || '') + (o.detail ? '\\n' + o.detail : '')); } },
          o.canRetry ? { label: 'Retry', primary: true, onClick: o.onRetry } : null,
          { label: 'OK', primary: !o.canRetry, onClick: function () {} },
        ].filter(Boolean),
      });
    } else {
      balloon({
        type: level === 'info' ? 'info' : 'warning',
        title: o.title || 'Warning',
        message: o.message + (o.detail ? '\\n' + o.detail : ''),
      });
    }
  }


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
   * \fromServer\ is the backend's own extension mapping, which knows more
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
        T.invoke('plugin:event|listen', {
          event: name,
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

  // ---------- editor ----------
  var ta = $('ta'), hlCode = $('hlCode'), hl = $('hl'), glines = $('glines');
  var currentFile = 'main.py';
  var currentLang = 'python';
  var BREAKPOINTS = { 9: true }; // 1-based line numbers with a breakpoint
  var folded = {}; // line -> collapsed

  // ---------- multi-language tokeniser (dependency-free) ----------
  // Newline / tab / backtick / angle brackets are built from char codes so this
  // block needs no backslash escapes (the whole script is a template literal).
  // Rules also avoid digit/word/space/boundary escapes: character classes and
  // lookarounds are used, and each rule is anchored per position (sticky y).
  var NLc = String.fromCharCode(10);
  var TABc = String.fromCharCode(9);
  var BT = String.fromCharCode(96);
  var LT = String.fromCharCode(60);
  var GT = String.fromCharCode(62);
  var WB = '(?<![A-Za-z0-9_])';
  var WA = '(?![A-Za-z0-9_])';
  var LANG_RULES = {
    go: [
      { re: '//[^' + NLc + ']*', cls: 'c' },
      { re: '[/][*][^]*?[*][/]', cls: 'c' },
      { re: BT + '[^' + BT + ']*' + BT, cls: 's' },
      { re: '"[^"]*"', cls: 's' },
      { re: "'[^']*'", cls: 's' },
      { re: WB + '(?:package|import|func|return|if|else|for|range|var|const|type|struct|interface|map|chan|go|defer|select|switch|case|default|break|continue|nil|true|false|make|new|append|len|cap)' + WA, cls: 'k' },
      { re: WB + '(?:string|int|int8|int16|int32|int64|uint|uint64|float32|float64|bool|byte|rune|error|any)' + WA, cls: 'b' },
      { re: '[0-9][0-9_]*(?:[.][0-9]+)?(?:[eE][+-]?[0-9]+)?', cls: 'n' },
      { re: '[A-Za-z_][A-Za-z0-9_]*(?=[(])', cls: 'f' }
    ],
    json: [
      { re: '"[^"]*"(?=[ ]*:)', cls: 'f' },
      { re: '"[^"]*"', cls: 's' },
      { re: WB + '(?:true|false|null)' + WA, cls: 'k' },
      { re: '[-]?[0-9]+(?:[.][0-9]+)?(?:[eE][+-]?[0-9]+)?', cls: 'n' }
    ],
    markdown: [
      { re: BT + BT + BT + '[^]*?' + BT + BT + BT, cls: 's' },
      { re: BT + '[^' + BT + NLc + ']*' + BT, cls: 's' },
      { re: '^#{1,6}[^' + NLc + ']*', cls: 'k', f: 'm' },
      { re: '[*][*][^' + NLc + ']+[*][*]', cls: 'b' },
      { re: '[*][^' + NLc + '*]+[*]', cls: 'd' },
      { re: '[[][^]]*[]][(][^)]*[)]', cls: 'f' },
      { re: '^[ ]*[-*+][ ]', cls: 'k', f: 'm' },
      { re: '^>[^' + NLc + ']*', cls: 'c', f: 'm' }
    ],
    yaml: [
      { re: '#[^' + NLc + ']*', cls: 'c' },
      { re: '"[^"]*"', cls: 's' },
      { re: "'[^']*'", cls: 's' },
      { re: '^[ ]*[A-Za-z0-9_.$-]+(?=[ ]*:)', cls: 'f', f: 'm' },
      { re: WB + '(?:true|false|null|yes|no|on|off)' + WA, cls: 'k' },
      { re: '[0-9]+(?:[.][0-9]+)?', cls: 'n' }
    ],
    javascript: [
      { re: '//[^' + NLc + ']*', cls: 'c' },
      { re: '[/][*][^]*?[*][/]', cls: 'c' },
      { re: BT + '[^' + BT + ']*' + BT, cls: 's' },
      { re: '"[^"]*"', cls: 's' },
      { re: "'[^']*'", cls: 's' },
      { re: WB + '(?:const|let|var|function|return|if|else|for|while|do|class|extends|new|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|of|in|void|delete|switch|case|break|continue|null|undefined|true|false|this|super|yield|interface|type|enum|public|private|protected|readonly|as)' + WA, cls: 'k' },
      { re: WB + '(?:console|process|globalThis|Math|JSON|Object|Array|Number|String|Boolean|Symbol|BigInt|Promise|Map|Set|WeakMap|Date|RegExp|Error|TypeError|RangeError|SyntaxError|parseInt|parseFloat|isNaN|structuredClone)' + WA, cls: 'b' },
      { re: '[0-9][0-9_]*(?:[.][0-9]+)?', cls: 'n' },
      { re: '[A-Za-z_$][A-Za-z0-9_$]*(?=[(])', cls: 'f' }
    ],
    html: [
      { re: LT + '!--[^]*?--' + GT, cls: 'c' },
      { re: LT + '[/]?[A-Za-z][A-Za-z0-9-]*', cls: 'k' },
      { re: '"[^"]*"', cls: 's' },
      { re: "'[^']*'", cls: 's' },
      { re: '[A-Za-z-:]+(?==)', cls: 'd' }
    ],
    css: [
      { re: '[/][*][^]*?[*][/]', cls: 'c' },
      { re: '"[^"]*"', cls: 's' },
      { re: "'[^']*'", cls: 's' },
      { re: '#[0-9A-Fa-f]{3,8}', cls: 'n' },
      { re: '[0-9]+(?:[.][0-9]+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr|pt)?', cls: 'n' },
      { re: '[@][A-Za-z-]+', cls: 'k' },
      { re: '[.][A-Za-z_-][A-Za-z0-9_-]*(?=[ ,{:.])', cls: 'cl' }
    ]
  };
  var RULES = (function () {
    var out = {};
    Object.keys(LANG_RULES).forEach(function (lang) {
      out[lang] = LANG_RULES[lang].map(function (r) { return { re: new RegExp(r.re, 'y' + (r.f || '')), cls: r.cls }; });
    });
    out.typescript = out.javascript;
    return out;
  })();
  function tokenizeRules(code, rules) {
    if (!rules || code.length > 200000) return esc(code);
    var out = '', i = 0, n = code.length;
    while (i < n) {
      var hit = false;
      for (var r = 0; r < rules.length; r++) {
        var re = rules[r].re; re.lastIndex = i;
        var mm = re.exec(code);
        if (mm && mm.index === i && mm[0].length > 0) {
          out += '<span class="tok-' + rules[r].cls + '">' + esc(mm[0]) + '</span>';
          i += mm[0].length; hit = true; break;
        }
      }
      if (!hit) { out += esc(code[i]); i++; }
    }
    return out;
  }
  // ---------- language catalogue ----------
  // The backend's plugin registry is authoritative: it arrives as a "workspace"
  // message on connect and carries display names, extensions, capabilities and
  // grammar rules straight from each manifest.json. The tables below are the
  // *offline bootstrap* — what the page can do before that message lands (and
  // if it is opened with no backend at all). Installing a language plugin must
  // never require editing this file.
  var SERVER_LANGS = { python: true, go: true, javascript: true };
  var LANG_NAMES = {
    python: 'Python', go: 'Go', javascript: 'JavaScript', typescript: 'TypeScript',
    markdown: 'Markdown', json: 'JSON', yaml: 'YAML', toml: 'TOML',
    html: 'HTML', css: 'CSS', sql: 'SQL', shell: 'Shell Script', text: 'Plain text'
  };
  var EXT_LANG = {
    py: 'python', pyi: 'python', go: 'go', md: 'markdown', markdown: 'markdown',
    json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript',
    tsx: 'typescript', jsx: 'javascript', sh: 'shell', bash: 'shell',
    html: 'html', css: 'css', sql: 'sql', txt: 'text'
  };
  var LANG_LIST = [];
  /** Language ids that arrived from the backend catalogue (installed plugins). */
  var CATALOG_IDS = [];
  /** language id -> default extension (no dot), for the New… menu. */
  var DEFAULT_EXT = {};
  (function () {
    Object.keys(EXT_LANG).forEach(function (e) {
      var id = EXT_LANG[e];
      if (id && !DEFAULT_EXT[id]) DEFAULT_EXT[id] = e;
    });
  })();
  function rebuildLangList() {
    // The picker offers exactly what the highlighter can colour: a language
    // that silently rendered as plain text would be a worse answer than no
    // choice. Python has its own tokeniser; everything else needs RULES.
    var ids = ['python'].concat(Object.keys(RULES));
    CATALOG_IDS.forEach(function (id) {
      if (ids.indexOf(id) === -1 && RULES[id]) ids.push(id);
    });
    LANG_LIST = ids.map(function (id) { return { id: id, name: LANG_NAMES[id] || id }; });
  }
  rebuildLangList();
  /**
   * Merge the backend catalogue into the local tables. Idempotent: the message
   * is re-sent on every reconnect.
   */
  function applyLanguageCatalog(list) {
    if (!list || !list.length) return;
    list.forEach(function (l) {
      if (!l || !l.id) return;
      if (CATALOG_IDS.indexOf(l.id) === -1) CATALOG_IDS.push(l.id);
      LANG_NAMES[l.id] = l.displayName || l.id;
      // "the backend can act on this language": run it, check it, or both.
      SERVER_LANGS[l.id] = !!(l.supportsRun || l.hasLsp);
      (l.extensions || []).forEach(function (e) { EXT_LANG[String(e).replace(/^[.]/, '').toLowerCase()] = l.id; });
      if (l.defaultExt) {
        var de = String(l.defaultExt).replace(/^[.]/, '').toLowerCase();
        EXT_LANG[de] = l.id;
        DEFAULT_EXT[l.id] = de;
      }
      if (l.grammar && l.grammar.length) {
        RULES[l.id] = l.grammar.map(function (r) {
          try { return { re: new RegExp(r.re, 'y' + (r.flags || '')), cls: r.cls }; } catch (e) { return null; }
        }).filter(Boolean);
      }
    });
    rebuildLangList();
    renderStLang();
    if (currentFile) renderLangs('');
  }
  function langLabel(id) {
    for (var i = 0; i < LANG_LIST.length; i++) if (LANG_LIST[i].id === id) return LANG_LIST[i].name;
    return String(id || '');
  }
  /** The language id to send to the backend, or '' when it can do nothing with it. */
  function lspLang() { return SERVER_LANGS[currentLang] ? currentLang : ''; }
  function highlight(code) {
    if (currentLang !== 'python') return tokenizeRules(code, RULES[currentLang]);
    var re = new RegExp(PY_PATTERN, 'g'), out = '', last = 0, mm;
    while ((mm = re.exec(code))) {
      out += esc(code.slice(last, mm.index));
      var cls = mm[1] ? 'c' : mm[2] ? 's' : mm[3] ? 'd' : mm[4] ? 'k' : mm[5] ? 'n' : mm[6] ? 'b' : mm[7] ? 'f' : mm[8] ? 'cl' : '';
      out += '<span class="tok-' + cls + '">' + esc(mm[0]) + '</span>';
      last = mm.index + mm[0].length;
      if (mm[0].length === 0) re.lastIndex++;
    }
    out += esc(code.slice(last));
    return out;
  }
  function lineIndent(line) { var m = /^[ \\t]*/.exec(line); return m ? m[0].length : 0; }
  function isDefLine(line) { return /^[ \\t]*(def|class)\\b/.test(line); }

  function renderGutter(lines) {
    var html = '';
    for (var i = 0; i < lines.length; i++) {
      var n = i + 1;
      var cls = 'gline';
      if (BREAKPOINTS[n]) cls += ' hasbp';
      var defI = isDefLine(lines[i]) ? lineIndent(lines[i]) : -1;
      if (defI >= 0) {
        // foldable when the block has at least one deeper, non-blank line
        for (var j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '') continue;
          if (lineIndent(lines[j]) > defI) cls += ' foldable';
          break;
        }
      }
      var inner = '<span class="num">' + n + '</span>';
      if (BREAKPOINTS[n]) inner = '<span class="bp" data-bp="' + n + '"></span>' + inner;
      if (cls.indexOf('foldable') >= 0) inner = '<span class="fold" data-fold="' + n + '">' + (folded[n] ? ic('chevR', 12) : ic('chevD', 12)) + '</span>' + inner;
      html += '<div class="' + cls + '">' + inner + '</div>';
    }
    glines.innerHTML = html;
    glines.querySelectorAll('[data-bp]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); var n = +el.getAttribute('data-bp'); delete BREAKPOINTS[n]; renderEditor(); });
    });
    glines.querySelectorAll('[data-fold]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); var n = +el.getAttribute('data-fold'); if (folded[n]) delete folded[n]; else folded[n] = true; renderEditor(); });
    });
  }

  function visibleLines(code) {
    if (!Object.keys(folded).length) return code.split('\\n');
    var lines = code.split('\\n'), out = [], skipIndent = -1;
    for (var i = 0; i < lines.length; i++) {
      var n = i + 1;
      if (skipIndent >= 0) {
        if (lines[i].trim() !== '' && lineIndent(lines[i]) <= skipIndent) skipIndent = -1;
        else continue;
      }
      out.push(lines[i]);
      if (folded[n]) skipIndent = lineIndent(lines[i]);
    }
    return out;
  }

  function renderEditor() {
    var code = ta.value;
    var vis = visibleLines(code);
    hlCode.innerHTML = highlight(vis.join('\\n')) + '\\n';
    renderGutter(code.split('\\n'));
    syncScroll();
  }
  function syncScroll() {
    glines.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
    var cl = $('curline'); if (cl) cl.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
  }
  function updateCaret() {
    var pos = ta.selectionStart, before = ta.value.slice(0, pos);
    var line = before.split('\\n').length, col = pos - before.lastIndexOf('\\n');
    $('stPos').textContent = 'Ln ' + line + ', Col ' + col;
    var gl = glines.children[line - 1];
    Array.prototype.forEach.call(glines.children, function (c) { c.classList.remove('cur'); });
    if (gl) gl.classList.add('cur');
    var cl = $('curline');
    if (cl) { cl.style.top = (10 + (line - 1) * 20) + 'px'; cl.style.display = 'block'; }
  }

  var CMP = { open: false, items: [], sel: 0, reqId: 0 };
  var HOV = { timer: 0, reqId: 0, cx: 0, cy: 0 };

  ta.addEventListener('input', function () { renderEditor(); scheduleComplete(); });
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('keyup', updateCaret);
  ta.addEventListener('click', updateCaret);
  ta.addEventListener('blur', function () { cmpClose(); });
  ta.addEventListener('mousemove', onCodeMouseMove);
  ta.addEventListener('mouseleave', function () { clearTimeout(HOV.timer); var t = $('hoverTip'); if (t) t.classList.remove('open'); });
  ta.addEventListener('keydown', onCodeKeyDown);

  function insertText(txt) {
    var s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + txt + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + txt.length;
    renderEditor(); updateCaret();
  }
  function replaceRange(a, b, txt) {
    ta.value = ta.value.slice(0, a) + txt + ta.value.slice(b);
    ta.selectionStart = ta.selectionEnd = a + txt.length;
  }
  // ---------- editor context menu ----------
  // PyCharm's editor menu. Undo/redo/cut/copy go through execCommand, which is
  // what a WebView2 textarea accepts inside a click; *paste* cannot (browsers
  // block it for the page), so Paste reads the async clipboard and says so when
  // that is denied too, instead of silently doing nothing.
  var CAN_EDIT = function () { return !!(currentFile && BUFFERS[currentFile] && BUFFERS[currentFile].editable); };
  function docCmd(name) {
    ta.focus();
    if (typeof document.execCommand === 'function') {
      try { document.execCommand(name); } catch (e) { /* clipboard policy denied it */ }
    }
  }
  function copyText(text) {
    if (!text) { toast('Nothing to copy'); return; }
    var clip = navigator.clipboard;
    if (clip && clip.writeText) {
      clip.writeText(text).then(function () { toast('Copied'); }, function () { toast('Copy failed — use Ctrl+C'); });
    } else { toast('Copy failed — clipboard unavailable'); }
  }
  function pasteAtCaret() {
    var clip = navigator.clipboard;
    if (!clip || !clip.readText) { toast('Paste blocked — use Ctrl+V'); return; }
    clip.readText().then(function (text) { insertText(String(text || '')); }, function () { toast('Paste blocked — use Ctrl+V'); });
  }
  function deleteSelection() {
    ta.focus();
    var s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e) return;
    insertText('');
  }
  function selectAllInEditor() {
    ta.focus();
    ta.selectionStart = 0; ta.selectionEnd = ta.value.length;
    updateCaret();
  }
  function editorMenu() {
    var canEdit = CAN_EDIT(), hasDoc = !!currentFile;
    return [
      { label: 'Undo', sc: 'Ctrl+Z', dis: !canEdit, act: function () { docCmd('undo'); } },
      { label: 'Redo', sc: 'Ctrl+Y', dis: !canEdit, act: function () { docCmd('redo'); } },
      { sep: true },
      { label: 'Cut', sc: 'Ctrl+X', dis: !canEdit, act: function () { docCmd('cut'); } },
      { label: 'Copy', sc: 'Ctrl+C', dis: !hasDoc, act: function () { docCmd('copy'); } },
      { label: 'Paste', sc: 'Ctrl+V', dis: !canEdit, act: pasteAtCaret },
      { label: 'Delete', sc: 'Del', dis: !canEdit, act: deleteSelection },
      { label: 'Select All', sc: 'Ctrl+A', dis: !hasDoc, act: selectAllInEditor },
      { sep: true },
      { label: 'Change Language Mode…', dis: !hasDoc, act: openLangPicker }
    ];
  }
  // ---------- tab context menu ----------
  function closeAllTabs() { TABS.slice().forEach(function (p) { closeTab(p); }); }
  function tabMenu(name) {
    if (!name) return [{ label: 'Close All', act: closeAllTabs }];
    return [
      { label: 'Close', sc: 'Ctrl+F4', act: function () { closeTab(name); } },
      { label: 'Close Others', act: function () { TABS.slice().forEach(function (p) { if (p !== name) closeTab(p); }); } },
      { label: 'Close All', act: closeAllTabs }
    ];
  }
  // ---------- dock context menu ----------
  function dockMenu(pane) {
    return [
      { label: 'Copy', sc: 'Ctrl+C', act: function () { copyText(pane ? pane.textContent : ''); } },
      { sep: true },
      { label: 'Clear Buffer', act: function () { clearDockPane(pane); } }
    ];
  }
  function clearDockPane(pane) {
    if (!pane) return;
    RUN_ACTIVE = false;
    if (activeBottom === 'terminal') { TERM_LINES.length = 0; renderTermOut(); }
    else if (activeBottom === 'problems') renderProblems([]);
    else if (activeBottom === 'logs') { LOGS.length = 0; renderLogs(); }
    else if (activeBottom === 'perf') renderPerf(null);
    else renderDock();
    var win = windowById(activeBottom === 'problems' ? 'problems' : activeBottom);
    toast('Cleared ' + (win ? win.title : 'console'));
  }
  // The left tool windows are read-only panes except Project, so the others get
  // no menu — but still no browser menu, whose only useful entry here is Reload.
  function panelMenu() {
    if (activeLeft !== 'project') return null;
    return [
      { label: 'New', sc: 'Alt+Ins', act: function () { showNewPopup(lastCtxX, lastCtxY, ''); } },
      { sep: true },
      { label: 'Collapse All', act: function () { EXPANDED = { '': true }; renderTree(); } }
    ];
  }
  function isWordCh(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$'; }
  function leadWs(s) { var i = 0; while (i < s.length && (s.charAt(i) === ' ' || s.charAt(i) === TABc)) i++; return s.slice(0, i); }
  function wordPrefix() { var pos = ta.selectionStart, v = ta.value, i = pos; while (i > 0 && isWordCh(v.charAt(i - 1))) i--; return v.slice(i, pos); }
  var CLOSERS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
  CLOSERS[BT] = BT;
  function onCodeKeyDown(e) {
    if (CMP.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); cmpMove(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); cmpMove(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); cmpAccept(); return; }
      if (e.key === 'Escape') { e.preventDefault(); cmpClose(); return; }
    }
    if (e.ctrlKey && (e.key === ' ' || e.key === 'Spacebar')) { e.preventDefault(); requestComplete(); return; }
    if (e.key === 'Tab') { e.preventDefault(); insertText('    '); scheduleComplete(); return; }
    if (e.key === 'Enter') { e.preventDefault(); autoIndentEnter(); scheduleComplete(); return; }
    if (e.key === 'Escape') { cmpClose(); return; }
    var close = CLOSERS[e.key];
    if (close) { e.preventDefault(); autoPair(e.key, close); scheduleComplete(); return; }
  }
  function autoIndentEnter() {
    var pos = ta.selectionStart, val = ta.value;
    var ls = val.lastIndexOf(NLc, pos - 1) + 1;
    var lineText = val.slice(ls, pos);
    var indent = leadWs(lineText);
    var trimmed = lineText.replace(/[ ]+$/, '');
    var last = trimmed.charAt(trimmed.length - 1);
    var grow = (':{(['.indexOf(last) >= 0);
    var nextCh = val.charAt(pos);
    if (grow && (')]}'.indexOf(nextCh) >= 0)) {
      replaceRange(pos, pos, NLc + indent + '    ' + NLc + indent);
      ta.selectionStart = ta.selectionEnd = pos + 1 + indent.length + 4;
    } else {
      var add = grow ? '    ' : '';
      replaceRange(pos, pos, NLc + indent + add);
      ta.selectionStart = ta.selectionEnd = pos + 1 + indent.length + add.length;
    }
    renderEditor(); updateCaret();
  }
  function autoPair(open, close) {
    var s = ta.selectionStart, e = ta.selectionEnd, val = ta.value;
    if (s !== e) {
      replaceRange(s, e, open + val.slice(s, e) + close);
      ta.selectionStart = s + 1; ta.selectionEnd = e + 1;
      renderEditor(); updateCaret(); return;
    }
    var next = val.charAt(s);
    if (next === close) { ta.selectionStart = ta.selectionEnd = s + 1; return; }
    replaceRange(s, s, open + close);
    ta.selectionStart = ta.selectionEnd = s + 1;
    renderEditor(); updateCaret();
  }
  var cmpTimer = 0;
  function scheduleComplete() { clearTimeout(cmpTimer); cmpTimer = setTimeout(requestComplete, 130); }
  function caretLC() {
    var pos = ta.selectionStart, before = ta.value.slice(0, pos);
    return { line: before.split(NLc).length - 1, character: pos - (before.lastIndexOf(NLc) + 1) };
  }
  function requestComplete() {
    if (ta.readOnly || !lspLang()) { cmpClose(); return; }
    var pref = wordPrefix();
    if (pref.length < 1) { cmpClose(); return; }
    CMP.reqId++;
    var lc = caretLC();
    BRIDGE.send({ kind: 'complete', code: ta.value, language: lspLang(), line: lc.line, character: lc.character, requestId: CMP.reqId });
  }
  function onCompletion(m) {
    if (m.requestId !== CMP.reqId) return;
    var pref = wordPrefix();
    var items = (m.items || []).filter(function (it) {
      return it && it.label && it.label.length > pref.length && it.label.slice(0, pref.length) === pref;
    });
    if (!items.length) { cmpClose(); return; }
    CMP.items = items.slice(0, 50); CMP.sel = 0; CMP.open = true;
    renderCmp();
  }
  function renderCmp() {
    var el = $('cmp');
    el.innerHTML = CMP.items.map(function (it, i) {
      var k = String(it.kind == null ? '' : it.kind).slice(0, 2);
      return '<div class="row' + (i === CMP.sel ? ' sel' : '') + '" data-i="' + i + '"><span class="k">' + esc(k) + '</span><span>' + esc(it.label) + '</span><span class="d">' + esc(it.detail || '') + '</span></div>';
    }).join('');
    el.querySelectorAll('.row').forEach(function (row) {
      row.addEventListener('mousedown', function (ev) { ev.preventDefault(); CMP.sel = +row.getAttribute('data-i'); cmpAccept(); });
    });
    var lc = caretLC();
    var host = el.parentNode ? el.parentNode : document.body;
    var left = 56 + 14 + lc.character * 7.2 - ta.scrollLeft;
    var top = 10 + (lc.line + 1) * 20 - ta.scrollTop;
    el.style.left = Math.max(58, Math.min(left, host.clientWidth - 250)) + 'px';
    el.style.top = Math.max(2, Math.min(top, host.clientHeight - 44)) + 'px';
    el.classList.add('open');
  }
  function cmpMove(d) { if (!CMP.open || !CMP.items.length) return; CMP.sel = (CMP.sel + d + CMP.items.length) % CMP.items.length; renderCmp(); }
  function cmpAccept() {
    if (!CMP.open) return;
    var it = CMP.items[CMP.sel]; cmpClose();
    if (!it) return;
    var pos = ta.selectionStart, pref = wordPrefix(), start = pos - pref.length;
    ta.value = ta.value.slice(0, start) + it.label + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = start + it.label.length;
    renderEditor(); updateCaret();
  }
  function cmpClose() { CMP.open = false; var el = $('cmp'); if (el) el.classList.remove('open'); }
  function onCodeMouseMove(e) {
    clearTimeout(HOV.timer);
    var rect = ta.getBoundingClientRect();
    HOV.cx = e.clientX; HOV.cy = e.clientY;
    var x = e.clientX - rect.left, y = e.clientY - rect.top;
    HOV.timer = setTimeout(function () { requestHover(x, y); }, 450);
  }
  function wordAt(text, col) {
    var i = 0, n = text.length;
    while (i < n) {
      if (isWordCh(text.charAt(i))) {
        var j = i; while (j < n && isWordCh(text.charAt(j))) j++;
        if (i <= col && col <= j) return { start: i, text: text.slice(i, j) };
        i = j;
      } else i++;
    }
    return null;
  }
  function requestHover(x, y) {
    if (!lspLang()) return;
    var line = Math.floor((y - 10 + ta.scrollTop) / 20);
    var col = Math.floor((x - 14 + ta.scrollLeft) / 7.2);
    var lines = ta.value.split(NLc);
    if (line < 0 || line >= lines.length) { $('hoverTip').classList.remove('open'); return; }
    var w = wordAt(lines[line], col);
    if (!w) { $('hoverTip').classList.remove('open'); return; }
    HOV.reqId++;
    BRIDGE.send({ kind: 'hover', code: ta.value, language: lspLang(), line: line, character: w.start + 1, requestId: HOV.reqId });
  }
  function onHover(m) {
    if (m.requestId !== HOV.reqId) return;
    var tip = $('hoverTip'), text = hoverText(m.hover);
    if (!text) { tip.classList.remove('open'); return; }
    tip.textContent = text;
    var host = tip.parentNode ? tip.parentNode : document.body;
    var hr = host.getBoundingClientRect();
    tip.style.left = Math.max(0, Math.min(HOV.cx - hr.left + 12, host.clientWidth - 340)) + 'px';
    tip.style.top = (HOV.cy - hr.top + 16) + 'px';
    tip.classList.add('open');
  }
  function hoverText(h) {
    if (!h) return '';
    var c = (h.contents != null) ? h.contents : h;
    if (typeof c === 'string') return c;
    if (c && typeof c.value === 'string') return c.value;
    if (Object.prototype.toString.call(c) === '[object Array]') {
      return c.map(function (x) { return (typeof x === 'string') ? x : (x && x.value) || ''; }).join(NLc + NLc);
    }
    return '';
  }

  // ---------- editor buffers + tabs ----------
  // BUFFERS maps a file's rel-path -> { content, languageId, editable, dirty, mtime }.
  // Editing happens in memory; saveFile flushes the active buffer to disk via fsWrite.
  var BUFFERS = {};
  var TABS = ['main.py', 'utils.py', 'README.md']; // open rel-paths (seeded with samples)
  function isOpen(p) { return TABS.indexOf(p) >= 0; }
  function bufferDirty(p) { return BUFFERS[p] ? BUFFERS[p].dirty : false; }
  function langOfName(name) {
    var d = String(name).lastIndexOf('.');
    var ext = d < 0 ? '' : name.slice(d + 1).toLowerCase();
    if (!ext) return undefined;
    return EXT_LANG[ext];
  }
  function renderTabs() {
    var el = $('etabs'); el.innerHTML = '';
    TABS.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'etab' + (p === currentFile ? ' active' : '');
      b.setAttribute('data-tab', p); // the right-click menu needs to know which tab
      b.innerHTML = '<span class="ic">' + ic('file', 16) + '</span><span class="nm">' + esc(p) + '</span>' +
        (p === currentFile && bufferDirty(p) ? '<span class="dirty">●</span>' : '') +
        '<span class="x" data-close="' + esc(p) + '">' + ic('close', 12) + '</span>';
      b.addEventListener('click', function (e) {
        if (e.target.closest('[data-close]')) { e.stopPropagation(); closeTab(p); return; }
        openFile(p);
      });
      el.appendChild(b);
    });
    var more = document.createElement('button');
    more.className = 'more'; more.innerHTML = ic('chevD', 16); more.title = 'Show hidden tabs';
    el.appendChild(more);
  }
  function closeTab(p) {
    var i = TABS.indexOf(p); if (i < 0) return;
    TABS.splice(i, 1); delete BUFFERS[p];
    if (currentFile === p) {
      var next = TABS[TABS.length - 1];
      if (next) openFile(next);
      else { currentFile = null; currentLang = 'python'; ta.value = ''; ta.readOnly = true; $('stFile').textContent = ''; renderStLang(); renderTabs(); renderEditor(); }
    } else { renderTabs(); }
    savePrefs({ tabs: TABS, current: currentFile });
  }
  function openFile(name) {
    if (BUFFERS[name]) { showBuffer(name); return; }
    // Load from the real filesystem; fall back to the bundled sample for offline boot.
    BRIDGE.send({ kind: 'fsRead', path: name });
    if (FILES[name] != null) showBuffer(name, FILES[name]);
  }
  function showBuffer(name, fallback) {
    var buf = BUFFERS[name];
    if (!buf) {
      if (fallback == null) { toast('no content for ' + name); return; }
      buf = BUFFERS[name] = { content: fallback, languageId: langOfDoc(name), editable: true, dirty: false };
    }
    if (!isOpen(name)) TABS.push(name);
    currentFile = name; currentLang = buf.languageId || 'python';
    ta.value = buf.content;
    ta.readOnly = !buf.editable;
    $('stFile').textContent = name;
    renderStLang();
    renderTabs(); renderEditor(); updateCaret();
    if (lspLang()) BRIDGE.send({ kind: 'check', code: ta.value, language: lspLang() });
    pushRecent(name);
    savePrefs({ tabs: TABS, current: currentFile });
  }
  function saveFile() {
    if (!currentFile || !BUFFERS[currentFile]) { reportError({ level: 'warn', title: 'Nothing to save', message: 'No document is open.' }); return; }
    if (ta.readOnly) { reportError({ level: 'warn', title: 'Read-only', message: currentFile + ' cannot be modified.' }); return; }
    var p = currentFile, content = ta.value;
    BRIDGE.send({ kind: 'fsWrite', path: p, content: content });
    // No dialog: PyCharm writes straight to disk and only shows a transient
    // status-bar hint. The failure path is the one that talks.
    setStatusHint('Saving ' + p + ' …');
  }
  function onFsFile(f) {
    var name = f.path;
    BUFFERS[name] = { content: f.content, languageId: langOfDoc(name, f.languageId), editable: f.truncated ? false : f.editable !== false, dirty: false, mtime: f.mtime };
    if (!isOpen(name)) TABS.push(name);
    if (currentFile === name || currentFile == null) showBuffer(name);
    else renderTabs();
  }
  function onFsSaved(m) {
    if (BUFFERS[m.path]) { BUFFERS[m.path].dirty = false; BUFFERS[m.path].content = ta.value; }
    renderTabs();
    setStatusHint('Saved ' + m.path);
  }
  function onFsError(m) {
    // A read of an embedded-sample path (e.g. boot's main.py) legitimately has
    // no on-disk file; we already loaded the bundled fallback, so stay quiet.
    if (m.path && BUFFERS[m.path]) return;
    reportError({ level: 'error', title: 'File system error', message: String(m.message || m.code || 'unknown'), detail: m.path });
  }
  /** Transient status-bar hint — the only feedback a successful save gives. */
  var hintT;
  function setStatusHint(text) {
    var el = $('stHint'); if (!el) return;
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(hintT);
    hintT = setTimeout(function () { el.textContent = ''; el.classList.remove('on'); }, 2400);
  }
  ta.addEventListener('input', function () {
    if (currentFile && BUFFERS[currentFile]) BUFFERS[currentFile].dirty = true;
    renderTabs();
  });

  // ---------- tool strip + tool windows ----------
  // Scope note: this shell is a *language* IDE. Database / Docker / remote / HTTP
  // client tooling is deliberately out of scope, so there is no database window
  // or strip entry — only the language-relevant tool windows live here.
  var LEFT_WINDOWS = [
    { id: 'project', title: 'Project', icon: 'project', key: 'Alt+1' },
    { id: 'structure', title: 'Structure', icon: 'structure', key: 'Alt+7' },
    { id: 'vcs', title: 'Version Control', icon: 'vcs', key: 'Alt+9' },
    { id: 'commit', title: 'Commit', icon: 'commit', key: 'Ctrl+K' },
    { id: 'ai', title: 'AI Assistant', icon: 'ai', key: 'Alt+A' }
  ];
  var BOTTOM_WINDOWS = [
    { id: 'run', title: 'Run', icon: 'run', key: 'Alt+4' },
    { id: 'terminal', title: 'Terminal', icon: 'terminal', key: 'Alt+F12' },
    { id: 'perf', title: 'Performance', icon: 'perf', key: 'Alt+8' },
    { id: 'logs', title: 'Logs', icon: 'logs', key: 'Alt+0' },
    { id: 'find', title: 'Find', icon: 'search', key: 'Ctrl+Shift+F' }
  ];
  var PROBLEMS = { id: 'problems', title: 'Problems', icon: 'warn', key: '' };
  // strip order per PyCharm New UI
  var STRIP = ['project', 'vcs', 'commit', 'terminal', 'run', 'structure', 'perf', 'logs', 'ai'];

  var activeLeft = 'project';
  var activeBottom = 'run';
  var pinned = true;

  function windowById(id) {
    var all = LEFT_WINDOWS.concat(BOTTOM_WINDOWS).concat([PROBLEMS]);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function isBottom(id) { return id === 'run' || id === 'terminal' || id === 'perf' || id === 'logs' || id === 'problems' || id === 'find'; }

  function renderStrip() {
    var el = $('strip'); el.innerHTML = '';
    STRIP.forEach(function (id) {
      var w = windowById(id); if (!w) return;
      var b = document.createElement('button');
      b.className = 'sbtn' + ((isBottom(id) ? activeBottom === id : activeLeft === id && !$('leftPanel').classList.contains('hidden')) ? ' active' : '');
      b.innerHTML = ic(w.icon, 20);
      b.title = w.title + (w.key ? '  ' + w.key : '');
      b.addEventListener('click', function () { toggleWindow(id); });
      el.appendChild(b);
    });
    var grow = document.createElement('span'); grow.className = 'grow'; el.appendChild(grow);
    var s = document.createElement('button');
    s.className = 'sbtn'; s.innerHTML = ic('settings', 20); s.title = 'Settings  Ctrl+Alt+S';
    s.addEventListener('click', openSettings);
    el.appendChild(s);
  }

  function saveLayout() {
    savePrefs({
      left: activeLeft, bottom: activeBottom,
      leftHidden: $('leftPanel').classList.contains('hidden'),
      bottomHidden: $('dock').classList.contains('hidden')
    });
  }
  function toggleWindow(id) {
    if (isBottom(id)) {
      activeBottom = id;
      $('dock').classList.remove('hidden');
      renderDock();
    } else {
      var panel = $('leftPanel');
      if (activeLeft === id && !panel.classList.contains('hidden')) panel.classList.add('hidden');
      else { activeLeft = id; panel.classList.remove('hidden'); }
      renderPanel();
    }
    renderStrip();
    saveLayout();
  }

  // ---- left panel content ----
  function renderPanel() {
    var w = windowById(activeLeft); if (!w) return;
    $('panelTitle').textContent = w.title;
    var body = $('panelBody');
    if (activeLeft === 'project') { if (!TREE['']) loadDir(''); renderTree(); }
    else if (activeLeft === 'structure') body.innerHTML = structureTree(ta.value);
    else if (activeLeft === 'vcs') body.innerHTML = '<div class="empty">No local changes.<br/>Working tree clean on <b>main</b>.</div>';
    else if (activeLeft === 'commit') body.innerHTML = commitPane();
    else if (activeLeft === 'ai') body.innerHTML = aiPane();
    else body.innerHTML = '';
    if (activeLeft === 'commit') wireCommit(body);
  }
  function treeHtml(nodes) {
    var h = '<div style="padding:6px 4px;font-size:12.5px">';
    nodes.forEach(function (n) {
      h += '<div style="display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:5px;margin-left:' + (n.d * 14) + 'px" class="tnode">';
      h += '<span class="ic" style="color:var(--icon-default)">' + ic(n.dir ? 'project' : 'file', 16) + '</span>';
      h += '<span>' + esc(n.name) + '</span></div>';
    });
    return h + '</div>';
  }
  // ---------- project tree (real filesystem) ----------
  var TREE = {};        // dir relPath -> FsEntry[] (one level, cached)
  var TREE_LOADING = {};// dir relPath -> true while a listing is in flight
  var EXPANDED = { '': true }; // root expanded by default
  var ROOT_NAME = 'Project';

  function parentDir(p) { var i = String(p).lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function loadDir(path) {
    if (!BRIDGE.ready()) return; // don't send until the socket is open
    if (TREE[path] || TREE_LOADING[path]) return;
    TREE_LOADING[path] = true;
    BRIDGE.send({ kind: 'fsList', path: path });
  }
  function refreshDir(path) { delete TREE[path]; delete TREE_LOADING[path]; loadDir(path); }
  function renderTree() {
    var body = $('panelBody'); if (!body) return;
    body.innerHTML = '<div class="ptree" id="ptree">' + renderNodes('', 0) + '</div>';
    wireTree(body);
  }
  function renderNodes(path, depth) {
    if (path && !EXPANDED[path]) return '';
    var entries = TREE[path];
    if (entries == null) return TREE_LOADING[path] ? '<div class="pempty">loading…</div>' : '';
    var h = '';
    entries.forEach(function (e) {
      var isDir = e.kind === 'dir';
      if (isDir) {
        h += '<div class="tnode dir ' + (EXPANDED[e.path] ? 'open' : '') + '" data-path="' + esc(e.path) + '" data-kind="dir" style="padding-left:' + (6 + depth * 14) + 'px">' +
          '<span class="chev">' + ic(EXPANDED[e.path] ? 'chevD' : 'chevR', 14) + '</span>' +
          '<span class="ic">' + ic('project', 16) + '</span><span class="nm">' + esc(e.name) + '</span></div>';
        h += renderNodes(e.path, depth + 1);
      } else {
        h += '<div class="tnode file ' + (e.path === currentFile ? 'active' : '') + (e.editable ? '' : ' ro') + '" data-path="' + esc(e.path) + '" data-kind="file" style="padding-left:' + (6 + (depth + 1) * 14) + 'px">' +
          '<span class="chev"></span><span class="ic">' + ic('file', 16) + '</span><span class="nm">' + esc(e.name) + '</span></div>';
      }
    });
    return h;
  }
  function wireTree(scope) {
    scope.querySelectorAll('.tnode').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.button !== 0) return;
        var path = row.getAttribute('data-path'), kind = row.getAttribute('data-kind');
        if (kind === 'dir') { var was = EXPANDED[path]; if (was) delete EXPANDED[path]; else EXPANDED[path] = true; loadDir(path); renderTree(); }
        else openFile(path);
      });
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var rp = row.getAttribute('data-path'), dir = parentDir(rp), isDir = row.getAttribute('data-kind') === 'dir';
        var target = isDir ? rp : dir;
        showCtx(e.clientX, e.clientY, [
          { label: 'New', sc: 'Alt+Ins', act: function () { showNewPopup(e.clientX, e.clientY, target); } },
          { sep: true },
          { label: 'Open', act: function () { openFile(rp); } },
          { label: 'Copy Path', act: function () { copyText(rp); } },
          { sep: true },
          { label: 'Rename…', sc: 'Shift+F6', act: function () { startInlineRename(row, rp); } },
          { label: 'Delete…', sc: 'Del', act: function () { deleteEntry([rp]); } }
        ]);
      });
      // PyCharm renames on F2 / a slow second click as well as from the menu.
      row.addEventListener('dblclick', function () {
        var rp = row.getAttribute('data-path');
        if (rp) startInlineRename(row, rp);
      });
    });
  }
  function onFsListing(m) {
    TREE[m.path] = m.entries || []; TREE_LOADING[m.path] = false;
    if (activeLeft === 'project') renderTree();
  }
  function onFsChanged(m) {
    if (m.op === 'create') refreshDir(parentDir(m.path));
    else if (m.op === 'rename') { refreshDir(parentDir(m.from)); refreshDir(parentDir(m.path)); }
    else if (m.op === 'delete') refreshDir(parentDir(m.path));
  }
  // ---------- project-tree editing (PyCharm semantics) ----------
  // New is a popup menu of entry kinds, then a naming dialog whose field starts
  // with the whole name selected — typing replaces it, Enter commits, Escape
  // cancels, and a name that already exists is refused inline.
  function showNewPopup(x, y, dirPath) {
    // Derived from the language catalogue, so a newly installed plugin adds its
    // own "New … File" entry without touching this file.
    var items = LANG_LIST.filter(function (l) {
      return SERVER_LANGS[l.id] && DEFAULT_EXT[l.id];
    }).map(function (l) {
      var ext = DEFAULT_EXT[l.id];
      return { label: l.name + ' File', act: function () { nameEntry(dirPath, 'file', ext); } };
    });
    items.push({ sep: true });
    items.push({ label: 'File', act: function () { nameEntry(dirPath, 'file', ''); } });
    items.push({ label: 'Directory', act: function () { nameEntry(dirPath, 'dir', ''); } });
    showCtx(x, y, items);
  }
  /** Does path already exist among the entries we know for its directory? */
  function entryExists(dirPath, name) {
    var full = dirPath ? dirPath + '/' + name : name;
    var known = TREE[dirPath] || [];
    for (var i = 0; i < known.length; i++) if (known[i].path === full) return true;
    return false;
  }
  function nameEntry(dirPath, kind, ext) {
    var seed = ext ? 'untitled.' + ext : (kind === 'dir' ? 'newFolder' : 'untitled');
    showModal({
      title: 'New ' + (kind === 'dir' ? 'Directory' : ext ? ext.toUpperCase() + ' File' : 'File'),
      icon: kind === 'dir' ? 'project' : 'file',
      message: dirPath ? 'in ' + dirPath : 'in the project root',
      fields: [{
        name: 'name', label: 'Name', value: seed, placeholder: 'name' + (ext ? '.' + ext : ''),
        validator: function (v) {
          var n = String(v || '').trim();
          if (!n) return 'Name is required';
          if (/[\\/:*?"<>|]/.test(n)) return 'These characters are not allowed: \\ / : * ? " < > |';
          if (entryExists(dirPath, n)) return 'That name already exists here';
          return null;
        },
      }],
      buttons: [
        { label: 'Cancel', onClick: function () {} },
        {
          label: 'OK', primary: true, onClick: function (v) {
            var n = String(v.name || '').trim();
            if (!n) return;
            // PyCharm completes the extension when the user typed a bare name.
            if (ext && n.toLowerCase().indexOf('.' + ext) < 0) n += '.' + ext;
            BRIDGE.send({ kind: 'fsCreate', path: dirPath ? dirPath + '/' + n : n, entryKind: kind });
          },
        },
      ],
    });
  }
  /**
   * Rename in place: the tree row's label becomes an input. No dialog at all —
   * Enter commits, Escape restores, blur commits (PyCharm's tree behaviour).
   */
  function startInlineRename(rowEl, path) {
    var label = rowEl.querySelector('.nm');
    if (!label || rowEl.querySelector('.inline-rename')) return;
    var old = path.split('/').pop();
    var input = document.createElement('input');
    input.className = 'inline-rename';
    input.value = old;
    input.setAttribute('data-rename', path);
    label.parentNode.replaceChild(input, label);
    input.focus(); input.select();
    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      var nv = input.value.trim();
      if (commit && nv && nv !== old) {
        var parent = parentDir(path);
        BRIDGE.send({ kind: 'fsRename', path: path, to: parent ? parent + '/' + nv : nv });
      } else {
        renderTree();
      }
    }
    input.addEventListener('blur', function () { finish(true); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
  }
  /** Delete asks first, with the names on the line — and a danger-coloured button. */
  function deleteEntry(paths) {
    var list = Array.isArray(paths) ? paths : [paths];
    if (!list.length) return;
    confirmDialog({
      title: 'Delete',
      icon: 'warn',
      message: 'Delete ' + list.length + (list.length > 1 ? ' items' : ' item') + '? This cannot be undone.',
      list: list.map(function (p) { return { icon: 'file', label: p }; }),
      buttons: [
        { label: 'Cancel', onClick: function () {} },
        {
          label: 'Delete', danger: true, onClick: function () {
            list.forEach(function (p) { BRIDGE.send({ kind: 'fsDelete', path: p }); });
            balloon({ type: 'success', title: 'Deleted', message: list.length + (list.length > 1 ? ' items' : ' item') });
          },
        },
      ],
    });
  }
  /**
   * Show a context menu. Items are \{label, sc?, act?, dis?}\ or \{sep:true}\.
   * The menu is flipped back inside the viewport rather than allowed to open
   * off-screen near an edge — the same thing PyCharm does with a popup.
   */
  function showCtx(x, y, items) {
    var m = $('ctxMenu'); if (!m) return;
    m.innerHTML = '';
    items.forEach(function (it) {
      if (it.sep) {
        var s = document.createElement('div'); s.className = 'csep'; m.appendChild(s); return;
      }
      var el = document.createElement('div');
      el.className = 'citem' + (it.dis ? ' dis' : '');
      el.innerHTML = '<span class="clbl">' + esc(it.label) + '</span>' + (it.sc ? '<span class="csc">' + esc(it.sc) + '</span>' : '');
      if (!it.dis) el.addEventListener('click', function (ev) { ev.stopPropagation(); hideCtx(); it.act(); });
      m.appendChild(el);
    });
    m.style.left = '0px'; m.style.top = '0px';
    m.classList.add('open');
    var mw = m.offsetWidth || 220, mh = m.offsetHeight || 100;
    m.style.left = Math.max(6, Math.min(x, window.innerWidth - mw - 6)) + 'px';
    m.style.top = Math.max(6, Math.min(y, window.innerHeight - mh - 6)) + 'px';
  }
  function hideCtx() { var m = $('ctxMenu'); if (m) m.classList.remove('open'); }
  function bootProject() { loadDir(''); openFile(currentFile || 'main.py'); }
  function structureTree(code) {
    var lines = code.split('\\n'), nodes = [];
    lines.forEach(function (l, i) {
      var m = /^(\\s*)(def|class)\\s+([A-Za-z_]\\w*)/.exec(l);
      if (m) nodes.push({ name: m[3] + (m[2] === 'class' ? ' (class)' : '()'), d: Math.floor(m[1].length / 4), line: i + 1 });
    });
    if (!nodes.length) return '<div class="empty">No symbols in this file.</div>';
    return treeHtml(nodes.map(function (n) { return { name: n.name, d: n.d }; }));
  }
  function commitPane() {
    return '<div style="padding:10px;display:flex;flex-direction:column;gap:8px;height:100%">' +
      '<textarea id="commitMsg" placeholder="Commit message" style="flex:1;min-height:90px;resize:none;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:8px;font:12px var(--sans)"></textarea>' +
      '<div style="display:flex;gap:8px"><button class="tbtn" id="commitBtn" style="flex:1;justify-content:center">Commit</button></div>' +
      '<div class="empty">Unversioned files · nothing staged (demo)</div></div>';
  }
  function wireCommit(body) {
    var b = body.querySelector('#commitBtn');
    if (b) b.addEventListener('click', function () { toast('Committed (demo)'); });
  }
  function aiPane() {
    return '<div style="padding:12px;display:flex;flex-direction:column;gap:10px">' +
      '<div style="color:var(--text-secondary);font-size:12px">Ask about the current file.</div>' +
      '<div style="display:flex;gap:6px"><input id="aiInput" placeholder="Explain this function…" style="flex:1;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text-primary)"/>' +
      '<button class="tbtn" id="aiAsk">Ask</button></div>' +
      '<div id="aiOut" class="console dim">—</div></div>';
  }

  // ---- bottom dock ----
  function renderDock() {
    var tabs = $('dockTabs');
    // keep the spacer + hide button; rebuild tab buttons before them
    Array.prototype.slice.call(tabs.querySelectorAll('.dtab')).forEach(function (n) { n.remove(); });
    BOTTOM_WINDOWS.concat([PROBLEMS]).forEach(function (w) {
      var b = document.createElement('button');
      b.className = 'dtab' + (activeBottom === w.id ? ' active' : '');
      b.innerHTML = '<span class="ic">' + ic(w.icon, 16) + '</span>' + w.title;
      b.addEventListener('click', function () { activeBottom = w.id; renderDock(); saveLayout(); });
      tabs.insertBefore(b, tabs.querySelector('.spacer'));
    });
    var body = $('dockBody');
    body.innerHTML =
      pane('run', '<div class="console" id="runOut"><span class="dim">Click Run (Shift+F10) to execute main.py in the sandbox.</span></div>' +
        '<div class="term-line" id="runLine"><span class="prompt" id="runPrompt">input&gt;</span>' +
        '<input class="term-in" id="runIn" disabled spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="program asks for input? type here, then Enter" /></div>') +
      pane('terminal', termPane()) +
      pane('perf', perfPane()) +
      pane('logs', logsPane()) +
      pane('find', findPane()) +
      pane('problems', '<div id="probOut"><div class="empty">No problems.</div></div>');
    wirePerf(); wireLogs(); wireTerm(); wireFind();
    var ri = $('runIn');
    if (ri) ri.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var v = ri.value; ri.value = '';
        if (RUN_ACTIVE) { BRIDGE.send({ kind: 'runInput', text: v + '\\n' }); appendRun(v + '\\n'); }
      }
    });
    if (activeBottom === 'logs') renderLogs();
    if (activeBottom === 'perf') renderPerf(lastMetrics);
    if (activeBottom === 'terminal') { renderTermOut(); var ti = $('termIn'); if (ti) ti.focus(); }
  }
  // ---- Find in Files (bottom dock, Ctrl+Shift+F) ----
  // Searches the documents currently held in memory (open buffers) plus any
  // project-tree file we can read. Results group by file; each match carries the
  // line number and the snippet, and double-clicking jumps to it.
  function findPane() {
    return '<div class="find-bar">' +
      '<input id="findIn" placeholder="Find in files…" spellcheck="false" autocapitalize="off" autocomplete="off" />' +
      '<label class="dlg-check" style="margin-left:8px"><input type="checkbox" id="findCS" />Case sensitive</label>' +
      '</div><div id="findOut" class="find-out"><div class="empty">Type to search open files.</div></div>';
  }
  function wireFind() {
    var inp = $('findIn'); if (!inp) return;
    inp.addEventListener('input', function () { renderFind(inp.value, $('findCS') && $('findCS').checked); });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { inp.value = ''; renderFind('', false); } });
    var cs = $('findCS'); if (cs) cs.addEventListener('change', function () { renderFind(inp.value, cs.checked); });
  }
  function openFindInFiles() {
    if (activeBottom !== 'find') { activeBottom = 'find'; renderDock(); }
    var inp = $('findIn'); if (inp) { inp.focus(); }
  }
  function renderFind(q, cs) {
    var out = $('findOut'); if (!out) return;
    q = q || '';
    if (!q.trim()) { out.innerHTML = '<div class="empty">Type to search open files.</div>'; return; }
    var needle = cs ? q : q.toLowerCase();
    var html = '';
    var total = 0;
    Object.keys(BUFFERS).forEach(function (path) {
      var content = BUFFERS[path].content || '';
      var lines = content.split('\\n');
      var hits = [];
      lines.forEach(function (ln, i) {
        var hay = cs ? ln : ln.toLowerCase();
        var idx = hay.indexOf(needle);
        if (idx >= 0) hits.push({ line: i + 1, text: ln });
      });
      if (!hits.length) return;
      total += hits.length;
      html += '<div class="fgroup" data-path="' + esc(path) + '"><div class="fhead">' + esc(path) + ' <span class="dim">(' + hits.length + ')</span></div>';
      hits.forEach(function (h) {
        html += '<div class="fhit" data-path="' + esc(path) + '" data-line="' + h.line + '">' +
          '<span class="fl">Ln ' + h.line + '</span>' + esc(h.text.slice(0, 200)) + '</div>';
      });
      html += '</div>';
    });
    out.innerHTML = total ? html : '<div class="empty">No matches in open files.</div>';
    out.querySelectorAll('.fhit').forEach(function (el) {
      el.addEventListener('dblclick', function () { gotoLineInFile(el.getAttribute('data-path'), +el.getAttribute('data-line')); });
    });
  }
  function gotoLineInFile(path, line) {
    if (!BUFFERS[path]) { openFile(path); }
    else showBuffer(path);
    var target = path, n = line;
    setTimeout(function () {
      var lines = ta.value.split('\\n');
      var pos = 0; for (var i = 0; i < n - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      ta.focus(); ta.setSelectionRange(pos, pos); updateCaret();
    }, 0);
  }
  function pane(id, inner) {
    return '<div class="dock-pane' + (activeBottom === id ? ' active' : '') + '" data-pane="' + id + '">' + inner + '</div>';
  }

  // ---------- performance ----------
  var lastMetrics = null;
  function perfPane() {
    return '<div class="perf-grid" id="perfGrid"></div>';
  }
  function renderPerf(m) {
    if (!m) return;
    var grid = $('perfGrid'); if (!grid) return;
    var names = Object.keys(m.metrics || {});
    // highest-p95 metric is the status-bar headline
    var top = null, topP = -1;
    names.forEach(function (n) { var s = m.metrics[n]; if (s && s.p95 > topP) { topP = s.p95; top = n; } });
    if (top) $('stPerfVal').textContent = 'P95 ' + fmtMs(m.metrics[top].p95);
    var shown = names.slice(0, 8);
    grid.innerHTML = shown.map(function (n) {
      var s = m.metrics[n], ser = (m.series || {})[n] || [];
      return '<div class="pcard"><div class="nm" title="' + esc(n) + '">' + esc(n) + '</div>' +
        '<div class="big">' + fmtMs(s.avg) + '</div>' +
        '<div class="row"><span>p50 ' + fmtMs(s.p50) + '</span><span>p95 ' + fmtMs(s.p95) + '</span></div>' +
        '<div class="row"><span>p99 ' + fmtMs(s.p99) + '</span><span>n=' + s.count + '</span></div>' +
        sparkline(ser) + '</div>';
    }).join('') || '<div class="empty">No metrics yet.</div>';
  }
  function fmtMs(v) { return v >= 100 ? Math.round(v) + 'ms' : (Math.round(v * 10) / 10) + 'ms'; }
  function sparkline(ser) {
    if (!ser || ser.length < 2) return '';
    var w = 100, h = 30, max = Math.max.apply(null, ser), min = Math.min.apply(null, ser);
    var span = (max - min) || 1;
    var pts = ser.map(function (v, i) {
      var x = (i / (ser.length - 1)) * w, y = h - ((v - min) / span) * (h - 4) - 2;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>';
  }
  function wirePerf() { if (activeBottom !== 'perf') return; }

  // ---------- logs ----------
  var LOGS = [];
  var logMin = 0; // 0=TRACE
  function logLevelLabel() {
    for (var i = 0; i < LOG_LEVELS.length; i++) if (LOG_LEVELS[i].val === logMin) return LOG_LEVELS[i].label;
    return 'All';
  }
  function logsPane() {
    return '<div class="logs-toolbar"><span style="font-size:12px;color:var(--text-secondary)">Level</span>' +
      '<button class="dd" id="logLevel">' + esc(logLevelLabel()) + '<span class="ic">' + ic('chevD', 13) + '</span></button>' +
      '<span style="margin-left:auto;font-size:11.5px;color:var(--text-tertiary)" id="logCount"></span></div>' +
      '<div id="logList"></div>';
  }
  /**
   * Self-drawn dropdown: the browser's <select> looks different on every
   * platform and cannot host the PyCharm layout. Reuses the context-menu
   * surface, anchored under the button.
   */
  function showDropdown(anchorEl, items, onPick) {
    var r = anchorEl.getBoundingClientRect();
    showCtx(r.left, r.bottom + 3, items.map(function (it) {
      return {
        label: (it.checked ? '✓  ' : '    ') + it.label,
        act: function () { onPick(it); },
      };
    }));
  }
  var LOG_LEVELS = [
    { val: 0, label: 'All' }, { val: 3, label: 'INFO+' }, { val: 4, label: 'WARN+' }, { val: 5, label: 'ERROR+' },
  ];
  function wireLogs() {
    var btn = $('logLevel');
    if (!btn) return;
    var sync = function () {
      for (var i = 0; i < LOG_LEVELS.length; i++) {
        if (LOG_LEVELS[i].val === logMin) btn.firstChild.textContent = LOG_LEVELS[i].label;
      }
    };
    btn.addEventListener('click', function () {
      showDropdown(btn, LOG_LEVELS.map(function (l) {
        return { label: l.label, val: l.val, checked: l.val === logMin };
      }), function (it) { logMin = it.val; sync(); renderLogs(); });
    });
    sync();
  }
  function renderLogs() {
    var list = $('logList'); if (!list) return;
    var rows = LOGS.filter(function (r) { return r.level >= logMin; }).slice(-400).reverse();
    $('logCount').textContent = rows.length + ' records';
    list.innerHTML = rows.map(function (r) {
      var t = new Date(r.ts);
      var hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0'), ss = String(t.getSeconds()).padStart(2, '0');
      return '<div class="logline"><span class="t">' + hh + ':' + mm + ':' + ss + '</span>' +
        '<span class="lv lv-' + r.levelName + '">' + r.levelName + '</span>' +
        '<span class="cp" title="' + esc(r.component) + '">' + esc(r.component) + '</span>' +
        '<span class="ms">' + esc(r.message) + '</span></div>';
    }).join('') || '<div class="empty">No log records at this level.</div>';
  }

  // ---------- problems ----------
  var problems = [];
  function renderProblems(items) {
    problems = items || [];
    var out = $('probOut');
    $('stProblems').textContent = problems.length + (problems.length === 1 ? ' problem' : ' problems');
    if (!out) return;
    if (!problems.length) { out.innerHTML = '<div class="empty">No problems detected.</div>'; return; }
    out.innerHTML = problems.map(function (p) {
      var sev = p.severity === 1 ? 'error' : 'warn';
      return '<div class="prob ' + sev + '"><span class="ic">' + ic(sev === 'error' ? 'close' : 'warn', 14) + '</span>' +
        '<span class="loc">' + (p.line + 1) + ':' + (p.character + 1) + '</span>' +
        '<span class="msg">' + esc(p.message) + '</span></div>';
    }).join('');
  }

  // ---------- run ----------
  function runCode() {
    activeBottom = 'run'; $('dock').classList.remove('hidden'); renderDock();
    var out = $('runOut');
    out.innerHTML = '<span class="cmd">&gt; ' + currentLang + ' ' + esc(currentFile) + '</span>\\n';
    var lg = lspLang();
    if (!lg) { toast('run: only Python / Go / JavaScript are supported yet'); return; }
    BRIDGE.send({ kind: 'run', code: ta.value, language: lg, sessionId: 'pycharm' });
    BRIDGE.send({ kind: 'check', code: ta.value, language: lg });
    toast('Running ' + currentFile + ' …');
    var ri = $('runIn'); if (ri) { ri.disabled = false; ri.focus(); }
  }
  function appendRun(text, cls) {
    var out = $('runOut'); if (!out) return;
    var s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text;
    out.appendChild(s);
  }

  // ---------- terminal ----------
  var TERM_LINES = [];
  var TERM_HIST = [];
  var TERM_HI = -1;
  var TERM_SEEDED = false;
  var TERM_PROMPT = 'nolanguage $';
  var TERM_ATTACHED = false;
  var RUN_ACTIVE = false;
  function termPane() {
    return '<div class="term">' +
      '<div class="term-out" id="termOut"></div>' +
      '<div class="term-line"><span class="prompt" id="termPrompt">' + TERM_PROMPT + '</span>' +
      '<input class="term-in" id="termIn" spellcheck="false" autocapitalize="off" autocomplete="off" /></div></div>';
  }
  function termWrite(text, cls) { TERM_LINES.push({ t: text, c: cls || '' }); if (TERM_LINES.length > 3000) TERM_LINES.shift(); }
  function renderTermOut() {
    var o = $('termOut'); if (!o) return;
    o.innerHTML = TERM_LINES.map(function (l) {
      return l.c ? '<span class="' + l.c + '">' + esc(l.t) + '</span>' : esc(l.t);
    }).join('');
    o.scrollTop = o.scrollHeight;
  }
  function termBuiltins(cmd) {
    var parts = cmd.split(/\s+/), head = parts[0], rest = cmd.slice(head.length).trim();
    switch (head) {
      case 'clear': TERM_LINES = []; renderTermOut(); return true;
      case 'help':
        termWrite('Built-ins: help, clear, echo, date, pwd, whoami, history, theme [dark|light]\\n', 'dim');
        termWrite('Everything else runs as a shell command in the project root (ls, git status, python main.py …).\\n', 'dim');
        return true;
      case 'echo': termWrite(rest + '\\n'); return true;
      case 'date': termWrite(new Date().toString() + '\\n'); return true;
      case 'pwd': termWrite('/Nolanguage\\n', 'acc'); return true;
      case 'whoami': termWrite('developer\\n', 'acc'); return true;
      case 'theme':
        setTheme(rest === 'light' ? 'light' : 'darcula');
        termWrite('theme -> ' + (rest === 'light' ? 'light' : 'darcula') + '\\n', 'dim');
        return true;
      case 'history':
        TERM_HIST.forEach(function (h, i) { termWrite((i + 1) + '  ' + h + '\\n', 'dim'); });
        return true;
      default: return false;
    }
  }
  function termSubmit(raw) {
    var cmd = raw.replace(/\s+$/, '');
    termWrite(TERM_PROMPT + ' ' + cmd + '\\n');
    var trimmed = cmd.trim();
    if (trimmed) {
      if (TERM_HIST[TERM_HIST.length - 1] !== trimmed) TERM_HIST.push(trimmed);
      TERM_HI = -1;
      if (!termBuiltins(trimmed)) {
        TERM_ATTACHED = true;
        BRIDGE.send({ kind: 'termExec', cmd: trimmed });
      }
    }
    renderTermOut();
  }
  function wireTerm() {
    if (!TERM_SEEDED) {
      TERM_SEEDED = true;
      termWrite('Nolanguage terminal — type "help" for built-ins; other commands run in the project root.\\n', 'dim');
    }
    renderTermOut();
    var inp = $('termIn'); if (!inp) return;
    var out = $('termOut');
    if (out) out.addEventListener('click', function () { inp.focus(); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var v = inp.value; inp.value = '';
        if (TERM_ATTACHED) {
          BRIDGE.send({ kind: 'termInput', text: v + '\\n' });
          termWrite(v + '\\n'); renderTermOut();
        } else {
          termSubmit(v);
        }
      }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (TERM_HI < TERM_HIST.length - 1) { TERM_HI++; inp.value = TERM_HIST[TERM_HIST.length - 1 - TERM_HI] || ''; } }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (TERM_HI > 0) { TERM_HI--; inp.value = TERM_HIST[TERM_HIST.length - 1 - TERM_HI] || ''; } else { TERM_HI = -1; inp.value = ''; } }
      else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); TERM_LINES = []; renderTermOut(); }
    });
  }

  // ---------- message handling ----------
  function handle(m) {
    switch (m.kind) {
      case 'hello':
        KCOMMANDS = m.commands || [];
        $('aboutBody').innerHTML = 'Nolanguage · PyCharm-style shell<br/>app ' + esc(m.appVersion) +
          '<br/>' + esc(m.os) + ' / ' + esc(m.arch) + '<br/><span class="dim">kernel commands: ' + KCOMMANDS.length + '</span>';
        break;
      case 'workspace':
        // The plugin catalogue: languages, extensions, grammar and capabilities.
        applyLanguageCatalog(m.languages || []);
        break;
      case 'metrics':
        lastMetrics = m; if (activeBottom === 'perf') renderPerf(m);
        break;
      case 'log':
        (m.records || []).forEach(function (r) { LOGS.push(r); });
        if (LOGS.length > 2000) LOGS = LOGS.slice(-1500);
        if (activeBottom === 'logs') renderLogs();
        break;
      case 'diagnostics':
        // A switch can move the document on while a check is in flight; showing
        // the old language's problems under the new one would be a lie.
        if (m.language && m.language !== currentLang) break;
        renderProblems(m.items || []);
        break;
      case 'runResult':
        appendRun('\\nProcess finished with exit code ' + (m.exitCode == null ? '?' : m.exitCode) +
          '  (' + fmtMs(m.durationMs) + ')\\n', m.exitCode === 0 ? 'ok' : 'err');
        RUN_ACTIVE = false;
        { var ri2 = $('runIn'); if (ri2) ri2.disabled = true; }
        break;
      case 'runStart':
        { var ro = $('runOut'); if (ro) ro.innerHTML = '<span class="dim">Running ' + currentFile + ' …</span>'; }
        RUN_ACTIVE = true;
        { var ri3 = $('runIn'); if (ri3) { ri3.disabled = false; ri3.focus(); } }
        break;
      case 'runOut':
        appendRun(m.text, m.stream === 'stderr' ? 'err' : '');
        break;
      case 'termResult':
        TERM_ATTACHED = false;
        if (m.code !== 0 && m.code !== null) termWrite('[exit ' + m.code + ' · ' + fmtMs(m.ms) + ']\\n', 'dim');
        renderTermOut();
        { var ti2 = $('termIn'); if (ti2) ti2.focus(); }
        break;
      case 'termOut':
        termWrite(m.text, m.stream === 'stderr' ? 'err' : '');
        renderTermOut();
        break;
      case 'extensions':
        renderExtModal(m.extensions || []);
        break;
      case 'extension':
        toast('[' + m.event + '] ' + m.extensionId);
        break;
      case 'extensionResult':
        toast(m.ok ? ('result: ' + JSON.stringify(m.result)) : ('error: ' + m.error));
        break;
      case 'fsListing': onFsListing(m); break;
      case 'fsFile': onFsFile(m.file); break;
      case 'fsSaved': onFsSaved(m); break;
      case 'fsChanged': onFsChanged(m); break;
      case 'fsRoot':
        ROOT_NAME = m.name;
        { var pv = document.querySelector('#projWidget .val'); if (pv) pv.textContent = m.name; }
        break;
      case 'fsError': onFsError(m); break;
      case 'completion': onCompletion(m); break;
      case 'hover': onHover(m); break;
    }
  }

  // ---------- extensions modal ----------
  function renderExtModal(list) {
    var body = $('extBody');
    if (!list.length) { body.innerHTML = '<div class="empty">No extensions discovered.</div>'; return; }
    body.innerHTML = list.map(function (e) {
      var st = e.state || (e.compatible ? 'idle' : 'incompatible');
      var h = '<div class="xrow"><div class="top"><span class="nm">' + esc(e.name) + '</span>' +
        '<span class="state ' + st + '">' + st + '</span></div>' +
        '<div class="meta">' + esc(e.id) + ' · v' + esc(e.version) + ' · engine ^' + esc(e.engine) + '</div>';
      if (e.pid != null) h += '<div class="meta">pid ' + e.pid + ' · crashes ' + e.crashes + ' · rss ' + Math.round((e.rssBytes || 0) / 1048576) + 'MB</div>';
      var cmds = e.commands || [];
      if (cmds.length) {
        h += '<div class="cmds">';
        cmds.forEach(function (c) {
          h += '<button data-cmd="' + esc(c.id) + '">' + esc(c.title || c.id) + '</button>';
        });
        h += '</div>';
      }
      return h + '</div>';
    }).join('');
    body.querySelectorAll('[data-cmd]').forEach(function (b) {
      b.addEventListener('click', function () {
        BRIDGE.send({ kind: 'runExtensionCommand', id: b.getAttribute('data-cmd'), args: [], reqId: Date.now() % 100000 });
        toast('ran ' + b.getAttribute('data-cmd'));
      });
    });
  }

  // ---------- menus ----------
  var MENUS = {
    'File': [
      { label: 'Open...', sc: 'Ctrl+O', act: openNativeFile },
      { label: 'Open Folder...', act: openNativeFolder },
      { label: 'Save', sc: 'Ctrl+S', act: saveFile },
      { label: 'Save As...', sc: 'Ctrl+Shift+S', act: saveAsNative },
      { sep: true },
      { label: 'Open Recent', act: openRecent }
    ],
    'Edit': [
      { label: 'Undo', sc: 'Ctrl+Z', act: function () { document.execCommand('undo'); } },
      { label: 'Redo', sc: 'Ctrl+Shift+Z', act: function () { document.execCommand('redo'); } }
    ],
    'View': [
      { label: 'Appearance: Darcula', sc: '', act: function () { setTheme('darcula'); } },
      { label: 'Appearance: Light', sc: '', act: function () { setTheme('light'); } },
      { sep: true },
      { label: 'Tool Window Bars', act: function () { $('strip').style.display = ($('strip').style.display === 'none' ? '' : 'none'); } },
      { label: 'Status Bar', act: function () { var s = document.querySelector('.status'); s.style.display = (s.style.display === 'none' ? '' : 'none'); } }
    ],
    'Navigate': [
      { label: 'Search Everywhere', sc: '⇧⇧', act: openSearch },
      { label: 'File Structure', sc: 'Ctrl+F12', act: function () { toggleWindow('structure'); } }
    ],
    'Code': [
      { label: 'Reformat Code', sc: 'Ctrl+Alt+L', act: function () { toast('Reformatted (demo)'); } },
      { label: 'Optimize Imports', sc: 'Ctrl+Alt+O', act: function () { toast('Optimized imports (demo)'); } }
    ],
    'Run': [
      { label: "Run 'main'", sc: 'Shift+F10', act: runCode },
      { label: "Debug 'main'", sc: 'Shift+F9', act: function () { runCode(); toast('Debug (demo)'); } },
      { sep: true },
      { label: 'Stop', act: function () { appendRun('\\n[stopped]\\n', 'dim'); } }
    ],
    'Tools': [
      { label: 'Extensions', act: openExt },
      { label: 'Language Plugins', act: openPlugins },
      { sep: true },
      { label: 'Performance', sc: 'Alt+8', act: function () { toggleWindow('perf'); } },
      { label: 'Logs', sc: 'Alt+0', act: function () { toggleWindow('logs'); } }
    ],
    'VCS': [ { label: 'Show Git Widget', act: function () { toast('Git: main (clean)'); } } ],
    'Window': [ { label: 'Minimize', act: function () { toast('minimize (demo)'); } } ],
    'Help': [ { label: 'About', act: openAbout } ]
  };
  function renderMenus() {
    var bar = $('menubar');
    Object.keys(MENUS).forEach(function (name) {
      var m = document.createElement('div');
      m.className = 'menu'; m.textContent = name;
      var pop = document.createElement('div'); pop.className = 'pop';
      MENUS[name].forEach(function (it) {
        if (it.sep) { var s = document.createElement('div'); s.className = 'sep'; pop.appendChild(s); return; }
        var b = document.createElement('button'); b.className = 'item';
        b.innerHTML = '<span>' + esc(it.label) + '</span>' + (it.sc ? '<span class="sc">' + esc(it.sc) + '</span>' : '');
        b.addEventListener('click', function () { closeMenus(); if (it.act) it.act(); });
        pop.appendChild(b);
      });
      m.appendChild(pop);
      m.addEventListener('click', function (e) {
        e.stopPropagation();
        var wasOpen = m.classList.contains('open');
        closeMenus();
        if (!wasOpen) m.classList.add('open');
      });
      m.addEventListener('mouseenter', function () {
        if (bar.querySelector('.menu.open')) { closeMenus(); m.classList.add('open'); }
      });
      bar.insertBefore(m, bar.querySelector('.spacer'));
    });
  }
  function closeMenus() { document.querySelectorAll('.menu.open').forEach(function (m) { m.classList.remove('open'); }); }
  document.addEventListener('click', closeMenus);
  // A click *inside* the context menu is handled by the item itself (which may
  // open a submenu), so the global closer must not swallow it.
  document.addEventListener('click', function (e) { if (!(e.target && e.target.closest && e.target.closest('#ctxMenu'))) hideCtx(); });

  // One right-click rule for the whole shell: every region has a PyCharm-style
  // menu, so the browser's own never appears. Inputs are deliberately not
  // covered (they need the native clipboard menu), and a region that handled the
  // event itself — a project-tree row — wins via defaultPrevented.
  var lastCtxX = 0, lastCtxY = 0;
  document.addEventListener('contextmenu', function (e) {
    lastCtxX = e.clientX; lastCtxY = e.clientY;
    var t = e.target;
    var region = t && t.closest ? t.closest('[data-ctx]') : null;
    if (!region) return;
    if (e.defaultPrevented) return;
    e.preventDefault();
    var kind = region.getAttribute('data-ctx');
    var items = null;
    if (kind === 'editor') items = editorMenu();
    else if (kind === 'tab') {
      var row = t.closest('.etab');
      items = tabMenu(row ? row.getAttribute('data-tab') : null);
    } else if (kind === 'dock') items = dockMenu(region.querySelector('.dock-pane.active'));
    else if (kind === 'panel') items = panelMenu();
    if (items && items.length) showCtx(e.clientX, e.clientY, items);
    else hideCtx();
  });

  // ---------- theme ----------
  function setTheme(t) { document.documentElement.setAttribute('data-theme', t); savePrefs({ theme: t }); toast('Theme: ' + t); }

  // ---------- language mode ----------
  // The default is the file type: a document's language is its extension. This
  // is the explicit override — the status bar cell mirrors PyCharm's language
  // selector, so the choice is always visible and always undoable (the "Auto"
  // row just drops the override). Switching re-tokenises, re-checks, and makes
  // Run use the chosen language instead of the extension.
  function renderStLang() {
    var el = $('stLang'); if (!el) return;
    var manual = !!(currentFile && LANGSET[currentFile]);
    var auto = currentFile ? (langOfName(currentFile) || 'python') : 'python';
    var label = currentFile ? langLabel(currentLang) : 'No file';
    el.innerHTML = ic('file', 14) + '<span class="lbl">' + esc(label + (manual ? ' · manual' : '')) + '</span>';
    el.title = !currentFile
      ? 'Language mode'
      : manual
        ? 'Language mode: ' + langLabel(currentLang) + ' — set manually. ' + currentFile + ' reads as ' + langLabel(auto) + ' by extension. Click to change.'
        : 'Language mode: ' + langLabel(currentLang) + ' — from the file type of ' + currentFile + '. Click to change.';
    el.classList.add('act');
  }
  function openLangPicker() {
    var inp = $('langInput');
    if (inp) inp.value = '';
    renderLangs('');
    openModal('langModal');
    if (inp) inp.focus();
  }
  function langRow(id, name, hint, sel) {
    return '<div class="mres' + (sel ? ' sel' : '') + '" data-lang="' + esc(id) + '">' +
      '<span class="ic">' + ic('file', 16) + '</span>' +
      '<span class="nm">' + esc(name) + '</span>' +
      '<span class="path">' + esc(hint) + '</span></div>';
  }
  function renderLangs(q) {
    var body = $('langBody');
    if (!currentFile) {
      body.innerHTML = '<div class="empty" style="padding:14px">Open a file to choose its language mode.</div>';
      return;
    }
    var f = String(q || '').toLowerCase();
    var auto = langOfName(currentFile) || 'python';
    var manual = !!LANGSET[currentFile];
    var html = '';
    if (!f || 'auto'.indexOf(f) !== -1 || langLabel(auto).toLowerCase().indexOf(f) !== -1 || currentFile.toLowerCase().indexOf(f) !== -1) {
      html += '<div class="mgrp">Detected from the file name</div>' +
        langRow('', 'Auto — ' + langLabel(auto), currentFile, !manual);
    }
    var list = LANG_LIST.filter(function (l) {
      return !f || l.name.toLowerCase().indexOf(f) !== -1 || l.id.indexOf(f) !== -1;
    });
    if (list.length) {
      html += '<div class="mgrp">All languages</div>' + list.map(function (l) {
        return langRow(l.id, l.name, SERVER_LANGS[l.id] ? 'run · check' : 'highlight only', manual && LANGSET[currentFile] === l.id);
      }).join('');
    }
    body.innerHTML = html || '<div class="empty" style="padding:14px">No language matches "' + esc(q) + '".</div>';
    Array.prototype.slice.call(body.querySelectorAll('.mres')).forEach(function (el) {
      el.addEventListener('click', function () { setDocLang(el.getAttribute('data-lang') || ''); });
    });
  }
  /** \lang\ empty means "go back to the file type". */
  function setDocLang(lang) {
    if (!currentFile) return;
    // Boot shows a document without having opened it, so make the buffer on
    // demand rather than letting the picker silently do nothing.
    if (!BUFFERS[currentFile]) BUFFERS[currentFile] = { content: ta.value, languageId: langOfDoc(currentFile), editable: !ta.readOnly, dirty: false };
    var chosen = lang || langOfName(currentFile) || 'python';
    setLangOverride(currentFile, lang);
    BUFFERS[currentFile].languageId = chosen;
    currentLang = chosen;
    closeModals();
    renderStLang();
    renderEditor(); updateCaret();
    // Re-check under the new language; a language with no server has no
    // problems to show, so clear the previous language's list.
    if (lspLang()) BRIDGE.send({ kind: 'check', code: ta.value, language: lspLang() });
    else renderProblems([]);
    toast('Language mode: ' + langLabel(chosen) + (lang ? ' (manual)' : ' (from file type)'));
  }

  // ---------- modals ----------
  function openModal(id) { $(id).classList.add('open'); $('scrim').classList.add('open'); }
  function closeModals() { document.querySelectorAll('.modal.open').forEach(function (m) { m.classList.remove('open'); }); $('scrim').classList.remove('open'); }
  $('scrim').addEventListener('click', closeModals);
  function openAbout() { openModal('aboutModal'); }
  function openExt() { openModal('extModal'); BRIDGE.send({ kind: 'listExtensions' }); }
  // Plugins live in their own page because managing them means typing a path,
  // reading a validation report and watching a budget — a modal is too small
  // for that, and the IDE already has a place for "the whole picture": a tab.
  function openPlugins() { window.open('/plugins', '_blank'); }
  function openRecent() { renderRecent(); openModal('recentModal'); }
  function renderRecent() {
    var b = $('recentBody');
    if (!RECENT.length) { b.innerHTML = '<div class="empty" style="padding:14px">No recent files yet.</div>'; return; }
    b.innerHTML = RECENT.map(function (p, i) { return '<button class="ritem" data-i="' + i + '">' + esc(p) + '</button>'; }).join('');
    b.querySelectorAll('.ritem').forEach(function (el) {
      el.addEventListener('click', function () { closeModals(); openFile(RECENT[+el.getAttribute('data-i')]); });
    });
  }
  $('recentClose').addEventListener('click', closeModals);

  // ---------- Settings (Ctrl+Alt+S) ----------
  // The one page-level settings surface: appearance + which chrome is visible.
  // Changes apply immediately on OK and persist through the normal prefs path.
  function openSettings() {
    var dark = document.documentElement.getAttribute('data-theme') !== 'light';
    var bars = $('strip').style.display !== 'none';
    var sb = (function () { var s = document.querySelector('.status'); return s && s.style.display !== 'none'; })();
    showModal({
      title: 'Settings', icon: 'settings',
      checkboxes: [
        { name: 'dark', label: 'Darcula theme (dark)', def: dark },
        { name: 'bars', label: 'Show tool window bars', def: bars },
        { name: 'status', label: 'Show status bar', def: sb }
      ],
      buttons: [
        { label: 'Cancel', onClick: function () {} },
        { label: 'OK', primary: true, onClick: function (v) {
          setTheme(v.dark ? 'darcula' : 'light');
          $('strip').style.display = v.bars ? '' : 'none';
          var st = document.querySelector('.status'); if (st) st.style.display = v.status ? '' : 'none';
          savePrefs({ theme: v.dark ? 'darcula' : 'light' });
        } }
      ]
    });
  }

  // ---------- Run / Debug configurations ----------
  // The toolbar's run-config button is a real selector, not a hardcoded label.
  // Configs persist; selecting one drives what Shift+F10 executes.
  var RUN_CONFIGS = (PREFS.runConfigs && PREFS.runConfigs.length) ? PREFS.runConfigs.slice() : [{ name: 'main', path: 'main.py' }];
  var ACTIVE_CFG = PREFS.activeConfig && RUN_CONFIGS.some(function (c) { return c.name === PREFS.activeConfig; })
    ? PREFS.activeConfig : RUN_CONFIGS[0].name;
  function renderCfgLabel() {
    var b = $('cfgBtn'); if (b) { var v = b.querySelector('.val'); if (v) v.textContent = ACTIVE_CFG; }
  }
  function openRunConfig() {
    var btn = $('cfgBtn'); var r = btn ? btn.getBoundingClientRect() : { left: 0, bottom: 0 };
    var items = RUN_CONFIGS.map(function (c) {
      return { label: (c.name === ACTIVE_CFG ? '✓  ' : '    ') + c.name, act: function () { ACTIVE_CFG = c.name; renderCfgLabel(); savePrefs({ activeConfig: ACTIVE_CFG }); } };
    });
    items.push({ sep: true });
    items.push({ label: 'Edit Configurations…', act: editRunConfigs });
    showCtx(r.left, r.bottom + 3, items);
  }
  function editRunConfigs() {
    var dirty = RUN_CONFIGS.map(function (c) { return { name: c.name, path: c.path }; });
    function draw() {
      showModal({
        title: 'Run/Debug Configurations', icon: 'run',
        message: 'Each configuration names a script entry point for the selected language.',
        buttons: [
          { label: 'Add', onClick: function () { dirty.push({ name: 'config' + (dirty.length + 1), path: 'main.py' }); draw(); } },
          { label: 'Cancel', onClick: function () {} },
          { label: 'OK', primary: true, onClick: function () {
            RUN_CONFIGS = dirty;
            if (!dirty.some(function (c) { return c.name === ACTIVE_CFG; })) ACTIVE_CFG = dirty.length ? dirty[0].name : 'main';
            savePrefs({ runConfigs: RUN_CONFIGS, activeConfig: ACTIVE_CFG }); renderCfgLabel();
          } }
        ]
      });
      var body = $('dlgRoot').querySelector('.dlg-body');
      if (!body) return;
      body.innerHTML = dirty.map(function (c, i) {
        return '<div style="display:flex;gap:6px;margin-bottom:6px">' +
          '<input data-cn="' + i + '" value="' + esc(c.name) + '" style="width:38%" placeholder="name" />' +
          '<input data-cp="' + i + '" value="' + esc(c.path) + '" style="flex:1" placeholder="script path" />' +
          '<button data-del="' + i + '" class="dlg-btn" style="padding:0 9px">✕</button></div>';
      }).join('');
      body.querySelectorAll('input[data-cn]').forEach(function (inp) {
        inp.addEventListener('input', function () { dirty[+inp.getAttribute('data-cn')].name = inp.value; });
      });
      body.querySelectorAll('input[data-cp]').forEach(function (inp) {
        inp.addEventListener('input', function () { dirty[+inp.getAttribute('data-cp')].path = inp.value; });
      });
      body.querySelectorAll('button[data-del]').forEach(function (b) {
        b.addEventListener('click', function () { dirty.splice(+b.getAttribute('data-del'), 1); draw(); });
      });
    }
    draw();
  }

  // ---------- native file pickers (Tauri only) ----------
  // These are the one allowed piece of OS-native UI: Open / Open Folder / Save As
  // are real system dialogs. In the web preview there is no OS picker, so we fall
  // back to a balloon and the Project tool window still opens files.
  function tauriDialog() {
    var T = window.__TAURI__;
    return (T && T.dialog) ? T.dialog : null;
  }
  function openNativeFile() {
    var d = tauriDialog();
    if (!d) { balloon({ type: 'info', title: 'Open', message: 'The native file picker is available in the desktop app. In the web preview, open files from the Project tool window.' }); return; }
    d.open({
      multiple: false, directory: false,
      filters: [{ name: 'Source', extensions: ['py', 'js', 'ts', 'go', 'md', 'json', 'yaml', 'html', 'css'] }],
      title: 'Open File'
    }).then(function (p) { if (p) BRIDGE.send({ kind: 'fsRead', path: p }); });
  }
  function openNativeFolder() {
    var d = tauriDialog();
    if (!d) { balloon({ type: 'info', title: 'Open Folder', message: 'The native folder picker is available in the desktop app.' }); return; }
    d.open({ directory: true, multiple: false, title: 'Open Folder' }).then(function (p) { if (p) BRIDGE.send({ kind: 'openFolder', path: p }); });
  }
  function saveAsNative() {
    var d = tauriDialog();
    if (!d) { balloon({ type: 'info', title: 'Save As', message: 'The native save dialog is available in the desktop app.' }); return; }
    d.save({ defaultPath: currentFile || 'untitled.py', filters: [{ name: 'Source', extensions: ['py', 'js', 'ts', 'go', 'md'] }], title: 'Save As' })
      .then(function (p) { if (p) BRIDGE.send({ kind: 'fsWrite', path: p, content: ta.value }); });
  }

  // ---------- language mode wiring ----------
  $('stLang').addEventListener('click', openLangPicker);
  $('langClose').addEventListener('click', closeModals);
  $('langInput').addEventListener('input', function () { renderLangs(this.value); });
  $('langInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var first = $('langBody').querySelector('.mres'); if (first) first.click(); }
    if (e.key === 'Escape') { closeModals(); this.blur(); }
  });

  // ---------- search everywhere ----------
  var searchTab = 'all';
  var SYMBOLS = [
    { name: 'fib(n)', path: 'main.py:5' },
    { name: 'main()', path: 'main.py:13' },
    { name: 'Point', path: 'utils.py:5' },
    { name: 'Point.norm()', path: 'utils.py:9' }
  ];
  var ACTIONS = [
    { name: "Run 'main'", sc: 'Shift+F10', act: runCode },
    { name: 'Toggle Theme', act: function () { setTheme(document.documentElement.getAttribute('data-theme') === 'darcula' ? 'light' : 'darcula'); } },
    { name: 'Change Language Mode', act: openLangPicker },
    { name: 'Open Extensions', act: openExt }
  ];
  function openSearch() { openModal('searchModal'); renderSearch(''); setTimeout(function () { $('searchInput').focus(); }, 0); }
  function searchResults(q) {
    q = q.toLowerCase();
    var files = Object.keys(FILES).filter(function (f) { return f.toLowerCase().indexOf(q) >= 0; }).map(function (f) { return { group: 'Files', name: f, path: 'src', icon: 'file', act: function () { openFile(f); } }; });
    var syms = SYMBOLS.filter(function (s) { return s.name.toLowerCase().indexOf(q) >= 0; }).map(function (s) { return { group: 'Symbols', name: s.name, path: s.path, icon: 'structure', act: function () { openFile(s.path.split(':')[0]); } }; });
    var acts = KCOMMANDS.filter(function (c) { return c.id.toLowerCase().indexOf(q) >= 0; }).slice(0, 6).map(function (c) { return { group: 'Actions', name: c.title || c.id, path: c.id, icon: 'settings', act: function () { toast('command: ' + c.id); } }; });
    acts = acts.concat(ACTIONS.filter(function (a) { return a.name.toLowerCase().indexOf(q) >= 0; }).map(function (a) { return { group: 'Actions', name: a.name, path: '', icon: 'run', act: a.act }; }));
    var all = files.concat(syms, acts);
    if (searchTab !== 'all') all = all.filter(function (r) { return r.group.toLowerCase() === searchTab; });
    return all;
  }
  function renderSearch(q) {
    var res = searchResults(q), body = $('searchBody');
    if (!res.length) { body.innerHTML = '<div class="empty">No matches.</div>'; return; }
    var html = '', group = '';
    res.forEach(function (r, i) {
      if (r.group !== group) { group = r.group; html += '<div class="mgrp">' + group + '</div>'; }
      html += '<div class="mres' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '">' +
        '<span class="ic">' + ic(r.icon, 16) + '</span><span class="nm">' + esc(r.name) + '</span>' +
        (r.path ? '<span class="path">' + esc(r.path) + '</span>' : '') + '</div>';
    });
    body.innerHTML = html;
    Array.prototype.forEach.call(body.querySelectorAll('.mres'), function (el) {
      el.addEventListener('click', function () { var r = res[+el.getAttribute('data-i')]; closeModals(); r.act(); });
    });
  }
  $('searchInput').addEventListener('input', function () { renderSearch(this.value); });
  $('searchInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var first = $('searchBody').querySelector('.mres'); if (first) first.click(); }
    if (e.key === 'Escape') closeModals();
  });
  Array.prototype.forEach.call($('searchChips').querySelectorAll('.chip'), function (c) {
    c.addEventListener('click', function () {
      $('searchChips').querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); });
      c.classList.add('on'); searchTab = c.getAttribute('data-tab'); renderSearch($('searchInput').value);
    });
  });
  $('searchBtn').addEventListener('click', openSearch);
  $('searchClose').addEventListener('click', closeModals);
  $('extClose').addEventListener('click', closeModals);
  $('aboutClose').addEventListener('click', closeModals);

  // ---------- toolbar wiring ----------
  $('runBtn').addEventListener('click', runCode);
  $('debugBtn').addEventListener('click', function () { runCode(); toast('Debug (demo)'); });
  $('covBtn').addEventListener('click', function () { toast('Coverage (demo)'); });
  $('stopBtn').addEventListener('click', function () { appendRun('\\n[stopped]\\n', 'dim'); toast('Stopped'); });
  $('cfgBtn').addEventListener('click', function (e) { e.stopPropagation(); openRunConfig(); });
  $('projWidget').addEventListener('click', function () { toggleWindow('project'); });
  $('newBtn').addEventListener('click', function () { var r = $('newBtn').getBoundingClientRect(); showNewPopup(r.left, r.bottom + 3, ''); });
  $('vcsWidget').addEventListener('click', function () { toast('Git: main · up to date'); });
  $('themeBtn').addEventListener('click', function () { setTheme(document.documentElement.getAttribute('data-theme') === 'darcula' ? 'light' : 'darcula'); });
  $('settingsBtn').addEventListener('click', openSettings);
  $('panelCloseBtn').addEventListener('click', function () { $('leftPanel').classList.add('hidden'); renderStrip(); saveLayout(); });
  $('collapseBtn').addEventListener('click', function () { if (activeLeft === 'structure') { folded = {}; renderEditor(); } toast('Collapsed'); });
  $('pinBtn').addEventListener('click', function () { pinned = !pinned; this.style.color = pinned ? '' : 'var(--text-tertiary)'; toast(pinned ? 'Pinned' : 'Unpinned'); });
  $('dockHide').addEventListener('click', function () { $('dock').classList.add('hidden'); saveLayout(); });

  // ---------- Tauri window controls (the desktop app turns OS chrome off) ----------
  if (window.__TAURI__ && window.__TAURI__.window) {
    document.documentElement.setAttribute('data-tauri', '1');
    var win = window.__TAURI__.window.getCurrentWindow();
    var tbMin = $('tbMin'), tbMax = $('tbMax'), tbClose = $('tbClose');
    if (tbMin) tbMin.addEventListener('click', function () { win.minimize(); });
    if (tbMax) tbMax.addEventListener('click', function () { win.toggleMaximize(); });
    if (tbClose) tbClose.addEventListener('click', function () { win.close(); });
  }

  // ---------- keyboard shortcuts ----------
  document.addEventListener('keydown', function (e) {
    // Order matters: the Alt/Ctrl combos must be tested before the bare Ctrl+S,
    // otherwise Ctrl+Alt+S is swallowed by the save shortcut.
    if (e.ctrlKey && e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); openSettings(); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); openFindInFiles(); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveAsNative(); return; }
    if (e.ctrlKey && (e.key === 's' || e.key === 'S') && !e.shiftKey && !e.altKey) { e.preventDefault(); saveFile(); return; }
    if (e.ctrlKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); openNativeFile(); return; }
    if (e.key === 'Escape') { hideCtx(); return; }
    if (e.key === 'Shift' && !e.repeat) {
      var now = Date.now();
      if (now - lastShift < 400) { openSearch(); lastShift = 0; } else lastShift = now;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    var map = { '1': 'project', '9': 'vcs', 'k': 'commit', '7': 'structure', 'a': 'ai', '4': 'run', '8': 'perf', '0': 'logs' };
    var k = e.key.toLowerCase();
    if (map[k]) { e.preventDefault(); toggleWindow(map[k]); }
    if (e.key === 'F12') { e.preventDefault(); toggleWindow('terminal'); }
  });
  var lastShift = 0;

  // ---------- boot ----------
  // Restore persisted theme / layout / tabs before the first paint.
  if (PREFS.theme) document.documentElement.setAttribute('data-theme', PREFS.theme);
  if (PREFS.left) activeLeft = PREFS.left;
  if (PREFS.bottom) activeBottom = PREFS.bottom;
  if (PREFS.leftHidden) $('leftPanel').classList.add('hidden');
  else if (PREFS.leftHidden === false) $('leftPanel').classList.remove('hidden');
  if (PREFS.bottomHidden) $('dock').classList.add('hidden');
  if (PREFS.tabs && PREFS.tabs.length) { TABS = PREFS.tabs.slice(); currentFile = PREFS.current || TABS[0]; }
  // Only the bundled samples have content before the first fs round-trip, so a
  // restored file that is not one of them falls back to the first showable tab.
  if (!FILES[currentFile]) currentFile = TABS.filter(function (p) { return FILES[p] != null; })[0] || 'main.py';
  // A persisted language override travels with the document, so boot applies it.
  currentLang = langOfDoc(currentFile);
  paintIcons(document);
  renderMenus();
  renderStrip();
  renderCfgLabel();
  renderTabs();
  ta.value = FILES[currentFile] || '';
  // The status bar names the active file and its language, so restore must
  // refresh both (they are otherwise only written by openFile, which boot skips).
  $('stFile').textContent = currentFile;
  renderStLang();
  renderEditor();
  updateCaret();
  renderDock();
  renderPanel();
})();
</script>
</body>
</html>`;
}
