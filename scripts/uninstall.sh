#!/usr/bin/env bash
#
# OmniVoice Studio — clean uninstaller (macOS + Linux).
#
# Finds every folder OmniVoice wrote (app data, the managed Python env, config,
# logs) and — separately, because it's a SHARED cache — the Hugging Face model
# cache, prints each with its size, and removes them. Dry-run by default: it
# prints what it WOULD delete and stops, so you always see the plan first.
#
#   scripts/uninstall.sh            # dry-run: list targets + sizes, delete nothing
#   scripts/uninstall.sh --yes      # delete the OmniVoice data/env/config/logs
#   scripts/uninstall.sh --yes --models   # also delete the shared HF model cache
#
# Honors custom locations via the same env vars the app reads:
#   OMNIVOICE_DATA_DIR, OMNIVOICE_CACHE_DIR, HF_HOME, HF_HUB_CACHE
# Export the ones you set for OmniVoice before running, and it targets those.
#
# It NEVER deletes the app binary itself (that's a per-platform step — see
# docs/install/uninstall.md), and it never touches anything outside the paths
# it lists. Mirrors backend/core/config.py + frontend/src-tauri/src/setup.rs.
set -euo pipefail

APPLY=0
INCLUDE_MODELS=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) APPLY=1 ;;
    --models) INCLUDE_MODELS=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed '1d'
      exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

IDENTIFIER="com.debpalash.omnivoice-studio"
OS="$(uname -s)"

# ── Resolve platform default paths (mirrors the app) ────────────────────────
data_default=""
config_default=""
logs_extra=()
models_default=""
case "$OS" in
  Darwin)
    data_default="$HOME/Library/Application Support/OmniVoice"
    config_default="$HOME/Library/Application Support/$IDENTIFIER"
    logs_extra=("$HOME/Library/Logs/OmniVoice" "$HOME/Library/Logs/$IDENTIFIER")
    models_default="$HOME/.cache/huggingface"
    ;;
  Linux)
    data_default="$HOME/.omnivoice"
    config_default="${XDG_DATA_HOME:-$HOME/.local/share}/$IDENTIFIER"
    # The BACKEND writes its own logs outside the app-data dir — see
    # backend_log_path() in src-tauri/src/backend.rs. Missing this left a stray
    # log dir behind on every Linux uninstall.
    logs_extra=("${XDG_STATE_HOME:-$HOME/.local/state}/OmniVoice")
    models_default="$HOME/.cache/huggingface"
    ;;
  *)
    echo "This script supports macOS and Linux. On Windows use scripts/uninstall.ps1." >&2
    exit 1 ;;
esac

# ── Apply env overrides the app honors ──────────────────────────────────────
DATA_DIR="${OMNIVOICE_DATA_DIR:-$data_default}"
# Model cache precedence matches the app: OMNIVOICE_CACHE_DIR → HF_HOME → HF_HUB_CACHE → default.
MODELS_DIR="${OMNIVOICE_CACHE_DIR:-${HF_HOME:-${HF_HUB_CACHE:-$models_default}}}"

# ── Collect existing targets ────────────────────────────────────────────────
app_targets=()
[ -e "$DATA_DIR" ] && app_targets+=("$DATA_DIR")
[ -e "$config_default" ] && app_targets+=("$config_default")
for d in "${logs_extra[@]:-}"; do [ -n "$d" ] && [ -e "$d" ] && app_targets+=("$d"); done

human_size() { du -sh "$1" 2>/dev/null | cut -f1 || echo "?"; }

echo "OmniVoice Studio uninstaller ($OS)"
echo "----------------------------------"
if [ "${#app_targets[@]}" -eq 0 ]; then
  echo "No OmniVoice app data / env / config folders found at the default or"
  echo "env-configured locations. Nothing to remove."
else
  echo "App data, managed Python env, config, and logs:"
  for t in "${app_targets[@]}"; do printf "  %-6s %s\n" "$(human_size "$t")" "$t"; done
fi

models_present=0
if [ -e "$MODELS_DIR" ]; then
  models_present=1
  echo
  echo "Model cache (Hugging Face weights — SHARED with other HF tools):"
  printf "  %-6s %s\n" "$(human_size "$MODELS_DIR")" "$MODELS_DIR"
  echo "  ↳ pass --models to include this (it may hold models from OTHER apps too)."
fi

echo
if [ "$APPLY" -ne 1 ]; then
  echo "DRY RUN — nothing deleted. Re-run with --yes to remove the app folders"
  [ "$models_present" -eq 1 ] && echo "         (add --models to also remove the shared model cache)."
  echo "See docs/install/uninstall.md to also remove the app binary itself."
  exit 0
fi

# ── Delete ──────────────────────────────────────────────────────────────────
deleted=0
for t in "${app_targets[@]:-}"; do
  [ -z "$t" ] && continue
  echo "Removing $t"
  rm -rf -- "$t" && deleted=$((deleted + 1))
done
if [ "$INCLUDE_MODELS" -eq 1 ] && [ "$models_present" -eq 1 ]; then
  echo "Removing $MODELS_DIR"
  rm -rf -- "$MODELS_DIR" && deleted=$((deleted + 1))
elif [ "$models_present" -eq 1 ]; then
  echo "Kept model cache ($MODELS_DIR) — re-run with --models to remove it."
fi

echo
echo "Done — removed $deleted folder(s)."
echo "To remove the app itself, see docs/install/uninstall.md (drag to Trash /"
echo "Add-or-remove-programs / delete the .AppImage)."
