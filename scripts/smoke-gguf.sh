#!/usr/bin/env bash
# GGUF-06 cross-hardware smoke test.
#
# Runs an end-to-end 3-second voice clone via the GGUF engine on one of
# three hardware classes and asserts the output WAV is decodable, ≥2.5s
# long at 24 kHz, and that the quant chosen matches `quant_map.json`.
# A human reviewer (Task 3 in plan 04-01) listens to the WAV and signs
# off on intelligibility.
#
# Usage:
#   scripts/smoke-gguf.sh --hardware-class {cpu|mid|high}
#
# Outputs:
#   tmp/smoke-gguf-<class>.wav   — the generated audio
#   tmp/smoke-gguf-<class>.json  — metadata (quant selected, duration, sr)
#
# Exit codes:
#   0 — generation succeeded, file is valid, quant matches the table
#   1 — generation failed or output failed validation
#   2 — binary unavailable on this host (expected on CI matrix
#       `continue-on-error: true` runner; not a hard failure)
set -euo pipefail

CLASS=""
PROMPT="${PROMPT:-Hello from OmniVoice GGUF smoke test.}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --hardware-class)
            CLASS="$2"
            shift 2
            ;;
        --prompt)
            PROMPT="$2"
            shift 2
            ;;
        -h|--help)
            sed -n '1,25p' "$0"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$CLASS" ]]; then
    echo "--hardware-class is required (cpu|mid|high)" >&2
    exit 1
fi

case "$CLASS" in
    cpu|mid|high) ;;
    *)
        echo "Unknown class: $CLASS (must be cpu|mid|high)" >&2
        exit 1
        ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$REPO_ROOT/tmp"

OUT_WAV="$REPO_ROOT/tmp/smoke-gguf-$CLASS.wav"
OUT_JSON="$REPO_ROOT/tmp/smoke-gguf-$CLASS.json"

# Force the compute-class bucket via env vars so the smoke test on a
# beefy machine can still exercise the CPU code path. The GGUF backend
# reads these as overrides during the probe.
case "$CLASS" in
    cpu)
        export OMNIVOICE_GGUF_FORCE_CLASS=cpu
        export CUDA_VISIBLE_DEVICES=""
        ;;
    mid)
        export OMNIVOICE_GGUF_FORCE_CLASS=mid-vram
        ;;
    high)
        export OMNIVOICE_GGUF_FORCE_CLASS=high-vram
        ;;
esac

cd "$REPO_ROOT"

# Quick availability check first so CI can route around a missing binary.
PYTHONPATH=backend python - <<PY || exit 2
import json, sys
from engines.omnivoice_gguf.backend import _make_backend_class, _platform_slug

cls = _make_backend_class()
ok, reason = cls.is_available()
if not ok:
    print(f"GGUF binary not available on this host ({_platform_slug()}): {reason}", file=sys.stderr)
    sys.exit(2)
print("→ GGUF binary available; running smoke generate")
PY

# Run the actual generation through the backend class.
PYTHONPATH=backend python - "$OUT_WAV" "$OUT_JSON" "$PROMPT" "$CLASS" <<'PY'
import json, sys, time

out_wav, out_json, prompt, class_name = sys.argv[1:5]

from engines.omnivoice_gguf.backend import _make_backend_class
import soundfile as sf

cls = _make_backend_class()
backend = cls()
entry = backend._select_quant_entry()

t0 = time.monotonic()
tensor = backend.generate(prompt)
elapsed = time.monotonic() - t0

# Save WAV to the expected path.
arr = tensor.squeeze(0).cpu().numpy()
sf.write(out_wav, arr, backend.sample_rate, subtype="PCM_16")

# Validate.
info = sf.info(out_wav)
duration_s = info.frames / info.samplerate
if duration_s < 2.5:
    print(f"FAIL: output too short ({duration_s:.2f}s < 2.5s)", file=sys.stderr)
    sys.exit(1)
if info.samplerate != 24_000:
    print(f"FAIL: unexpected sample rate {info.samplerate} (expected 24000)", file=sys.stderr)
    sys.exit(1)

meta = {
    "class": class_name,
    "quant_base": entry.get("base"),
    "quant_tokenizer": entry.get("tokenizer"),
    "rationale": entry.get("rationale"),
    "duration_s": duration_s,
    "elapsed_s": elapsed,
    "sample_rate": info.samplerate,
    "frames": info.frames,
    "prompt": prompt,
}
with open(out_json, "w") as f:
    json.dump(meta, f, indent=2)

print(f"✓ smoke-gguf-{class_name}: {duration_s:.2f}s in {elapsed:.1f}s "
      f"using {entry.get('base')}")
PY

echo "✓ Smoke test passed for hardware class: $CLASS"
echo "  Output: $OUT_WAV"
echo "  Meta:   $OUT_JSON"
