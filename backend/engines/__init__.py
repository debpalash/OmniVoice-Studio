"""Subprocess-isolated TTS engine sidecars (Phase 2).

Each subdirectory holds a single sidecar entrypoint (`main.py`) that runs
under its own Python interpreter (its own venv when the engine has
conflicting dependencies). The parent process spawns these via
`backend/services/subprocess_backend.py::SubprocessBackend`.

`_echo/` is permanent CI regression infrastructure — it ensures the
SubprocessBackend round-trip stays green even when no production engine is
installed. Do NOT delete it.
"""
