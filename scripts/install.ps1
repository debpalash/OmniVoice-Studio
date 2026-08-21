# VoiceStudio — universal installer for Windows.
#
# Installs VoiceStudio from source on Windows 10/11 (x64): system deps via
# winget, Python deps via uv, frontend via bun. Run once, then
# `bun run desktop-prod` each time you want to use the app.
#
# Usage:
#   irm https://voicestudio.sh/install | iex
#   # or locally:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#
# Overrides (set before running):
#   $env:OMNIVOICE_PYTHON = "3.12"   # Python version (default 3.11)
#   $env:OMNIVOICE_REGION = "china"  # route Python downloads through a mirror

$ErrorActionPreference = "Stop"

function Step($name, $value) {
    Write-Host ("  {0,-18}" -f $name) -NoNewline -ForegroundColor DarkGray
    Write-Host $value -ForegroundColor Green
}
function Note($msg) {
    Write-Host ("  {0,-18}" -f "") -NoNewline -ForegroundColor DarkGray
    Write-Host $msg -ForegroundColor DarkGray
}
function Warn($msg) { Write-Host "  ⚠  $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "  ✗  $msg" -ForegroundColor Red; exit 1 }

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host ""
Write-Host "🎙 VoiceStudio Installer" -ForegroundColor Magenta
Write-Host ("─" * 56) -ForegroundColor DarkGray
Write-Host ""

Step "platform" "windows ($env:PROCESSOR_ARCHITECTURE)"

# ── winget ───────────────────────────────────────────────────────────────────
# Only required when a system package is actually missing — machines that
# already have git/ffmpeg never need it.
function Install-WingetPackage([string]$id, [string]$label) {
    if (-not (Test-Command "winget")) {
        Die "winget not found and $label is missing. Install 'App Installer' from the Microsoft Store, or install $label manually (see docs/install/windows.md)."
    }
    Note "Installing $label via winget..."
    winget install --id $id -e --accept-source-agreements --accept-package-agreements --silent | Out-Null
    if ($LASTEXITCODE -ne 0) { Warn "winget install of $label failed — install it manually if setup stops." }
    # Refresh PATH so newly installed tools are visible in this session.
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

# ── Git ──────────────────────────────────────────────────────────────────────
Step "git" "checking..."
if (-not (Test-Command "git")) {
    Install-WingetPackage "Git.Git" "Git for Windows"
}
if (Test-Command "git") {
    Step "git" (git --version)
} else {
    Die "git is required. Install Git for Windows and re-run."
}

# ── FFmpeg ───────────────────────────────────────────────────────────────────
Step "ffmpeg" "checking..."
if (-not (Test-Command "ffmpeg")) {
    Install-WingetPackage "Gyan.FFmpeg" "ffmpeg"
}
if (Test-Command "ffmpeg") {
    Step "ffmpeg" ((ffmpeg -Version 2>$null | Select-Object -First 1))
} else {
    Warn "ffmpeg not found — some features will be unavailable. Open a new terminal after this install so PATH picks it up."
}

# ── uv ───────────────────────────────────────────────────────────────────────
Step "uv" "checking..."
if (-not (Test-Command "uv")) {
    Note "Installing uv package manager..."
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}
Step "uv" (uv --version)

# ── Bun ──────────────────────────────────────────────────────────────────────
Step "bun" "checking..."
if (-not (Test-Command "bun")) {
    Note "Installing bun..."
    Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
    $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
}
Step "bun" "bun $(bun --version)"

# ── GPU detection (informational) ────────────────────────────────────────────
Step "gpu" "detecting..."
$gpuInfo = "CPU only"
if (Test-Command "nvidia-smi") {
    $gpuName = (nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1)
    if ($gpuName) { $gpuInfo = "NVIDIA $gpuName (CUDA)" }
}
Step "gpu" $gpuInfo

# ── Resolve repo directory ───────────────────────────────────────────────────
# If run from inside a checkout, use it; otherwise clone into %USERPROFILE%\VoiceStudio.
$here = try { Split-Path -Parent $MyInvocation.MyCommand.Path } catch { $null }
$repoDir = $null
if ($here -and (Test-Path (Join-Path $here "..\pyproject.toml"))) {
    $repoDir = (Resolve-Path (Join-Path $here "..")).Path
}
if (-not $repoDir) {
    if (Test-Path ".\pyproject.toml") {
        $repoDir = (Get-Location).Path
    } else {
        $repoDir = Join-Path $env:USERPROFILE "VoiceStudio"
        if (Test-Path (Join-Path $repoDir ".git")) {
            Note "Updating existing clone at $repoDir"
            Push-Location $repoDir
            git pull --ff-only 2>$null
            Pop-Location
        } else {
            Step "clone" "downloading VoiceStudio..."
            git clone --depth 1 https://github.com/debpalash/VoiceStudio.git $repoDir
        }
    }
}
Set-Location $repoDir

# ── Python version ───────────────────────────────────────────────────────────
$pythonVersion = if ($env:OMNIVOICE_PYTHON) { $env:OMNIVOICE_PYTHON } else { "3.11" }

# Restricted-network support: mirrors python-build-standalone downloads through
# ghproxy.net when OMNIVOICE_REGION is set (see issues #57, #60).
switch ($env:OMNIVOICE_REGION) {
    { $_ -in "china", "russia", "restricted" } {
        if (-not $env:UV_PYTHON_INSTALL_MIRROR) {
            $env:UV_PYTHON_INSTALL_MIRROR = "https://ghproxy.net/https://github.com/astral-sh/python-build-standalone/releases/download"
        }
        Note "Using ghproxy.net mirror for Python download (OMNIVOICE_REGION=$($env:OMNIVOICE_REGION))"
    }
}
if (-not $env:UV_HTTP_TIMEOUT) { $env:UV_HTTP_TIMEOUT = "120" }
if (-not $env:UV_HTTP_RETRIES) { $env:UV_HTTP_RETRIES = "5" }

# ── Python dependencies via uv ───────────────────────────────────────────────
Step "python" "syncing dependencies..."
Note "This can take 5–10 min the first time (torch + torchaudio + demucs...)"

if (-not (Test-Path ".venv")) {
    uv venv --python $pythonVersion
    if ($LASTEXITCODE -ne 0) {
        Warn "uv venv failed (likely Python download). Retrying with system Python..."
        uv venv --python $pythonVersion --python-preference only-system
        if ($LASTEXITCODE -ne 0) {
            Die "uv venv failed: install Python $pythonVersion system-wide, set OMNIVOICE_REGION=china|russia|restricted to route through a mirror, or check your network."
        }
    }
}

uv sync
if ($LASTEXITCODE -ne 0) { Die "uv sync failed — see output above." }
Step "python" "OK — virtualenv at .venv\"

# ── Frontend deps + build ────────────────────────────────────────────────────
Push-Location frontend
Step "frontend" "installing dependencies..."
bun install
if ($LASTEXITCODE -ne 0) { Pop-Location; Die "bun install failed — see output above." }
Step "frontend" "building bundle..."
bun run build
if ($LASTEXITCODE -ne 0) { Pop-Location; Die "frontend build failed — see output above." }
Pop-Location
Step "frontend" "OK — output at frontend\dist\"

# ── Log directory ────────────────────────────────────────────────────────────
$logDir = Join-Path $env:LOCALAPPDATA "VoiceStudio"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "✓ Install complete!" -ForegroundColor Magenta
Write-Host ("─" * 56) -ForegroundColor DarkGray
Write-Host ""
Write-Host "  next             Run bun run desktop-prod to start VoiceStudio" -ForegroundColor Green
Write-Host ""
Note "First launch downloads ~5 GB of ML model weights (VoiceStudio TTS + Whisper)."
Note "After that, launches are instant."
Write-Host ""
Note "GPU: $gpuInfo"
Note "Logs: $logDir\omnivoice.log"
