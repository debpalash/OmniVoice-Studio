# Tasks: Windows Runtime Integrity (plan-02)

**Branch**: `003-windows-runtime-integrity` | Closes #65 (Triton gate). Addresses #129/#116. **TDD.**

## Phase 1: torch.compile Triton gate (RED→GREEN)
- [x] T001 `tests/test_torch_compile_gate.py`: skip on non-CUDA, skip when Triton
  missing, compile when present+enabled, skip when disabled in Settings. RED.
- [x] T002 `engine_env.should_torch_compile(device)` — CUDA + find_spec("triton")
  + setting gate, INFO log on skip. GREEN (4/4).
- [x] T003 `model_manager.py` call site uses `should_torch_compile(device)`.

## Phase 2: ASR critical-path install smoke (#116 guard)
- [x] T004 `scripts/smoke-test.sh` INST-02: import torch + ctranslate2 + whisperx
  → fail build if missing (runs in the CI smoke-matrix on all 3 OSes).
- [x] T005 Confirm `setuptools>=75.0` still pinned (fix-sequence step 1, shipped).

## Phase 3: Verify
- [ ] T006 Full backend suite green before PR.

## Out of scope / follow-up
- [ ] In-app post-bootstrap integrity banner ("setup incomplete") — richer than
  the smoke gate; deferred.
