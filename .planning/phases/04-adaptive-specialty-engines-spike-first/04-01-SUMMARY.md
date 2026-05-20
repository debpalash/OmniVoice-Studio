# Plan 04-01 Summary — SPIKE-01 (GGUF) GO + Wave 1 integration

**Phase:** 04 — Adaptive & Specialty Engines (spike-first)
**Plan:** 01 — SPIKE-01 (GGUF) GO + integration
**Status:** Wave 1 (Task 1 + Task 2) complete; Task 3 is the human-verification
  checkpoint that flips the ADR Status to Accepted after the CI matrix
  produces real binaries and a reviewer listens to the GGUF-06 smoke outputs.

## Spike outcome

**GO.** All six verification questions in the spike-first protocol checked
out:

| Question | Verdict |
|----------|---------|
| Model identity / lineage | Confirmed: quantization of `k2-fsa/OmniVoice` via HF `base_model` tags + `gguf.architecture = "omnivoice-lm"` |
| License | Apache-2.0 (model) + MIT (runtime) — clean for v0.3.x |
| Runtime | Custom `omnivoice.cpp` (does NOT load in vanilla llama.cpp — confirms RESEARCH.md anti-pattern call) |
| Quant variants | 4 quants × 2 files (Q4_K_M / Q8_0 / BF16 / F32; 659 MB → 3.19 GB total) |
| Cross-platform | Linux + Windows + macOS Intel YES; macOS Apple Silicon Metal CONDITIONAL (no published `buildmetal.sh` — handled via `cmake -DGGML_METAL=ON` direct invocation + `continue-on-error: true` on the CI slot) |
| Subprocess CLI fit | YES — argv + stdin + output-file matches Phase 2 SubprocessBackend pattern |

## Pinned SHAs

- `Serveurperso/OmniVoice-GGUF` HuggingFace revision: `361609388ae572a820d085185bbbe2a2aac4b30e`
  (lastModified `2026-04-30T13:39:10.000Z`, resolved 2026-05-20)
- `ServeurpersoCom/omnivoice.cpp` master HEAD: `886fc079838ca7400cb2b42b36e2a65aa1daabe8`
  (commit message: "cmake: scope /utf-8 to C and C++ so nvcc does not treat it as an input file",
  `2026-05-17T12:41:06Z`)

Both SHAs are mirrored in `backend/engines/omnivoice_gguf/quant_map.json` `_meta`
block and in `.planning/decisions/SPIKE-01-gguf.md` so the engine code and the ADR
cannot drift.

## macOS Apple Silicon Metal outcome

**Deferred to Task 3 / CI matrix.** The `build-omnivoice-tts` job in
`.github/workflows/ci.yml` has the `macos-14` (Apple Silicon) slot marked
`continue-on-error: true`. Result:

- If the CI Metal build succeeds → `bin/omnivoice-tts-darwin-arm64` ships,
  `OmniVoiceGGUFBackend` is the cloning default on Apple Silicon, ADR Status
  flips to "Accepted".
- If the CI Metal build fails → the binary is absent, `is_available()` returns
  `(False, "binary missing")`, `select_default_engine()` falls back to
  `"omnivoice"` (the in-process default) on macOS Apple Silicon, ADR Status
  flips to "Accepted with reduced scope: macOS Apple Silicon falls back to
  in-process OmniVoiceBackend per Pitfall 1".

The local build environment for this PR is macOS Apple Silicon but the actual
Metal build is left to the CI matrix per the plan's Task 2 step 7. The four
binary placeholders in `bin/` are committed as zero-byte files so `is_available()`
fails clean and the registry behaves identically to the documented fallback.

## 3-hardware-class smoke results

**Pending Task 3.** `scripts/smoke-gguf.sh --hardware-class {cpu,mid,high}` is
shipped and exercised in the unit tests (with stubbed subprocess) but the real
3-hardware-class human review happens at the Task 3 checkpoint, after the CI
matrix produces real binaries.

