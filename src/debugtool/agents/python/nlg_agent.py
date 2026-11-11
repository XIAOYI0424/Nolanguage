"""Nolanguage Debug Observatory — in-process agent (Python).

Injected through `sitecustomize` + `PYTHONPATH`, so the observed program keeps
its argv, its `__main__` and its source exactly as written. Everything it does is
bounded: a fixed sample rate, a fixed stack depth, and a serializer that refuses
to walk forever.

What it sends (NDJSON over the loopback socket):

    hello       once, on attach
    stack       `hz` times a second — the main thread's frames
    snapshot    live locals (every few samples) and on-demand expressions
    watch       user expressions, evaluated at a low rate
    exception   uncaught exceptions, before the process dies
    bye         on interpreter shutdown

What it receives: `set-watches`, `snapshot`, `bye`.

Non-negotiable rules (they are what makes this safe to leave running):

  * never raise into user code — every send/parse is wrapped;
  * never call `repr()` / properties / `__getattr__` — only real data;
  * redact by name *before* the value leaves the process;
  * stop sampling when the engine goes away, but never stop the program.
"""
import json
import os
import socket
import sys
import threading
import time
import traceback

V = 1
MAX_FRAMES = 12
MAX_DEPTH = 6
MAX_ITEMS = 50
MAX_STR = 512
MAX_NODES = 4000
MAX_LOCALS = 24
REDACT = ("password", "passwd", "secret", "token", "apikey", "api_key", "authorization", "cookie", "credential")

_state = {
    "sock": None,
    "lock": threading.Lock(),
    "stop": threading.Event(),
    "watches": [],
    "sent": 0,
    "dropped": 0,
    "ticks": 0,
}
_main_ident = None


# --------------------------------------------------------------------- plumbing

def _send(ev):
    """One NDJSON line. Failures are counted, never raised."""
    sock = _state["sock"]
    if sock is None:
        return
    try:
        line = json.dumps(ev, separators=(",", ":"), default=str) + "\n"
        with _state["lock"]:
            sock.sendall(line.encode("utf-8"))
        _state["sent"] += 1
    except Exception:
        _state["dropped"] += 1


def _connect():
    port = int(os.environ.get("NLG_DEBUG_PORT", "0") or 0)
    if not port:
        return None
    sock = socket.create_connection(("127.0.0.1", port), timeout=3.0)
    sock.settimeout(None)
    return sock


# ------------------------------------------------------------------- serializer

def _sensitive(name):
    low = name.lower()
    return any(r in low for r in REDACT)


def _typename(v):
    t = type(v)
    if t.__name__ == "instance":
        return t.__name__
    return t.__name__


def _clip(s):
    if len(s) <= MAX_STR:
        return s
    return s[:MAX_STR] + "… (%d more chars)" % (len(s) - MAX_STR)


def _prim(v):
    if v is None:
        return {"k": "prim", "t": "none", "v": "None"}
    if v is True or v is False:
        return {"k": "prim", "t": "bool", "v": "true" if v else "false"}
    if isinstance(v, int) and not isinstance(v, bool):
        return {"k": "prim", "t": "int", "v": str(v)}
    if isinstance(v, float):
        return {"k": "prim", "t": "float", "v": repr(v)}
    if isinstance(v, str):
        return {"k": "prim", "t": "str", "v": _clip(v)}
    if isinstance(v, bytes):
        return {"k": "prim", "t": "str", "v": _clip(repr(v[:64]))}
    return None


# Types we are willing to stringify: they cannot execute user code.
_SAFE_STR = ("datetime", "date", "time", "timedelta", "Decimal", "UUID", "Path", "PurePath", "Fraction")


