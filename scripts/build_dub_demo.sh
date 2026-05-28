#!/bin/bash
# Build the synthetic dubbing demo: one English source video + 4 dubbed
# variants. Each video is a 720p H.264 file with the showwaves audio
# visualizer over a dark gradient background — no copyrighted footage,
# no third-party voice IP.
#
# Output layout (under backend/assets/demo/dubbing/):
#   source.mp4         English audio + visualizer
#   dubbed_es.mp4      Spanish (Mónica)
#   dubbed_fr.mp4      French (Thomas)
#   dubbed_zh.mp4      Mandarin (Tingting)
#   dubbed_ja.mp4      Japanese (Kyoko)
#   *.srt              transcripts for each
#   manifest.json      single source of truth the frontend reads
#
# Bundle target: ~5 MB per mp4 × 5 files = ~25 MB. Well under the 45 MB
# cap from the dubbing-demo design spec.

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${REPO_ROOT}/backend/assets/demo/dubbing"
mkdir -p "$OUT_DIR"

# Compatibility: must run on macOS default bash 3.2 (no associative arrays,
# no ${var@Q}). We sidestep both by passing scripts as env vars to python3
# below. Just guard the basics.
if ! command -v ffmpeg >/dev/null || ! command -v say >/dev/null; then
  echo "ERROR: need both ffmpeg and macOS 'say'." >&2
  exit 1
fi
if ! command -v python3 >/dev/null; then
  echo "ERROR: python3 not found — needed to emit manifest.json." >&2
  exit 1
fi

# ── Scripts: source + 4 translations ─────────────────────────────────────
# Each is ~20-25 seconds when spoken — short enough to keep the demo snappy,
# long enough to show off pacing + accent. All translations preserve meaning;
# they were drafted manually so the script is reproducible.

EN_SCRIPT="OmniVoice Studio is a desktop app for voice cloning, video dubbing, and voice design. It runs entirely on your machine. No accounts, no cloud, no API keys. Just open the app and start creating."

ES_SCRIPT="OmniVoice Studio es una aplicación de escritorio para clonación de voz, doblaje de vídeo y diseño de voz. Funciona completamente en tu máquina. Sin cuentas, sin nube, sin claves de API. Solo abre la aplicación y comienza a crear."

FR_SCRIPT="OmniVoice Studio est une application de bureau pour le clonage de voix, le doublage vidéo et la conception vocale. Elle fonctionne entièrement sur votre machine. Pas de compte, pas de cloud, pas de clé d'API. Ouvrez l'application et commencez à créer."

ZH_SCRIPT="OmniVoice Studio 是一款桌面应用，用于语音克隆、视频配音和声音设计。它完全在你的电脑上运行。无需账户，无需云端，无需 API 密钥。打开应用即可开始创作。"

JA_SCRIPT="OmniVoice Studioは、ボイスクローン、ビデオ吹き替え、ボイスデザインのためのデスクトップアプリです。すべてお使いのコンピュータ上で動作します。アカウント、クラウド、APIキーは不要です。アプリを開けば、すぐに制作を始められます。"

