"""Shared pipeline-failure helper (plan-04 / #131).

Single source of truth for "what a failure looks like" so every emit site —
the TaskManager worker, the dub ingest pipeline, the dub/batch routers — produces
the same structured, **non-empty**, sanitized failure event instead of its own
ad-hoc ``str(e)`` (which is empty or cryptic for many exception types, and was
the root of the "extract: unknown error" reports in #122/#63).

Guarantees:
  - ``reason`` is ALWAYS non-empty (falls back to the exception class name).
  - ``detail`` / ``diagnostic`` are sanitized: HF tokens, ``*TOKEN*/*KEY*/*SECRET*``
    env values, and absolute home paths never leak (Constitution I).
  - the 5-class docs taxonomy is reused from ``core.error_docs_map`` (not
    duplicated) so the deeplink contract stays single-sourced.
"""
from __future__ import annotations

import os
import platform
import re
import sys
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

from core import error_docs_map
from core.logging_filter import REDACTED, _HF_TOKEN_RE

# Env vars whose *name* implies a credential — their values are redacted.
_SECRET_NAME_RE = re.compile(r"(TOKEN|KEY|SECRET)", re.IGNORECASE)
_REDACTED_VALUE = "***REDACTED***"

# One-line "what to do" per docs-taxonomy key. Keys mirror error_docs_map's
# taxonomy; the docs URL itself stays owned by error_docs_map.
_HINTS: dict[str, str] = {
    "PKG_RESOURCES_MISSING": "Run `uv pip install --reinstall 'setuptools>=75,<80'` in the backend venv (a plain install is skipped when setuptools' metadata is present but its pkg_resources files were removed by antivirus). Restart after.",
    "GATEKEEPER_QUARANTINE": "Clear the macOS quarantine flag (xattr -cr the app), then reopen.",
    "APPIMAGE_WEBKIT_WHITESCREEN": "Launch with WEBKIT_DISABLE_DMABUF_RENDERER=1 set.",
    "HF_AUTH_FAILED": "Set a valid HF_TOKEN in Settings → Hugging Face and retry.",
    "PYANNOTE_LICENSE_REQUIRED": "Accept the pyannote model licenses on Hugging Face, then retry.",
    "COMPUTE_TYPE_UNSUPPORTED": "Your GPU doesn't support float16 — OmniVoice retried on int8. If transcription still fails, set OMNIVOICE/ASR_COMPUTE_TYPE=int8 or use CPU.",
    "TRANSFORMERS_IMPORT": "Your transformers install is incomplete. Reinstall it (`uv pip install --reinstall transformers`) or switch ASR to faster-whisper (Settings → Models).",
    "OS_INVALID_ARGUMENT": "The OS rejected a file operation (Errno 22 / invalid argument) — in the transcribe path this is the temporary WAV write before ASR. It's almost always the temp directory: missing, read-only, on a full or removed drive, or blocked by antivirus. Check that your system TEMP/TMP folder exists and is writable and the drive has free space (add an OmniVoice antivirus exclusion if you use one), then retry.",
    "SOCKS_PROXY_SUPPORT_MISSING": "A SOCKS proxy is configured in your environment (ALL_PROXY/HTTPS_PROXY=socks5://…) and the backend's HTTP client is missing SOCKS support. Newer OmniVoice builds ship SOCKS support (the socksio package) — update the app. If you still see this, unset ALL_PROXY/HTTPS_PROXY for OmniVoice, or run `uv pip install 'httpx[socks]'` in the backend venv, then restart.",
    "SSL_HANDSHAKE_FAILURE": "A corporate or antivirus proxy is intercepting HTTPS traffic and re-signing certificates with its own CA — your OS trusts that CA, but Python's bundled certifi CA list doesn't, so the TLS handshake fails even though the connection reached the server. Newer OmniVoice builds trust the OS certificate store at startup (the truststore package), which should already fix this — update the app and retry. If you still see this, add an HTTPS-scanning exclusion for OmniVoice/Python in your antivirus, or ask IT for the proxy's CA bundle and set SSL_CERT_FILE to it, then restart.",
    "UNSUPPORTED_VIDEO_URL": "This link isn't a directly downloadable video. Paste a direct video page (e.g. a youtube.com/watch?v=… or douyin.com/video/<id> link), not a share/profile/feed link — or download the file and drop it in directly.",
    "VIDEO_DOWNLOAD_NETWORK": "The connection to the video server dropped mid-download (often a transient CDN/network blip or a regional rate-limit). Just retry — OmniVoice already cleaned up the partial download. If it keeps failing, check your network/VPN.",
    "BROKEN_VENV": "The Python backend environment was moved or damaged. OmniVoice rebuilds it automatically on the next launch; if it keeps failing, use Clean & Retry on the setup screen.",
    "MODEL_CACHE_CORRUPT": "The model cache had broken file links — snapshot entries that no longer point at their downloaded data (interrupted renames or antivirus interference can cause this). OmniVoice repairs this automatically and retries the load once. If the error persists, quit OmniVoice, delete the model's models--<org>--<name> folder inside the Hugging Face cache, and restart — the model re-downloads automatically.",
    # HF_MIRROR_UNREACHABLE has a DYNAMIC hint (it names the configured mirror)
    # — see hf_mirror_hint(); build_failure special-cases it.
}