The CI matrix is wired to run on `ubuntu-latest`, `windows-latest`, `macos-13`
(Intel), and `macos-14` (Apple Silicon) — covering the three GGUF-06 hardware
classes plus the Apple Silicon Metal verification.

## Threshold adjustments

None. The `_bucket()` thresholds match RESEARCH.md exactly:
- ≥ 12 GB VRAM → high-vram → BF16
- ≥ 4 GB VRAM → mid-vram → Q8_0 (Pitfall 2: default Q8_0 once we have ≥ ~1 GB free)
- ≥ 1 GB VRAM → low-vram → Q4_K_M
- otherwise → cpu → Q4_K_M

One addition not in the RESEARCH.md skeleton: an `_extras` block in
`quant_map.json` carrying F32 as an override-only quant (auto-selector never
picks it but the Settings dropdown allow-list accepts it). This keeps the
allow-list defensible without forcing F32 into the auto-select table.

## Final ADR Status

`Proposed (research-supported)`. Task 3 (human checkpoint) flips this to either
`Accepted` or `Accepted with reduced scope: macOS Apple Silicon falls back to
in-process OmniVoiceBackend per Pitfall 1` depending on the CI matrix outcome
for `macos-14`.

## Files shipped

- `.planning/decisions/SPIKE-01-gguf.md` — ADR with pinned SHAs (`361609388…`
  for the GGUF repo, `886fc079…` for the runtime); "Status:" stays Proposed
  pending Task 3 checkpoint.
- `backend/engines/omnivoice_gguf/__init__.py` — lazy re-export of
  `OmniVoiceGGUFBackend`.
- `backend/engines/omnivoice_gguf/hardware_probe.py` — `detect_capabilities()`,
  `HardwareCapabilities`, `_bucket()` per GGUF-01.
- `backend/engines/omnivoice_gguf/quant_map.json` — GGUF-02 shippable table,
  4 auto-select compute classes + F32 as `_extras` override.
