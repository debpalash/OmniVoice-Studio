#!/usr/bin/env bash
# Inject our custom AppRun into Tauri's auto-generated AppImage staging dir.
#
# Wired into tauri.conf.json's `build.beforeBundleCommand`, this script runs
# AFTER `cargo build` but BEFORE `appimagetool` packs the .AppDir. We overwrite
# the default AppRun (which Tauri generates without WEBKIT_DISABLE_COMPOSITING_MODE
# handling) with our conditional launcher.
#
# Issue: #56 (AppImage white-screen on Fedora 44 / Ubuntu 24.04)
# Decision: .planning/decisions/apprun-strategy.md
#
# Idempotent + safe on non-Linux: if no AppDir staging exists (e.g. macOS
# build, or `--bundles app` only), the script exits 0 cleanly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

APPRUN_SRC="$REPO_ROOT/frontend/src-tauri/appimage/AppRun"

if [ ! -f "$APPRUN_SRC" ]; then
  echo "inject-apprun: source not found: $APPRUN_SRC" >&2
  exit 1
fi

# Tauri's AppImage staging dir: frontend/src-tauri/target/{profile}/bundle/appimage/*.AppDir/
# The .AppDir name follows productName (e.g. "OmniVoice Studio.AppDir").
# Glob across both release and debug profiles in case the caller used --debug.
STAGE_BASE_RELEASE="$REPO_ROOT/frontend/src-tauri/target/release/bundle/appimage"
STAGE_BASE_DEBUG="$REPO_ROOT/frontend/src-tauri/target/debug/bundle/appimage"

found=0
for stage_base in "$STAGE_BASE_RELEASE" "$STAGE_BASE_DEBUG"; do
  if [ ! -d "$stage_base" ]; then
    continue
  fi
  # Use a glob loop instead of `find` to avoid surprises with names containing spaces.
  shopt -s nullglob
  for appdir in "$stage_base"/*.AppDir; do
    if [ -d "$appdir" ]; then
      echo "inject-apprun: replacing AppRun in $appdir"
      cp -f "$APPRUN_SRC" "$appdir/AppRun"
      chmod 755 "$appdir/AppRun"
      # Stamp the bundled WebKitGTK version (#961 follow-up). The AppImage
      # bundles THIS build host's libwebkit2gtk, so the host's pkg-config
      # answer here is the version the shipped bundle will actually run —
      # knowable by construction at bundle time, unknowable reliably at
      # runtime (a user's pkg-config reports their SYSTEM's version, which
      # LD_LIBRARY_PATH overrides with the bundled copy). AppRun's workaround
      # auto-detection reads this marker first and only falls back to host
      # pkg-config when the marker is absent (bundles predating the stamp).
      wk_bundled="$(pkg-config --modversion webkit2gtk-4.1 2>/dev/null \
                 || pkg-config --modversion webkit2gtk-4.0 2>/dev/null \
                 || echo "")"
      if [ -n "$wk_bundled" ]; then
        printf '%s\n' "$wk_bundled" > "$appdir/.bundled-webkitgtk-version"
        echo "inject-apprun: stamped bundled WebKitGTK version: $wk_bundled"
      else
        echo "inject-apprun: WARNING — could not read the bundled WebKitGTK version (pkg-config missing?); AppRun will use its runtime fallback" >&2
      fi
      found=1
    fi
  done
  shopt -u nullglob
done

if [ $found -eq 0 ]; then
  # Not necessarily an error — beforeBundleCommand runs unconditionally even
  # when the active target list does not include appimage. Stay quiet so
  # macOS/Windows builds do not see noisy stderr.
  echo "inject-apprun: no AppDir staging found (skipping — not an AppImage build)"
fi

exit 0
