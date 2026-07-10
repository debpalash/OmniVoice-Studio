"""3-source HF token resolver — AUTH-01, AUTH-03, AUTH-06.

Resolution priority (highest → lowest):

  1. app    — `settings_store.get_hf_token()` (encrypted in SQLite)
  2. env    — `HF_TOKEN` or the legacy `HUGGING_FACE_HUB_TOKEN` env var
  3. hf-cli — `huggingface_hub.get_token()` (canonical ~/.cache/huggingface/token)

For each candidate, the resolver calls `huggingface_hub.whoami(token=...)`
to verify the token is live; any HTTP error (401, 403, network) skips to
the next source. Results are cached per (source, token-sha256) for 300
seconds so repeat reads from the UI/dub_core don't hammer the HF API.

Replaces every bare `os.environ.get("HF_TOKEN")` call site in the backend
(per Pitfall #1 in 01-RESEARCH.md and the grep gate in 01-01-PLAN.md
Task 2 verification).
"""
from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Literal, Optional

logger = logging.getLogger("omnivoice.token_resolver")

Source = Literal["app", "env", "hf-cli"]
_PRIORITY: tuple[Source, ...] = ("app", "env", "hf-cli")

_CACHE_TTL_SECONDS = 300.0  # UI "Test now" busts it via GET /hf-token/state?fresh=1.


@dataclass(frozen=True)
class ResolvedToken:
    token: str
    source: Source
    username: Optional[str]


@dataclass(frozen=True)
class SourceState:
    source: Source
    set: bool
    masked: Optional[str]
    whoami_user: Optional[str]
    whoami_ok: bool


# ── module-level cache ────────────────────────────────────────────────────

_VALIDATION_CACHE: dict[tuple[Source, str], tuple[float, Optional[str]]] = {}
_CACHE_LOCK = threading.Lock()


def invalidate_cache() -> None:
    """Drop the whoami validation cache. Called by the Settings UI "Test now"
    button (GET /api/settings/hf-token/state?fresh=1), by save/clear API
    endpoints, and by on_401()."""
    with _CACHE_LOCK:
        _VALIDATION_CACHE.clear()


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ── source readers ────────────────────────────────────────────────────────


def _read_app() -> Optional[str]:
    try:
        from services import settings_store
        return settings_store.get_hf_token()
    except Exception:
        logger.exception("settings_store read failed")
        return None


def _read_env() -> Optional[str]:
    # HF docs explicitly accept either name; user may have either exported.
    val = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    return val or None


def _read_hf_cli() -> Optional[str]:
    try:
        import huggingface_hub
        tok = huggingface_hub.get_token()
        return tok or None
    except Exception:
        logger.exception("huggingface_hub.get_token failed")
        return None


_READERS: dict[Source, callable] = {  # type: ignore[type-arg]
    "app": _read_app,
    "env": _read_env,
    "hf-cli": _read_hf_cli,
}


# ── whoami validation ─────────────────────────────────────────────────────


def _validate(source: Source, token: str) -> Optional[str]:
    """Returns the validated whoami username, or None if the token is invalid.

    Caches results for `_CACHE_TTL_SECONDS` per (source, token-hash) so the
    Settings panel's repeated state() calls don't hit the HF API every load.
    """
    key = (source, _hash(token))
    now = time.monotonic()
    with _CACHE_LOCK:
        cached = _VALIDATION_CACHE.get(key)
    if cached is not None:
        ts, username = cached
        if now - ts < _CACHE_TTL_SECONDS:
            return username

    import huggingface_hub
    try:
        info = huggingface_hub.whoami(token=token)
        name = (info or {}).get("name") if isinstance(info, dict) else None
        with _CACHE_LOCK:
            _VALIDATION_CACHE[key] = (now, name)
        return name
    except Exception as exc:
        # Any failure — HfHubHTTPError 401/403, network — disqualifies this source.
        # Cache the negative result so we don't slam the API in tight loops;
        # the cache TTL is bounded so transient failures still recover.
        with _CACHE_LOCK:
            _VALIDATION_CACHE[key] = (now, None)
        logger.debug("whoami failed for source=%s: %s", source, exc)
        return None


