#!/usr/bin/env bash
# Seed Tauri's AppImage tool cache with VoiceStudio's launcher.
#
# Tauri copies target/.tauri/AppRun-<arch> into the AppDir after
# beforeBundleCommand returns.  Replacing an AppDir/AppRun here cannot work:
# the AppDir does not exist until the bundler runs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APPRUN_SRC="$REPO_ROOT/frontend/src-tauri/appimage/AppRun"

# beforeBundleCommand also runs for macOS and Windows bundles.
case "${OSTYPE:-}" in
  linux*) ;;
  *) exit 0 ;;
esac

if [ ! -f "$APPRUN_SRC" ]; then
  echo "inject-apprun: source not found: $APPRUN_SRC" >&2
  exit 1
fi

TOOLS_DIR="${OMNIVOICE_TAURI_TOOLS_DIR:-$REPO_ROOT/frontend/src-tauri/target/.tauri}"
ARCH="${OMNIVOICE_TARGET_ARCH:-$(uname -m)}"
case "$ARCH" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  armv7l|armhf) ARCH=armhf ;;
  *)
    echo "inject-apprun: unsupported Linux architecture: $ARCH" >&2
    exit 1
    ;;
esac

mkdir -p "$TOOLS_DIR"
install -m 755 "$APPRUN_SRC" "$TOOLS_DIR/AppRun-$ARCH"

# Tauri's appimage.files copies this into usr/lib. AppRun reads the marker
# there to compare the bundled WebKitGTK with the host copy it may prefer.
WK_VERSION="${OMNIVOICE_WEBKIT_VERSION:-$(pkg-config --modversion webkit2gtk-4.1 2>/dev/null \
  || pkg-config --modversion webkit2gtk-4.0 2>/dev/null || true)}"
if [ -z "$WK_VERSION" ]; then
  echo "inject-apprun: bundled WebKitGTK version is unavailable" >&2
  exit 1
fi
printf '%s\n' "$WK_VERSION" > "$TOOLS_DIR/bundled-webkitgtk-version"

echo "inject-apprun: seeded AppRun-$ARCH (WebKitGTK $WK_VERSION)"
