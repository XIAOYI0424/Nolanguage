"""Injection point for the Debug Observatory (Python).

Python imports `sitecustomize` automatically at interpreter start when it can be
found on `sys.path`, so putting this directory on `PYTHONPATH` attaches the agent
to *any* program with no change to the program or its command line.

**Only the first `sitecustomize` on `sys.path` runs.** Ours is prepended, so a
user who already has one (coverage.py, a company bootstrap, a venv hook) would
silently lose it — the kind of breakage that shows up as "coverage stopped
collecting" weeks later. So after booting the agent we look up the *next*
`sitecustomize` and execute it ourselves.

The whole body is guarded: with no engine running (`NLG_DEBUG_PORT` unset) or if
the agent fails to start, this file must be a no-op.
"""
import importlib.machinery
import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))


def _chain_to_user_sitecustomize():
    """Run the sitecustomize we shadowed, if there is one."""
    try:
        rest = [p for p in sys.path if os.path.abspath(p or os.curdir) != _HERE]
        spec = importlib.machinery.PathFinder.find_spec("sitecustomize", rest)
        if not spec or not spec.origin or not spec.loader:
            return
        if os.path.abspath(os.path.dirname(spec.origin)) == _HERE:
            return
        module = importlib.util.module_from_spec(spec)
        # Replace the entry Python already registered (that is *this* module), so
        # anything importing sitecustomize later sees the user's, not ours.
        sys.modules["sitecustomize"] = module
        spec.loader.exec_module(module)
    except Exception:  # noqa: BLE001 - the user's hook failing must not stop us
        pass


if os.environ.get("NLG_DEBUG_PORT"):
    try:
        import nlg_agent

        nlg_agent.boot()
    except Exception:  # noqa: BLE001 - never surface into user code
        pass

_chain_to_user_sitecustomize()