def ser(v, depth=0, path="$", key=None, seen=None, budget=None):
    """Bounded, side-effect-free serialization (mirrors src/debugtool/serializer.ts)."""
    if seen is None:
        seen = {}
    if budget is None:
        budget = [MAX_NODES]
    budget[0] -= 1
    if budget[0] <= 0:
        return {"k": "trunc", "why": "size"}

    if key is not None and _sensitive(key):
        return {"k": "trunc", "why": "redacted", "t": _typename(v)}

    p = _prim(v)
    if p is not None:
        return p

    ident = id(v)
    if ident in seen:
        return {"k": "obj", "t": _typename(v), "fields": [], "cycle": seen[ident]}
    if depth >= MAX_DEPTH:
        return {"k": "trunc", "why": "depth", "t": _typename(v)}
    seen[ident] = path

    try:
        if isinstance(v, (list, tuple)):
            items = []
            for i, item in enumerate(v):
                if i >= MAX_ITEMS or budget[0] <= 0:
                    break
                items.append(ser(item, depth + 1, "%s[%d]" % (path, i), None, seen, budget))
            node = {"k": "seq", "t": _typename(v), "n": len(v), "items": items}
            if len(v) > len(items):
                node["more"] = len(v) - len(items)
            return node

        if isinstance(v, (set, frozenset)):
            items = []
            for i, item in enumerate(v):
                if i >= MAX_ITEMS or budget[0] <= 0:
                    break
                items.append(ser(item, depth + 1, "%s{%d}" % (path, i), None, seen, budget))
            node = {"k": "seq", "t": _typename(v), "n": len(v), "items": items}
            if len(v) > len(items):
                node["more"] = len(v) - len(items)
            return node

        if isinstance(v, dict):
            entries = []
            for i, (k, val) in enumerate(v.items()):
                if i >= MAX_ITEMS or budget[0] <= 0:
                    break
                key_node = ser(k, depth + 1, "%s.key%d" % (path, i), None, seen, budget)
                entries.append([key_node, ser(val, depth + 1, "%s[%d]" % (path, i), k if isinstance(k, str) else None, seen, budget)])
            node = {"k": "map", "t": _typename(v), "n": len(v), "entries": entries}
            if len(v) > len(entries):
                node["more"] = len(v) - len(entries)
            return node

        # Dataclasses / plain objects: __dict__ only. Reading it cannot run code,
        # unlike getattr() on a property.
        fields = []
        raw = getattr(v, "__dict__", None)
        if isinstance(raw, dict):
            # `list(raw.keys())` would copy every key of the object *inside the
            # observed process*, at the live-locals rate (2 Hz). On a 200k-key
            # object that is a ~20 MB allocation twice a second in someone else's
            # program — the tool would be the reason it got slow. `len()` is O(1)
            # and iterating a dict view is lazy, so the work is O(MAX_ITEMS).
            total = len(raw)
            for name, value in raw.items():
                if len(fields) >= MAX_ITEMS or budget[0] <= 0:
                    break
                fields.append([name, ser(value, depth + 1, "%s.%s" % (path, name), name, seen, budget)])
            node = {"k": "obj", "t": _typename(v), "fields": fields}
            if total > len(fields):
                node["more"] = total - len(fields)
            return node

        slots = getattr(type(v), "__slots__", None)
        if slots:
            for name in (slots if isinstance(slots, (list, tuple)) else [slots]):
                if len(fields) >= MAX_ITEMS or budget[0] <= 0:
                    break
                try:
                    val = object.__getattribute__(v, name)
                except Exception:
                    continue
                fields.append([name, ser(val, depth + 1, "%s.%s" % (path, name), name, seen, budget)])
            return {"k": "obj", "t": _typename(v), "fields": fields}

        if _typename(v) in _SAFE_STR:
            return {"k": "prim", "t": "str", "v": _clip(str(v))}

        return {"k": "trunc", "why": "unsupported", "t": _typename(v)}
    finally:
        seen.pop(ident, None)


# ------------------------------------------------------------------ frame utils

_AGENT_FILES = ("nlg_agent.py", "sitecustomize.py")


