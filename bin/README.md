# Bundled binaries

This directory holds platform-specific binaries that ship inside the
OmniVoice Studio installer. Today:

| File | Built from | Purpose |
|------|------------|---------|
| `omnivoice-tts-darwin-arm64` | `ServeurpersoCom/omnivoice.cpp` @ pinned SHA | GGUF inference runtime — Apple Silicon |
| `omnivoice-tts-darwin-x86_64` | same | Intel Mac |
| `omnivoice-tts-linux-x86_64` | same | Linux |
| `omnivoice-tts-windows-x86_64.exe` | same | Windows |
| `checksums.sha256` | computed by `scripts/build-omnivoice-tts.sh` | SHA-256 manifest — verified by `OmniVoiceGGUFBackend.is_available()` |

The pinned commit SHA for `omnivoice.cpp` lives in
`backend/engines/omnivoice_gguf/quant_map.json` `_meta.runtime_commit_sha`.

## Building locally

```
scripts/build-omnivoice-tts.sh --platform <slug> --commit-sha <40hex>
```

See `.github/workflows/ci.yml` `build-omnivoice-tts` job for the CI
matrix that produces these artifacts on every PR. The Apple Silicon
slot (`macos-14`) is marked `continue-on-error: true` because the
upstream `omnivoice.cpp` README does not publish a `buildmetal.sh`
(Pitfall 1 in `04-RESEARCH.md`); a failed Metal build is documented
and the macOS Apple Silicon cloning default falls back to the
in-process `OmniVoiceBackend`.

## Placeholder note

Until the CI matrix produces real binaries, this directory may contain
zero-byte placeholders. `OmniVoiceGGUFBackend.is_available()` returns
`(False, "...binary missing...")` in that case so the engine reports
honestly through the Engine Compatibility Matrix and the default
selection falls back to the in-process `OmniVoiceBackend`.
