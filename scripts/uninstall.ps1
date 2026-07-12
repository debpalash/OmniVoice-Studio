<#
.SYNOPSIS
  OmniVoice Studio — clean uninstaller (Windows).

.DESCRIPTION
  Finds every folder OmniVoice wrote (app data, the managed Python env, config,
  logs) and — separately, because it's a SHARED cache — the Hugging Face model
  cache, prints each with its size, and removes them. Dry-run by default: it
  prints what it WOULD delete and stops, so you always see the plan first.

  It NEVER deletes the app binary itself (uninstall that via Settings > Apps),
  and never touches anything outside the paths it lists. Mirrors
  backend/core/config.py + frontend/src-tauri/src/setup.rs.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -Yes
  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -Yes -Models
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$Models
)

$ErrorActionPreference = 'Stop'
$identifier = 'com.debpalash.omnivoice-studio'

# ── Resolve platform default paths (mirrors the app) ────────────────────────
$appData   = [Environment]::GetEnvironmentVariable('APPDATA')
$localApp   = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')

$dataDefault   = Join-Path $appData 'OmniVoice'
$configDefault = Join-Path $localApp $identifier
# Windows model-cache default: OmniVoice redirects HF cache to a short path to
# dodge MAX_PATH, unless HF_HOME is set (see backend/core/config.py).
$modelsDefault = Join-Path (Join-Path $localApp 'OmniVoice') 'hf_cache'

# ── Apply the env overrides the app honors ──────────────────────────────────
$dataDir = if ($env:OMNIVOICE_DATA_DIR) { $env:OMNIVOICE_DATA_DIR } else { $dataDefault }
$modelsDir =
  if     ($env:OMNIVOICE_CACHE_DIR) { $env:OMNIVOICE_CACHE_DIR }
  elseif ($env:HF_HOME)             { $env:HF_HOME }
  elseif ($env:HF_HUB_CACHE)        { $env:HF_HUB_CACHE }
  else                              { $modelsDefault }

function Get-FolderSize($path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $bytes = (Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue |
      Measure-Object -Property Length -Sum).Sum
    if (-not $bytes) { return '0 B' }
    $units = 'B','KB','MB','GB','TB'; $i = 0
    while ($bytes -ge 1024 -and $i -lt 4) { $bytes /= 1024; $i++ }
    return ('{0:N1} {1}' -f $bytes, $units[$i])
  } catch { return '?' }
}

# The BACKEND writes its own logs here (backend_log_path() in
# src-tauri/src/backend.rs) — a sibling of hf_cache under %LOCALAPPDATA%\OmniVoice,
# so it is covered by neither the app-data nor the config dir.
$logsDefault = Join-Path (Join-Path $localApp 'OmniVoice') 'Logs'

$appTargets = @()
foreach ($p in @($dataDir, $configDefault, $logsDefault)) {
  if (Test-Path -LiteralPath $p) { $appTargets += $p }
}

Write-Host 'OmniVoice Studio uninstaller (Windows)'
Write-Host '--------------------------------------'
if ($appTargets.Count -eq 0) {
  Write-Host 'No OmniVoice app data / env / config folders found at the default or'
  Write-Host 'env-configured locations. Nothing to remove.'
} else {
  Write-Host 'App data, managed Python env, config, and logs:'
  foreach ($t in $appTargets) { '  {0,-9} {1}' -f (Get-FolderSize $t), $t | Write-Host }
}

$modelsPresent = Test-Path -LiteralPath $modelsDir
if ($modelsPresent) {
  Write-Host ''
  Write-Host 'Model cache (Hugging Face weights — SHARED with other HF tools):'
  '  {0,-9} {1}' -f (Get-FolderSize $modelsDir), $modelsDir | Write-Host
  Write-Host '  -> pass -Models to include this (it may hold models from OTHER apps too).'
}

Write-Host ''
if (-not $Yes) {
  Write-Host 'DRY RUN — nothing deleted. Re-run with -Yes to remove the app folders'
  if ($modelsPresent) { Write-Host '         (add -Models to also remove the shared model cache).' }
  Write-Host 'To remove the app itself: Settings > Apps > OmniVoice Studio > Uninstall.'
  exit 0
}

$deleted = 0
foreach ($t in $appTargets) {
  Write-Host "Removing $t"
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
  $deleted++
}
if ($Models -and $modelsPresent) {
  Write-Host "Removing $modelsDir"
  Remove-Item -LiteralPath $modelsDir -Recurse -Force -ErrorAction SilentlyContinue
  $deleted++
} elseif ($modelsPresent) {
  Write-Host "Kept model cache ($modelsDir) — re-run with -Models to remove it."
}

Write-Host ''
Write-Host "Done — removed $deleted folder(s)."
Write-Host 'To remove the app itself: Settings > Apps > OmniVoice Studio > Uninstall.'
