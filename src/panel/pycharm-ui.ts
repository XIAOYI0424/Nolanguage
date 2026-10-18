/**
 * PyCharm New UI shell (design: 复刻 PyCharm 2024.1+ New UI) — **assembly**.
 *
 * The page is still one self-contained HTML document (no build step, no CDN,
 * no network), but it is assembled from three files so each layer has an owner:
 *
 *   ui/pycharm-css.ts     <- the stylesheet
 *   ui/pycharm-shell.ts   <- the body markup
 *   ui/pycharm-client.ts  <- the browser script (one IIFE)
 *
 * This file keeps only what is genuinely server-side: the Python token pattern,
 * the sample workspace and the expui icon geometry, plus the string assembly.
 */
import { PYCHARM_CSS } from './ui/pycharm-css.js';
import { PYCHARM_SHELL } from './ui/pycharm-shell.js';
import { pyCharmClientScript } from './ui/pycharm-client.js';
import { CODEMIRROR_CSS, CODEMIRROR_JS } from './ui/codemirror-assets.js';

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
<!-- The UI is English while the OS may be Chinese; without this Chromium pops
     its "translate this page?" bubble over the app window. -->
<meta name="google" content="notranslate" />
<title>Nolanguage · PyCharm UI</title>
<style>
${PYCHARM_CSS}
${CODEMIRROR_CSS}
</style>
</head>
${PYCHARM_SHELL}
<script>
${CODEMIRROR_JS}
</script>
<script>
${pyCharmClientScript({ iconsJson, patternJson, mainJson, utilsJson, jsJson, readmeJson })}
</script>
</body>
</html>`;
}
