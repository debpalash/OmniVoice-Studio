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
    size_gb: float
    languages: str
    files: dict[str, str]
    recommended: bool = False
    model_type: str = ""           # offline transducer only (nemo_transducer)
    extra: dict = field(default_factory=dict)

    @property
    def streaming(self) -> bool:
        return self.tag == "streaming"


# ── The 7 models (HF repo ids under csukuangfj/, filenames VERIFIED against the
#    live HF /api/models/<repo>/tree/main on 2026-06-25; int8 variants pinned).
_MODELS: dict[str, SherpaModelSpec] = {
    "sherpa-parakeet-tdt-v3": SherpaModelSpec(
        id="sherpa-parakeet-tdt-v3",
        repo_id="csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        label="Parakeet TDT v3",
        tag="offline",
        kind="offline-transducer",
        size_gb=0.18,
        languages="25 European languages",
        recommended=True,
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
        size_gb=0.17,
        languages="English",
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
        size_gb=0.13,
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
        size_gb=0.115,
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
        size_gb=0.128,
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
        size_gb=0.074,
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
        size_gb=0.116,
        languages="90+ languages (auto-detect)",
        files={
            "encoder": "tiny-encoder.int8.onnx",
            "decoder": "tiny-decoder.int8.onnx",
            "tokens": "tiny-tokens.txt",
        },
    ),
}

DEFAULT_MODEL_ID = "sherpa-parakeet-tdt-v3"

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


def _resolve_model_dir(spec: SherpaModelSpec, *, download: bool = True) -> str:
    """Return the local directory containing this model's ONNX assets.

    Tries the HF cache offline first (``local_files_only=True``); on a miss,
    downloads on first use (like every other engine) unless ``download=False``.
    Restricts the fetch to the exact int8 assets we pin via ``allow_patterns``
    so we never pull the bundled fp32 weights or test wavs.
    """
    from huggingface_hub import snapshot_download

    wanted = list(spec.files.values())
    try:
        return snapshot_download(
            repo_id=spec.repo_id,
            local_files_only=True,
            allow_patterns=wanted,
        )
    except Exception:
        if not download:
            raise
    logger.info("sherpa dictation: downloading %s on first use", spec.repo_id)
    return snapshot_download(repo_id=spec.repo_id, allow_patterns=wanted)


def is_installed(spec: SherpaModelSpec) -> bool:
    """True if every pinned asset is already present in the HF cache."""
    try:
        d = _resolve_model_dir(spec, download=False)
    except Exception:
        return False
    return all(os.path.isfile(os.path.join(d, f)) for f in spec.files.values())


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
            num_threads=_NUM_THREADS,
            provider=_PROVIDER,
            decoding_method="greedy_search",
            model_type=spec.model_type or "nemo_transducer",
        )
    if spec.kind == "offline-whisper":
        return sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=p("encoder"),
            decoder=p("decoder"),
            tokens=p("tokens"),
            num_threads=_NUM_THREADS,
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

    def p(role: str) -> str:
        return os.path.join(d, spec.files[role])

    if spec.kind == "online-transducer":
        return sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=p("tokens"),
            encoder=p("encoder"),
            decoder=p("decoder"),
            joiner=p("joiner"),
            num_threads=_NUM_THREADS,
            provider=_PROVIDER,
            decoding_method="greedy_search",
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=2.4,
            rule2_min_trailing_silence=1.2,
            rule3_min_utterance_length=20,
        )
    if spec.kind == "online-paraformer":
        return sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=p("tokens"),
            encoder=p("encoder"),
            decoder=p("decoder"),
            num_threads=_NUM_THREADS,
            provider=_PROVIDER,
            decoding_method="greedy_search",
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=2.4,
            rule2_min_trailing_silence=1.2,
            rule3_min_utterance_length=20,
        )
    raise ValueError(f"{spec.id} is not a streaming model (kind={spec.kind})")
