"""Minimal observatory agent (M0 probe).

Proves the two assumptions the whole design rests on:

  1. an agent can be injected with **no change to the target** — `sitecustomize`
     runs at interpreter start when its directory is on PYTHONPATH, so argv,
     `__main__` and the script text all stay exactly as the user wrote them;
  2. the side channel is a loopback TCP socket, not stdout, so the program keeps
     its own output stream untouched.

It samples the main thread's stack with `sys._current_frames()` — the one API
that reports *another* thread's frame without stopping it. Sampling is done from
a daemon thread at a fixed rate, so the overhead is bounded and predictable.

Not in this probe (M1): snapshots, watches, exceptions. The engine-side protocol
already accepts them; this file only proves transport + injection.
"""
import json
import os
import socket
import sys
import threading
import time
import traceback

PROTOCOL_VERSION = 1
MAX_FRAMES = 12

_stop = threading.Event()
_sock = None
_sent = 0
_dropped = 0


def _connect():
    port = int(os.environ.get("NLG_DEBUG_PORT", "0"))
    if not port:
        return None
    sock = socket.create_connection(("127.0.0.1", port), timeout=2.0)
    sock.settimeout(2.0)
    return sock


def _send(event):
    """Send one NDJSON line; never raise into the host program."""
    global _sent, _dropped
    if _sock is None:
        return
    try:
        _sock.sendall((json.dumps(event, separators=(",", ":")) + "\n").encode("utf-8"))
        _sent += 1
    except Exception:
        # The engine went away (or the buffer is full): stop talking, keep the
        # program running. An observability tool must never take the program down.
        _dropped += 1


def _frames_of(frame):
    out = []
    for summary in traceback.extract_stack(frame)[-MAX_FRAMES:]:
        out.append({
            "fn": summary.name,
            "file": os.path.basename(summary.filename or ""),
            "line": summary.lineno or 0,
        })
    return out


def _sample_loop(hz, main_ident):
    interval = 1.0 / max(0.5, hz)
    while not _stop.is_set():
        try:
            frame = sys._current_frames().get(main_ident)
            if frame is not None:
                frames = _frames_of(frame)
                # A stack whose innermost frame is the sleep call is "blocked",
                # which is what the stall detector keys on.
                state = "blocked" if frames and frames[-1]["fn"] in ("sleep", "_sleep") else "running"
                _send({
                    "v": PROTOCOL_VERSION,
                    "t": "stack",
                    "at": int(time.time() * 1000),
                    "tid": main_ident,
                    "state": state,
                    "frames": frames,
                })
        except Exception:
            pass
        _stop.wait(interval)


def boot():
    """Start the agent. Called from sitecustomize, before user code runs."""
    global _sock
    if _sock is not None:
        return
    try:
        _sock = _connect()
    except Exception:
        _sock = None
        return
    if _sock is None:
        return

    _send({
        "v": PROTOCOL_VERSION,
        "t": "hello",
        "token": os.environ.get("NLG_DEBUG_TOKEN", ""),
        "lang": "python",
        "pid": os.getpid(),
        "target": os.path.basename(sys.argv[0] or ""),
        "agentVersion": "probe-0.1",
        "caps": ["stack"],
    })

    hz = float(os.environ.get("NLG_DEBUG_HZ", "10"))
    main_ident = threading.main_thread().ident
    thread = threading.Thread(target=_sample_loop, args=(hz, main_ident), name="nlg-debug-sampler", daemon=True)
    thread.start()

    def _shutdown():
        _stop.set()
        _send({"v": PROTOCOL_VERSION, "t": "bye", "reason": "exit", "sent": _sent, "dropped": _dropped})
        try:
            if _sock is not None:
                _sock.close()
        except Exception:
            pass

    import atexit
    atexit.register(_shutdown)
