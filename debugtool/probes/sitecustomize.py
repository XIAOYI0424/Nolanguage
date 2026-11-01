"""Injection point for the observatory (Python).

Python imports `sitecustomize` automatically at interpreter start when it can be
found on `sys.path` — which means putting this directory on `PYTHONPATH` is
enough to attach an agent to any program, with **no change to the program and no
change to its command line**.

The whole body is guarded: if the tool is not running (`NLG_DEBUG_PORT` unset) or
the agent cannot start, this file must be a no-op. A debug aid that breaks the
program it observes is not a debug aid.
"""
import os

if os.environ.get("NLG_DEBUG_PORT"):
    try:
        import nlg_agent_probe as _nlg_agent

        _nlg_agent.boot()
    except Exception:  # noqa: BLE001 - never surface into user code
        pass
