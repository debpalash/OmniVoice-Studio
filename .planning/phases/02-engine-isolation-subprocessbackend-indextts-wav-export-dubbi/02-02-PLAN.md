---
phase: 02-engine-isolation-subprocessbackend-indextts-wav-export-dubbi
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - backend/services/audio_io.py
  - backend/api/routers/generation.py
  - backend/api/routers/openai_compat.py
  - backend/api/routers/dub_generate.py
  - backend/api/routers/dub_core.py
  - backend/api/routers/batch.py
  - tests/backend/services/test_audio_io.py
  - tests/backend/test_dub_pipeline_wav.py
autonomous: true
requirements:
  - BUG-01

must_haves:
  truths:
    - "Every WAV/audio file written by the OmniVoice backend passes soundfile.info() with a valid header, expected frames, and a recognized PCM_ or PCM_F subtype"
    - "Issue #48 (corrupt dub-pipeline WAV) is reproduced by a regression test on the Phase 0 fixture and that test fails on the current main without the fix"
    - "All 11 in-tree torchaudio.save / sf.write call sites delegate to _safe_torchaudio_save (or _safe_soundfile_write for the one sf.write site in dub_core.py:438) — zero bare calls remain in backend/api/routers/"
    - "Calling _safe_torchaudio_save with a CUDA/MPS tensor, non-contiguous tensor, out-of-range tensor, or non-float32 dtype produces a valid WAV (not silent corruption)"
    - "The helper enforces explicit encoding=PCM_S/PCM_F and bits_per_sample so torchaudio backend drift (TorchCodec delegation in 2.9+) cannot silently change the file format"
  artifacts:
    - path: "backend/services/audio_io.py"
      provides: "_safe_torchaudio_save + _safe_soundfile_write helpers — single audited audio-write path"
      min_lines: 60
      contains: "_safe_torchaudio_save"
    - path: "tests/backend/services/test_audio_io.py"
      provides: "Parametric round-trip tests across dtype × contiguity × out-of-range × format"
      min_lines: 80
      contains: "test_safe_save_round_trip"
    - path: "tests/backend/test_dub_pipeline_wav.py"
      provides: "End-to-end dub-pipeline regression test for #48; uses Phase 0 fixture; asserts sf.info() decodes the final WAV"
      min_lines: 40
  key_links:
    - from: "backend/api/routers/generation.py:148"
      to: "backend/services/audio_io.py::_safe_torchaudio_save"
      via: "replace bare torchaudio.save with _safe_torchaudio_save"
      pattern: "_safe_torchaudio_save"
    - from: "backend/api/routers/generation.py:162"
      to: "backend/services/audio_io.py::_safe_torchaudio_save"
      via: "buffered torchaudio.save → _safe_torchaudio_save with format=wav explicit"
      pattern: "_safe_torchaudio_save"
    - from: "backend/api/routers/openai_compat.py (all 7 sites)"
      to: "backend/services/audio_io.py::_safe_torchaudio_save"
      via: "format passthrough — _safe_torchaudio_save accepts wav/flac/mp3/ogg via the format kwarg"
      pattern: "_safe_torchaudio_save"
    - from: "backend/api/routers/dub_generate.py (4 sites)"
      to: "backend/services/audio_io.py::_safe_torchaudio_save"
      via: "all 4 dubbing write sites — including line 390 (track_path full_audio assemble) which is the most likely #48 root cause"
      pattern: "_safe_torchaudio_save"
    - from: "backend/api/routers/batch.py:341"
      to: "backend/services/audio_io.py::_safe_torchaudio_save"
      via: "batch.py shares the dub_generate.py:390 assembly pattern — same fix"
      pattern: "_safe_torchaudio_save"
    - from: "backend/api/routers/dub_core.py:438"
      to: "backend/services/audio_io.py::_safe_soundfile_write"
      via: "sf.write is a different library API than torchaudio.save; provide a sibling helper that applies the same sanity checks (dtype, contig, shape) before delegating to sf.write"
      pattern: "_safe_soundfile_write"
    - from: "tests/backend/test_dub_pipeline_wav.py"
      to: "soundfile.info"
      via: "assert frames > 0, samplerate > 0, subtype.startswith('PCM_'), max(samples)>0.1"
      pattern: "sf\\.info"

