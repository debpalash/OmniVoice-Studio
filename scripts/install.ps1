# VoiceStudio — universal installer for Windows.
#
# Default mode installs the prebuilt .msi from GitHub Releases (checksum
# verified) via msiexec. Use -Source to build from source instead:
# system deps via winget, Python deps via uv, frontend via bun.
#
# Usage:
#   irm https://voicestudio.sh/install | iex          # prebuilt app (default)
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Source
#
# Overrides (set before running):
#   $env:VOICESTUDIO_VERSION = "0.5.2"  # release version in binary mode
#   $env:VOICESTUDIO_INSTALL_MODE = "source"  # same as -Source when piped
#   $env:OMNIVOICE_PYTHON = "3.12"      # Python version (source mode)
#   $env:OMNIVOICE_REGION = "china"     # route Python downloads through a mirror

param([switch]$Source)

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

$mode = if ($env:VOICESTUDIO_INSTALL_MODE) { $env:VOICESTUDIO_INSTALL_MODE } elseif ($Source) { "source" } else { "binary" }
if ($mode -ne "binary" -and $mode -ne "source") {
    Die "VOICESTUDIO_INSTALL_MODE must be 'binary' or 'source' (got '$mode')."
}

if ($mode -eq "binary") {
    Step "release" "resolving latest version..."
    try {
        $manifest = Invoke-RestMethod "https://github.com/debpalash/VoiceStudio/releases/latest/download/latest.json"
    } catch {
        Die "Could not fetch the latest release manifest: $($_.Exception.Message)"
    }
    $vsVersion = if ($env:VOICESTUDIO_VERSION) { $env:VOICESTUDIO_VERSION.TrimStart("v") } else { $manifest.version }
    $msiUrl = $manifest.platforms.'windows-x86_64-msi'.url
    if (-not $msiUrl) { Die "No Windows .msi found in release manifest." }
    Step "release" "v$vsVersion"

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("voicestudio-install-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    $msiPath = Join-Path $tmpDir ("VoiceStudio_$vsVersion.msi")
    $sumsName = "SHA256SUMS-Windows.x64.txt"
    $sumsPath = Join-Path $tmpDir $sumsName

    Step "download" (Split-Path $msiUrl -Leaf)
    Note "~165 MB; runs through your GitHub connection."
    Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath
    if (-not (Test-Path $msiPath)) { Die "Download failed." }
    Step "download" ("{0:N0} MB" -f ((Get-Item $msiPath).Length / 1MB))

    Step "checksum" "verifying..."
    $sumsUrl = "https://github.com/debpalash/VoiceStudio/releases/download/v$vsVersion/$sumsName"
    Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsPath
    $expected = (Select-String -Path $sumsPath -Pattern ([regex]::Escape((Split-Path $msiUrl -Leaf))) |
        Select-Object -First 1).Line.Split(" ")[0]
    if (-not $expected) { Warn "Checksum entry not found — skipping verification." }
    else {
        $actual = (Get-FileHash -Algorithm SHA256 $msiPath).Hash.ToLower()
        if ($actual -ne $expected.ToLower()) { Die "Checksum mismatch for the installer — download corrupted?" }
        Step "checksum" "OK"
    }

    Step "install" "launching the VoiceStudio setup wizard..."
    if ($env:CI) {
        Step "install" "running msiexec silently (CI)..."
        $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", "`"$msiPath`"", "/norestart", "/qn" -Wait -PassThru
        if ($proc.ExitCode -ne 0) { Die "msiexec failed with exit code $($proc.ExitCode)" }
    }
    else {
        Step "install" "launching the VoiceStudio setup wizard..."
        Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", "`"$msiPath`""
    }
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

    Write-Host ""
    Write-Host "✓ Installer launched!" -ForegroundColor Magenta
    Write-Host ("─" * 56) -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  next             Finish the setup wizard, then launch VoiceStudio" -ForegroundColor Green
    Write-Host ""
    Note "ffmpeg is required at runtime — if winget is available:"
    Note "  winget install --id Gyan.FFmpeg -e"
    Write-Host ""
    exit 0
}

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
