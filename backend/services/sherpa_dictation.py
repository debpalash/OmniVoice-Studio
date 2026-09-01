"""
sherpa-onnx live-dictation ASR backend.

Adds the k2-fsa/sherpa-onnx ONNX runtime as a *dictation* engine alongside the
existing Whisper/NeMo family — without touching any of them. The whole point of
this engine is **live, faster-than-real-time dictation on CPU**:

  • STREAMING models (OnlineRecognizer) emit partial text frame-by-frame as the
    user speaks, finalising on sherpa's built-in endpoint (silence) detection.
  • OFFLINE models (OfflineRecognizer) re-transcribe a growing buffer on a short
    cadence so the user still sees live partials, finalising on EOF/silence.

CPU provider only (strict cross-platform-default parity rule): identical
behaviour on macOS arm64+x86_64, Windows x64, Linux. No CUDA dependency.

Model weights are the small int8 ONNX checkpoints published under
``csukuangfj/`` on HuggingFace; they download on first use through the same HF
cache the rest of the app uses (``snapshot_download``). Exact asset filenames
were verified against the live HF repo trees (see ``_MODELS`` below) — the
streaming zipformer repos use the plain ``encoder-epoch-99-avg-1.int8.onnx``
naming, NOT a ``-chunk-16-left-64`` variant.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

logger = logging.getLogger("omnivoice.asr.sherpa")

# CPU only — strict cross-platform default-parity rule. Overridable for
# power users on a verified GPU build, but the default never diverges.
_PROVIDER = os.environ.get("OMNIVOICE_SHERPA_ASR_PROVIDER", "cpu")
_NUM_THREADS = int(os.environ.get("OMNIVOICE_SHERPA_ASR_THREADS", "2"))

# The 0.6B models need more than the 2-thread default to hold a comfortable
# real-time factor. At 2 threads Parakeet measures RTF ~0.33 on older x64 —
# it keeps up, but with almost no headroom, so a background compile or a
# browser tab pushes decode behind the speaker and the pill visibly lags.
# The small zipformers do not need it and are the fallback for exactly the
# machines where spending cores is a bad trade, so this is per-model rather
# than a global bump.
#
# Capped at the host's core count (and never below the base default) so a
# 2-core laptop is not told to run 4 ASR threads, which costs more in
# contention than it buys. This is a PERFORMANCE knob, not behaviour: every
# platform runs the same models with the same results, so tuning it against
# the host is inside the parity rule, not an exception to it.
_LARGE_MODEL_THREADS = 4


def _threads_for(spec: "SherpaModelSpec") -> int:
    """Thread count for this model, honouring the env override verbatim."""
    if "OMNIVOICE_SHERPA_ASR_THREADS" in os.environ:
        return _NUM_THREADS
    if not getattr(spec, "heavy", False):
        return _NUM_THREADS
    cores = os.cpu_count() or 1
    return max(_NUM_THREADS, min(_LARGE_MODEL_THREADS, cores))


def _endpoint_rules() -> tuple[float, float]:
    """Trailing-silence endpoint rules (seconds) for streaming recognizers.

    Wispr-Flow-speed defaults (dictation v2): rule2 commits ~0.6s after speech
    stops, rule1 flushes after 1.0s of trailing non-speech — down from the
    upstream 2.4/1.2, which made every committed sentence feel laggy. Read at
    call time so the env overrides apply without a restart.
    """
    def _f(env: str, default: float) -> float:
        try:
            return float(os.environ.get(env, "") or default)
        except (TypeError, ValueError):
            return default
    return (_f("OMNIVOICE_DICTATION_ENDPOINT_R1", 1.0),
            _f("OMNIVOICE_DICTATION_ENDPOINT_R2", 0.6))


@dataclass(frozen=True)
class SherpaModelSpec:
    """One downloadable sherpa-onnx dictation model.

    ``files`` maps a logical role (encoder/decoder/joiner/tokens) to the EXACT
    asset filename in the HF repo. ``kind`` selects the recognizer factory:
    ``offline-transducer`` | ``offline-whisper`` | ``online-transducer`` |
    ``online-paraformer``. ``tag`` is the frontend-facing "offline"/"streaming".
    """
    id: str
    repo_id: str
    label: str
    tag: str            # "offline" | "streaming"
    kind: str           # recognizer factory selector
    size_gb: float     # on-disk download size, measured — see _MODELS header
    languages: str
    files: dict[str, str]
    recommended: bool = False
    heavy: bool = False             # 0.6B-class: more decode threads (_threads_for)
    model_type: str = ""           # offline transducer only (nemo_transducer)
    extra: dict = field(default_factory=dict)

    @property
    def streaming(self) -> bool:
        return self.tag == "streaming"


# ── The 7 models (HF repo ids under csukuangfj/, filenames VERIFIED against the
#    live HF /api/models/<repo>/tree/main on 2026-06-25; int8 variants pinned).
#
#    `size_gb` is the sum of the pinned `files` for each repo, MEASURED from
#    the same HF tree API on 2026-08-07 — not estimated. Every one of the seven
#    was wrong before, and in both directions, which is worse than uniformly
#    optimistic: the two Parakeets under-reported by ~3.8x (0.18 -> 0.67 GB),
#    so installing v3 quietly downloaded four times what the picker
#    promised on a metered or small-disk machine; but the two low-RAM
#    zipformers OVER-reported by ~3x (0.128 -> 0.044), making the fallback
#    models look bulkier than the heavyweights they exist to rescue users
#    from. tests/test_sherpa_model_sizes.py pins these against the manifest.
#
#    Note this is DISK. Peak RSS is substantially higher for the 0.6B models
#    because onnxruntime's arena allocator does not return freed blocks
#    (sherpa-onnx#2626); the picker labels the figure as download size rather
#    than implying it is the memory cost.
_MODELS: dict[str, SherpaModelSpec] = {
    "sherpa-parakeet-tdt-v3": SherpaModelSpec(
        id="sherpa-parakeet-tdt-v3",
        repo_id="csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        label="Parakeet TDT v3",
        tag="offline",
        kind="offline-transducer",
        size_gb=0.67,
        languages="25 European languages",
        heavy=True,
        model_type="nemo_transducer",
        files={
            "encoder": "encoder.int8.onnx",
            "decoder": "decoder.int8.onnx",
            "joiner": "joiner.int8.onnx",
            "tokens": "tokens.txt",
        },
    ),
    "sherpa-parakeet-tdt-v2": SherpaModelSpec(
        id="sherpa-parakeet-tdt-v2",
        repo_id="csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
        label="Parakeet TDT v2",
        tag="offline",
        kind="offline-transducer",
        size_gb=0.66,
        languages="English",
        heavy=True,
        model_type="nemo_transducer",
        files={
            "encoder": "encoder.int8.onnx",
            "decoder": "decoder.int8.onnx",
            "joiner": "joiner.int8.onnx",
            "tokens": "tokens.txt",
        },
    ),
    "sherpa-zipformer-bilingual-zh-en": SherpaModelSpec(
        id="sherpa-zipformer-bilingual-zh-en",
        repo_id="csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
        label="Zipformer Bilingual",
        tag="streaming",
        kind="online-transducer",
        size_gb=0.2,
        languages="Chinese + English",
        files={
            "encoder": "encoder-epoch-99-avg-1.int8.onnx",
            "decoder": "decoder-epoch-99-avg-1.int8.onnx",
            "joiner": "joiner-epoch-99-avg-1.int8.onnx",
            "tokens": "tokens.txt",
        },
    ),
    "sherpa-paraformer-bilingual-zh-en": SherpaModelSpec(
        id="sherpa-paraformer-bilingual-zh-en",
        repo_id="csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en",
        label="Paraformer Bilingual",
        tag="streaming",
        kind="online-paraformer",
        size_gb=0.24,
        languages="Chinese + English",
        files={
            "encoder": "encoder.int8.onnx",
            "decoder": "decoder.int8.onnx",
            "tokens": "tokens.txt",
        },
    ),
    "sherpa-zipformer-en-20m": SherpaModelSpec(
        id="sherpa-zipformer-en-20m",
        repo_id="csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17",
        label="Zipformer Streaming EN",
        tag="streaming",
        kind="online-transducer",
        size_gb=0.044,
        languages="English",
        files={
            "encoder": "encoder-epoch-99-avg-1.int8.onnx",
            "decoder": "decoder-epoch-99-avg-1.int8.onnx",
            "joiner": "joiner-epoch-99-avg-1.int8.onnx",
            "tokens": "tokens.txt",
        },
    ),
    "sherpa-zipformer-zh-14m": SherpaModelSpec(
        id="sherpa-zipformer-zh-14m",
        repo_id="csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23",
        label="Zipformer Streaming ZH",
        tag="streaming",
        kind="online-transducer",
        size_gb=0.025,
        languages="Chinese",
        files={
            "encoder": "encoder-epoch-99-avg-1.int8.onnx",
            "decoder": "decoder-epoch-99-avg-1.int8.onnx",
            "joiner": "joiner-epoch-99-avg-1.int8.onnx",
            "tokens": "tokens.txt",
        },
    ),
    "sherpa-whisper-tiny": SherpaModelSpec(
        id="sherpa-whisper-tiny",
        repo_id="csukuangfj/sherpa-onnx-whisper-tiny",
        label="Whisper Tiny",
        tag="offline",
        kind="offline-whisper",
        size_gb=0.104,
        languages="90+ languages (auto-detect)",
        recommended=True,
        files={
            "encoder": "tiny-encoder.int8.onnx",
            "decoder": "tiny-decoder.int8.onnx",
            "tokens": "tiny-tokens.txt",
        },
    ),
}

DEFAULT_MODEL_ID = "sherpa-whisper-tiny"

# repo_id → model id, so the model-store list (keyed by repo_id) can be
# enriched with the dictation metadata, and so capture can map either key.
_REPO_TO_ID: dict[str, str] = {m.repo_id: mid for mid, m in _MODELS.items()}


def list_specs() -> list[SherpaModelSpec]:
    return list(_MODELS.values())


def get_spec(model_id: str) -> SherpaModelSpec | None:
    """Look up a spec by its dictation id OR its HF repo_id."""
    if model_id in _MODELS:
        return _MODELS[model_id]
    if model_id in _REPO_TO_ID:
        return _MODELS[_REPO_TO_ID[model_id]]
    return None


def is_sherpa_model(model_id: str | None) -> bool:
    return bool(model_id) and get_spec(model_id) is not None


def sherpa_available() -> tuple[bool, str]:
    try:
        import sherpa_onnx  # noqa: F401
        return True, "ready"
    except ImportError as e:
        return False, f"sherpa-onnx not installed: {e}. Install with: uv add sherpa-onnx"
    except Exception as e:  # noqa: BLE001 — an availability probe must fail closed
        # Native wheel failures surface as OSError/RuntimeError rather than
        # ImportError (missing DLL/dylib/so, loader or runtime init failure) —
        # but the set is open-ended: an extension module is free to raise
        # anything at init. This is an availability question, so ANY failure to
        # import means "not available", never an exception escaping to the
        # caller. SherpaDictationBackend.is_available() calls this directly and
        # capture_ws.ws_transcribe calls that without a guard, so an unexpected
        # type here took the WebSocket down instead of falling back (#1610).
        return False, f"sherpa-onnx unavailable ({type(e).__name__}): {e}"


def _usable_model_file(path: str) -> bool:
    try:
        return os.path.isfile(path) and os.path.getsize(path) > 0
    except OSError:
        return False


def _resolve_model_dir(spec: SherpaModelSpec, *, download: bool = True) -> str:
    """Return the local directory containing this model's ONNX assets.

    Tries the HF cache offline first (``local_files_only=True``); on a miss,
    downloads on first use (like every other engine) unless ``download=False``.
    Restricts the fetch to the exact int8 assets we pin via ``allow_patterns``
    so we never pull the bundled fp32 weights or test wavs.
    """
    from huggingface_hub import snapshot_download
    from services.hf_revisions import revision_for

    wanted = list(spec.files.values())
    cache_dir = _live_hub_cache_dir()
    # Probe the revision an existing installation actually resolved.  Older
    # releases followed ``main`` and may therefore have a different snapshot;
    # retaining it preserves offline upgrades.  Any network fetch still uses
    # the reviewed immutable pin.
    installed = _installed_snapshot(spec)
    if installed:
        return installed
    if not download:
        raise FileNotFoundError(f"No complete cached snapshot for {spec.repo_id}")

    # A Windows cache can retain a snapshot entry whose target blob vanished,
    # or a zero-byte ONNX placeholder left by an interrupted download.  Hub may
    # then treat that entry as already materialized and return the same broken
    # snapshot.  Repair those entries before asking for another download so the
    # recognizer never receives a path to a file that does not resolve (#1733).
    from services.hf_cache_repair import (
        find_dangling_entries,
        repair_repo_cache,
        repo_cache_dir,
    )

    if find_dangling_entries(repo_cache_dir(spec.repo_id, cache_dir)):
        repair = repair_repo_cache(spec.repo_id, cache_dir)
        installed = _installed_snapshot(spec)
        if installed:
            return installed
        if not repair.get("ok"):
            logger.warning(
                "sherpa dictation: cache repair for %s failed: %s",
                spec.repo_id,
                repair.get("error") or repair.get("outcome") or "unknown error",
            )

    logger.info("sherpa dictation: downloading %s on first use", spec.repo_id)
    snapshot = snapshot_download(
        repo_id=spec.repo_id,
        revision=revision_for(spec.repo_id),
        allow_patterns=wanted,
        cache_dir=cache_dir,
    )
    missing = [
        name for name in wanted
        if not _usable_model_file(os.path.join(snapshot, name))
    ]
    if not missing:
        return snapshot

    # Verify after the Hub reports success.  This catches hosts where a broken
    # snapshot entry short-circuits snapshot_download.  The generic repair
    # removes only broken entries, preserves blobs, and retries the immutable
    # installed revision.
    repair = repair_repo_cache(spec.repo_id, cache_dir)
    installed = _installed_snapshot(spec)
    if installed:
        return installed
    detail = repair.get("error") or repair.get("outcome") or "repair did not restore them"
    raise FileNotFoundError(
        f"Sherpa model cache is incomplete for {spec.repo_id}; missing "
        f"{', '.join(missing)}. Cache repair failed: {detail}. Reinstall this "
        "model from Model Catalogue."
    )


def _live_hub_cache_dir() -> str:
    """The effective hub root, evaluated after Settings restores the env."""
    direct = os.environ.get("HF_HUB_CACHE") or os.environ.get("HUGGINGFACE_HUB_CACHE")
    if direct:
        return os.path.expanduser(direct)
    home = os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface")
    return os.path.join(os.path.expanduser(home), "hub")


def _installed_snapshot(spec: SherpaModelSpec) -> str | None:
    """Complete snapshot for the recorded revision in the live cache."""
    from services.hf_revisions import installed_revision

    cache_dir = _live_hub_cache_dir()
    revision = installed_revision(spec.repo_id, cache_dir)
    snapshot = os.path.join(
        cache_dir,
        "models--" + spec.repo_id.replace("/", "--"),
        "snapshots",
        revision,
    )
    if all(
        _usable_model_file(os.path.join(snapshot, filename))
        for filename in spec.files.values()
    ):
        return snapshot
    return None


def is_installed(spec: SherpaModelSpec) -> bool:
    """True if the recorded cached snapshot contains every pinned asset.

    Do not use ``snapshot_download(local_files_only=True)`` for this probe.
    ``huggingface_hub.constants.HF_HUB_CACHE`` is fixed when that module is
    first imported, while VoiceStudio can restore its cache directory later
    from the durable user settings. Resolve the live root and the recorded
    revision ourselves so readiness and loading cannot disagree after a cache
    move, desktop relaunch, or stale snapshot (#1707).
    """
    return _installed_snapshot(spec) is not None


# ── Recognizers ──────────────────────────────────────────────────────────────


def build_offline_recognizer(spec: SherpaModelSpec, *, download: bool = True):
    """Construct an ``OfflineRecognizer`` for an offline transducer/whisper model."""
    import sherpa_onnx

    d = _resolve_model_dir(spec, download=download)

    def p(role: str) -> str:
        return os.path.join(d, spec.files[role])

    if spec.kind == "offline-transducer":
        return sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=p("encoder"),
            decoder=p("decoder"),
            joiner=p("joiner"),
            tokens=p("tokens"),
            num_threads=_threads_for(spec),
            provider=_PROVIDER,
            decoding_method="greedy_search",
            model_type=spec.model_type or "nemo_transducer",
        )
    if spec.kind == "offline-whisper":
        return sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=p("encoder"),
            decoder=p("decoder"),
            tokens=p("tokens"),
            num_threads=_threads_for(spec),
            provider=_PROVIDER,
            language="",          # auto-detect
            task="transcribe",
        )
    raise ValueError(f"{spec.id} is not an offline model (kind={spec.kind})")


def build_online_recognizer(spec: SherpaModelSpec, *, download: bool = True):
    """Construct an ``OnlineRecognizer`` (true streaming) with endpoint detection.

    Endpoint (silence) detection drives the live "final" boundary: sherpa
    commits a sentence after trailing silence so we can flush a ``final`` and
    reset the stream for the next utterance — all within one WS session.
    """
    import sherpa_onnx

    d = _resolve_model_dir(spec, download=download)
    rule1, rule2 = _endpoint_rules()

    def p(role: str) -> str:
        return os.path.join(d, spec.files[role])

    if spec.kind == "online-transducer":
        return sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=p("tokens"),
            encoder=p("encoder"),
            decoder=p("decoder"),
            joiner=p("joiner"),
            num_threads=_threads_for(spec),
            provider=_PROVIDER,
            decoding_method="greedy_search",
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=rule1,
            rule2_min_trailing_silence=rule2,
            rule3_min_utterance_length=20,
        )
    if spec.kind == "online-paraformer":
        return sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=p("tokens"),
            encoder=p("encoder"),
            decoder=p("decoder"),
            num_threads=_threads_for(spec),
            provider=_PROVIDER,
            decoding_method="greedy_search",
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=rule1,
            rule2_min_trailing_silence=rule2,
            rule3_min_utterance_length=20,
        )
    raise ValueError(f"{spec.id} is not a streaming model (kind={spec.kind})")


# ── Silent-model demotion ────────────────────────────────────────────────────
# A sherpa model can install cleanly, load without error, and still decode
# NOTHING. The NeMo-TDT path does exactly this on some builds: parakeet-tdt
# v2/v3 return an empty token list for clear speech (both int8 and fp32, both
# decoding methods, sherpa-onnx 1.13.3 and 1.13.4) while whisper and zipformer
# transcribe the same bytes. It is a defect inside sherpa-onnx that the app
# cannot fix by configuration.
#
# Installation alone therefore cannot prove that a recognizer works. When a
# session hears real speech and the model returns nothing, that model is
# demoted on this machine and stops being selected. This self-corrects wherever
# the decoder defect appears and is a no-op everywhere it does not.

#: prefs key holding the list of model ids demoted on this machine.
PREF_SILENT_MODELS = "dictation.silent_models"


def demoted_models() -> list[str]:
    """Model ids observed to decode nothing on this machine."""
    try:
        from core import prefs
        v = prefs.get(PREF_SILENT_MODELS, [])
    except Exception:
        return []
    return [str(x) for x in v] if isinstance(v, list) else []


def is_demoted(model_id: str | None) -> bool:
    return bool(model_id) and model_id in demoted_models()


def demote_model(model_id: str) -> bool:
    """Record that `model_id` produced no text despite real speech.

    Returns True when this is a new demotion. Idempotent, and never raises —
    failing to persist must not break the dictation session that noticed.
    """
    if not model_id:
        return False
    try:
        from core import prefs
        current = demoted_models()
        if model_id in current:
            return False
        prefs.set_(PREF_SILENT_MODELS, [*current, model_id])
        return True
    except Exception:
        logger.exception("could not persist silent-model demotion for %s", model_id)
        return False


def clear_demotion(model_id: str | None = None) -> None:
    """Forget demotions — one model, or all when `model_id` is None.

    The user stays in charge: a sherpa upgrade may fix the decoder, and picking
    the model again in Settings should give it a fresh chance.
    """
    try:
        from core import prefs
        if model_id is None:
            prefs.set_(PREF_SILENT_MODELS, [])
        else:
            prefs.set_(PREF_SILENT_MODELS, [m for m in demoted_models() if m != model_id])
    except Exception:
        logger.exception("could not clear silent-model demotion")