def _frames_of(frame):
    """Frames of the target, never the agent's own startup.

    `boot()` runs *inside* `sitecustomize`, so the first samples show the
    interpreter importing us — a stack of `sitecustomize > boot > start > wait`
    that has nothing to do with the program and would be the hottest stack in the
    first second. Those samples are dropped rather than relabelled: "no data yet"
    is honest, "the agent is the hot path" is not.
    """
    out = []
    for summary in traceback.extract_stack(frame)[-MAX_FRAMES:]:
        name = os.path.basename(summary.filename or "")
        if name in _AGENT_FILES:
            return []
        out.append({"fn": summary.name, "file": name, "line": summary.lineno or 0})
    return out


def _main_frame():
    if _main_ident is None:
        return None
    return sys._current_frames().get(_main_ident)


def _namespace(frame, max_frames=12):
    """Names visible from `frame`, walking outwards (innermost wins).

    A debugger shows the whole call chain for a reason: while the program sits in
    `work()`, `order` still lives in `main()`'s frame, and a user typing
    `order.items` means *that* `order`. Evaluating in the innermost frame alone
    turns every useful expression into `NameError`.
    """
    ns = {}
    f = frame
    depth = 0
    while f is not None and depth < max_frames:
        try:
            for key, value in list(f.f_locals.items()):
                if key not in ns:
                    ns[key] = value
        except Exception:
            pass
        f = f.f_back
        depth += 1
    return ns


def _resolve(expr, frame):
    """Evaluate a watch/snapshot expression against the whole visible chain."""
    if frame is None:
        raise RuntimeError("main thread has no frame")
    if expr in ("locals", "f_locals"):
        return _namespace(frame)
    if expr in ("globals", "f_globals"):
        return dict(frame.f_globals)
    return eval(expr, frame.f_globals, _namespace(frame))  # noqa: S307 - the user typed it


# --------------------------------------------------------------------- threads

def _sample_loop(hz):
    interval = 1.0 / max(0.5, hz)
    locals_every = max(1, int(round(hz / 2)))  # live locals at ~2 Hz
    while not _state["stop"].is_set():
        try:
            frame = _main_frame()
            if frame is not None:
                frames = _frames_of(frame)
                if not frames:
                    _state["stop"].wait(interval)
                    continue
                innermost = frames[-1]["fn"] if frames else ""
                state = "blocked" if innermost in ("sleep", "_sleep", "wait", "join", "accept", "recv") else "running"
                _send({"v": V, "t": "stack", "at": int(time.time() * 1000), "tid": _main_ident,
                       "state": state, "frames": frames})

                _state["ticks"] += 1
                if _state["ticks"] % locals_every == 0:
                    _send({"v": V, "t": "snapshot", "id": "live-locals", "at": int(time.time() * 1000),
                           "path": "locals", "value": ser(_bounded_locals(frame))})

                if _state["watches"]:
                    _emit_watches(frame)
        except Exception:
            pass
        _state["stop"].wait(interval)


def _bounded_locals(frame):
    """The first few visible names, so one huge function cannot flood the wire.

    Innermost-first, because that is the frame the user is looking at.
    """
    try:
        ns = _namespace(frame)
        names = list(ns.keys())[:MAX_LOCALS]
        return {n: ns[n] for n in names}
    except Exception:
        return {}


def _emit_watches(frame):
    now = int(time.time() * 1000)
    # Build the namespace once per tick, not once per expression.
    ns = _namespace(frame)
    for expr in list(_state["watches"]):
        try:
            value = eval(expr, frame.f_globals, ns) if expr not in ("locals", "f_locals", "globals", "f_globals") else _resolve(expr, frame)
            _send({"v": V, "t": "watch", "at": now, "id": expr, "ok": True, "value": ser(value)})
        except Exception as exc:  # noqa: BLE001 - a broken expression is data
            _send({"v": V, "t": "watch", "at": now, "id": expr, "ok": False,
                   "error": "%s: %s" % (type(exc).__name__, exc)})


