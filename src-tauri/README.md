# Nolanguage · Tauri shell

The desktop host: a Rust window plus the engine it relays to. The engine is the
same Node program (`src/`) the dev server runs, started as a sidecar with
`--panel-stdio` so it speaks the panel protocol on stdin/stdout instead of over
a WebSocket.

```
 webview ──invoke('engine_send', {msg})──▶ Rust ──line of JSON──▶ sidecar stdin
 webview ◀──emit('engine_message', msg)─── Rust ◀──line of JSON─── sidecar stdout
```

## Status: compiled, and the release binary runs standalone

The Rust compiles clean on this machine (`cargo 1.99.1`, Windows/MSVC):

```
cargo check                     Finished, 0 errors, 0 warnings
cargo clippy -- -D warnings     Finished, 0 warnings
cargo build                     Finished in ~48s  → target/debug/nolanguage.exe
tauri build                     release binary built → target/release/nolanguage.exe
```

`@tauri-apps/cli` 2.12.3 is installed as a devDependency (the `npm` shim in
`D:\node` is broken here, so it was installed with
`node D:\node\node_modules\npm\bin\npm-cli.js install --save-dev @tauri-apps/cli`).

### Verified, not just built

`target/release/nolanguage.exe` was run **standalone** — no dev server — and the
sidecar's stdin trace shows the whole boot arriving through the relay:

```
in {"kind":"listExtensions"}
in {"kind":"fsRead","path":"main.py"}
in {"code":"import os\nimport sys\n…"}            ← the Check request
in {"kind":"fsList","path":""}                    → fsListing: 14 dirs, 7 files
out {"kind":"workspace",…} {"kind":"fsRoot",…} {"kind":"diagnostics",…} …
```

So the assets are embedded, the page loads from them, and both directions of the
IPC work in the production build. (The HTML is compressed inside the binary, so
grepping it for `nolanguage.pycharm.v1` finds nothing — that is not a symptom.)

### The installer is *not* produced here

`tauri build` compiles the binary and then stops at the bundling step: MSI needs
WiX and NSIS needs its own toolchain, and **both are downloaded from
github.com at bundle time**. This machine cannot reach GitHub (DNS blocked), nor
any of the usual proxies (ghproxy / ghfast / gh-proxy all time out), so the
download hangs indefinitely. The binary is fine; only the installer packaging is
blocked.

On a network with GitHub access:

```bash
npm run tauri build        # → target/release/bundle/msi/*.msi + bundle/nsis/*.exe
```

To run the release binary by hand (no installer):

```bash
cp dist/Nolanguage.exe target/release/NolanguageEngine-x86_64-pc-windows-msvc.exe
./target/release/nolanguage.exe
```

Note the release build is **not** a dev build: assets are embedded and `devUrl`
is unused, so no dev server is needed.

## Build

```bash
# 1. the frontend asset (from the same renderer the dev server uses)
npm run build:frontend          # → frontend/dist/index.html

# 2. the engine sidecar, named the way Tauri's externalBin requires
npm run build:exe               # → dist/Nolanguage.exe
cp dist/Nolanguage.exe binaries/NolanguageEngine-x86_64-pc-windows-msvc.exe

# 3. the shell
npm run tauri build             # → target/release/bundle/
```

`externalBin` names `binaries/NolanguageEngine`; Tauri appends the target triple
itself, so the file on disk must carry it
(`NolanguageEngine-x86_64-pc-windows-msvc.exe`). The bundled installer strips the
triple, so `engine.rs` accepts either name at runtime
(`NolanguageEngine.exe` or `NolanguageEngine-<triple>.exe`).

### Running a bare `cargo build` output

`cargo build` (unlike `tauri build`) produces a **dev-mode** binary: it does not
embed `frontendDist`, it loads `devUrl`, and it expects the sidecar next to the
exe. So to run `target/debug/nolanguage.exe` directly:

```bash
cp dist/Nolanguage.exe target/debug/NolanguageEngine-x86_64-pc-windows-msvc.exe
node scripts/serve-dist.mjs &          # the devUrl server
./target/debug/nolanguage.exe
```

`tauri dev` does both for you.

## What the Rust knows

Nothing about the protocol. It spawns the sidecar, writes each `invoke` payload
as one line of JSON to its stdin, and forwards each line of stdout back as an
`engine_message` event. Every semantic decision — routing, languages, the
sandbox, the file service — stays in `src/`, where it is tested.

## Bugs found while getting here running

These cost real debugging time and are worth keeping in mind:

1. **A missing sidecar used to fork the app.** `shell().sidecar("Nolanguage")`
   falls back to a bare-name lookup when `Nolanguage-<triple>` is absent, and on
   a case-insensitive filesystem `Nolanguage.exe` *is the app* — so it spawned
   itself, which spawned itself: 180 processes in ~15s. `engine.rs` now computes
   the path explicitly, requires the exact `<name>-<triple>` file, and refuses
   to spawn anything that canonicalises to `current_exe()`.
2. **The page must talk to `__TAURI_INTERNALS__`, not `__TAURI__`.** The
   friendly global comes from `@tauri-apps/api`, which this page deliberately
   does not bundle (the jsdom suites enforce a self-contained page). Probing a
   live window confirmed it: `__TAURI__` is `undefined`,
   `__TAURI_INTERNALS__` has `invoke` and `transformCallback`. The bridge uses
   the latter, and events go through `plugin:event|listen` with a
   `transformCallback` id.
3. **`cargo build` is a dev build** (see above) — assets are not embedded and
   the window is blank without the dev server. Easy to misread as "Tauri is
   broken".
4. **Single instance is not automatic.** A second launch used to open a second
   window (and a second engine), which reads exactly like "the program started
   repeatedly". `tauri-plugin-single-instance` is now wired, and closing the
   window exits the process so the sidecar is never orphaned.

## Registry mirror

crates.io is unreachable from this machine (DNS blocked), so the repo carries
`.cargo/config.toml` pointing the sparse index and downloads at RsProxy. It is
repo-local and changes nothing on a network that reaches crates.io directly.

## Notes

- `csp` keeps `'unsafe-inline'` because the shell page is a single inline
  `<script>` + `<style>`. Splitting them into files (as `build-frontend.mjs`
  could) would let it be tightened to `script-src 'self'`.
- The dev-only pages (`/monitor`, `/perf`, `/extensions`) are not bundled: they
  speak WebSocket to a host on `location.host`, which a Tauri build does not
  have. Use `npm run ide` for those.
- `capabilities/default.json` grants only the shell + event permissions. The
  page has no network and no filesystem access of its own.
- `NOLANGUAGE_STDIO_TRACE=<file>` makes the engine append every inbound and
  outbound stdio frame to that file — the only way to see what the UI actually
  sent through the relay, and how the bugs above were diagnosed.
