// RSS soft-limit watchdog for `script-host` child processes.
//
// Loaded via `node -r <this file>` *before* the plugin's runtime.js. It polls
// `process.memoryUsage().rss` and self-terminates the process once resident
// memory exceeds NL_MEM_LIMIT_BYTES.
//
// Why a child-side watchdog instead of `setrlimit`? Node exposes no portable
// `setrlimit` binding, and a parent-side poll would need a native dep
// (`pidusage`) on Windows. A `--require`d ESM timer is zero-dependency and
// cross-platform. The V8 `--max-old-space-size` flag caps only the *old space
// heap*; this watchdog is the real OS-level (RSS) cap.
//
// Plain ESM on purpose: it must load without the host's TS loader and must not
// import any substrate module.
const limit = Number(process.env.NL_MEM_LIMIT_BYTES);

if (Number.isFinite(limit) && limit > 0) {
  const interval = setInterval(() => {
    let rss;
    try {
      rss = process.memoryUsage().rss;
    } catch {
      // Cannot read memory — bail out of watching rather than crash the run.
      clearInterval(interval);
      return;
    }
    if (rss > limit) {
      clearInterval(interval);
      // 137 == 128 + SIGKILL: a recognizable "killed" exit code that the host
      // surfaces as a memory-cap violation rather than a generic non-zero exit.
      process.exit(137);
    }
  }, 250);

  // Never keep a short-lived run alive just for the watchdog timer.
  if (typeof interval.unref === 'function') interval.unref();
}