threat_model:
  trust_boundaries:
    - "torchaudio backend ↔ on-disk WAV (corruption mode = data tampering of OmniVoice output)"
  threats:
    - id: T-02-06
      category: Tampering
      component: backend/api/routers/dub_generate.py / openai_compat.py / batch.py / generation.py / dub_core.py
      disposition: mitigate
      mitigation: "Centralize WAV writes through _safe_torchaudio_save which enforces (a) tensor.cpu() — torchaudio cannot serialize CUDA/MPS, (b) tensor.contiguous() — non-contig is silent-corruption on some backends, (c) tensor.clamp(-1,1) — out-of-range is silent-corruption on TorchCodec 2.9+, (d) explicit encoding=PCM_S + bits_per_sample=16 — defends against torchaudio backend drift. Regression test parametrically asserts each failure mode produces a sf.info()-valid file."
    - id: T-02-07
      category: Information Disclosure
      component: backend/services/audio_io.py (path handling)
      disposition: accept
      mitigation: "Helper accepts path_or_buf as-is and does not log it (Phase 1 logging filter would not redact a file path anyway). File paths are not secrets; caller owns path validation."
---

<objective>
Close BUG-01 / issue #48 by centralizing all 11 in-tree audio-write call sites on a single audited helper that defends against the four documented `torchaudio.save` failure modes (CUDA/MPS tensor, non-contiguous, out-of-range, wrong dtype) AND the torchaudio 2.9+ TorchCodec-delegation behavior drift. Ship a regression test that decodes a dub-pipeline-produced WAV via `soundfile.info()` and asserts the header + samples are valid.

Purpose: Issue #48 is a "silent corruption" bug — dub jobs produce WAVs that decode as silence/noise/header errors without any traceback. The fix is structural, not a one-line patch: every code path that produces audio must converge on a helper that enforces the invariants. Otherwise the same bug surfaces a year later in a different write site. The helper is also the foundation Plan 02-03 relies on (IndexTTS sidecar's audio output ultimately writes through this same path).

Output: ~60 LOC `audio_io.py` helper + ~30 lines changed across 5 router files (replace 11 bare calls) + ~120 LOC of tests. Zero new Python dependencies. Independent of 02-01 — this plan touches only router files + a new service file; 02-01 touches `tts_backend.py` + new `subprocess_backend.py`. Both ship in Wave 1 in parallel.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/STATE.md
@.planning/phases/02-engine-isolation-subprocessbackend-indextts-wav-export-dubbi/02-RESEARCH.md

@CLAUDE.md
@backend/api/routers/generation.py
@backend/api/routers/openai_compat.py
@backend/api/routers/dub_generate.py
@backend/api/routers/dub_core.py
@backend/api/routers/batch.py

<interfaces>
<!-- Helper contract that this plan creates. Every audio write site in the backend consumes this. -->

```python
# backend/services/audio_io.py — public API
from __future__ import annotations
from pathlib import Path
from typing import BinaryIO, Union
import torch

PathOrBuf = Union[str, Path, BinaryIO]

def _safe_torchaudio_save(
    path_or_buf: PathOrBuf,
    tensor: torch.Tensor,
    sample_rate: int,
    *,
    format: str = "wav",
    bits_per_sample: int = 16,
) -> None:
    """Single audited audio-write path. Closes BUG-01 / issue #48.

    Guarantees:
      - tensor moved to CPU before write (torchaudio cannot serialize CUDA/MPS)
      - tensor coerced to torch.float32 (TorchCodec 2.9+ requires float32-in-[-1,1])
      - tensor clamped to [-1.0, 1.0] (out-of-range = silent corruption on some backends)
      - tensor reshaped to 2D (channels, samples); 1D inputs get unsqueezed
      - tensor made contiguous (non-contig = silent corruption on some backends)
      - explicit encoding + bits_per_sample so torchaudio backend selection
        (sox/soundfile/TorchCodec) cannot drift the on-disk format silently
      - format passthrough for wav/flac/mp3/ogg — caller controls container.
    """

def _safe_soundfile_write(
    path: PathOrBuf,
    samples: "numpy.ndarray",
    sample_rate: int,
    *,
    subtype: str = "PCM_16",
) -> None:
    """Sibling helper for the one in-tree sf.write call site (dub_core.py:438).
    Applies the same sanity checks (dtype/contiguity/shape/range) to the
    numpy array before delegating to soundfile.write. Same correctness
    guarantees as _safe_torchaudio_save."""
```
</interfaces>

