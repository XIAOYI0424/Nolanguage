# CodeMirror 5 — vendored editor assets

Vendored from **`codemirror@5.65.21`** (MIT). These files are inlined into the
self-contained page: nothing is fetched at runtime, and CodeMirror is **not** an
npm dependency. The packaged exe carries them exactly like the vendored Vue
runtime.

## Why CodeMirror 5 (and not 6)

CM5 is a single `codemirror.js` + `codemirror.css` with per-language mode files.
That is the only shape that can be vendored with **zero build tooling and zero
network**. CM6 is dozens of ESM packages and needs a bundler.

## Files

```
codemirror.js / codemirror.css     core
mode/{python,go,javascript,markdown,xml,css,yaml,sql,shell,toml,htmlmixed}/
addon/hint/show-hint.js + .css     completion UI (loaded; the shell uses its own popup)
addon/edit/matchbrackets.js
addon/edit/closebrackets.js
addon/selection/active-line.js
addon/fold/foldcode.js + foldgutter.js + .css     folding commands, gutter, arrows
addon/fold/brace-fold.js + indent-fold.js        local finders (no-LSP fallback)
LICENSE
```

Folding is the one addon group the shell depends on for a feature (Code > Fold),
so `verify-editor-assets` treats those five files as **required**, not optional.

`xml` is loaded before `markdown` / `htmlmixed` because those resolve
`text/xml` / `text/html` when a mode instance is created.

## How it is wired

- `src/panel/ui/codemirror-assets.ts` imports every file with `?raw` and exports
  `CODEMIRROR_CSS` / `CODEMIRROR_JS` (load order: core → modes → addons →
  show-hint) plus a theme bridge that maps CM token classes onto the shell's
  `--syn-*` variables (Light / Darcula).
- `src/panel/pycharm-ui.ts` emits the CSS inside `<style>` and the JS inside a
  `<script>` block **before** the client script.
- `src/panel/ui/pycharm-client.ts`:
  - creates `#cmHost` and `CodeMirror(host, {...})` when `window.CodeMirror`
    exists and the UA is not jsdom;
  - wraps the instance in a **textarea-compatible adapter** (`value`,
    `selectionStart/End`, `setSelectionRange`, `scrollTop/Left`, `readOnly`,
    `focus`, `addEventListener`, `getBoundingClientRect`), then reassigns `ta`
    to it — the rest of the client keeps working unchanged;
  - hides `#ta`, `#hl`, the custom `#gutter` and `#curline`;
  - positions the completion popup with `cm.cursorCoords`, hover with
    `coordsChar`, undo/redo with `cm.undo/redo`;
  - sets `allowDropFileTypes: []` so a dropped file is never read into the
    buffer (native-shell hardening).
- jsdom (the verification harness) has no layout, so the client detects its UA
  and stays on the textarea. `verify-pycharm` therefore tests the fallback, and
  a static assertion checks that the page ships CodeMirror.

## Adding a language mode

1. Copy `mode/<lang>/<lang>.js` here.
2. Import it in `codemirror-assets.ts` (before `htmlmixed` if it depends on it).
3. Map the plugin id to the mode name in `cmModeFor()` in `pycharm-client.ts`.
4. A language without a vendored mode still works — CM shows it as plain text,
   and the textarea fallback keeps using the manifest's `grammar.rules`.

## Upgrading

Replace the files with a newer CM5 release, then run:

```bash
node --experimental-transform-types --no-warnings \
  --experimental-loader ./resolve-loader.mjs scripts/verify-editor-assets.ts
npm run verify:ui        # verify-pycharm (181 checks)
npm run build:exe && npm run build:setup
```

`verify-editor-assets.ts` prints a per-file checklist and validates the two
entry points (`codemirror.js` defines `CodeMirror`, `codemirror.css` targets
`.CodeMirror`).
