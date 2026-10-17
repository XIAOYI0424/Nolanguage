/**
 * Worker bootstrap sources, inlined as string constants so they bundle into
 * the packaged exe with no asset-embedding step. `WarmWorker` materialises
 * them to a temp file on first use and spawns `python <file>` / `node <file>`.
 *
 * Wire protocol (both workers): the driver writes `<len>\n<json-bytes>` and the
 * worker answers with `<len>\n<json-bytes>`. On stdin EOF the worker exits.
 * The worker processes one request at a time and stays alive, so a session's
 * state (Python globals / Node context globals) survives between runs — that
 * is the whole point of the warm pool.
 */

/** Persistent Python REPL worker (pure stdlib). */
export const PYTHON_WORKER_SRC = [
  'import sys, json, io, traceback, time',
  'NS = {}',
  '',
  'def read_frame():',
  '    line = sys.stdin.buffer.readline()',
  '    if not line:',
  '        return None',
  '    n = int(line.strip())',
  '    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))',
  '',
  'def write_frame(obj):',
  '    b = json.dumps(obj).encode("utf-8")',
  '    sys.stdout.buffer.write(str(len(b)).encode() + b"\\n")',
  '    sys.stdout.buffer.flush()',
  '',
  'while True:',
  '    req = read_frame()',
  '    if req is None:',
  '        break',
  '    code = req.get("code", "")',
  '    out = io.StringIO()',
  '    err = io.StringIO()',
  '    ok = True',
  '    error = None',
  '    t0 = time.perf_counter()',
  '    try:',
  '        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):',
  '            exec(compile(code, "<sandbox>", "exec"), NS)',
  '    except BaseException:',
  '        # Keep the worker alive for any snippet error (incl. SystemExit).',
  '        ok = False',
  '        error = traceback.format_exc()',
  '    dt = (time.perf_counter() - t0) * 1000.0',
  '    write_frame({',
  '        "id": req.get("id"),',
  '        "ok": ok,',
  '        "stdout": out.getvalue(),',
  '        "stderr": err.getvalue(),',
  '        "error": error,',
  '        "durationMs": dt,',
  '    })',
].join('\n');

/**
 * Persistent Node worker: the *process* is reused, but every run gets a fresh
 * vm context. That is not an oversight — a shared context cannot re-declare a
 * top-level `const`/`let` (running the snippet a second time would die with
 * "Identifier 'x' has already been declared"), so a fresh context is what keeps
 * ordinary modern JavaScript re-runnable. Consequently `globalThis` assignments
 * do *not* carry over between runs; Python's namespace does (its worker execs
 * into one long-lived dict).
 */
export const NODE_WORKER_SRC = [
  "import vm from 'node:vm';",
  "import process from 'node:process';",
  '',
  'let buf = Buffer.alloc(0);',
  'let parsing = false;',
  '',
  'function makeContext() {',
  '  const out = [];',
  '  const err = [];',
  '  const push = (arr, args) => { arr.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" ") + "\\n"); };',
  '  const sandbox = {',
  '    console: {',
  '      log: (...a) => push(out, a),',
  '      info: (...a) => push(out, a),',
  '      debug: (...a) => push(out, a),',
  '      warn: (...a) => push(err, a),',
  '      error: (...a) => push(err, a),',
  '    },',
  '    setTimeout, clearTimeout, setInterval, clearInterval,',
  '    queueMicrotask,',
  '    process: { env: {}, argv: [], platform: process.platform, version: process.version },',
  '    globalThis: null,',
  '  };',
  '  const ctx = vm.createContext(sandbox);',
  '  sandbox.globalThis = ctx;',
  '  return { ctx, out, err };',
  '}',
  '',
  'function tryParse() {',
  '  if (parsing) return;',
  '  const nl = buf.indexOf(0x0a);',
  '  if (nl === -1) return;',
  '  const len = parseInt(buf.subarray(0, nl).toString("utf8").trim(), 10);',
  '  if (!Number.isFinite(len)) { buf = buf.subarray(nl + 1); return; }',
  '  if (buf.length < nl + 1 + len) return;',
  '  const json = buf.subarray(nl + 1, nl + 1 + len);',
  '  buf = buf.subarray(nl + 1 + len);',
  '  let req;',
  '  try { req = JSON.parse(json.toString("utf8")); } catch { parsing = false; return; }',
  '  parsing = true;',
  '  handle(req).then((res) => {',
  '    const b = Buffer.from(JSON.stringify(res), "utf8");',
  '    process.stdout.write(Buffer.from(String(b.length) + "\\n", "utf8"));',
  '    process.stdout.write(b);',
  '    parsing = false;',
  '    setImmediate(tryParse);',
  '  });',
  '}',
  '',
  'async function handle(req) {',
  '  const { ctx, out, err } = makeContext();',
  '  out.length = 0; err.length = 0;',
  '  let ok = true; let error = null;',
  '  const t0 = process.hrtime.bigint();',
  '  try {',
  '    vm.runInContext(req.code || "", ctx, { filename: "<sandbox>" });',
  '  } catch (e) {',
  '    ok = false;',
  '    error = e instanceof Error ? (e.stack || e.message) : String(e);',
  '  }',
  '  const dt = Number(process.hrtime.bigint() - t0) / 1e6;',
  '  return { id: req.id, ok, stdout: out.join(""), stderr: err.join(""), error, durationMs: dt };',
  '}',
  '',
  "process.stdin.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); tryParse(); });",
  "process.stdin.on('end', () => process.exit(0));",
].join('\n');
