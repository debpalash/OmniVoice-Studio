#!/usr/bin/env bash
# Build the `omnivoice-tts` binary from a pinned omnivoice.cpp commit SHA.
#
# Phase 4 Plan 04-01 (GGUF-03 / GATE-03). Runs in CI for every PR that
# touches `backend/engines/omnivoice_gguf/` and on every release. The
# bundled output goes to `bin/omnivoice-tts-<platform>` (with .exe on
# Windows) and a SHA-256 line is appended to `bin/checksums.sha256`.
#
# Usage:
#   scripts/build-omnivoice-tts.sh \
#       --platform {darwin-arm64|darwin-x86_64|windows-x86_64|linux-x86_64} \
#       --commit-sha <40hex>
#
# Required tools: git, cmake, ninja or make, a working C++17 compiler,
# `sha256sum` (Linux) or `shasum -a 256` (macOS) or `CertUtil` (Windows).
#
# Hard exits:
#   * exit 2 — macOS Apple Silicon + cmake -DGGML_METAL=ON failed. The
#     caller (CI matrix) treats this as a documented Pitfall 1 fallback:
#     macOS Apple Silicon stays on the in-process OmniVoiceBackend.
set -euo pipefail

PLATFORM=""
COMMIT_SHA=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --commit-sha)
            COMMIT_SHA="$2"
            shift 2
            ;;
        -h|--help)
            sed -n '1,30p' "$0"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$PLATFORM" || -z "$COMMIT_SHA" ]]; then
    echo "Both --platform and --commit-sha are required." >&2
    exit 1
fi

if ! [[ "$COMMIT_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "--commit-sha must be a 40-char hex SHA (got: $COMMIT_SHA)" >&2
    exit 1
fi

case "$PLATFORM" in
    darwin-arm64|darwin-x86_64|windows-x86_64|linux-x86_64) ;;
    *)
        echo "Unknown --platform: $PLATFORM" >&2
        exit 1
        ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$REPO_ROOT/bin"
mkdir -p "$BIN_DIR"

WORK="$(mktemp -d -t omnivoice-cpp-build.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "→ Cloning omnivoice.cpp at $COMMIT_SHA into $WORK"
git clone --recurse-submodules https://github.com/ServeurpersoCom/omnivoice.cpp.git "$WORK/src"
git -C "$WORK/src" checkout "$COMMIT_SHA"
git -C "$WORK/src" submodule update --init --recursive

cd "$WORK/src"

OUT_NAME="omnivoice-tts-$PLATFORM"
case "$PLATFORM" in
    windows-x86_64) OUT_NAME="$OUT_NAME.exe" ;;
esac

case "$PLATFORM" in
    linux-x86_64)
        if [[ -x ./buildcpu.sh ]]; then
            ./buildcpu.sh
        else
            cmake -B build -DCMAKE_BUILD_TYPE=Release
            cmake --build build --config Release -j
        fi
        cp -v build/omnivoice-tts "$BIN_DIR/$OUT_NAME"
        ;;
    windows-x86_64)
        # CI runs this from MSYS / git-bash; CMake picks up the MSVC
        # toolchain via the GitHub Actions runner's default env.
        cmake -B build -DCMAKE_BUILD_TYPE=Release
        cmake --build build --config Release -j
        cp -v build/Release/omnivoice-tts.exe "$BIN_DIR/$OUT_NAME"
        ;;
    darwin-x86_64)
        # x86_64 Macs build the CPU variant; Metal on Intel is undocumented.
        cmake -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=x86_64
        cmake --build build --config Release -j
        cp -v build/omnivoice-tts "$BIN_DIR/$OUT_NAME"
        ;;
    darwin-arm64)
        # Apple Silicon — try Metal (no published buildmetal.sh; we
        # invoke the GGML flag directly per Pitfall 1 / A1).
        if cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON -DCMAKE_OSX_ARCHITECTURES=arm64; then
            if cmake --build build --config Release -j; then
                cp -v build/omnivoice-tts "$BIN_DIR/$OUT_NAME"
            else
                echo "→ Metal build failed during compilation; macOS Apple Silicon falls back to in-process OmniVoiceBackend per Pitfall 1." >&2
                exit 2
            fi
        else
            echo "→ Metal cmake configure failed; macOS Apple Silicon falls back to in-process OmniVoiceBackend per Pitfall 1." >&2
            exit 2
        fi
        ;;
esac

# Compute SHA-256 and append to bin/checksums.sha256.
cd "$BIN_DIR"
if command -v sha256sum >/dev/null 2>&1; then
    DIGEST="$(sha256sum "$OUT_NAME" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
    DIGEST="$(shasum -a 256 "$OUT_NAME" | awk '{print $1}')"
else
    echo "No sha256sum/shasum found; cannot compute checksum." >&2
    exit 1
fi

# Rewrite the manifest atomically so we don't accumulate stale entries
# for renamed platforms.
MANIFEST="$BIN_DIR/checksums.sha256"
TMP_MANIFEST="$(mktemp)"
if [[ -f "$MANIFEST" ]]; then
    grep -v "  $OUT_NAME$" "$MANIFEST" > "$TMP_MANIFEST" || true
fi
printf '%s  %s\n' "$DIGEST" "$OUT_NAME" >> "$TMP_MANIFEST"
sort -k2 -o "$MANIFEST" "$TMP_MANIFEST"
rm -f "$TMP_MANIFEST"

echo "✓ Built $OUT_NAME ($DIGEST)"
