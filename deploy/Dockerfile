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
FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime AS runtime
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

# Install `uv` for blazing-fast reliable pip resolution
RUN pip install --no-cache-dir uv

# Copy python packaging specs (README.md required by hatchling metadata)
COPY pyproject.toml uv.lock README.md ./

# Install the project (non-editable — no need for -e in containers).
# Uses `uv` for exponentially faster resolution than plain pip.
RUN uv pip install --system --no-cache .  

# Copy application source
COPY backend/ ./backend/
COPY omnivoice/ ./omnivoice/

# Copy the pre-built React frontend from the builder stage
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Expose the single unified API and UI port
EXPOSE 3900

# Mount points for persistent data (sqlite db, user voices, huggingface cache)
VOLUME ["/app/omnivoice_data"]

# Bind to 0.0.0.0 for external access
ENTRYPOINT ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "3900"]
