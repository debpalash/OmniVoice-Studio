"""Process-survival containment for engine/library code.

Leaf module (stdlib-only) so both services.model_manager and
services.asr_backend can import it at module top without a cycle.
"""
from __future__ import annotations


def contain_system_exit(fn, what: str):
    """Wrap a pool job so library code calling ``sys.exit()`` cannot kill the app.

    Real case (#1133): mlx-audio's Kokoro pipeline uses misaki's G2P, which
    runs ``spacy.cli.download()`` IN-PROCESS on first use; spaCy's CLI error
    printer responds to a missing pip (uv-managed venvs ship none) with
    ``sys.exit(1)``. ``except Exception`` never catches SystemExit, so it rode
    the executor future into the event loop — where uvicorn treats SystemExit
    as "shut down", killing the whole backend 21 s after start. Any engine
    dependency written as a CLI can do this; containing it at the dispatch
    boundary covers every load, generate, and transcribe.
    """
    def wrapped():
        try:
            return fn()
        except SystemExit as e:  # noqa: PERF203 — the whole point
            raise RuntimeError(
                f"{what}: engine code tried to exit the process "
                f"(SystemExit {e.code}) — contained. This usually means an "
                f"engine dependency failed to auto-install something (e.g. a "
                f"spaCy model needing pip); see the backend log above this "
                f"line for the real error."
            ) from e
    return wrapped
