#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

OMNIVOICE_TAURI_TOOLS_DIR="$TMP/tools" \
OMNIVOICE_TARGET_ARCH=amd64 \
OMNIVOICE_WEBKIT_VERSION=2.48.7 \
  bash "$REPO_ROOT/scripts/inject-apprun.sh"

cmp -s \
  "$REPO_ROOT/frontend/src-tauri/appimage/AppRun" \
  "$TMP/tools/AppRun-x86_64"
[ -x "$TMP/tools/AppRun-x86_64" ]
[ "$(cat "$TMP/tools/bundled-webkitgtk-version")" = "2.48.7" ]

mkdir -p "$TMP/squashfs-root/usr/lib"
cp "$TMP/tools/bundled-webkitgtk-version" \
  "$TMP/squashfs-root/usr/lib/.bundled-webkitgtk-version"
cmp -s \
  "$TMP/squashfs-root/usr/lib/.bundled-webkitgtk-version" \
  "$TMP/tools/bundled-webkitgtk-version"
printf '%s\n' '2.48.6' > "$TMP/squashfs-root/usr/lib/.bundled-webkitgtk-version"
if cmp -s \
  "$TMP/squashfs-root/usr/lib/.bundled-webkitgtk-version" \
  "$TMP/tools/bundled-webkitgtk-version"; then
  echo "FAIL: stale packaged WebKitGTK marker was accepted" >&2
  exit 1
fi

echo "PASS: Tauri AppImage tool cache seeded"
