from pydantic import BaseModel
from typing import List, Optional

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
    slot_fit: Optional[str] = "time_stretch"

class TranslateSegment(BaseModel):
    id: str
    text: str
    target_lang: Optional[str] = None

class TranslateRequest(BaseModel):
    segments: List[TranslateSegment]
    target_lang: str  # ISO 639-1 code like "es", "fr"
    provider: Optional[str] = None
    source_lang: Optional[str] = None  # ISO 639-1; overrides job detection
    job_id: Optional[str] = None  # Dub job id, used to resolve detected source_lang
    quality: Optional[str] = "fast"  # "fast" (one-shot) | "cinematic" (reflect → adapt)
    glossary: Optional[List[dict]] = None  # [{"source": "...", "target": "...", "note": "..."}]

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
