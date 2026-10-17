"""Nolanguage session bootstrap (official Python plugin).

The `repl-session` runtime spawns this file once per run and hands it three
environment variables. It knows nothing about Python; this script is the only
place the persistence *mechanism* lives, and it ships with the plugin rather
than being compiled into the engine.

    NL_SOURCE_FILE   the snippet the user just ran
    NL_SESSION_DIR   stable directory for this session
    NL_GLOBALS_FILE  where to pickle the namespace between runs
    NL_LANGUAGE      the plugin id (diagnostics only)

Only *data* survives a run. Functions, classes and modules are pickled by
reference and cannot be restored into a different `__main__`, so they are
skipped — snippets re-declare their own helpers. That is the same contract the
engine used when this logic was hardcoded.
"""

import os
import pickle
import sys
import types

source = os.environ.get("NL_SOURCE_FILE")
globals_path = os.environ.get("NL_GLOBALS_FILE")

if not source:
    print("[session] NL_SOURCE_FILE is not set", file=sys.stderr)
    raise SystemExit(2)

namespace = {"__name__": "__main__", "__file__": source}
sys.argv = [source]

if globals_path and os.path.exists(globals_path):
    try:
        with open(globals_path, "rb") as handle:
            namespace.update(pickle.load(handle))
    except Exception as exc:  # a corrupt pickle must not lose the run
        print("[session] failed to restore state: %s" % exc, file=sys.stderr)

try:
    with open(source, encoding="utf-8") as handle:
        code = handle.read()
except OSError as exc:
    print("[session] cannot read source: %s" % exc, file=sys.stderr)
    raise SystemExit(2)

exec(compile(code, source, "exec"), namespace)

if globals_path:
    _SKIP = (
        types.ModuleType,
        types.FunctionType,
        types.BuiltinFunctionType,
        types.MethodType,
        types.LambdaType,
        type,
    )
    keep = {}
    for key, value in list(namespace.items()):
        if key.startswith("_"):
            continue
        if isinstance(value, _SKIP):
            continue
        try:
            pickle.loads(pickle.dumps(value))
        except Exception:
            continue
        keep[key] = value
    try:
        with open(globals_path, "wb") as handle:
            pickle.dump(keep, handle)
    except Exception as exc:
        print("[session] failed to persist state: %s" % exc, file=sys.stderr)