<existing_state>
- 11 in-tree audio-write call sites identified by grep (locked decision D2 — researcher found 4 more beyond the original 7):
  1. `backend/api/routers/generation.py:148` — torchaudio.save (single-shot generation, file path)
  2. `backend/api/routers/generation.py:162` — torchaudio.save (single-shot generation, in-memory buffer, format=wav)
  3. `backend/api/routers/openai_compat.py:155` — torchaudio.save (format=wav)
  4. `backend/api/routers/openai_compat.py:160` — torchaudio.save (format=flac)
  5. `backend/api/routers/openai_compat.py:168` — torchaudio.save (format=mp3)
  6. `backend/api/routers/openai_compat.py:172` — torchaudio.save (format=wav)
  7. `backend/api/routers/openai_compat.py:178` — torchaudio.save (format=ogg)
  8. `backend/api/routers/openai_compat.py:182` — torchaudio.save (format=wav)
  9. `backend/api/routers/openai_compat.py:193` — torchaudio.save (format=wav)
  10. `backend/api/routers/dub_generate.py:289` — torchaudio.save (per-segment WAV write)
  11. `backend/api/routers/dub_generate.py:328` — torchaudio.save (per-segment WAV write, alt branch)
  12. `backend/api/routers/dub_generate.py:390` — torchaudio.save (final track assembly — MOST LIKELY #48 root cause: `full_audio` is built via torch.cat across CPU+GPU tensors with potential non-contiguity after slicing/concatenation)
  13. `backend/api/routers/dub_generate.py:508` — torchaudio.save (buffer, format=wav, preview)
  14. `backend/api/routers/batch.py:341` — torchaudio.save (batch track assembly — same shape as 390)
  15. `backend/api/routers/dub_core.py:438` — sf.write (numpy array — sibling helper needed; soundfile API ≠ torchaudio API)
- Count: 14 grep hits across 5 files. Two of those hits are duplicates of the same line (counted once each above gives 11 + 3 duplicates = the "11" in scope decision D2). Confirm exact count via the grep gate in verification.
- Phase 0 fixture: `omnivoice_data/` regression fixture must include a small video for the dub-pipeline regression test. If the existing fixture does NOT include a video, this plan adds a frozen 3-second 24 kHz reference WAV + a 2-segment SRT under `tests/fixtures/` (per RESEARCH.md Validation Architecture). Verify fixture presence in Task 1.
- `soundfile` is already a transitive dep (RESEARCH.md confirmed via dub_core.py:438 import); no install needed.
- No new Python dependency — `torch`, `torchaudio`, `soundfile`, `numpy` are all pinned.
- This plan does NOT touch `backend/services/sonitranslate.py` (locked decision D1 — SoniTranslate refactor deferred to v0.4).
</existing_state>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: _safe_torchaudio_save + _safe_soundfile_write helpers with parametric tests</name>
  <files>backend/services/audio_io.py, tests/backend/services/test_audio_io.py</files>
  <behavior>
    `tests/backend/services/test_audio_io.py`:
    - `test_safe_save_round_trip[dtype-device-contiguous]`: parametrize across `dtype ∈ {torch.float32, torch.float64, torch.int16}` × `device ∈ ["cpu"]` (add "mps"/"cuda" guarded by availability) × `contiguous ∈ {True, False}`. For each combination: build a 1-second 0.5-amplitude sinusoid → call `_safe_torchaudio_save(path, tensor, 24000)` → `sf.info(path)` returns frames=24000, samplerate=24000, subtype starts with "PCM_" → `sf.read(path)` returns samples with `abs(samples).max() > 0.1`.
    - `test_safe_save_out_of_range_clamped`: tensor with values in [-3, 3] → save → re-read → max abs is ≤ 1.0 (clamping happened).
    - `test_safe_save_non_contiguous_via_transpose`: build a contiguous (2, N) tensor → transpose → assert `not t.is_contiguous()` → save → sf.info OK + samples non-zero.
    - `test_safe_save_explicit_encoding_persists`: save with default kwargs → assert `sf.info(path).subtype == "PCM_16"` exactly (no implicit drift to PCM_24 or FLOAT).
    - `test_safe_save_format_passthrough`: save with `format="flac"` → assert `sf.info(path).format == "FLAC"`.
    - `test_safe_save_in_memory_buffer`: pass an `io.BytesIO()` instead of a path → save → seek(0) → sf.read consumes it → samples valid.
    - `test_safe_soundfile_write_round_trip`: numpy array of float32 → call `_safe_soundfile_write` → sf.info subtype=PCM_16, frames match input length.
    - `test_safe_soundfile_write_non_contiguous_array`: build an ndarray slice that's non-contiguous → `_safe_soundfile_write` produces a valid WAV (the helper calls `np.ascontiguousarray` first).
    - `test_safe_save_rejects_empty_tensor`: empty tensor → `ValueError` (do NOT silently write a zero-length WAV).
  </behavior>
  <action>
    Step 1 — Create `backend/services/audio_io.py`:
      - Module docstring: "Single audited audio-write path. All 11 in-tree audio-write call sites converge here. Closes BUG-01 / issue #48. Defends against the four documented torchaudio.save failure modes (CUDA tensor, non-contiguous, out-of-range, wrong dtype) AND the torchaudio 2.9+ TorchCodec-delegation behavior drift."
      - `_safe_torchaudio_save(path_or_buf, tensor, sample_rate, *, format="wav", bits_per_sample=16) -> None`:
        - Validate: `tensor.numel() > 0` else raise `ValueError("empty audio tensor")`.
        - If `tensor.is_cuda` or `tensor.device.type == "mps"` → `tensor = tensor.cpu()`.
        - If `tensor.dtype != torch.float32` → `tensor = tensor.to(torch.float32)`.
        - `tensor = tensor.clamp(-1.0, 1.0)`.
        - If `tensor.ndim == 1` → `tensor = tensor.unsqueeze(0)`.
        - If `not tensor.is_contiguous()` → `tensor = tensor.contiguous()`.
        - Determine encoding: `encoding = "PCM_F" if bits_per_sample == 32 else "PCM_S"`.
        - Call `torchaudio.save(path_or_buf, tensor, sample_rate, format=format, encoding=encoding, bits_per_sample=bits_per_sample)`.
        - For non-WAV formats (flac/mp3/ogg) where encoding may not apply, wrap the encoding kwarg in a try/except and retry without encoding if torchaudio raises — log at debug level. This preserves backward-compat with the existing openai_compat.py mp3/ogg sites which today don't pass encoding.
      - `_safe_soundfile_write(path, samples, sample_rate, *, subtype="PCM_16") -> None`:
        - Validate: `samples.size > 0` else raise `ValueError`.
        - `samples = np.ascontiguousarray(samples)` (handles non-contig slices).
        - If `samples.dtype != np.float32` and `samples.dtype != np.int16` → cast to float32.
        - If float dtype → clip to [-1.0, 1.0] via `np.clip(samples, -1.0, 1.0, out=samples)`.
        - Call `soundfile.write(path, samples, sample_rate, subtype=subtype)`.
      - Use `from __future__ import annotations` at the top so the `Union[BinaryIO]` type hint works without import-time cost.

    Step 2 — Write `tests/backend/services/test_audio_io.py` covering all 9 behaviors. Use `tmp_path` for file outputs. For the non-contiguous test, use `t.t().t()` or a `[..., ::2]` stride trick — verify `not t.is_contiguous()` before calling the helper (the test asserts the failure mode is reproduced before asserting the helper handles it).

    Step 3 — Confirm `pytest-timeout` cap (30 s) is in `pyproject.toml [tool.pytest.ini_options]` per Phase 0; the audio_io tests run in well under 5 s but the gate prevents future regressions hanging the suite.

    Cross-platform: every test runs on macOS Apple Silicon (where mps device guard is exercised IF available), macOS Intel, Linux, Windows. No platform skips.
  </action>
  <verify>
    <automated>uv run pytest tests/backend/services/test_audio_io.py -x -v --timeout=30</automated>
  </verify>
  <done>
    All 9+ parametrized tests in `test_audio_io.py` pass. `backend/services/audio_io.py` exists with both `_safe_torchaudio_save` and `_safe_soundfile_write` exported. The helper file is < 100 LOC (room for the docstring + the two functions). No new entries appear in `pyproject.toml [project.dependencies]`.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Migrate all 11 write sites + dub-pipeline #48 regression test</name>
  <files>backend/api/routers/generation.py, backend/api/routers/openai_compat.py, backend/api/routers/dub_generate.py, backend/api/routers/dub_core.py, backend/api/routers/batch.py, tests/backend/test_dub_pipeline_wav.py</files>
  <behavior>
    `tests/backend/test_dub_pipeline_wav.py`:
    - `test_dub_pipeline_produces_valid_wav`: Use the Phase 0 fixture (a small 5-second video under `tests/fixtures/` — if missing, the test scaffolds a synthetic one via torchaudio.save of a 5 s 0.3-amplitude sine to a temp wav and wraps it in an MP4 via ffmpeg). Run the dub pipeline end-to-end via the FastAPI route (TestClient.post `/dub/generate` with a minimal 2-segment SRT). Assert the response 200, locate the output WAV, then assert `sf.info(output_path).frames > 0`, `sf.info(output_path).samplerate in {24000, 44100, 48000}`, `sf.info(output_path).subtype.startswith("PCM_")`, and `abs(sf.read(output_path)[0]).max() > 0.01` (audio is not silent).
    - `test_no_bare_audio_writes_in_routers`: grep test — assert `grep -nE "(torchaudio\\.save|soundfile\\.write|sf\\.write)\\(" backend/api/routers/ --include=*.py | grep -v "_safe_torchaudio_save\\|_safe_soundfile_write" | grep -v '^\\s*#'` returns 0 lines. The grep gate filters out comments per the planner anti-pattern rule (bare `grep -c` counts comments). Use `grep -v '^[[:space:]]*#'` to strip comment lines from the count.
    - `test_track_assembly_handles_non_contig_after_torch_cat`: simulate the dub_generate.py:390 pattern by torch.cat-ing a list of GPU and CPU tensors of various shapes/dtypes → call _safe_torchaudio_save → assert sf.info() valid. This is the smoking-gun reproduction of #48: the bug is dub_generate.py:390's `torchaudio.save(track_path, full_audio, sr)` where `full_audio` is the result of `torch.cat(segments_list)` and segments may be non-contiguous after slicing in upstream segmenter code.
  </behavior>
  <action>
    Step 1 — Patch `backend/api/routers/generation.py`:
      - Add at top: `from backend.services.audio_io import _safe_torchaudio_save`.
      - Line 148: replace `torchaudio.save(audio_path, audio_tensor, _model.sampling_rate)` → `_safe_torchaudio_save(audio_path, audio_tensor, _model.sampling_rate)`.
      - Line 162: replace `torchaudio.save(buffer, audio_tensor, _model.sampling_rate, format="wav")` → `_safe_torchaudio_save(buffer, audio_tensor, _model.sampling_rate, format="wav")`.

    Step 2 — Patch `backend/api/routers/openai_compat.py`:
      - Add the import.
      - 7 sites at lines 155, 160, 168, 172, 178, 182, 193 — replace each `torchaudio.save(...)` with `_safe_torchaudio_save(...)`, preserving the `format=` kwarg verbatim from each call. The mp3/ogg sites at 168/178 may not accept `bits_per_sample` — rely on the helper's encoding try/except fallback to handle that case.

    Step 3 — Patch `backend/api/routers/dub_generate.py`:
      - Add the import.
      - 4 sites at lines 289, 328, 390, 508 — replace each. Line 390 is the suspected #48 root cause; verify the surrounding code shows `full_audio = torch.cat(...)` followed by the save — this is the pattern that produces non-contiguous tensors that silent-corrupt on the TorchCodec backend.

    Step 4 — Patch `backend/api/routers/batch.py`:
      - Add the import.
      - Line 341 — replace.

    Step 5 — Patch `backend/api/routers/dub_core.py`:
      - Add `from backend.services.audio_io import _safe_soundfile_write` at top.
      - Line 438 — replace `sf.write(tmp.name, arr, local_sr)` → `_safe_soundfile_write(tmp.name, arr, local_sr)`. (Different helper because sf.write is a different library API than torchaudio.save.)

    Step 6 — Run the grep gate locally to confirm zero bare write call sites remain:
      ```
      grep -nE "(torchaudio\\.save|soundfile\\.write|sf\\.write)\\(" backend/api/routers/ -r --include='*.py' \
        | grep -v "_safe_torchaudio_save\\|_safe_soundfile_write" \
        | grep -v '^[^:]*:[[:space:]]*#'
      ```
      Should return 0 matches.

    Step 7 — Write `tests/backend/test_dub_pipeline_wav.py`:
      - Use `from fastapi.testclient import TestClient` + the app factory from `backend/main.py`.
      - Phase 0 fixture probe: check if `tests/fixtures/sample_5s.mp4` exists. If not, the test xfails with a clear message: "Phase 0 fixture missing — add tests/fixtures/sample_5s.mp4 before running." (Do NOT skip silently — the test needs to surface the missing fixture as a CI failure so it gets fixed.)
      - For `test_track_assembly_handles_non_contig_after_torch_cat`: synthesize the failure mode directly without going through the dub pipeline. Build a list of segments: `[torch.linspace(-1,1,12000).unsqueeze(0), torch.linspace(0,0.5,8000).t().t().unsqueeze(0)]` etc. → torch.cat along dim=1 → assert the concatenated tensor is non-contiguous → _safe_torchaudio_save → sf.info OK.
      - For `test_no_bare_audio_writes_in_routers`: run the grep via `subprocess.run(["grep", "-rnE", ...])` and assert returncode == 1 (no match) or zero stdout lines after the filtering pipeline. Skip on Windows if grep is unavailable; the same gate also runs in the `<verify>` block of this task so CI catches drift regardless of platform.
  </action>
  <verify>
    <automated>uv run pytest tests/backend/test_dub_pipeline_wav.py -x -v --timeout=120 && bash -c 'COUNT=$(grep -rnE "(torchaudio\.save|soundfile\.write|sf\.write)\(" backend/api/routers/ --include="*.py" | grep -v "_safe_torchaudio_save\|_safe_soundfile_write" | grep -v "^[^:]*:[[:space:]]*#" | wc -l); if [ "$COUNT" -ne 0 ]; then echo "FAIL: $COUNT bare write site(s) remain"; exit 1; fi; echo "OK: zero bare audio writes in routers"'</automated>
  </verify>
  <done>
    All 3 tests in `test_dub_pipeline_wav.py` pass. The grep gate returns 0 bare write sites across `backend/api/routers/`. Running the dub pipeline end-to-end with the Phase 0 fixture produces a WAV that `soundfile.info()` decodes cleanly. Manually open the produced WAV in a player (smoke check, not gated) — should play audible audio, not silence/noise.
  </done>
</task>

</tasks>

<verification>
  After both tasks:
  - `uv run pytest tests/backend/services/test_audio_io.py tests/backend/test_dub_pipeline_wav.py -x --timeout=120` → all green
  - Grep gate green: `grep -rnE "(torchaudio\.save|soundfile\.write|sf\.write)\(" backend/api/routers/ --include="*.py" | grep -v "_safe_torchaudio_save\|_safe_soundfile_write" | grep -v "^[^:]*:[[:space:]]*#"` → 0 lines
  - All 5 router files import the new helper(s): `grep -l "_safe_torchaudio_save\|_safe_soundfile_write" backend/api/routers/*.py | wc -l` → 5
  - Manual smoke: dub a 5-s video, open the output WAV — audible, not silent, not corrupted-header
  - `git diff backend/services/sonitranslate.py` is empty (D1 locked decision)
  - `uv pip list` post-task matches pre-task — no new dependency installed
</verification>

<success_criteria>
1. BUG-01 closed: issue #48's "exported WAV is silent / has corrupt header" reproduction passes after the fix and fails before it (regression coverage).
2. Single audited write path: every audio file the OmniVoice backend produces flows through `_safe_torchaudio_save` or `_safe_soundfile_write`. CI grep gate prevents future drift.
3. Defense against torchaudio behavior drift: the helper's explicit `encoding=PCM_S` + `bits_per_sample=16` means torchaudio 2.9's TorchCodec delegation cannot silently change the on-disk format. Future torchaudio upgrades cannot reopen this bug class.
4. Parametric test coverage: all 4 documented failure modes (CUDA/MPS device, non-contiguous, out-of-range, wrong dtype) are exercised by the test suite — not "we fixed it, trust us" but "the test asserts we fixed each mode."
5. Zero new dependencies. SoniTranslate untouched.
</success_criteria>

<output>
Create `.planning/phases/02-engine-isolation-subprocessbackend-indextts-wav-export-dubbi/02-02-SUMMARY.md` when done. Include:
- The exact list of 11 write sites patched (file:line → file:line so 02-03 can confirm the IndexTTS sidecar's audio output path uses the helper too).
- Note whether the Phase 0 fixture supplied the 5-s video used by the dub regression test, or whether this plan added a synthetic fixture under `tests/fixtures/`.
- Any torchaudio version-specific quirks observed during the encoding/bits_per_sample try/except fallback (so the Phase 6 release notes can call them out).
</output>
</content>
</invoke>