# ── HF mirror connectivity (#874) ────────────────────────────────────────────
# When a non-default HF_ENDPOINT (a mirror, e.g. hf-mirror.com — set via
# Settings → Models → Hugging Face mirror) is configured and a model
# download/load fails with a connectivity error, the raw transformers/hf_hub
# message ("We couldn't connect to 'https://hf-mirror.com' to load the files…")
# gives the user no next step. This is the single classifier for that class,
# shared by every surface: build_failure() (model status, dub/task events),
# the global 500 handler (main.py — covers /generate and every other route
# that can leak a model-load error), and the model-install SSE
# (setup/download.py).

_OFFICIAL_HF_ENDPOINTS = {"https://huggingface.co", "https://hf.co"}

# Connectivity signatures across the layers an HF download failure surfaces
# from: transformers' wording, huggingface_hub errors, requests/urllib3, and
# raw socket/DNS failures (Linux/macOS/Windows variants).
_HF_CONNECTIVITY_SIGNATURES = (
    "couldn't connect to",             # transformers: "We couldn't connect to '<endpoint>' …"
    "could not connect to",
    "connection error",                # huggingface_hub / requests
    "connection refused",
    "connection reset",
    "connection aborted",
    "max retries exceeded",            # urllib3 via requests
    "failed to establish a new connection",
    "name or service not known",       # Linux DNS
    "temporary failure in name resolution",
    "nodename nor servname provided",  # macOS DNS
    "getaddrinfo failed",              # Windows DNS
    "timed out",
    "an error happened while trying to locate the file on the hub",  # LocalEntryNotFoundError
    "we cannot find the requested files",                            # LocalEntryNotFoundError
)

# The failure must also be Hugging-Face-shaped — the configured endpoint/host
# named in the message, or HF-download wording — so a random socket error
# (e.g. a local LLM provider being down) doesn't get the mirror hint just
# because a mirror happens to be configured.
_HF_CONTEXT_MARKERS = (
    "huggingface",
    "hf_hub",
    "hf-hub",
    "load the files",          # transformers
    "cached files",            # transformers
    "the requested files",     # LocalEntryNotFoundError
    "locate the file on the hub",
    "snapshot_download",
)


def configured_hf_mirror() -> str:
    """The non-default Hugging Face endpoint (mirror) in effect, or "".

    Same resolution the download paths use: ``HF_ENDPOINT`` env (what
    Settings → Models → Hugging Face mirror persists via user_env, and what
    the HF libraries read) with the ``hf_endpoint`` pref as fallback
    (mirrors setup/download.py's ``prefs.resolve``). Never raises.
    """
    ep = (os.environ.get("HF_ENDPOINT") or "").strip()
    if not ep:
        try:
            from core import prefs

            ep = str(prefs.get("hf_endpoint", "") or "").strip()
        except Exception:
            ep = ""
    ep = ep.rstrip("/")
    if not ep or ep.lower() in _OFFICIAL_HF_ENDPOINTS:
        return ""
    return ep


def hf_mirror_hint(reason: Optional[str]) -> str:
    """Actionable hint when ``reason`` is an HF-download connectivity failure
    and a non-default mirror endpoint is configured; "" otherwise.

    The hint names the configured mirror, says it may be down, points at the
    setting (Settings → Models → Hugging Face mirror), suggests the official
    endpoint when the model isn't cached yet, and notes the restart
    requirement (HF reads HF_ENDPOINT at import time — see the hf-mirror
    endpoints in api/routers/settings.py). Never raises.
    """
    mirror = configured_hf_mirror()
    if not mirror:
        return ""
    low = (reason or "").lower()
    if not any(sig in low for sig in _HF_CONNECTIVITY_SIGNATURES):
        return ""
    try:
        host = (urlsplit(mirror).netloc or "").lower()
    except Exception:
        host = ""
    if not (
        mirror.lower() in low
        or (host and host in low)
        or any(m in low for m in _HF_CONTEXT_MARKERS)
    ):
        return ""
    return (
        f"Your Hugging Face mirror is set to {mirror}, which couldn't be "
        "reached — the mirror may be down or blocked on your network. If the "
        'model isn\'t in your local cache yet, switch to "Hugging Face '
        '(official)" in Settings → Models → Hugging Face mirror (or wait for '
        "the mirror to recover), then restart OmniVoice — the mirror setting "
        "is applied when the app starts."
    )