# ── render_lang(code, voice, text) ──────────────────────────────────────
#   Produces: $OUT_DIR/{source|dubbed_$code}.mp4 + matching .srt
# Uses showwaves to render a styled audio visualizer over a dark backdrop.
# Resolution 1280x720 keeps each output around 4-6 MB at CRF 28.
render_lang() {
  local code="$1" voice="$2" text="$3"
  local stem
  if [ "$code" = "en" ]; then stem="source"; else stem="dubbed_${code}"; fi

  local aiff="${OUT_DIR}/${stem}.aiff"
  local wav="${OUT_DIR}/${stem}.wav"
  local mp4="${OUT_DIR}/${stem}.mp4"
  local srt="${OUT_DIR}/${stem}.srt"

  say -v "$voice" -o "$aiff" "$text"
  ffmpeg -y -loglevel error -i "$aiff" -ar 44100 -ac 1 "$wav"
  rm -f "$aiff"

  # Visual: showwaves p2p mode over a dark gradient with a colored line.
  # `nullsrc` + `geq` would let us make a static gradient backdrop, but
  # simpler is `color` with overlay'd waveform.
  ffmpeg -y -loglevel error \
    -i "$wav" \
    -filter_complex "[0:a]showwaves=s=1280x720:mode=p2p:rate=30:colors=0xf3a5b6[wave]; \
                     color=c=0x1d2021:s=1280x720:d=60[bg]; \
                     [bg][wave]overlay=format=auto,format=yuv420p,trim=duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$wav")[v]" \
    -map "[v]" -map 0:a \
    -c:v libx264 -crf 28 -preset medium \
    -c:a aac -b:a 96k -ac 1 \
    -shortest \
    "$mp4"

  rm -f "$wav"

  # Single-cue SRT — entire utterance as one block, "good enough" for the
  # demo player which shows it as a caption strip rather than karaoke.
  local dur
  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$mp4")
  local end_ts
  end_ts=$(awk -v d="$dur" 'BEGIN { h=int(d/3600); m=int((d%3600)/60); s=d-int(d/60)*60; printf "%02d:%02d:%06.3f", h, m, s }' | tr '.' ',')
  cat > "$srt" <<EOF
1
00:00:00,000 --> ${end_ts}
${text}
EOF

  local size
  size=$(du -h "$mp4" | awk '{print $1}')
  echo "  ✓ ${stem}.mp4 ($size, $voice)"
}

echo "── Source video (English) ────────────────────────────────"
render_lang en  Samantha "$EN_SCRIPT"

echo ""
echo "── Dubbed videos (4 languages) ───────────────────────────"
render_lang es  Mónica   "$ES_SCRIPT"
render_lang fr  Thomas   "$FR_SCRIPT"
render_lang zh  Tingting "$ZH_SCRIPT"
render_lang ja  Kyoko    "$JA_SCRIPT"

echo ""
echo "── Manifest ──────────────────────────────────────────────"
# bash 3.2 (default on macOS) lacks ${var@Q}; pass scripts as env vars to
# Python so escaping of unicode + quotes is handled correctly.
OUT_DIR="$OUT_DIR" \
EN_SCRIPT="$EN_SCRIPT" ES_SCRIPT="$ES_SCRIPT" FR_SCRIPT="$FR_SCRIPT" \
ZH_SCRIPT="$ZH_SCRIPT" JA_SCRIPT="$JA_SCRIPT" \
python3 - <<'PY'
import json, datetime, os
out = os.path.join(os.environ["OUT_DIR"], "manifest.json")
manifest = {
  "version": "0.3.0",
  "rendered_by": "macOS say + ffmpeg showwaves (bootstrap)",
  "rendered_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
  "license": "MIT (synthetic, no third-party IP)",
  "source": {
    "code": "en", "label": "English",
    "video": "source.mp4", "srt": "source.srt",
    "script": os.environ["EN_SCRIPT"],
  },
  "dubbed": [
    {"code":"es","label":"Español","video":"dubbed_es.mp4","srt":"dubbed_es.srt","dir":"ltr","script":os.environ["ES_SCRIPT"]},
    {"code":"fr","label":"Français","video":"dubbed_fr.mp4","srt":"dubbed_fr.srt","dir":"ltr","script":os.environ["FR_SCRIPT"]},
    {"code":"zh","label":"中文","video":"dubbed_zh.mp4","srt":"dubbed_zh.srt","dir":"ltr","script":os.environ["ZH_SCRIPT"]},
    {"code":"ja","label":"日本語","video":"dubbed_ja.mp4","srt":"dubbed_ja.srt","dir":"ltr","script":os.environ["JA_SCRIPT"]},
  ],
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
PY
echo "  ✓ manifest.json"

echo ""
du -sh "$OUT_DIR" | awk '{print "  Bundle: " $1}'
echo "Done."
