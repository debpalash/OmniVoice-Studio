"""Durable per-user environment file (`~/.config/omnivoice/env`).

`main.py` loads this file at startup (via dotenv) before importing torch/HF, so
values written here take effect on the next backend launch. Used by the
configurable models directory (#64): the Settings endpoint upserts
``OMNIVOICE_CACHE_DIR`` here, which main.py then maps to
``HF_HOME`` / ``HF_HUB_CACHE`` / ``TORCH_HOME``.

Format is dotenv-style ``KEY=value`` lines. Upsert preserves other keys (e.g. a
persisted ``HF_TOKEN``) and writes the file ``0600`` (it can hold secrets).
"""
from __future__ import annotations

import os
from typing import Optional

USER_ENV_PATH = os.path.expanduser("~/.config/omnivoice/env")


def _read_lines(path: str) -> list[str]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().splitlines()
    except OSError:
        return []


def _write_lines(path: str, lines: list[str]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = "\n".join(lines)
    if body and not body.endswith("\n"):
        body += "\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    try:
        os.chmod(path, 0o600)  # may hold secrets; no-op semantics on Windows
    except OSError:
        pass  # best-effort hardening; some filesystems/Windows don't support chmod


def get_user_env(key: str, path: Optional[str] = None) -> Optional[str]:
    path = path or os.environ.get("OMNIVOICE_ENV_FILE") or USER_ENV_PATH  # resolved at call time so tests can monkeypatch
    prefix = f"{key}="
    for line in _read_lines(path):
        if line.startswith(prefix):
            return line[len(prefix):]
    return None


def set_user_env(key: str, value: str, path: Optional[str] = None) -> None:
    """Upsert ``KEY=value``, preserving all other lines."""
    path = path or os.environ.get("OMNIVOICE_ENV_FILE") or USER_ENV_PATH
    prefix = f"{key}="
    lines = _read_lines(path)
    replaced = False
    for i, line in enumerate(lines):
        if line.startswith(prefix):
            lines[i] = f"{key}={value}"
            replaced = True
            break
    if not replaced:
        lines.append(f"{key}={value}")
    _write_lines(path, lines)


def unset_user_env(key: str, path: Optional[str] = None) -> None:
    """Remove ``KEY=...`` if present, preserving all other lines."""
    path = path or os.environ.get("OMNIVOICE_ENV_FILE") or USER_ENV_PATH
    prefix = f"{key}="
    lines = [ln for ln in _read_lines(path) if not ln.startswith(prefix)]
    _write_lines(path, lines)
