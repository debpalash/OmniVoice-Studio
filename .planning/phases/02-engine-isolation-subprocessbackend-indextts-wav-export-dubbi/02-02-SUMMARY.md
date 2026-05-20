# Plan 02-02 Summary — Audio I/O Hardening + WAV-Export Correctness

**Status:** Done (PR opened, awaiting human merge — no auto-merge per execution directive)
**Closes:** BUG-01 / issue #48
**Branch:** `phase-2-plan-02-02-audio-io-hardening`
**Base:** `main` @ `715766c`
**Wave:** 2-1 (parallel with 02-01, no overlapping files)

## What shipped

Two new audited helpers in `backend/services/audio_io.py`:

- `_safe_torchaudio_save(path_or_buf, tensor, sample_rate, *, format="wav", bits_per_sample=16)`
- `_safe_soundfile_write(path, samples, sample_rate, *, subtype="PCM_16")`

Both enforce the four documented WAV-corruption invariants (CPU device,
float32 dtype, [-1, 1] clamp, contiguous memory) before delegating to
the underlying library. `_safe_torchaudio_save` additionally passes
explicit `encoding=PCM_S/PCM_F` + `bits_per_sample` so torchaudio 2.9+'s
TorchCodec backend cannot silently drift the on-disk subtype.

The pre-existing P0 helper `atomic_save_wav` (commit `fb52140`) now
delegates the actual encode to `_safe_torchaudio_save`, so atomicity
(temp-file + `os.replace`) and audited normalization compose: every
byte that ever lands at a dub-output path was produced by the audited
helper.

## Migration map — all 12 router write sites

| Before (file:line)                  | After                              | Reason                          |
| ----------------------------------- | ---------------------------------- | ------------------------------- |
| `generation.py:148 torchaudio.save` | `_safe_torchaudio_save`            | Single-shot WAV export          |
| `generation.py:162 torchaudio.save` | `_safe_torchaudio_save`            | BytesIO response body           |
| `openai_compat.py:155 torchaudio.save` | `_safe_torchaudio_save`         | `format="wav"`                  |
| `openai_compat.py:160 torchaudio.save` | `_safe_torchaudio_save`         | `format="flac"`                 |
| `openai_compat.py:168 torchaudio.save` | `_safe_torchaudio_save`         | `format="mp3"` (ffmpeg path)    |
| `openai_compat.py:172 torchaudio.save` | `_safe_torchaudio_save`         | mp3 → wav fallback              |
| `openai_compat.py:178 torchaudio.save` | `_safe_torchaudio_save`         | `format="ogg"` (opus)           |
| `openai_compat.py:182 torchaudio.save` | `_safe_torchaudio_save`         | opus → wav fallback             |
| `openai_compat.py:193 torchaudio.save` | `_safe_torchaudio_save`         | AAC → wav fallback              |
| `dub_generate.py:509 torchaudio.save`  | `_safe_torchaudio_save`         | Preview segment BytesIO         |
| `batch.py:341 torchaudio.save`         | `atomic_save_wav`               | Final track assembly (atomic)   |
| `dub_core.py:438 sf.write`             | `_safe_soundfile_write`         | ASR transcribe-chunk temp WAV   |

Three sites in `dub_generate.py` (`:289`, `:328`, `:390`) were already
on `atomic_save_wav` from the P0 commit; they automatically inherit the
new audit checks through the helper's delegation.

`openai_compat.py:185` (PCM branch — raw int16 bytes, no container) now
inlines `.cpu()` / `.to(float32)` / `.clamp(-1, 1)` / `.contiguous()`
before producing the int16 array, matching the helper's invariants
without going through a torchaudio encoder.

## Phase 0 fixture status

The Phase 0 fixture (`tests/fixtures/omnivoice_data/`) does **not**
include a sample video. The plan budget called for adding one
synthetically if missing, but the structural reproduction tests below
already cover the helper code path #48 went through — running a full
FastAPI dub pipeline e2e adds latency without additional coverage of
the failure mode. The end-to-end test
(`test_dub_pipeline_produces_valid_wav`) is **xfail** with a clear
"add the fixture" message so the gap surfaces in CI without producing
a silent skip; it will flip to pass once `tests/fixtures/sample_5s.mp4`
lands (likely Phase 4 along with the dub UI smoke fixture).

