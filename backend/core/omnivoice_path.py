"""Resolve the project's own ``omnivoice`` package from source when the venv's
editable install is missing (#564).

``omnivoice`` is normally an editable install in the backend venv. An interrupted
or offline ``uv sync`` can install dependencies yet never lay the editable record
(``_editable_impl_omnivoice.pth``), or an antivirus quarantine can remove it —
leaving a venv that starts uvicorn but cannot ``import omnivoice``, so it boots
fine and only fails at the first model call (``No module named 'omnivoice'``).

The desktop layout always copies ``omnivoice/`` next to ``backend/``, so we fall
back to importing it from there. The bootstrap now also gates on omnivoice being
importable (re-syncing to re-lay the editable install), but this keeps the
backend resilient even when that repair hasn't run yet.
"""
import os
import sys


def find_omnivoice_source_root(candidates):
    """Return the first candidate dir holding ``omnivoice/__init__.py``, else None."""
    for root in candidates:
        if root and os.path.isfile(os.path.join(root, "omnivoice", "__init__.py")):
            return root
    return None


def _candidate_roots(backend_dir):
    """Source roots to probe, most-specific first.

    ``OMNIVOICE_PROJECT_ROOT`` lets the launcher point at the staged project dir
    explicitly; otherwise the desktop layout puts ``omnivoice/`` beside
    ``backend/`` (parent of ``backend_dir``).
    """
    roots = []
    env = os.environ.get("OMNIVOICE_PROJECT_ROOT")
    if env:
        roots.append(env)
    roots.append(os.path.dirname(os.path.abspath(backend_dir)))
    return roots


def _already_importable():
    import importlib.util
    try:
        return importlib.util.find_spec("omnivoice") is not None
    except (ImportError, ValueError):
        # A half-laid spec (e.g. a stale .pth pointing at a deleted dir) raises
        # rather than returning None — treat it as "not importable" so we fall
        # back to the on-disk source.
        return False


def ensure_omnivoice_importable(backend_dir, logger=None):
    """Make ``import omnivoice`` work, falling back to the sibling source tree.

    No-op when the editable/site-packages install already resolves it. Otherwise
    appends the first source root containing ``omnivoice/`` to ``sys.path``
    (appended, never inserted, so a real install keeps precedence). Returns the
    root that was added, or ``None`` if none was needed or found.
    """
    if _already_importable():
        return None
    root = find_omnivoice_source_root(_candidate_roots(backend_dir))
    if root and root not in sys.path:
        sys.path.append(root)
        if logger:
            logger.warning(
                "omnivoice not importable from the venv (missing/broken editable "
                "install) — resolving it from source at %s (#564)", root,
            )
    elif logger and root is None:
        logger.error(
            "omnivoice is not importable and no source tree was found next to "
            "%s — the install is incomplete; relaunch to let the bootstrap "
            "repair the venv (#564)", backend_dir,
        )
    return root