def append_hf_mirror_hint(text: str) -> str:
    """``"{text} — {hint}"`` when the mirror-connectivity class applies;
    ``text`` unchanged otherwise. For surfaces that hand a raw error string to
    the UI (the global 500 handler, the model-install SSE). Never raises."""
    try:
        hint = hf_mirror_hint(text)
    except Exception:
        return text
    return f"{text} — {hint}" if hint else text


# Classes whose hint is safe to attach on the CONTEXT-FREE surfaces (the
# global 500 handler in main.py, the model-install SSE in setup/download.py),
# where all we have is a raw error string with no stage. Only classes whose
# classify() trigger is unmistakable belong here — e.g. VIDEO_DOWNLOAD_NETWORK
# must NOT be added: its bare "timed out" trigger would stamp a "video server"
# hint on a model-load timeout that leaks through the 500 handler.
_CONTEXT_FREE_HINT_CLASSES = frozenset({
    "SOCKS_PROXY_SUPPORT_MISSING",
    "SSL_HANDSHAKE_FAILURE",
})


def append_hint(text: str) -> str:
    """``"{text} — {hint}"`` for raw-string surfaces (the global 500 handler,
    the model-install SSE): the dynamic mirror hint (#874) when that class
    applies, else a context-free static class hint (#959). ``text`` unchanged
    otherwise — a no-op for every other error. Never raises."""
    try:
        hint = hf_mirror_hint(text)
        if not hint:
            topic = classify(text)
            if topic in _CONTEXT_FREE_HINT_CLASSES:
                hint = _HINTS.get(topic, "")
    except Exception:
        return text
    return f"{text} — {hint}" if hint else text


