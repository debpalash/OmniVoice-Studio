#!/usr/bin/env bash
# Shell unit test for the AppImage AppRun launcher.
# Verifies the _detect_webkit_workaround function's conditional behavior:
#   - WEBKIT_DISABLE_COMPOSITING_MODE=1 on known-broken WebKit ranges (2.44.x, 2.46.x)
#   - WEBKIT_DISABLE_COMPOSITING_MODE unset on healthy versions (2.48+)
#   - WEBKIT_DISABLE_COMPOSITING_MODE=1 when pkg-config is absent (fail-safe)
#
# Per W-1 checker requirement in 01-03-PLAN.md.

set -uo pipefail

THIS_DIR="$(cd "$(dirname "$0")" && pwd)"

PASS_COUNT=0
FAIL_COUNT=0

run_case() {
  local label="$1" pkg_output="$2" expected="$3" pkg_present="${4:-yes}"

  # Run each case in an isolated subshell.
  # - Stub `pkg-config` to print the version we want.
  # - Stub `exec` as a no-op so AppRun does not actually try to launch the binary.
  # - Sentinel: replace `command -v` so the "missing pkg-config" case can be
  #   simulated reliably (PATH manipulation alone is fragile in test envs).
  local actual
  actual=$(
    bash -c '
      set +e
      pkg_present="'"$pkg_present"'"
      pkg_output="'"$pkg_output"'"

      pkg-config() { echo "$pkg_output"; }
      export -f pkg-config

      command() {
        if [[ "$1" == "-v" && "$2" == "pkg-config" ]]; then
          if [[ "$pkg_present" == "yes" ]]; then
            echo "function"
            return 0
          else
            return 1
          fi
        fi
        builtin command "$@"
      }
      export -f command

      # Neutralise the exec at the end of AppRun so sourcing does not hand off
      # control to a missing binary.
      exec() { :; }
      export -f exec

      # Source the AppRun and call the detection function. AppRun begins with
      # `set -euo pipefail`; that is fine for the function itself.
      # shellcheck disable=SC1090
      source "'"$THIS_DIR"'/AppRun" >/dev/null 2>&1 || true
      echo "${WEBKIT_DISABLE_COMPOSITING_MODE:-unset}"
    '
  )

  if [[ "$actual" == "$expected" ]]; then
    echo "PASS [$label]"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL [$label]: expected '$expected' got '$actual'" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

run_case "2.44 (broken)"          "2.44.3" "1"
run_case "2.46 (broken)"          "2.46.1" "1"
run_case "2.48 (healthy)"         "2.48.0" "unset"
run_case "pkg-config absent"      "0.0"    "1"     "no"

# ── Bundled-version marker cases (#961 follow-up) ───────────────────────────
# inject-apprun.sh stamps the bundle's actual WebKitGTK version into
# .bundled-webkitgtk-version at build time; AppRun must prefer that marker
# over the host's pkg-config (which reports the SYSTEM version — wrong
# whenever it diverges from the bundled copy, e.g. on a machine with newer
# dev packages installed).

run_marker_case() {
  local label="$1" marker_content="$2" pkg_output="$3" expected="$4"
  local marker_file
  marker_file="$(mktemp)"
  printf '%s\n' "$marker_content" > "$marker_file"

  local actual
  actual=$(
    bash -c '
      set +e
      pkg_output="'"$pkg_output"'"
      export OMNIVOICE_APPRUN_WK_MARKER="'"$marker_file"'"

      pkg-config() { echo "$pkg_output"; }
      export -f pkg-config

      exec() { :; }
      export -f exec

      # shellcheck disable=SC1090
      source "'"$THIS_DIR"'/AppRun" >/dev/null 2>&1 || true
      echo "${WEBKIT_DISABLE_COMPOSITING_MODE:-unset}"
    '
  )
  rm -f "$marker_file"

  if [[ "$actual" == "$expected" ]]; then
    echo "PASS [$label]"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL [$label]: expected '$expected' got '$actual'" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# Marker says broken → workaround applies, even though host pkg-config reports
# a different number. The host here is OLDER, so the bundled lib is the one
# that runs and the marker is the only correct source.
#
# (This case used to pair marker 2.46 with host 2.48 and expect the workaround.
# Since #1258 a host that is NEWER takes over the run entirely, so the honest
# expectation for that pairing is "no workaround" — asserted directly in
# run_workaround_with_system below. The intent being pinned here, "trust the
# marker over the host for the library that actually runs", is unchanged.)
run_marker_case "marker 2.46 beats host 2.44"  "2.46.1" "2.44.3" "1"
# Marker says healthy → no workaround, even though host pkg-config says broken
# (the exact #961 inversion: from-source user with old system lib, new bundle).
run_marker_case "marker 2.48 beats host 2.44"  "2.48.0" "2.44.3" "unset"
# Empty marker → treated as unknown → fail-safe workaround.
run_marker_case "empty marker fails safe"      ""       "2.48.0" "1"

# ── System-vs-bundled WebKit priority (#1258, #1244) ────────────────────────
# The bundled WebKitGTK links against the HOST's Mesa (the AppImage ships no
# libEGL), so a host that has moved ahead of the build runner hits
# EGL_BAD_PARAMETER and a permanently blank window — with no env-var escape,
# because the failure precedes every rendering-path flag. When the host has a
# WebKitGTK at least as new as ours, its own copy must win: that is exactly
# what makes a source build work on the hardware where the AppImage does not.

run_ldpath_case() {
  local label="$1" marker_content="$2" system_version="$3" expected="$4"
  local marker_file wklibdir
  marker_file="$(mktemp)"
  printf '%s\n' "$marker_content" > "$marker_file"
  # A REAL file: AppRun's libdir probe uses `[ -e ]`, which is a shell builtin
  # and cannot be stubbed.
  wklibdir="$(mktemp -d)"
  touch "$wklibdir/libwebkit2gtk-4.1.so.0"

  local actual
  actual=$(
    bash -c '
      set +e
      export OMNIVOICE_APPRUN_WK_MARKER="'"$marker_file"'"
      sys="'"$system_version"'"
      wklibdir="'"$wklibdir"'"

      pkg-config() {
        [ -n "$sys" ] || return 1
        case "$1" in
          --variable=libdir) echo "$wklibdir" ;;
          *)                 echo "$sys" ;;
        esac
      }
      export -f pkg-config

      exec() { :; }
      export -f exec

      unset LD_LIBRARY_PATH
      # shellcheck disable=SC1090
      source "'"$THIS_DIR"'/AppRun" >/dev/null 2>&1 || true

      # The bug this pins: LD_LIBRARY_PATH is searched BEFORE the linker default
      # paths regardless of ordering within it, so merely appending the bundle
      # still let the bundled WebKit win on a normal (empty) launch. The host
      # libdir must be named explicitly, ahead of ours.
      case "$LD_LIBRARY_PATH" in
        "$wklibdir":*) echo "system-first" ;;
        *)             echo "bundle-first" ;;
      esac
    '
  )
  rm -rf "$marker_file" "$wklibdir"

  if [[ "$actual" == "$expected" ]]; then
    echo "PASS [$label]"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL [$label]: expected '$expected' got '$actual'" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# The #1258 machine: Arch/CachyOS ships WebKit 2.52.5, we bundle 2.44 —
