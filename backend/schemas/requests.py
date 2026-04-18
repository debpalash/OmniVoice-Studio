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

class ProjectSaveRequest(BaseModel):
    name: str
    video_path: Optional[str] = None
    audio_path: Optional[str] = None
    duration: Optional[float] = None
    state: dict  # Full JSON blob: segments, settings, tracks, etc.