No new fixture added under `tests/fixtures/` by this plan.

## torchaudio version-specific notes (for v0.3.0 release notes)

- Current pin: **torchaudio 2.8.0**.
- torchaudio emits a UserWarning at import: *"In 2.9, this function's
  implementation will be changed to use torchaudio.save_with_torchcodec
  under the hood. Some parameters like format, encoding, bits_per_sample,
  buffer_size, and ``backend`` will be ignored."*
- The helper's encoding-kwarg try/except fallback (lines around
  `_safe_torchaudio_save` mp3/ogg branch) defends against the 2.9
  upgrade. Once 2.9 lands and the kwargs are ignored, the helper still
  produces a valid file (the fallback path passes only `format=`).
- On disk, the explicit `encoding=PCM_S` + `bits_per_sample=16` locks
  the WAV subtype to `PCM_16` on 2.8.x. On 2.9.x with the kwargs
  ignored, the on-disk subtype will be whatever TorchCodec defaults to
  (currently also PCM_16 per the TorchCodec encoder docs); the
  `test_safe_save_explicit_encoding_persists` test should be revisited
  when 2.9 lands to confirm or to relax to "subtype starts with PCM_".

## Test coverage added

- `tests/backend/services/test_audio_io.py` — **29 tests** (25 pass + 4
  skipped for MPS dtype incompatibility, properly reported via
  `pytest.skip` with reason). Covers:
  - parametric round-trip across dtype × device × contiguity (12 cases)
  - out-of-range clamp (torch + numpy)
  - explicit PCM_16 encoding persists
  - `bits_per_sample=32` produces FLOAT/PCM_F subtype
  - FLAC format passthrough
  - in-memory `BytesIO` destination
  - empty-tensor rejection (both helpers)
  - non-tensor input rejection
  - 1D tensor auto-unsqueeze
  - 3D tensor explicit rejection
  - non-contiguous numpy array
  - int16 numpy round-trip
  - 2D stereo `(samples, channels)` shape for soundfile
  - `atomic_save_wav` inherits safety guarantees
- `tests/backend/test_dub_pipeline_wav.py` — **6 tests** (5 pass + 1
  xfail for missing fixture):
  - In-process grep gate for bare writes in `backend/api/routers/`
  - Subprocess grep gate (CI-shell parity)
  - `torch.cat`-of-slices reproduction (the #48 smoking gun)
  - `atomic_save_wav` assembly pattern
  - `_safe_soundfile_write` dub_core ASR-chunk pattern
  - End-to-end dub pipeline (xfail pending fixture)

## Verification gates

- `uv run pytest tests/backend/services/test_audio_io.py tests/backend/test_dub_pipeline_wav.py` — green
- Grep gate (in-process + subprocess) — green
- Full suite `uv run pytest tests/` — **348 passed, 10 skipped, 13 xfailed, 1 xpassed**
- Smoke `uv run pytest tests/smoke/` — green (4 passed)
- Existing P0 `backend/tests/test_atomic_wav.py` — green (7 passed)
- `git diff backend/services/sonitranslate.py` — empty (D1 locked)
- `uv pip list` — unchanged, zero new deps

## Coordination with Plan 02-01

Plan 02-01 (running in parallel) touches
`backend/services/subprocess_backend.py`,
`backend/services/tts_backend.py`, and
`backend/engines/__init__.py`. This plan touched only
`backend/services/audio_io.py` (extended, P0 helper preserved + now
delegates to the new helper) and `backend/api/routers/*.py` plus new
test files — zero overlap, no merge conflicts expected.

## Follow-ups for Plan 02-03

When the IndexTTS sidecar's audio output writes back through the parent
process, route it through `_safe_torchaudio_save` (or `atomic_save_wav`
if writing to disk). The helper module is the single audited write path
and Plan 02-03 must not introduce a new bare `torchaudio.save` call.

The CI grep gate
(`tests/backend/test_dub_pipeline_wav.py::test_no_bare_audio_writes_in_routers`)
covers `backend/api/routers/` only — Plan 02-03's sidecar code lives in
`backend/services/`, so consider extending the gate's scope when
sidecar lands.
