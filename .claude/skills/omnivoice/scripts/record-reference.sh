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

set -euo pipefail

OUT="${1:-$HOME/Downloads/omnivoice-ref.wav}"
DUR="${2:-12}"
MIC="${3:-1}"

RAW="$(mktemp -t omnivoice-raw-XXXXX).wav"
trap 'rm -f "$RAW"' EXIT

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "✗ ffmpeg not found — install via brew install ffmpeg" >&2
  exit 2
fi

if [ "$(uname)" != "Darwin" ]; then
  echo "✗ this helper is macOS-only (avfoundation). Use arecord + espeak on Linux." >&2
  exit 2
fi

echo "▶︎ Recording reference for OmniVoice voice cloning"
echo "   mic index: $MIC (run \`ffmpeg -f avfoundation -list_devices true -i \"\"\` to list)"
echo "   raw window: ${DUR}s · output: $OUT"
echo

# Spoken instructions + countdown (heard in real time, bypasses terminal buffering)
say -r 180 "Recording in three seconds. After the high beep, speak your reference phrase. Recording continues for ${DUR} seconds."
sleep 0.3
say -r 220 "three"; say -r 220 "two"; say -r 220 "one"

# Start cue
afplay /System/Library/Sounds/Ping.aiff &

# Capture
ffmpeg -hide_banner -loglevel error -y -f avfoundation -i ":$MIC" -t "$DUR" -ac 1 -ar 24000 "$RAW"

# End cue
afplay /System/Library/Sounds/Pop.aiff &

echo "✓ raw captured"

# Sanity-check levels
LEVELS=$(ffmpeg -hide_banner -i "$RAW" -af "volumedetect" -f null - 2>&1 | grep -E "mean_volume|max_volume")
echo "raw levels:"; echo "$LEVELS" | sed 's/^/  /'

# Trim leading silence + take first ~10 seconds of speech (or all of it if shorter)
TARGET=10
ffmpeg -hide_banner -loglevel error -y -i "$RAW" \
  -af "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-40dB,atrim=end=${TARGET}" \
  -ac 1 -ar 24000 "$OUT"

echo "✓ trimmed reference: $OUT"
ffmpeg -hide_banner -i "$OUT" -af "volumedetect" -f null - 2>&1 \
  | grep -E "Duration|mean_volume|max_volume" \
  | sed 's/^/  /'

# Auto-play back so the user can verify before POSTing
echo
echo "▶︎ playing reference for verification..."
afplay -v 3 "$OUT" 2>/dev/null
echo "✓ done"
echo
echo "Next: POST to /profiles to create a voice profile:"
echo "  curl -X POST http://127.0.0.1:3900/profiles \\"
echo "    -F \"name=my-voice\" \\"
echo "    -F \"ref_audio=@$OUT\" \\"
echo "    -F \"ref_text=<the exact text you spoke>\" \\"
echo "    -F \"language=English\""
