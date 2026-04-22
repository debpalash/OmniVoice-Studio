"""Numpy compatibility shim for PyInstaller.

Two things we have to guarantee in a frozen build:

1. `numpy` gets imported before anything that monkey-touches its C API
   (scipy, torch, torchaudio) so the extension loader runs in a clean
   state and we don't hit "module compiled against API version X but
   this version of numpy is Y" surprises.

2. NUMPY_EXPERIMENTAL_ARRAY_FUNCTION is left at its default. Some
   frozen builds end up with it unset because PyInstaller strips certain
   env-based defaults — explicitly mirror numpy's own default so
   downstream libs don't disable fast paths by accident.

This hook runs BEFORE the main script via `runtime_hooks=[...]` in the
spec, so the import order is deterministic regardless of which library
the user's code touches first.
"""
import os

os.environ.setdefault("NUMPY_EXPERIMENTAL_ARRAY_FUNCTION", "1")

try:
    import numpy  # noqa: F401  (side-effect import: primes the C extension)
except ImportError:
    # Let the main app fail loudly with its own error message rather
    # than crashing the runtime hook itself.
    pass
