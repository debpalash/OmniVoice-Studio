from pydantic import BaseModel, field_validator
from typing import List, Literal, Optional

from services.audio_dsp import EFFECT_PRESETS

class ExportRequest(BaseModel):
    source_filename: str
    destination_path: str
    mode: str = "history"

class ExportRecordRequest(BaseModel):
    filename: str
    destination_path: str = "~/Downloads"
    mode: str = "file"

class RevealRequest(BaseModel):
    path: str

class DubSegment(BaseModel):
    start: float
    end: float
    text: str
    instruct: str = ""       # Per-segment voice override
    profile_id: str = ""     # Per-segment voice profile
    speed: Optional[float] = None
    gain: Optional[float] = None  # Per-segment volume (0.0 - 2.0, default 1.0)
    target_lang: Optional[str] = None  # Per-segment language override (ISO code)
    # Phase 4.2 free-form directorial note ("urgent, whispered…"). The client
    # has always sent this; without the field pydantic silently dropped it,
    # so directions never reached TTS and never entered the regen
    # fingerprint (#281).
    direction: Optional[str] = None
    effect_preset: str = "broadcast"   # NEW: DSP preset id (default: broadcast)

    @field_validator("effect_preset")
    @classmethod
    def validate_effect_preset(cls, v: str) -> str:
        if v not in EFFECT_PRESETS:
            raise ValueError(
                f"Unknown effect preset: {v!r}. "
                f"Valid: {list(EFFECT_PRESETS.keys())}"
            )
        return v

class FitOptions(BaseModel):
    """Optional knob overrides for the `smart_fit` timing strategy.

    All fields default to None — the server fills in the canonical
    defaults (services.fit_planner.FitParams) so old clients and sparse
    payloads behave identically to a fully-populated default payload.
    """
    max_audio_only_rate: Optional[float] = None  # default 1.2
    audio_rate_cap: Optional[float] = None       # default 1.5
    video_slow_cap: Optional[float] = None       # default 2.0
    gap_guard_s: Optional[float] = None          # default 0.05
    allow_video_retime: Optional[bool] = None    # default True

class DubRequest(BaseModel):
    segments: List[DubSegment]
    language: str = "Auto"
    language_code: str = "und"  # ISO 639-1 for ffmpeg metadata (e.g. "es", "fr", "de")
    instruct: str = ""
    num_step: int = 16
    guidance_scale: float = 2.0
    speed: float = 1.0
    # Phase 4.1 — partial regen. Parallel lists by index with `segments`.
    # When `regen_only` is set, only listed segment ids re-run TTS; others
    # reuse their on-disk seg_N.wav. `segment_ids` lets the client bind
    # each segment to a stable id across regen cycles.
    segment_ids: Optional[List[str]] = None
    regen_only: Optional[List[str]] = None
    # Fast-preview mode for interactive edits. When true, TTS runs at
    # num_step=8 (~2× faster, ~10-20% quality drop). Client is responsible
    # for re-rendering preview segs at full quality before final export.
    preview: Optional[bool] = False
    # How to handle segs whose TTS audio is longer than its slot (the
    # "ghost lang" overlap bug otherwise). Options:
    #   "time_stretch" — phase-vocoder stretch to fit, preserves pitch (default).
    #   "trim"         — hard-clip to slot length + fade out (cheap, may cut mid-word).
    #   "off"          — no fit; mix layers with += (legacy behaviour, may overlap).
    # Legacy knob. When `timing_strategy` is set, it takes precedence and this is ignored.
    slot_fit: Optional[str] = "time_stretch"

    # High-level timing strategy. Replaces the audio-compression default that
    # produced chipmunk/alien artefacts on high-density target languages
    # (Bengali, Hindi, Arabic…). Three modes:
    #   "concise"       — never compress TTS audio. Trim text up-front via
    #                     speech_rate so it fits naturally; if it still
    #                     overflows, hard-trim at slot with a short fade and
    #                     surface fit_status="overflows" so the UI can prompt
    #                     the user to shorten the segment. DEFAULT.
    #   "stretch_video" — never compress TTS audio. Re-lay the timeline so
    #                     each segment's video portion is stretched (via
    #                     ffmpeg setpts) to fit the natural-rate dub audio.
    #                     Audio plays at 1.0×; total video duration grows.
    #   "smart_fit"     — dub-length fitting v2: split the burden between a
    #                     mild pitch-preserving audio speed-up (≤1.2× alone,
    #                     ≤1.5× in hybrid) and a mild per-segment video
    #                     slow-down (≤2.0×), per services/fit_planner.py.
    #                     Residual overflow is trimmed and surfaced.
    #   "strict_slot"   — legacy: keep `slot_fit` semantics (atempo squeeze
    #                     when audio > slot). Kept for back-compat.
    timing_strategy: Optional[Literal["concise", "stretch_video", "strict_slot", "smart_fit"]] = "concise"

    # Per-job slip budget for "concise" mode. Hard-trim only kicks in once
    # gap absorption + this much extra time has been consumed.
    overflow_budget_s: Optional[float] = 0.0

    # Knob overrides for `smart_fit` (ignored by other strategies). Omitted
    # fields default server-side to fit_planner.FitParams values.
    fit_options: Optional[FitOptions] = None

class TranslateSegment(BaseModel):
    id: str
    text: str
    target_lang: Optional[str] = None
    # Free-form delivery direction ("urgent, whispering") — feeds the
    # cinematic reflect/adapt prompts. The frontend has sent this since
    # Phase 4.2 but pydantic silently dropped it as an undeclared extra,
    # so the per-segment direction hint never reached the LLM.
    direction: Optional[str] = None
    # Available time slot (end - start, seconds) for rate-ratio prediction
    # and the cinematic slot-fit pass. Same silent-drop fix as `direction`.
    slot_seconds: Optional[float] = None

class TranslateRequest(BaseModel):
    segments: List[TranslateSegment]
    target_lang: str  # ISO 639-1 code like "es", "fr"
    provider: Optional[str] = None
    source_lang: Optional[str] = None  # ISO 639-1; overrides job detection
    job_id: Optional[str] = None  # Dub job id, used to resolve detected source_lang
    quality: Optional[str] = "fast"  # "fast" (one-shot) | "cinematic" (reflect → adapt)
    glossary: Optional[List[dict]] = None  # [{"source": "...", "target": "...", "note": "..."}]
    # Optional regional dialect (BCP-47, e.g. "es-AR", "pt-BR") — #280 item 2.
    # Applied by LLM-backed paths (provider="openai" or quality="cinematic"):
    # the prompt asks for that region's vocabulary/grammar (e.g. Argentinian
    # voseo: "vos sos" instead of "tú eres"). Non-LLM providers (Argos, NLLB,
    # Google) can't honor it; the response then carries dialect_applied=false.
    dialect: Optional[str] = None

class DubIngestUrlRequest(BaseModel):
    url: str
    job_id: Optional[str] = None
    # When true and the URL is a caption-bearing host (YouTube, Vimeo, TED…),
    # ask yt-dlp to also download the original-language + any additional
    # sub_langs as VTT. The UI uses this to seed a transcript without running
    # Whisper, and optionally to skip the Translate step for languages that
    # YouTube auto-translates for us.
    fetch_subs: Optional[bool] = False
    sub_langs: Optional[List[str]] = None

class ProjectSaveRequest(BaseModel):
    name: str
    video_path: Optional[str] = None
    audio_path: Optional[str] = None
    duration: Optional[float] = None
    state: dict  # Full JSON blob: segments, settings, tracks, etc.