def _read_loop(sock):
    buf = b""
    while not _state["stop"].is_set():
        try:
            chunk = sock.recv(65536)
        except Exception:
            break
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                cmd = json.loads(line.decode("utf-8"))
            except Exception:
                continue
            _handle_command(cmd)
    _state["stop"].set()


def _handle_command(cmd):
    t = cmd.get("t")
    if t == "set-watches":
        watches = cmd.get("watches")
        _state["watches"] = [w for w in watches if isinstance(w, str)][:32] if isinstance(watches, list) else []
    elif t == "snapshot":
        sid = str(cmd.get("id") or "")
        expr = str(cmd.get("path") or "locals")
        frame = _main_frame()
        try:
            value = _resolve(expr, frame)
            _send({"v": V, "t": "snapshot", "id": sid, "at": int(time.time() * 1000),
                   "path": expr, "value": ser(value)})
        except Exception as exc:  # noqa: BLE001
            _send({"v": V, "t": "snapshot", "id": sid, "at": int(time.time() * 1000), "path": expr,
                   "value": {"k": "trunc", "why": "unsupported", "t": "%s: %s" % (type(exc).__name__, exc)}})
    elif t == "bye":
        _state["stop"].set()


def _install_thread_hook():
    """Report exceptions from worker threads too.

    `sys.excepthook` only fires for the main thread; a crashing worker used to
    disappear without a trace, which is exactly the bug people attach an
    observatory to find.
    """
    try:
        import threading

        previous = threading.excepthook

        def hook(args):
            try:
                frames = []
                for summary in traceback.extract_tb(args.exc_traceback)[-MAX_FRAMES:]:
                    frames.append({"fn": summary.name, "file": os.path.basename(summary.filename or ""),
                                   "line": summary.lineno or 0})
                name = getattr(args.exc_type, "__name__", "Exception")
                message = str(args.exc_value) if args.exc_value is not None else ""
                _send({"v": V, "t": "exception", "at": int(time.time() * 1000), "tid": args.thread.ident or 0,
                       "type": "thread:" + name, "message": message, "frames": frames})
            except Exception:
                pass
            previous(args)

        threading.excepthook = hook
    except Exception:
        pass


def _install_excepthook():
    previous = sys.excepthook

    def hook(exc_type, exc, tb):
        try:
            frames = []
            for summary in traceback.extract_tb(tb)[-MAX_FRAMES:]:
                frames.append({"fn": summary.name, "file": os.path.basename(summary.filename or ""),
                               "line": summary.lineno or 0})
            _send({"v": V, "t": "exception", "at": int(time.time() * 1000), "tid": _main_ident,
                   "type": getattr(exc_type, "__name__", "Exception"), "message": str(exc), "frames": frames})
        except Exception:
            pass
        previous(exc_type, exc, tb)

    sys.excepthook = hook


# ------------------------------------------------------------------------ boot

def boot():
    global _main_ident
    if _state["sock"] is not None:
        return
    try:
        sock = _connect()
    except Exception:
        return
    if sock is None:
        return

    _state["sock"] = sock
    _main_ident = threading.main_thread().ident

    _send({"v": V, "t": "hello", "token": os.environ.get("NLG_DEBUG_TOKEN", ""), "lang": "python",
           "pid": os.getpid(), "target": os.path.basename(sys.argv[0] or ""),
           "agentVersion": "0.2", "caps": ["stack", "snapshot", "watch", "exception", "locals"]})

    _install_excepthook()
    _install_thread_hook()
    hz = float(os.environ.get("NLG_DEBUG_HZ", "10") or 10)
    threading.Thread(target=_sample_loop, args=(hz,), name="nlg-sampler", daemon=True).start()
    threading.Thread(target=_read_loop, args=(sock,), name="nlg-reader", daemon=True).start()

    def shutdown():
        _state["stop"].set()
        _send({"v": V, "t": "bye", "reason": "exit", "sent": _state["sent"], "dropped": _state["dropped"]})
        try:
            sock.close()
        except Exception:
            pass

    import atexit
    atexit.register(shutdown)
