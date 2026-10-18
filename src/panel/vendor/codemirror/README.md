# CodeMirror 5 — vendored editor assets

This directory is the drop point for the **CodeMirror 5** distribution that the
editor plugin inlines. Nothing here is downloaded at runtime: the app is a
self-contained exe, so the files are imported statically (`?raw`) and bundled —
exactly like `../vue.global.prod.js`.

## Why CodeMirror 5 (and not 6)

CM5 is a single `codemirror.js` + `codemirror.css` with per-language mode files.
That is the only shape that can be vendored with **zero build tooling and zero
network**. CM6 is dozens of ESM packages and needs a bundler; the project has
neither esbuild-in-the-build nor network access.

## Required files (drop them here, keep these exact paths)

```
codemirror.js                      <- lib/codemirror.js
codemirror.css                     <- lib/codemirror.css
mode/python/python.js
mode/go/go.js
mode/javascript/javascript.js
mode/markdown/markdown.js
mode/xml/xml.js                    <- markdown mode depends on it
addon/hint/show-hint.js
addon/hint/show-hint.css
```

## Recommended addons (same paths, optional but used if present)

```
addon/edit/matchbrackets.js
addon/edit/closebrackets.js
addon/selection/active-line.js
addon/comment/comment.js
addon/fold/foldcode.js
addon/fold/foldgutter.js
addon/fold/brace-fold.js
addon/fold/indent-fold.js
addon/fold/markdown-fold.js
```

## How to obtain them (on a machine with network)

```bash
npm pack codemirror@5.65.16
tar -xzf codemirror-5.65.16.tgz
# copy package/lib/*, package/mode/*, package/addon/* into this directory,
# preserving the sub-paths shown above.
```

`codemirror@5.65.16` is the last CM5 release (MIT). Keep `LICENSE` alongside if
you copy the whole package.

## Verify the drop

```bash
node --experimental-transform-types --no-warnings \
  --experimental-loader ./resolve-loader.mjs scripts/verify-editor-assets.ts
```

It prints a per-file checklist and exits non-zero if anything required is
missing. Once it is green, the editor plugin can be wired (static `?raw`
imports in `src/panel/ui/codemirror-assets.ts`, CM init in
`ui/pycharm-client.ts`, LSP completion mapped to `showHint`).

## Integration contract (what the code will expect)

- `window.CodeMirror` is defined by `codemirror.js`.
- Modes are registered as `CodeMirror.modes.python` / `.go` / `.javascript` /
  `.markdown` after their files run.
- `CodeMirror.hint.auto` / `showHint` come from `addon/hint/show-hint.js`.
- The editor mounts into `#editorHost` (the existing `#ta` stays as the
  fallback when these files are absent).