- `backend/engines/omnivoice_gguf/backend.py` — `OmniVoiceGGUFBackend` subclass
  of `TTSBackend` (subprocess host, NOT `SubprocessBackend` — the C++ binary's
  CLI doesn't speak the JSON-over-stdin protocol; see module docstring),
  `select_default_engine()` module function for GGUF-05.
- `backend/engines/omnivoice_gguf/README.md` — install + usage walk-through,
  license, pinned SHAs, macOS Gatekeeper workaround.
- `backend/services/gpu_sandbox.py` — `__getattr__` lazily re-exports
  `detect_capabilities` so backend-tier callers have a single import path.
- `backend/services/tts_backend.py` — `_LAZY_REGISTRY["omnivoice-gguf"]`
  entry; `_INSTALL_HINTS["omnivoice-gguf"]` tooltip.
- `backend/services/settings_store.py` — `get_quant_override()`,
  `set_quant_override()` with `quant_map.json` allow-list + `ValueError` on
  freeform path / unknown filename (T-04-05).
- `bin/omnivoice-tts-{darwin-arm64,darwin-x86_64,linux-x86_64,windows-x86_64.exe}`
  — zero-byte placeholders. The CI matrix produces real binaries; `is_available()`
  fails honestly on the placeholders so the in-process fallback engages.
- `bin/README.md` — explains the placeholder→real-binary lifecycle.
- `scripts/build-omnivoice-tts.sh` — cross-platform build script for the
  `omnivoice-tts` runtime from a pinned commit SHA; exits 2 on macOS Metal
  failure per Pitfall 1.
- `scripts/smoke-gguf.sh` — GGUF-06 hardware-class-parameterized smoke test.
- `tests/backend/engines/test_hardware_probe.py` — 8 tests covering GGUF-01
  + the single-entry-point re-export invariant.
- `tests/backend/engines/test_omnivoice_gguf.py` — 13 tests covering GGUF-02,
  GGUF-03, GGUF-04 (via settings_store), GGUF-05; SHA-256 manifest verification;
  freeform-path rejection; `shell=True` grep gate (tokenizer-based, robust
  against docstring mentions).
- `tests/backend/services/test_settings_store.py` — 6 new tests for the GGUF-04
  quant override round-trip + allow-list rejection.
- `.github/workflows/ci.yml` — new `build-omnivoice-tts` job matrix for GATE-03.

## Test results

- **New tests:** 36 passed (8 hardware-probe + 13 GGUF engine + 6 settings_store
  + 9 from existing settings_store coverage) — run via
  `uv run pytest tests/backend/engines/ tests/backend/services/test_settings_store.py`.
- **Smoke suite:** 4 passed (no regressions).
- **Full suite:** 428 passed, 10 skipped, 13 xfailed, 1 xpassed (well above the
  402+ baseline). One unrelated failure on `tests/test_supertonic3.py` —
  Phase 3 Plan 03-01 is running in parallel and that test file is currently
  untracked / not part of this PR's scope; ignored via `--ignore=` for the
  regression-check run.

## Deviations from the plan

1. **Backend is not a `SubprocessBackend` subclass.** The plan front-matter
   references the Phase 2 `SubprocessBackend` JSON-over-stdin protocol but the
   `omnivoice-tts` CLI doesn't speak that wire format — it's argv + stdin text
   + output WAV file. Subclassing `SubprocessBackend` would require either
   teaching the C++ binary the length-prefixed JSON protocol (out of scope)
   or doing protocol translation in the parent (defeats the isolation point).
   Instead, `OmniVoiceGGUFBackend` subclasses `TTSBackend` directly and uses
   `subprocess.run` per generate call with a 120-second hard timeout. The
   isolation property (the binary is the boundary; no shared Python interpreter,
   no shared CUDA context) is preserved. The class still appears with
   `isolation_mode: "subprocess"` in `list_backends()` via the
   `_is_subprocess_isolated` duck-typed marker — added in `__init__` rather
   than inherited.

2. **F32 quant in `_extras`, not in the auto-select table.** The plan and
   RESEARCH.md describe 4 compute-class rows. F32 is published by the model but
   would never be auto-selected (no quality gain over BF16, 2x disk). Adding it
   to the allow-list under an `_extras` block keeps the override UI honest
   without putting it into a row the probe could pick.

3. **No SQLite migration for `gguf_quant_override`.** The plan's Task 2 step 6
   mentions `ALTER TABLE settings ADD COLUMN gguf_quant_override TEXT` but the
   existing `settings` table is a key/value store (`key TEXT PRIMARY KEY, value
   TEXT NOT NULL, updated_at REAL NOT NULL`) — no schema change needed; the new
   row just appears under the `gguf_quant_override` key alongside `hf_token` and
   the license-acceptance rows. Saves one alembic migration file with no
   functional difference.

4. **Phase 3 parallel work file collision avoided.** I deliberately did not
   touch `pyproject.toml`, `uv.lock`, `backend/engines/__init__.py`, or
   `backend/engines/supertonic3/*` per the executor brief. The GGUF engine
   needs no new Python deps (huggingface_hub, soundfile, torch are already in
   the lock).

## Human-checkpoint next steps (Task 3)

Once the CI matrix's `build-omnivoice-tts` job produces real binaries:

1. Download the four artifacts and replace the zero-byte placeholders in
   `bin/`. `bin/checksums.sha256` will be regenerated by the build script.
2. Run `scripts/smoke-gguf.sh --hardware-class cpu` on a Linux box, `--mid` on
   8 GB VRAM hardware, `--high` on 16+ GB VRAM hardware.
3. Listen to `tmp/smoke-gguf-{cpu,mid,high}.wav` and confirm intelligibility.
4. Inspect `https://github.com/ServeurpersoCom/omnivoice.cpp/commit/886fc079838ca7400cb2b42b36e2a65aa1daabe8`
   for any concerning patterns.
5. Flip the ADR Status to Accepted (or Accepted-with-reduced-scope per the
   macOS Metal outcome) and append the "Verified on:" stamp.

The PR for this plan is opened with `Do NOT auto-merge` and the human checkpoint
acts as the merge gate.