def _mask(token: str) -> str:
    """`hf_…<last 3>` — what the Settings UI shows in the "currently set"
    field. We never reveal the full token in any read API."""
    if not token:
        return ""
    tail = token[-3:] if len(token) >= 3 else token
    return f"hf_…{tail}"


# ── public API ────────────────────────────────────────────────────────────


def resolve(skip: frozenset[Source] = frozenset()) -> Optional[ResolvedToken]:
    """Return the highest-priority valid token, or None if all sources are
    empty/invalid. `skip` excludes specific sources — used by `on_401()`
    when a previously-resolved token started returning 401 mid-job."""
    for source in _PRIORITY:
        if source in skip:
            continue
        token = _READERS[source]()
        if not token:
            continue
        username = _validate(source, token)
        if username is None and not _all_validation_skipped():
            # Token present but whoami failed — log once at debug and try
            # the next source. We do NOT log the token (the redactor would
            # mask it anyway, but no need to even emit it).
            continue
        return ResolvedToken(token=token, source=source, username=username)
    return None


def _all_validation_skipped() -> bool:
    """Hook left here as a no-op for now. Originally intended to allow
    network-disabled environments to bypass whoami; left in for future
    extension and explicit so reviewers see the choice."""
    return False


def on_401(active_source: Source) -> Optional[ResolvedToken]:
    """AUTH-06: when the active source started returning 401 mid-job (e.g.
    the user rotated the token externally), invalidate the cache and try
    resolving again while skipping the offending source."""
    invalidate_cache()
    return resolve(skip=frozenset({active_source}))


def state() -> dict:
    """Return one SourceState per priority position so the Settings UI can
    render the cascade table. Includes a masked token + whoami result;
    never includes the raw token."""
    rows: list[SourceState] = []
    active: Optional[Source] = None
    for source in _PRIORITY:
        token = _READERS[source]()
        if token:
            username = _validate(source, token)
            ok = username is not None
            rows.append(SourceState(
                source=source,
                set=True,
                masked=_mask(token),
                whoami_user=username,
                whoami_ok=ok,
            ))
            if active is None and ok:
                active = source
        else:
            rows.append(SourceState(
                source=source,
                set=False,
                masked=None,
                whoami_user=None,
                whoami_ok=False,
            ))
    return {"sources": rows, "active": active}


def save_app_token(token: str) -> None:
    """Persist token to the encrypted settings store AND populate the HF
    canonical file via `huggingface_hub.login()`. Per Pitfall #2:
    `add_to_git_credential=False` is non-negotiable — the alternative
    silently writes the token to the user's global git credential helper,
    which is leaks-galore for a desktop app."""
    if not token:
        clear_app_token()
        return
    from services import settings_store
    settings_store.set_hf_token(token)
    try:
        import huggingface_hub
        huggingface_hub.login(
            token=token,
            add_to_git_credential=False,
            new_session=False,
        )
    except TypeError:
        # Older huggingface_hub may not have new_session kwarg — retry
        # without it. The add_to_git_credential=False kwarg is the
        # invariant that matters; new_session is just a perf tweak.
        try:
            import huggingface_hub
            huggingface_hub.login(token=token, add_to_git_credential=False)
        except Exception:
            logger.exception("huggingface_hub.login failed (non-fatal)")
    except Exception:
        # Hub login failure must not strand the user — the token is still
        # in the encrypted store and the resolver will pick it up.
        logger.exception("huggingface_hub.login failed (non-fatal)")
    invalidate_cache()


def clear_app_token(also_clear_hf_cli: bool = False) -> None:
    """Remove from the encrypted settings store; optionally also call
    `huggingface_hub.logout()` to clear the canonical HF file."""
    from services import settings_store
    settings_store.clear_hf_token()
    if also_clear_hf_cli:
        try:
            import huggingface_hub
            huggingface_hub.logout()
        except Exception:
            logger.exception("huggingface_hub.logout failed (non-fatal)")
    invalidate_cache()