def classify(reason: str) -> str:
    """Map a failure reason to a docs-taxonomy key, or "" when unknown.

    Heuristic substring match — mirrors the frontend ``classifyError`` so the
    backend log / diagnostic names the same class the UI deeplink will use.
    """
    low = (reason or "").lower()
    if "pkg_resources" in low:
        return "PKG_RESOURCES_MISSING"
    if "quarantine" in low or "is damaged" in low or "gatekeeper" in low:
        return "GATEKEEPER_QUARANTINE"
    if "webkit" in low or "white screen" in low or "dmabuf" in low or "appimage" in low:
        return "APPIMAGE_WEBKIT_WHITESCREEN"
    if "pyannote" in low or ("gated" in low and "model" in low) or "accept the" in low:
        return "PYANNOTE_LICENSE_REQUIRED"
    # ASR robustness (#551 / #549): name the class so the no-segments toast is
    # actionable. Place before the generic returns so a compute-type/transformers
    # failure gets its hint rather than falling through to "".
    if "compute type" in low or "efficient float16" in low:
        return "COMPUTE_TYPE_UNSUPPORTED"
    # #763: a bare OS-level EINVAL ("[Errno 22] Invalid argument") while writing
    # the per-chunk temp WAV for transcription (tempfile.NamedTemporaryFile /
    # soundfile.write on the system temp dir) used to collapse into a dead-end
    # "produced no segments. [Errno 22] Invalid argument" toast with no next
    # step. errno 22 is EINVAL on every platform; in this path it's almost always
    # a temp dir that's missing, read-only, on a full/removed drive, or blocked
    # by antivirus. Name the class so build_failure attaches an actionable hint
    # instead of a raw errno. Matching the errno (not the generic "invalid
    # argument" wording) keeps this from mislabelling unrelated failures; the
    # transformers "errno 2" rule below is unaffected — it also requires the
    # transformers + site-packages markers, which this signature lacks.
    if "errno 22" in low:
        return "OS_INVALID_ARGUMENT"
    # An HF cache whose snapshot entries don't resolve (dangling symlinks /
    # zero-byte stand-ins): transformers reports the weights missing ("does
    # not appear to have a file named pytorch_model.bin or model.safetensors")
    # even though the blobs are fully on disk. model_manager self-heals this
    # (delete broken entries → snapshot_download → retry once); the class here
    # covers both the raw transformers wording (any load surface can leak it)
    # and OmniVoice's own repair messages, so the user-facing error and the
    # auto bug report name the class and its automatic repair.
    if ("does not appear to have a file named" in low
            or "broken file link" in low):
        return "MODEL_CACHE_CORRUPT"
    if (
        "could not import module" in low
        or "autofeatureextractor" in low
        # A corrupted/incomplete transformers install: a model load lazily
        # resolves a module file that's MISSING from site-packages (an
        # interrupted `uv sync`, antivirus removal, or a partial update), e.g.
        # `[Errno 2] No such file or directory:
        #  '.../site-packages/transformers/models/qwen3/modeling_qwen3.py'`.
        # That's a FileNotFoundError, not an ImportError, so the matches above
        # miss it and the user got a useless "try restarting". Substring-match
        # the package + the missing-file signal (separately, so it works on both
        # POSIX `/` and Windows `\` paths).
        or (
            ("no such file" in low or "errno 2" in low)
            and "transformers" in low
            and "site-packages" in low
        )
    ):
        return "TRANSFORMERS_IMPORT"
    # #959: httpx raises ImportError AT CLIENT CONSTRUCTION ("Using SOCKS
    # proxy, but the 'socksio' package is not installed. Make sure to install
    # httpx using `pip install httpx[socks]`.") when ALL_PROXY/HTTPS_PROXY is
    # socks5:// and socksio isn't importable. It surfaced from
    # huggingface_hub's get_session() inside model load — a bare 500 on
    # /generate with no next step. Checked BEFORE the HF-auth/mirror rules so
    # a message that also carries HF wording still names this class.
    if "socks proxy" in low or "socksio" in low:
        return "SOCKS_PROXY_SUPPORT_MISSING"
    # #976: a TLS handshake failing AFTER the TCP connection succeeds — the
    # signature of a corporate/antivirus proxy that TLS-inspects traffic and
    # re-signs certificates with a CA the OS trusts but Python's bundled
    # certifi list doesn't (a different failure mode from #984's TCP-level
    # "can't reach the host at all"). Requires "ssl" plus a handshake/cert-
    # verify marker so a generic connection error isn't mislabelled.
    if "ssl" in low and (
        "handshake" in low
        or "certificate verify failed" in low
        or "sslv3_alert" in low
        or "sslcertverificationerror" in low
    ):
        return "SSL_HANDSHAKE_FAILURE"
    if ("huggingface" in low or "hf_token" in low or "401" in low or "unauthorized" in low) and (
        "token" in low or "auth" in low or "401" in low or "unauthorized" in low
    ):
        return "HF_AUTH_FAILED"
    # #874: a model download that failed because the CONFIGURED HF mirror is
    # unreachable. Env-aware by design — the class only exists when a
    # non-default HF_ENDPOINT is configured. Checked BEFORE the video-download
    # network class so a model download's "timed out"/"connection reset"
    # names the mirror instead of the "video server".
    if hf_mirror_hint(reason):
        return "HF_MIRROR_UNREACHABLE"
    # Video download (#554/#536): a non-downloadable URL shape vs a transient
    # network drop — both previously surfaced as a bare yt-dlp string with no
    # next step. UNSUPPORTED first (more specific) so "Unable to download video:
    # Broken pipe" still classifies as a network blip.
    if "unsupported url" in low or "no video formats" in low or "is not a valid url" in low:
        return "UNSUPPORTED_VIDEO_URL"
    if (
        "broken pipe" in low
        or "connection reset" in low
        or "unable to download video" in low
        or "remote end closed" in low
        or "timed out" in low
    ):
        return "VIDEO_DOWNLOAD_NETWORK"
    # A relocated/corrupted venv whose interpreter can't bootstrap its stdlib —
    # the Rust self-heal rebuilds it; this names the class for the toast.
    if "no module named 'encodings'" in low:
        return "BROKEN_VENV"
    # #564: the interpreter starts fine but the backend can't import its OWN
    # `omnivoice` package (a venv missing the editable install). Same self-heal
    # class — Clean & Retry / the bootstrap repair rebuilds it. The trailing
    # quote keeps a legitimately-named `omnivoice_*` helper from matching.
    if "no module named 'omnivoice'" in low:
        return "BROKEN_VENV"
    return ""


