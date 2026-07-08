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

# Marker says broken → workaround applies, even though host pkg-config says healthy.
run_marker_case "marker 2.46 beats host 2.48"  "2.46.1" "2.48.0" "1"
# Marker says healthy → no workaround, even though host pkg-config says broken
# (the exact #961 inversion: from-source user with old system lib, new bundle).
run_marker_case "marker 2.48 beats host 2.44"  "2.48.0" "2.44.3" "unset"
# Empty marker → treated as unknown → fail-safe workaround.
run_marker_case "empty marker fails safe"      ""       "2.48.0" "1"

echo
echo "─── AppRun test summary: $PASS_COUNT pass / $FAIL_COUNT fail ───"
if [[ $FAIL_COUNT -ne 0 ]]; then
  exit 1
fi
exit 0
