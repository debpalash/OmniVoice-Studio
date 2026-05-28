# [plan-02] Windows Runtime Integrity — complete venv + safe accel gating

## Defect
The packaged/bootstrapped Windows venv makes unsafe assumptions about its environment. Transitive runtime deps are missing (e.g. `setuptools`/`pkg_resources` that `ctranslate2`→`whisperx` import), and `torch.compile` is enabled where Triton has no Windows build — both fail only at *inference* time, surfacing as confusing errors (a fake "OOM", or a hard `ModuleNotFoundError` mid-transcription).

## Children
- #116 — `ModuleNotFoundError: No module named 'pkg_resources'` from `ctranslate2.__init__` via `whisperx` during chunk transcription (recurrence of the previously-closed #58)
- #65 — `torch.compile(mode="reduce-overhead")` requires Triton at runtime; Triton is unavailable on Windows → masked as TTS OOM. Suggested gate: `importlib.util.find_spec("triton")` before compile
- (note) the MSI "missing modules / Triton" half of #122 is the same family

## Fix sequence
1. Pin `setuptools` (provides `pkg_resources`) as an explicit runtime dep; verify it resolves in the bootstrapped venv.
2. Add a post-bootstrap venv integrity check that imports the critical chain (`ctranslate2`, `whisperx`, `torch`) and reports a clear actionable error if anything is missing.
3. Gate `torch.compile` on `find_spec("triton")`; fall back to eager mode with an INFO log on platforms without Triton.
4. Add an installer smoke test that imports the ASR/TTS critical path on Windows before the build is published.

## Test matrix
| OS | Accel | Required behavior |
|---|---|---|
| Windows + CUDA, no Triton | torch.compile path | skips compile, eager inference succeeds |
| Windows packaged venv | ASR transcribe | `pkg_resources`/`ctranslate2` import OK, segments produced |
| macOS MPS / Linux CUDA+Triton | both | unchanged |

## Out of scope
HF cache traversal (→ plan-01). The "no error in logs" transparency defect (→ plan-04).