def sanitize(text: Optional[str]) -> str:
    """Redact secrets and strip the home path from a string.

    - HF tokens (reuses the regex from ``core.logging_filter``)
    - values of env vars whose name matches ``*TOKEN*/*KEY*/*SECRET*``
    - the user's absolute home directory → ``~``
    """
    if not text:
        return text or ""
    out = _HF_TOKEN_RE.sub(REDACTED, str(text))
    for name, val in os.environ.items():
        # Only redact substantial values so short/empty ones don't blank the text.
        if val and len(val) >= 6 and _SECRET_NAME_RE.search(name):
            out = out.replace(val, _REDACTED_VALUE)
    try:
        home = str(Path.home())
        if home and home in out:
            out = out.replace(home, "~")
    except Exception:
        # Best-effort: sanitize() must never raise (it runs on the failure path);
        # if home-dir resolution fails, leave the text as-is rather than throw.
        pass
    return out


def _env_summary() -> str:
    lines: list[str] = []
    try:
        lines.append(f"OS:      {platform.platform()}")
    except Exception:
        # Best-effort env summary — omit the OS line rather than fail diagnostics.
        pass
    lines.append(f"Python:  {sys.version.split()[0]}")
    try:
        import psutil  # already a runtime dep

        vm = psutil.virtual_memory()
        lines.append(f"CPU:     {os.cpu_count()} cores")
        lines.append(f"RAM:     {round(vm.total / 1024 ** 3, 1)} GB")
    except Exception:
        # Best-effort — omit CPU/RAM if psutil is unavailable or probing fails.
        pass
    # Only probe the GPU if torch is ALREADY imported — importing it here just
    # to build a diagnostic would add seconds to every failure (and to tests).
    torch = sys.modules.get("torch")
    if torch is not None:
        try:
            if torch.cuda.is_available():
                lines.append(f"GPU:     CUDA {torch.cuda.get_device_name(0)}")
            elif getattr(getattr(torch, "backends", None), "mps", None) and torch.backends.mps.is_available():
                lines.append("GPU:     MPS (Apple)")
            else:
                lines.append("GPU:     CPU only")
        except Exception:
            # Best-effort — omit the GPU line if torch probing raises.
            pass
    return "\n".join(lines)


def diagnostic(*, reason: str, error_class: str, stage: str) -> str:
    """A sanitized, copy-paste-friendly diagnostic block for a failed job."""
    block = (
        "OmniVoice diagnostic\n"
        "--------------------\n"
        f"Stage:   {stage}\n"
        f"Error:   {error_class}\n"
        f"Reason:  {reason}\n"
        f"{_env_summary()}\n"
    )
    return sanitize(block)


def build_failure(
    exc_or_msg: Any,
    *,
    stage: str,
    context: Optional[dict] = None,
    include_diagnostic: bool = True,
) -> dict:
    """Build the structured failure fields (no ``type`` — caller/prep_event adds it).

    ``reason`` is guaranteed non-empty: ``str(exc)`` → exception class name.
    """
    if isinstance(exc_or_msg, BaseException):
        error_class = type(exc_or_msg).__name__
        raw = str(exc_or_msg).strip() or error_class
    else:
        error_class = "Error"
        raw = str(exc_or_msg).strip() or "Unknown failure"

    reason = sanitize(raw) or error_class
    docs_topic = classify(raw)
    # HF_MIRROR_UNREACHABLE's hint is dynamic (it names the configured mirror)
    # so it can't live in the static _HINTS table.
    hint = hf_mirror_hint(raw) if docs_topic == "HF_MIRROR_UNREACHABLE" else _HINTS.get(docs_topic, "")
    fields: dict[str, Any] = {
        "reason": reason,
        "error": reason,  # backward-compat mirror for older frontends
        "error_class": error_class,
        "stage": stage,
        "hint": hint,
        "docs_topic": docs_topic,
        "docs_url": error_docs_map.ERROR_DOCS.get(docs_topic, ""),
        "detail": sanitize(raw),
    }
    if context:
        fields["context"] = {k: sanitize(str(v)) for k, v in context.items()}
    if include_diagnostic:
        fields["diagnostic"] = diagnostic(reason=reason, error_class=error_class, stage=stage)
    return fields


def build_failure_event(
    exc_or_msg: Any,
    *,
    stage: str,
    event_type: str = "error",
    context: Optional[dict] = None,
    include_diagnostic: bool = True,
) -> dict:
    """``build_failure`` plus a ``type`` key, for SSE event sites (tasks.py)."""
    return {
        "type": event_type,
        **build_failure(
            exc_or_msg, stage=stage, context=context, include_diagnostic=include_diagnostic
        ),
    }
