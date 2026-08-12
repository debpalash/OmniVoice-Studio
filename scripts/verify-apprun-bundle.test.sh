#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERIFY="$REPO_ROOT/scripts/verify-apprun-bundle.sh"
EXPECTED="$REPO_ROOT/frontend/src-tauri/appimage/AppRun"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

make_root() {
  local root="$1"
  mkdir -p "$root/usr/lib" "$root/usr/share/icons/hicolor/128x128/apps"
  printf '%s\n' '2.52.3' > "$root/usr/lib/.bundled-webkitgtk-version"
  # A healthy icon set: a real root-level PNG named after Icon=, a .DirIcon
  # that resolves to it, and a categorised desktop entry.
  printf 'PNG' > "$root/usr/share/icons/hicolor/128x128/apps/omnivoice-studio.png"
  cp "$root/usr/share/icons/hicolor/128x128/apps/omnivoice-studio.png" "$root/omnivoice-studio.png"
  ln -sf omnivoice-studio.png "$root/.DirIcon"
  cat > "$root/VoiceStudio.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=VoiceStudio
Exec=omnivoice-studio
Icon=omnivoice-studio
Categories=AudioVideo;Audio;
DESKTOP
}

printf '%s\n' '2.52.3' > "$TMP/expected-marker"

make_root "$TMP/direct"
install -m 755 "$EXPECTED" "$TMP/direct/AppRun"
bash "$VERIFY" "$TMP/direct" "$EXPECTED" "$TMP/expected-marker"

make_root "$TMP/wrapped"
install -m 755 "$EXPECTED" "$TMP/wrapped/AppRun.wrapped"
cat > "$TMP/wrapped/AppRun" <<'WRAPPER'
#!/usr/bin/env bash
this_dir="$(dirname "$(readlink -f "${0}")")"
exec "$this_dir"/AppRun.wrapped "$@"
WRAPPER
chmod 755 "$TMP/wrapped/AppRun"
bash "$VERIFY" "$TMP/wrapped" "$EXPECTED" "$TMP/expected-marker"

make_root "$TMP/broken"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$TMP/broken/AppRun"
chmod 755 "$TMP/broken/AppRun"
if bash "$VERIFY" "$TMP/broken" "$EXPECTED" "$TMP/expected-marker" >/dev/null 2>&1; then
  echo "FAIL: stock launcher was accepted without the custom launcher" >&2
  exit 1
fi

# ── Icon integrity ────────────────────────────────────────────────────────
# The exact shape that shipped in v0.4.2: .DirIcon pointing at the build
# machine's path, which dangles everywhere else.
make_root "$TMP/absicon"
install -m 755 "$EXPECTED" "$TMP/absicon/AppRun"
ln -sf "$TMP/absicon/omnivoice-studio.png" "$TMP/absicon/.DirIcon"
rm -f "$TMP/absicon/omnivoice-studio.png"
if bash "$VERIFY" "$TMP/absicon" "$EXPECTED" "$TMP/expected-marker" >/dev/null 2>&1; then
  echo "FAIL: a dangling .DirIcon was accepted" >&2
  exit 1
fi

make_root "$TMP/noicon"
install -m 755 "$EXPECTED" "$TMP/noicon/AppRun"
rm -f "$TMP/noicon/.DirIcon"
if bash "$VERIFY" "$TMP/noicon" "$EXPECTED" "$TMP/expected-marker" >/dev/null 2>&1; then
  echo "FAIL: a missing .DirIcon was accepted" >&2
  exit 1
fi

# Icon= naming a file that is not at the AppImage root: integration finds
# nothing to install and the menu entry draws blank.
make_root "$TMP/iconmismatch"
install -m 755 "$EXPECTED" "$TMP/iconmismatch/AppRun"
rm -f "$TMP/iconmismatch/omnivoice-studio.png"
printf 'PNG' > "$TMP/iconmismatch/SomethingElse.png"
ln -sf SomethingElse.png "$TMP/iconmismatch/.DirIcon"
if bash "$VERIFY" "$TMP/iconmismatch" "$EXPECTED" "$TMP/expected-marker" >/dev/null 2>&1; then
  echo "FAIL: Icon= with no matching root PNG was accepted" >&2
  exit 1
fi

# The empty Categories= tauri emits when bundle.category is unset.
make_root "$TMP/nocategory"
install -m 755 "$EXPECTED" "$TMP/nocategory/AppRun"
sed -i 's/^Categories=.*/Categories=/' "$TMP/nocategory/VoiceStudio.desktop"
if bash "$VERIFY" "$TMP/nocategory" "$EXPECTED" "$TMP/expected-marker" >/dev/null 2>&1; then
  echo "FAIL: an empty Categories= was accepted" >&2
  exit 1
fi

echo "PASS: launcher chains classified; dangling, missing, mismatched icons and empty Categories rejected"
