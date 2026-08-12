#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:?AppDir root is required}"
EXPECTED_APPRUN="${2:?expected AppRun is required}"
EXPECTED_MARKER="${3:?expected WebKitGTK marker is required}"

fail() {
  echo "FAIL — $1" >&2
  exit 1
}

[ -x "$ROOT/AppRun" ] || fail "final AppImage launcher is missing or not executable"

if cmp -s "$ROOT/AppRun" "$EXPECTED_APPRUN"; then
  : # linuxdeploy did not install launcher hooks.
elif [ -x "$ROOT/AppRun.wrapped" ] \
  && cmp -s "$ROOT/AppRun.wrapped" "$EXPECTED_APPRUN" \
  && grep -Fq 'exec "$this_dir"/AppRun.wrapped "$@"' "$ROOT/AppRun"; then
  : # GTK/GStreamer hooks wrap the custom launcher by design.
else
  fail "custom AppRun missing from final AppImage launcher chain"
fi

[ -s "$ROOT/usr/lib/.bundled-webkitgtk-version" ] \
  || fail "bundled WebKitGTK version marker missing"
cmp -s "$ROOT/usr/lib/.bundled-webkitgtk-version" "$EXPECTED_MARKER" \
  || fail "bundled WebKitGTK version marker is stale or mismatched"

# ── Icon integrity ────────────────────────────────────────────────────────
# v0.4.2 shipped with .DirIcon as an ABSOLUTE symlink into the build machine:
#
#   .DirIcon -> /home/runner/work/OmniVoice-Studio/…/OmniVoice Studio.AppDir/…
#
# That path exists on nobody's computer, so the link dangled the moment the
# AppImage left CI, and every tool that reads .DirIcon — file managers for the
# file's own icon, AppImageLauncher and appimaged for desktop integration — got
# nothing and drew a blank. A dangling symlink is not a build error, the bundle
# packs and runs fine, so nothing noticed for an entire release.
#
# `readlink -f` resolves the whole chain; the result has to stay inside the
# AppDir, because anything outside it does not travel with the bundle.
resolved_inside() {
  local target
  target="$(readlink -f -- "$1" 2>/dev/null)" || return 1
  [ -f "$target" ] || return 1
  case "$target" in
    "$(readlink -f -- "$ROOT")"/*) return 0 ;;
    *) return 1 ;;
  esac
}

[ -e "$ROOT/.DirIcon" ] || fail ".DirIcon is missing — the AppImage will show no icon"
resolved_inside "$ROOT/.DirIcon" \
  || fail ".DirIcon does not resolve to a file inside the bundle (dangling or absolute symlink): $(readlink -- "$ROOT/.DirIcon" 2>/dev/null)"

# The desktop entry is what puts the app in the menu, and the icon it names has
# to be reachable — as a root-level file next to the entry, which is where
# desktop integration looks.
DESKTOP="$(find "$ROOT" -maxdepth 1 -name '*.desktop' | head -1)"
[ -n "$DESKTOP" ] || fail "no .desktop entry at the AppImage root"
resolved_inside "$DESKTOP" || fail ".desktop entry does not resolve inside the bundle"

ICON_NAME="$(sed -n 's/^Icon=//p' "$DESKTOP" | head -1)"
[ -n "$ICON_NAME" ] || fail "the .desktop entry names no Icon"
case "$ICON_NAME" in
  /*) fail "Icon= must be a theme name, not an absolute path: $ICON_NAME" ;;
esac
resolved_inside "$ROOT/$ICON_NAME.png" \
  || fail "the .desktop names Icon=$ICON_NAME but $ICON_NAME.png is not at the AppImage root"

# An empty Categories= is not the same as omitting it: desktop-file-validate
# rejects the entry outright, and menu builders that honour it skip the app.
if grep -q '^Categories=' "$DESKTOP"; then
  grep -q '^Categories=..*' "$DESKTOP" \
    || fail "Categories= is present but empty — set bundle.category in tauri.conf.json"
fi

echo "OK — AppImage uses the custom launcher, current WebKitGTK marker, and a resolvable icon"