# the host's copy is newer AND built against the Mesa actually installed.
run_ldpath_case "newer host WebKit wins"        "2.44.3"  "2.52.5" "system-first"
# Equal is still a win for the host: same version, but compiled against the
# Mesa that is actually present.
run_ldpath_case "equal host WebKit wins"        "2.48.0"  "2.48.0" "system-first"
# An OLDER host must not be preferred — that is the #961 regression.
run_ldpath_case "older host WebKit loses"       "2.48.0"  "2.44.3" "bundle-first"
# A host with no WebKitGTK at all is the case the bundle exists for.
run_ldpath_case "no host WebKit → bundle"       "2.48.0"  ""       "bundle-first"
# An unstamped bundle can't compare, so it must not gamble.
run_ldpath_case "unknown bundle → bundle"       "0.0"     "2.52.5" "bundle-first"

# Runtime-only hosts (an end user who never installed the -dev package) have the
# library but no .pc file, so the version is unknowable from here. Preferring an
# unverified copy could hand the user an OLDER WebKit than we ship (#961), so
# the default stays with the bundle and an explicit opt-in exists for the
# machines where the bundle simply cannot start (#1258 review).
run_optin_case() {
  local label="$1" optin="$2" marker_content="$3" system_version="$4" expected="$5"
  local marker_file wklibdir
  marker_file="$(mktemp)"
  printf '%s\n' "$marker_content" > "$marker_file"
  wklibdir="$(mktemp -d)"
  touch "$wklibdir/libwebkit2gtk-4.1.so.0"

  local actual
  actual=$(
    bash -c '
      set +e
      export OMNIVOICE_APPRUN_WK_MARKER="'"$marker_file"'"
      export OMNIVOICE_PREFER_SYSTEM_WEBKIT="'"$optin"'"
      sys="'"$system_version"'"
      wklibdir="'"$wklibdir"'"

      pkg-config() {
        [ -n "$sys" ] || return 1
        case "$1" in
          --variable=libdir) echo "$wklibdir" ;;
          *)                 echo "$sys" ;;
        esac
      }
      export -f pkg-config
      # A runtime-only host: no pkg-config metadata, but ldconfig knows the lib.
      ldconfig() { echo "  libwebkit2gtk-4.1.so.0 (libc6,x86-64) => $wklibdir/libwebkit2gtk-4.1.so.0"; }
      export -f ldconfig
      exec() { :; }
      export -f exec

      unset LD_LIBRARY_PATH
      # shellcheck disable=SC1090
      source "'"$THIS_DIR"'/AppRun" >/dev/null 2>&1 || true
      case "$LD_LIBRARY_PATH" in
        "$wklibdir":*) echo "system-first" ;;
        *)             echo "bundle-first" ;;
      esac'
  )
  rm -rf "$marker_file" "$wklibdir"

  if [[ "$actual" == "$expected" ]]; then
    echo "PASS [$label]"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL [$label]: expected '$expected' got '$actual'" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# No pkg-config metadata → version unknowable → keep the bundle by default.
