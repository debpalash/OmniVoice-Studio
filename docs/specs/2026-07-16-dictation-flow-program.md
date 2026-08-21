# Dictation Flow Program — local cross-platform flow dictation

*Spec, 2026-07-16. Research inputs: a multi-agent product-landscape study, in-repo capability map, and local ASR feasibility review. Sources are cited inline where load-bearing.*

## Why

Dictating prompts to AI agents is a rapidly growing text-input workload, while polished options remain cloud-first and Linux support is uneven. VoiceStudio already has the hard parts: a compact capture pill, global hotkey, sherpa-onnx streaming WS, **Whisper Tiny int8 as the shipped cross-platform default**, clipboard-restoring paste, and local-LLM refinement. A local, cross-platform, private flow-dictation experience is reachable and strategically differentiating — the wedge is **local + Linux/Wayland + agent-prompting**.

## Current state (verified in-repo)

Widget: pill webview + `tauri-plugin-global-shortcut` (`CmdOrCtrl+Shift+Space`, toggle/hold) on macOS, Windows and X11 + the GlobalShortcuts desktop portal on Wayland + browser-mode keyboard fallback; `getUserMedia` → 16 kHz raw-PCM WS `/ws/transcribe`; a native session captures the destination before the pill appears, restores an untouched clipboard by generation, reactivates macOS/Windows/X11 targets, and uses a truthful copy fallback on Wayland unless current-focus insertion is explicitly enabled. Backend: 7 sherpa models (Whisper Tiny default), streaming path (zipformer/paraformer) + chunked-offline path (0.8 s partial cadence, **RMS silence gate**), shared speech-evidence model demotion with installed-only ASR fallback, `text_polish` on finals, opt-in LLM refinement (Ollama/LM Studio, ≤4 s wall clock). Gaps: no real VAD, no dictionary/hotwords, no per-app formatting profiles, no command grammar, no language picker, picker understates model size ~4×.

## Program phases

Every phase: cross-platform default parity (CPU int8 everywhere; platform-specific *implementation* allowed), fully local, i18n for all strings, fail-before/pass-after tests, docs in the same PR.

