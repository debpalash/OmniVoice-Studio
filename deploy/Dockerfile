# Base image for the Python/PyTorch runtime stage. The default builds the
# CUDA variant; CI also builds a ROCm/AMD variant (issue #1165) by overriding:
#   BASE_IMAGE=rocm/pytorch:rocm7.2.4_ubuntu24.04_py3.12_pytorch_release_2.8.0
#   GPU_FLAVOR=rocm
# Both bases ship torch/torchaudio 2.8.0 preinstalled; the dependency install
# below deliberately preserves them (see the GPU_FLAVOR guard).
ARG BASE_IMAGE=pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime

# ==========================================
# Builder Stage: Compile React Frontend
# ==========================================
FROM oven/bun:1-alpine AS frontend-builder
WORKDIR /app

# Monorepo — bun workspace with lockfile at repo root. Copy manifests first
# so `bun install` caches independently of source edits.
COPY package.json bun.lock ./
COPY frontend/package.json ./frontend/

RUN bun install --frozen-lockfile

# Build static files (output lands in /app/frontend/dist)
COPY frontend/ ./frontend/
RUN bun run --cwd frontend build

# ==========================================
# Runtime Stage: Python & PyTorch Backend
# ==========================================
FROM ${BASE_IMAGE} AS runtime
WORKDIR /app

# Enable unbuffered logs and optimizations
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV UV_SYSTEM_PYTHON=1
ENV HF_HOME=/app/omnivoice_data/huggingface
# Allow bare imports (from core.config, from services.*, etc.) when
# uvicorn is started as `backend.main:app` from WORKDIR /app.
ENV PYTHONPATH=/app/backend
# Headless server deployment: relax the desktop-only loopback origin gate.
# Docker's network NAT rewrites the client host to the bridge gateway, so the
# gate would otherwise 403 the operator out of /system/* and /api/settings/*
# ("Loopback origin required", issue #261). Exposure is governed by the
# operator's `-p` port mapping plus the optional share PIN. Desktop builds
# never set this, so their loopback boundary is unchanged.
ENV OMNIVOICE_SERVER_MODE=1

# Install system dependencies (FFmpeg is critical for torchaudio/scene splitting)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ffmpeg \
    libsndfile1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# PEP 668: the ROCm base (Ubuntu 24.04) marks its system Python
# EXTERNALLY-MANAGED, which would refuse `pip install` / `uv pip install
# --system`. Inside a single-purpose container image installing into the
# base env is exactly what we want. No-ops on the conda-based CUDA image.
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV UV_BREAK_SYSTEM_PACKAGES=1

# Install `uv` for blazing-fast reliable pip resolution
# (`python3 -m pip` — not every base symlinks a bare `pip` onto PATH)
RUN python3 -m pip install --no-cache-dir uv

# Copy python packaging specs (README.md required by hatchling metadata)
COPY pyproject.toml uv.lock README.md ./

# Install the project (non-editable — no need for -e in containers).
# Uses `uv` for exponentially faster resolution than plain pip.
#
# NOTE: `uv pip install` (without --upgrade) keeps already-installed packages
# that satisfy the requirements, so the base image's GPU-built torch/torchaudio
# (2.8.0, satisfying our `torch>=2.4`) survive this step instead of being
# clobbered by PyPI's CUDA-default wheels. That property is what makes the
# ROCm variant possible at all — the guard below pins it down.
RUN uv pip install --system --no-cache .

# Guard (fails the build, not the user at runtime): assert the dependency
# install did NOT replace the base image's GPU torch. A future dep bump that
# forces a different torch version would otherwise silently ship a CUDA build
# in the ROCm image (= CPU-only for AMD users) — catch it here instead.
ARG GPU_FLAVOR=cuda
RUN python3 -c "import os, torch, torchaudio; \
    flavor = os.environ['GPU_FLAVOR']; \
    accel = torch.version.hip if flavor == 'rocm' else torch.version.cuda; \
    print(f'torch={torch.__version__} torchaudio={torchaudio.__version__} {flavor}={accel}'); \
    assert accel, f'base image {flavor} torch was clobbered (now {torch.__version__})'"

# Copy application source
COPY backend/ ./backend/
COPY omnivoice/ ./omnivoice/
# Alembic config so schema migrations run natively on existing volumes
# (without it the backend fell back to the additive-column self-heal —
# functional, but the real migration chain is the first-class path).
COPY alembic.ini ./

# Copy the pre-built React frontend from the builder stage
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Expose the single unified API and UI port
EXPOSE 3900

# Image-level health probe (compose files define their own; this covers plain
# `docker run`). Generous start period: first boot creates the venv-less
# schema + may pull model metadata before /health answers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3900/health || exit 1

# Mount points for persistent data (sqlite db, user voices, huggingface cache)
VOLUME ["/app/omnivoice_data"]

# Bind to 0.0.0.0 for external access
ENTRYPOINT ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "3900"]
