"""Injection point for the Debug Observatory (Python).

Python imports `sitecustomize` automatically at interpreter start when its
directory is on `sys.path`, so putting this directory on `PYTHONPATH` attaches
the agent to *any* program without touching the program or its command line.

Guarded on purpose: with no engine running (`NLG_DEBUG_PORT` unset) or if the
agent fails to start, this file must be a no-op. A debug aid that breaks the
thing it observes is not a debug aid.
"""
import os

if os.environ.get("NLG_DEBUG_PORT"):
    try:
        import nlg_agent

        nlg_agent.boot()
    except Exception:  # noqa: BLE001 - never surface into user code
        pass