### Phase 0 — honesty & cheap wins (hours)
- **Fix `size_gb` metadata** in `sherpa_dictation.py` (Parakeet listed 0.17–0.18 GB; real int8 ≈ 0.67 GB disk / ~1.2 GB RAM — onnxruntime arena, sherpa-onnx #2626). Show disk *and* expected RAM in the picker.
- **Threads 2→4** for 0.6B models (`OMNIVOICE_SHERPA_ASR_THREADS` stays the override); 2 threads = RTF ~0.33 on older x64 — thin margin.

### Phase 1 — the feel: real VAD + true-streaming Parakeet (the core ask)
- **silero-VAD v5 replaces the RMS gate** in `_run_sherpa_offline` (`capture_ws.py`): commit decode fires on the VAD speech-end event (~0.35 s min-silence) with ~0.2 s pre-roll, partials decoded only while VAD says speech → finals **~0.4–0.7 s after pause** (from ~1.4 s today), zero idle CPU burn, robust under fan noise/music. Silero is MIT and already inside sherpa-onnx — no new dependency. (ten-vad exists but its modified-Apache license needs review; not default.)
- **Add true-streaming Parakeet models** — no dependency change (repo pins `sherpa-onnx>=1.13.3`):
  - `nemotron-speech-streaming-en-0.6b` int8, 160 ms chunk (recommended English): per-word partials trailing speech ~200–400 ms, finals ~0.5–0.7 s, punctuation built in. Existing `_run_sherpa_streaming` handles it — this is a `_MODELS` entry + config.
  - `Nemotron-3.5-ASR-Streaming-0.6B` int8, 320 ms (opt-in multilingual, 40 locales).
  - License note: NVIDIA Open Model License / OpenMDW-1.1 (redistribution OK; document, unlike CC-BY Parakeet).
- **Pill partials UX**: dimmed live partial text (exists) polished to the Claude-Code/Aqua pattern — streaming preview in the pill, *final-only* insertion into the target app.
- RAM mitigations: honest labels (Phase 0), existing idle-unload (#1104), zipformer-20M low-RAM fallback stays first-class.

### Phase 2 — personal dictionary & technical vocabulary (highest leverage)
Parakeet's one real weakness is OOV technical terms — and the dictionary is Wispr's most-loved feature; no OSS app ships the full version.
- **Deterministic replacement engine** (post-STT, case-aware, engine-agnostic): user terms + corrections ("omni voice"→"VoiceStudio", "cube control"→"kubectl"). Settings → Dictation UI; stored in prefs; applies before polish/refinement.
- **Opt-in hotword biasing** for offline Parakeet: sherpa-onnx `modified_beam_search` + hotwords file (upstream PR #3077, ≥v1.12.24). Strictly opt-in — greedy stays default due to the known ~20% TDT beam-search hallucination bug (#3267); regression-test with silence + short clips; flip to default when upstream fixes. (Streaming Nemotron hotwords not yet upstream — #3572.)
- **Refinement fidelity**: extend the prompt with verbatim-span protection (code identifiers, paths, quoted error text untouched) and a "transcribe, don't improve" default — over-editing is Wispr's top accuracy complaint.
- Stretch (v2): auto-learn dictionary candidates from user corrections in the pill.

### Phase 3 — modes: app-aware formatting + agent-prompting
- **Frontmost-app detection** (Tauri per-OS implementation) → formatting profiles: **terminal/IDE** (no trailing period, no auto-capitalize, no smart quotes — today's always-on `text_polish` injecting a trailing period into a terminal is actively destructive), **chat** (casual, no trailing period), **prose** (current behavior). Default profile map + user per-app overrides. Browser/Docker mode: manual profile toggle in the pill (parity: feature works everywhere, detection is desktop-enhanced).
- **Agent-prompting mode**: glossary-biased recognition (Phase 2 machinery), terminal-safe insertion, optional auto-submit (Enter) with a word-count guard (Claude Code's pattern), and a "paste last transcript" hotkey.
- Language picker in the pill/panel for multi-model users (model-bound today).

### Phase 4 — insertion reliability + Wayland (beat everyone on Linux)
- **Reliability engineering** (the boring 20% that reads professional; Wispr does 5 retries): retry-with-backoff on paste, transcript stays on clipboard + toast on failure, password-field refusal, Windows elevated-window detection.
- **Wayland insertion chain** replacing bare enigo on Linux: wtype→dotool→ydotool→wl-copy+notify fallback, IBus/Fcitx5 input-method commit path evaluated for GNOME (highest quality, nobody mainstream ships it), libei/RemoteDesktop-portal as the forward bet. Reliable local Linux insertion is the moat.

### Phase 5 — command mode (headline, local-only differentiator)
Second hotkey → speak an instruction over selected text → local LLM rewrite → explicit Apply. Wispr charges for this; ours is local and free. Requires configured LLM; hidden otherwise (existing `llm_ready` plumbing).

### Phase 6 — docs, benchmarks, evals
- `docs/features/dictation.md` (none exists today) — modes, models, latency expectations, dictionary, per-OS insertion notes.
- Latency surfaced in-product (release→pasted ms in the pill's done state) — make speed a visible feature.
- Extend `tests/probe/dictation` evals: latency budget, VAD finalization, dictionary hit-rate, terminal-profile no-trailing-period.

## Model recommendation matrix

| Use case | Model | Partials | Final after pause | Disk/RAM |
|---|---|---|---|---|
| English, best feel | nemotron-streaming-en 160 ms (new, Ph. 1) | 200–400 ms | ~0.5–0.7 s | 0.66 GB / ~1.2 GB |
| European languages (opt-in) | parakeet-tdt-v3 + silero-VAD (upgraded path) | 0.8 s cadence | ~0.4–0.7 s | 0.67 GB / ~1.2 GB |
| Multilingual streaming (opt-in) | Nemotron-3.5 320 ms (new) | ~400 ms | ~0.7 s | 0.68 GB / ~1.2 GB |
| Low-RAM | zipformer-20M (existing) | ~100 ms | ~0.6 s | 0.13 GB / ~0.3 GB |
| Multilingual default / CJK | whisper-tiny (existing; consider small) | n/a | seconds | 0.104 GB |

## Top risks

1. **RAM (~1.2 GB in use) on 8 GB machines** — honest picker labels, idle-unload, zipformer fallback, test on 8 GB Windows.
2. **TDT beam-search bug (#3267)** gates hotwords — opt-in only until upstream fix.
3. **Old-CPU RTF margin** — thread bump + first-load auto-benchmark, fall back to zipformer if RTF > 0.8.
4. **Wayland fragmentation** — fallback chain with per-technique detection; wl-copy+notify as guaranteed floor.
5. **Scope creep** — phases are independently shippable; each lands behind the existing Settings surface; no phase blocks another.

## Explicit non-goals

Token-level coding-by-voice (Talon/Cursorless grammar) — months of learning curve, served ecosystem; our coding story is agent-prompting. Cloud ASR of any kind. Always-on open mic.
