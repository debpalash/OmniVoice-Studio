#!/usr/bin/env bash
# Record a clean reference clip for OmniVoice voice cloning.
#
# Usage:
#   scripts/record-reference.sh [output.wav] [duration_seconds] [mic_index]
#
# Defaults:
#   output     = ~/Downloads/omnivoice-ref.wav
#   duration   = 12 seconds raw capture (trimmed to 10 sec of speech)
#   mic_index  = 1 (typically MacBook built-in; run `ffmpeg -f avfoundation -list_devices true -i ""` to enumerate)
#
# Why this script exists:
#   - macOS Terminal buffers stdout — "speak now" prints arrive AFTER the recording finishes.
#     This script uses `say` (macOS TTS) + system sound beeps to give the user *audible* cues
#     that bypass terminal buffering.
#   - 24 kHz mono is what OmniVoice's diffusion model expects internally; recording natively at
#     that rate avoids a resample step.
#   - silenceremove + atrim crops the user's actual speech window out of a longer raw capture,
#     so the user doesn't have to time their start perfectly.
#
# Cross-platform note: macOS-only (relies on avfoundation, `say`, /System/Library/Sounds).
# Linux equivalent would use `arecord` + `espeak` + `aplay`; not implemented here.
#
# Exit codes:
#   0   success
#   2   environment problem (wrong OS, missing tool)
#   3   user-action problem (mic permission denied — captured silence)
#   4   verification failed (trimmed reference too short)

set -euo pipefail

# Platform guard FIRST — before mktemp / trap / anything else macOS-specific
if [ "$(uname)" != "Darwin" ]; then
  echo "✗ this helper is macOS-only (uses avfoundation, say, /System/Library/Sounds)." >&2
  echo "  Linux equivalent: arecord + espeak + aplay; not implemented." >&2
  exit 2
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "✗ ffmpeg not found — install via brew install ffmpeg" >&2
  exit 2
fi

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "✗ ffprobe not found — install via brew install ffmpeg" >&2
  exit 2
fi

OUT="${1:-$HOME/Downloads/omnivoice-ref.wav}"
DUR="${2:-12}"
MIC="${3:-1}"

RAW="$(mktemp -t omnivoice-raw-XXXXX).wav"
# Cover all common termination paths so the temp file never leaks
trap 'rm -f "$RAW"' EXIT INT TERM HUP

# Beep helper — uses system sound if available, otherwise terminal bell.
beep() {
  local snd="$1"
  if [ -f "$snd" ]; then
    afplay "$snd" &
  else
    printf '\a' >&2
  fi
}

PING="/System/Library/Sounds/Ping.aiff"
POP="/System/Library/Sounds/Pop.aiff"

echo "▶︎ Recording reference for OmniVoice voice cloning"
echo "   mic index: $MIC (run \`ffmpeg -f avfoundation -list_devices true -i \"\"\` to list)"
echo "   raw window: ${DUR}s · output: $OUT"
echo

# Spoken instructions + countdown (heard in real time, bypasses terminal buffering)
say -r 180 "Recording in three seconds. After the high beep, speak your reference phrase. Recording continues for ${DUR} seconds."
sleep 0.3
say -r 220 "three"; say -r 220 "two"; say -r 220 "one"

# Start cue
beep "$PING"

# Capture
ffmpeg -hide_banner -loglevel error -y -f avfoundation -i ":$MIC" -t "$DUR" -ac 1 -ar 24000 "$RAW"

# End cue
beep "$POP"

echo "✓ raw captured"

# Sanity-check levels — bail loudly if the recording is silent (mic permission denied is the
# most common cause: macOS gives the calling process a silent stream and ffmpeg returns 0).
LEVELS=$(ffmpeg -hide_banner -i "$RAW" -af "volumedetect" -f null - 2>&1)
echo "raw levels:"
echo "$LEVELS" | grep -E "mean_volume|max_volume" | sed 's/^/  /'

MEAN=$(echo "$LEVELS" | grep -oE "mean_volume:[[:space:]]*-?[0-9.]+" | grep -oE "\-?[0-9.]+$" | head -1)
if [ -z "$MEAN" ]; then
  echo "✗ could not parse audio levels — ffmpeg may have failed to record" >&2
  exit 3
fi
# Compare via awk (bash can't do floating-point natively)
if awk -v m="$MEAN" 'BEGIN { exit !(m < -50) }'; then
  echo "✗ recording is silent (mean ${MEAN} dB < -50 dB)." >&2
  echo "  Most likely: macOS denied microphone access to the calling process." >&2
  echo "  Fix: System Settings → Privacy & Security → Microphone → enable for your terminal" >&2
  echo "       (or for the agent harness). Then re-run this script." >&2
  exit 3
fi

# Trim leading silence + take first ~10 seconds of speech (or all of it if shorter)
TARGET=10
ffmpeg -hide_banner -loglevel error -y -i "$RAW" \
  -af "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-40dB,atrim=end=${TARGET}" \
  -ac 1 -ar 24000 "$OUT"

# Verify the trim produced a usable reference (≥ 2.0s of speech)
REF_DUR=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT" 2>/dev/null || echo "0")
if awk -v d="$REF_DUR" 'BEGIN { exit !(d < 2.0) }'; then
  echo "✗ trimmed reference is only ${REF_DUR}s (< 2s minimum)." >&2
  echo "  silenceremove found very little speech above -40 dB threshold." >&2
  echo "  Likely cause: you spoke too softly, or the mic captured mostly background noise." >&2
  echo "  Try again, speak closer to the mic." >&2
  exit 4
fi

echo "✓ trimmed reference: $OUT"
ffmpeg -hide_banner -i "$OUT" -af "volumedetect" -f null - 2>&1 \
  | grep -E "Duration|mean_volume|max_volume" \
  | sed 's/^/  /'

# Auto-play back so the user can verify before POSTing.
# Don't swallow stderr — if playback fails the user should know.
echo
echo "▶︎ playing reference for verification..."
if ! afplay -v 3 "$OUT"; then
  echo "⚠ verification playback failed — afplay exited non-zero. The file may still be valid;" >&2
  echo "  try \`afplay $OUT\` manually or open it in a player to confirm." >&2
fi
echo "✓ done"
echo
echo "Next: POST to /profiles to create a voice profile:"
echo "  curl -X POST http://127.0.0.1:3900/profiles \\"
echo "    -F \"name=my-voice\" \\"
echo "    -F \"ref_audio=@$OUT\" \\"
echo "    -F \"ref_text=<the exact text you spoke>\" \\"
echo "    -F \"language=English\""