run_optin_case "runtime-only host defaults to bundle" ""  "2.44.3" "" "bundle-first"
# ...and the opt-in gets that user running without building from source.
run_optin_case "opt-in overrides the unknown"         "1" "2.44.3" "" "system-first"
# The opt-out is honoured even when the host would otherwise win.
run_optin_case "opt-out keeps the bundle"             "0" "2.44.3" "2.52.5" "bundle-first"

# When the host's copy is chosen, the compositing workaround must be decided
# against THAT version, not the bundled one it was picked for.
run_workaround_with_system() {
  local label="$1" marker_content="$2" system_version="$3" expected="$4"
  local marker_file wklibdir
  marker_file="$(mktemp)"
  printf '%s\n' "$marker_content" > "$marker_file"
  # A REAL file: AppRun's libdir probe uses `[ -e ]`, which is a shell builtin
  # and cannot be stubbed.
  wklibdir="$(mktemp -d)"
  touch "$wklibdir/libwebkit2gtk-4.1.so.0"

  local actual
  actual=$(
    bash -c '
      set +e
      export OMNIVOICE_APPRUN_WK_MARKER="'"$marker_file"'"
      sys="'"$system_version"'"
      wklibdir="'"$wklibdir"'"
      pkg-config() {
        [ -n "$sys" ] || return 1
        case "$1" in
          --variable=libdir) echo "$wklibdir" ;;
          *)                 echo "$sys" ;;
        esac
      }
      export -f pkg-config
      exec() { :; }
      export -f exec
      # shellcheck disable=SC1090
      source "'"$THIS_DIR"'/AppRun" >/dev/null 2>&1 || true
      echo "${WEBKIT_DISABLE_COMPOSITING_MODE:-unset}"
    '
  )
  rm -f "$marker_file"

  if [[ "$actual" == "$expected" ]]; then
    echo "PASS [$label]"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL [$label]: expected '$expected' got '$actual'" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# Bundle 2.44 (broken → workaround armed), host 2.52 healthy and now in charge:
# the workaround must be dropped or we software-render a healthy WebKit.
run_workaround_with_system "healthy host drops the workaround" "2.44.3" "2.52.5" "unset"
# Bundle 2.44, host 2.46 — newer, so it wins, but it is ALSO in the broken
# range: the workaround must be re-armed for the version that actually runs.
run_workaround_with_system "broken host re-arms it"            "2.44.3" "2.46.1" "1"

# ── GStreamer: host core must win, and the registry must be private (#1333) ──
# The bundle ships libgstreamer-1.0 (WebKit links it) but no plugins (they are
# dlopen'd, so nothing static can see them to copy). A bundled core paired with
# host plugins fails its version check, finds no `appsink`, and getUserMedia()
# rejects with NotFoundError — the "No microphone found" the user saw, on a
# machine whose audio stack was verified healthy with pactl/wpctl/gst-launch.
# `discovery` selects which lookup path finds the host library:
#   pkgconfig — the -dev package is installed and answers
#   ldconfig  — runtime-only host (no .pc file), the #1258-review fallback
#   none      — no host GStreamer at all
run_gst_case() {
  local label="$1" optout="$2" discovery="$3" expected="$4"
  local gstlibdir cachedir actual
  gstlibdir="$(mktemp -d)"
  cachedir="$(mktemp -d)"
  [ "$discovery" = "none" ] || touch "$gstlibdir/libgstreamer-1.0.so.0"

  actual=$(
    bash -c '
      set +e
      export OMNIVOICE_PREFER_SYSTEM_GSTREAMER="'"$optout"'"
      export XDG_CACHE_HOME="'"$cachedir"'"
      gstlibdir="'"$gstlibdir"'"
      discovery="'"$discovery"'"

      pkg-config() {
        if [ "$1" = "--variable=libdir" ] && [ "$2" = "gstreamer-1.0" ] \
           && [ "$discovery" = "pkgconfig" ]; then
          echo "$gstlibdir"; return 0
        fi
        return 1
      }
      export -f pkg-config
      # No host WebKit either way; this case is only about the GStreamer branch.
      ldconfig() {
        [ "$discovery" = "ldconfig" ] || return 1
        echo "  libgstreamer-1.0.so.0 (libc6,x86-64) => $gstlibdir/libgstreamer-1.0.so.0"
      }
      export -f ldconfig
      exec() { :; }
      export -f exec

      unset LD_LIBRARY_PATH
      # shellcheck disable=SC1090
      source "'"$THIS_DIR"'/AppRun" >/dev/null 2>&1 || true
      case "$LD_LIBRARY_PATH" in
        "$gstlibdir":*) printf "gst-first" ;;
        *)              printf "no-gst" ;;
      esac
      case "${GST_REGISTRY_1_0:-}" in
        "'"$cachedir"'"/OmniVoice/*) printf "+private-registry" ;;
        *)                           printf "+shared-registry" ;;
      esac'
  )
  rm -rf "$gstlibdir" "$cachedir"

  if [[ "$actual" == "$expected" ]]; then
    echo "PASS [$label]"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL [$label]: expected '$expected' got '$actual'" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# The reported machine: a healthy host GStreamer exists, so it must resolve
# ahead of the bundled core.
run_gst_case "host GStreamer wins (pkg-config)" ""  "pkgconfig" "gst-first+private-registry"
# Runtime-only host: the library is installed but there is no .pc file, so only
# ldconfig can find it. Unlike WebKit there is no version to compare, so this
# path must still win rather than fall back (CodeRabbit: the fallback branch was
# untested because every case forced ldconfig to fail).
run_gst_case "host GStreamer wins (ldconfig)"  ""  "ldconfig"  "gst-first+private-registry"
# A host with no GStreamer at all: nothing to prefer, and the bundled core is
# all there is. Must not break, and must still get a private registry.
run_gst_case "no host GStreamer is harmless"   ""  "none"      "no-gst+private-registry"
# Escape hatch for a host whose own GStreamer is broken.
run_gst_case "opt-out keeps the bundled core"  "0" "pkgconfig" "no-gst+private-registry"

echo
echo "─── AppRun test summary: $PASS_COUNT pass / $FAIL_COUNT fail ───"
if [[ $FAIL_COUNT -ne 0 ]]; then
  exit 1
fi
exit 0
