"""Pydantic v2 schemas for request/response validation.

Shared across routers — import from here rather than defining inline.
Using ``model_config = ConfigDict(...)`` for Pydantic v2 compat.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


# ── System ────────────────────────────────────────────────────────────────

class SysinfoResponse(BaseModel):
    """GET /sysinfo"""
    model_config = ConfigDict(extra="allow")

    cpu: float = Field(description="CPU usage percentage (0–100)")
    ram: float = Field(description="Used RAM in GiB")
    total_ram: float = Field(description="Total RAM in GiB")
    vram: float = Field(0.0, description="Used VRAM in GiB")
    gpu_active: bool = Field(False, description="Whether a GPU is actively used")


class SystemInfoResponse(BaseModel):
    """GET /system/info"""
    model_config = ConfigDict(extra="allow")

    data_dir: str
    outputs_dir: str
    crash_log_path: str
    idle_timeout_seconds: int
    model_checkpoint: str = "unknown"
    asr_model: str = "unknown"
    translate_provider: str = "unknown"
    has_hf_token: bool = False
    device: str = "cpu"
    python: str = ""
    platform: str = ""
    error: str | None = None


class ModelStatusResponse(BaseModel):
    """GET /model/status"""
    model_config = ConfigDict(extra="allow")

    status: str = Field(description="idle | loading | ready")
    checkpoint: str | None = None
    loaded_at: str | None = None
    sub_stage: str | None = Field(None, description="Current loading sub-stage: importing | loading_weights | loading_asr | compiling | ready | error")
    detail: str | None = Field(None, description="Human-readable detail of current loading phase")
    error: str | None = Field(None, description="Error message if loading failed")


class LogsResponse(BaseModel):
    """GET /system/logs"""
    lines: list[str] = Field(default_factory=list)
    path: str = ""
    exists: bool = False
    total_lines: int = 0
    error: str | None = None
    candidates: list[str] | None = None


class FlushMemoryResponse(BaseModel):
    """POST /system/flush-memory"""
    flushed: bool = True
    unloaded_model: bool = False
    ram_after: float = 0.0
    vram_after: float = 0.0


# ── Setup ─────────────────────────────────────────────────────────────────

class MissingModel(BaseModel):
    repo_id: str
    label: str


class SetupStatusResponse(BaseModel):
    """GET /setup/status"""
    models_ready: bool
    missing: list[MissingModel] = Field(default_factory=list)
    hf_cache_dir: str
    disk_free_gb: float
    min_free_gb: int = 10
    enough_disk: bool = True


class PreflightCheck(BaseModel):
    """One check in the preflight report."""
    model_config = ConfigDict(extra="allow")

    id: str
    label: str
    status: str = Field(description="pass | warn | fail")
    detail: str = ""
    fix: str | None = None


class DeviceInfo(BaseModel):
    """GPU/system device info from preflight."""
    model_config = ConfigDict(extra="allow")

    os: str
    arch: str
    gpu_vendor: str = "none"
    gpu_backend: str = "cpu"
    gpu_available: bool = False
    gpu_driver: str | None = None
    gpu_device_name: str | None = None
    ram_gb: float = 0.0
    disk_free_gb: float = 0.0


class PreflightResponse(BaseModel):
    """GET /setup/preflight"""
    ok: bool
    has_warnings: bool = False
    checks: list[PreflightCheck] = Field(default_factory=list)
    device: DeviceInfo


class InstallModelRequest(BaseModel):
    """POST /models/install"""
    repo_id: str


class DeleteModelResponse(BaseModel):
    """DELETE /models/{repo_id}"""
    deleted: bool = True
    repo_id: str
    freed_bytes: int = 0


# ── Models list ───────────────────────────────────────────────────────────

class ModelEntry(BaseModel):
    """One model in the GET /models response."""
    model_config = ConfigDict(extra="allow")

    repo_id: str
    label: str
    role: str
    size: str = ""
    required: bool = False
    installed: bool = False
    supported: bool = True
    size_on_disk: int | None = None
    nb_files: int | None = None
