"""Opt-in product analytics — hardened.

OmniVoice is local-first, so analytics here is held to a higher bar than the
usual SDK drop-in. Three rules, each enforced in code below and pinned by tests:

1. **Off unless the user says yes.** Two independent gates must BOTH be true:
   a build-provided ``POSTHOG_PROJECT_TOKEN`` *and* the user's explicit
   ``analytics_enabled`` preference, which defaults to **False**. A default
   install transmits nothing, so the product's promise holds out of the box.
   ``OMNIVOICE_ANALYTICS_DISABLED=1`` is a hard kill switch that outranks both.

2. **No exception autocapture, ever.** The obvious SDK default
   (``enable_exception_autocapture=True``) ships raw tracebacks — which carry
   absolute paths (``/Users/<name>/…``), and in this codebase can carry Hugging
   Face tokens and model paths straight out of exception messages. That would
   bypass ``core.failure.sanitize()``, the redaction this project already runs on
   every error surface. It is explicitly disabled.

3. **Metadata only, enforced by allowlist.** Every event property is filtered
   through ``_ALLOWED_PROPS``. A key that isn't on the list is *dropped*, not
   trusted — so no future caller can leak the text of a take, a file path, or a
   voice name by adding a field. Counts, durations, ids of *engines* (not users),
   and booleans are all that can get through.

The person id is a random UUID minted per installation. It is not derived from
hardware, hostname, username, or anything else identifying — it exists only to
tell "same install" from "different install".
"""
from __future__ import annotations

import atexit
import logging
import os
import uuid
from typing import Any, Optional

logger = logging.getLogger("omnivoice.analytics")

_client = None
_client_key: Optional[str] = None  # the (token, host) the live client was built for

_KILL_SWITCH = "OMNIVOICE_ANALYTICS_DISABLED"
_OFF_VALUES = {"1", "true", "yes", "on"}

#: The ONLY property keys that may leave this machine. Anything else is dropped.
#: Deliberately conservative: no free text, no paths, no names, no ids of user
#: content. Add here only after asking "could this ever hold something the user
#: typed, recorded, or named?" — if yes, it doesn't belong.
_ALLOWED_PROPS: frozenset[str] = frozenset({
    "engine_id",        # which TTS/ASR engine (our identifier, not the user's)
    "language",         # e.g. "en" / "auto"
    "mode",             # clone | design
    "kind",             # profile kind
    "source",           # upload | url
    "input_type",       # video | audio
    "effect_preset",
    "error_type",       # exception CLASS name only — never the message
    "duration_seconds",
    "gen_time_seconds",
    "text_length",      # the LENGTH of the text. never the text.
    "has_profile",
    "stream",
    "app_version",
    "platform",
})

#: A string property longer than this is refused outright — a belt-and-braces
#: guard so a stray free-text value can't ride in on an allowlisted key.
_MAX_STR_LEN = 64


def _kill_switched() -> bool:
    return (os.environ.get(_KILL_SWITCH, "") or "").strip().lower() in _OFF_VALUES


def user_opted_in() -> bool:
    """The user's explicit choice. Default **False** — silence is not consent."""
    try:
        from core import prefs

        return bool(prefs.get("analytics_enabled", False))
    except Exception:  # noqa: BLE001 — a broken prefs file must not enable tracking
        return False


def set_opted_in(enabled: bool) -> None:
    """Persist the user's choice and rebuild/tear down the client immediately, so
    the toggle takes effect without a restart."""
    from core import prefs

    prefs.set_("analytics_enabled", bool(enabled))
    if not enabled:
        shutdown()


def token_configured() -> bool:
    """Whether this BUILD ships an analytics destination at all. When false,
    analytics can never run no matter what the user chooses — which is the case
    for anyone building from source."""
    return bool((os.environ.get("POSTHOG_PROJECT_TOKEN", "") or "").strip())


def enabled() -> bool:
    """The single source of truth: BOTH gates true, and not kill-switched."""
    return (not _kill_switched()) and token_configured() and user_opted_in()


def _get_client():
    """Lazily build the client, but only while `enabled()`. Rebuilt if the token
    or host changes; torn down the moment consent is withdrawn."""
    global _client, _client_key

    if not enabled():
        if _client is not None:
            shutdown()
        return None

    token = os.environ["POSTHOG_PROJECT_TOKEN"].strip()
    host = (os.environ.get("POSTHOG_HOST") or "https://eu.i.posthog.com").strip()
    key = f"{token}@{host}"
    if _client is not None and _client_key == key:
        return _client

    try:
        from posthog import Posthog

        _client = Posthog(
            token,
            host=host,
            # RULE 2. Tracebacks carry home paths and can carry HF tokens; they
            # would bypass core.failure.sanitize() entirely. Never turn this on.
            enable_exception_autocapture=False,
        )
        _client_key = key
        atexit.register(shutdown)
        logger.info("Analytics enabled by user opt-in (host=%s).", host)
    except Exception as e:  # noqa: BLE001 — analytics must never break the app
        logger.warning("Analytics client unavailable: %s", e)
        _client, _client_key = None, None
    return _client


def shutdown() -> None:
    """Flush and drop the client. Safe to call repeatedly."""
    global _client, _client_key
    if _client is not None:
        try:
            _client.shutdown()
        except Exception:  # noqa: BLE001
            logger.debug("analytics shutdown error (non-fatal)", exc_info=True)
    _client, _client_key = None, None


def installation_id() -> str:
    """A random per-installation UUID. NOT derived from hardware, hostname, or
    username — it only distinguishes one install from another."""
    from core import prefs

    iid = prefs.get("installation_id")
    if not iid:
        iid = str(uuid.uuid4())
        try:
            prefs.set_("installation_id", iid)
        except Exception:  # noqa: BLE001
            logger.debug("could not persist installation_id (non-fatal)", exc_info=True)
    return str(iid)


def sanitize_properties(properties: Optional[dict]) -> dict:
    """RULE 3. Drop every key not on the allowlist, and refuse long strings.

    Pure + exported so the guarantee is directly testable: this is what stops a
    future caller from leaking a take's text, a file path, or a voice name."""
    out: dict[str, Any] = {}
    for k, v in (properties or {}).items():
        if k not in _ALLOWED_PROPS:
            continue
        if isinstance(v, str) and len(v) > _MAX_STR_LEN:
            continue
        if isinstance(v, (str, int, float, bool)) or v is None:
            out[k] = v
    return out


def capture(event: str, properties: Optional[dict] = None) -> None:
    """Record one product event. A no-op unless the user opted in. Never raises."""
    try:
        client = _get_client()
        if client is None:
            return
        client.capture(
            event,
            distinct_id=installation_id(),
            properties=sanitize_properties(properties),
        )
    except Exception as e:  # noqa: BLE001 — analytics may never break a feature
        logger.debug("analytics capture failed (%s): %s", event, e)
