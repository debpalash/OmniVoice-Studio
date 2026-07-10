# Adjacent open-source projects — research notes (2026-07-10)

Owner-requested research on five neighboring projects, read against OmniVoice
Studio's current feature-maturity map. Each section ends with what we should
take from it. Priorities are consolidated at the bottom.

| Project | Stars | License | Status | Why it matters to us |
|---|---|---|---|---|
| [Real-Time-Voice-Cloning](https://github.com/CorentinJ/Real-Time-Voice-Cloning) | ~60k | MIT | Retired (models frozen 2019, maintainer quit 2020) | Positioning/SEO opportunity, cautionary tales |
| [VoxCPM](https://github.com/OpenBMB/VoxCPM) | ~33k | Apache-2.0 | Very active (VoxCPM2, Apr 2026) | **Upstream of our `voxcpm2` engine** — sync items below |
| [ebook2audiobook](https://github.com/DrewThomasson/ebook2audiobook) | ~19.5k | Apache-2.0 (default XTTS weights are CPML non-commercial) | Very active, weekly releases | The playbook for our weakest shipped surface (audiobook) |
| [VideoLingo](https://github.com/Huanshere/VideoLingo) | ~17.7k | Apache-2.0 | Active, bursty | Dub-pipeline techniques (translation loop, timeline fit) |
| [voicebox](https://github.com/jamiepine/voicebox) | ~40.2k | MIT | Very active, post-viral triage debt | **Direct competitor** — same stack, same pitch, 10x the audience |

## 1. Real-Time-Voice-Cloning — the retired ancestor

The 2019 SV2TTS implementation ("clone a voice in 5 seconds") that created the
DIY voice-cloning category. Explicitly retired: the maintainer said in 2020 he
won't develop it again; the README now calls itself old and redirects users to
Chatterbox. Models are frozen 2019 checkpoints — 16 kHz, English-only, weak
similarity, Tacotron+WaveRNN. Community PRs keep the install alive (uv
one-command install landed Sept 2025), but ~163 open issues are mostly "how do
I make it sound good" — the answer is: you can't.

**Integrating it as an engine: no.** Strictly worse than everything we ship,
plus PyQt/legacy baggage.

**Take:**
- 60k stars of traffic reads a README that says "go elsewhere," and the
  redirect target is a model repo, not a product. An honest
  "Real-Time-Voice-Cloning alternative" comparison page is cheap, truthful,
  and lands exactly our pitch (local, free, modern quality, 646 languages,
  actual installer).
- Its headline copy discipline ("Clone a voice in 5 seconds, generate
  arbitrary speech in real-time") is better than ours; our 3-second-reference
  claim deserves the same outcome-first, time-boxed phrasing.
- Its failure modes validate our Core Value: out-of-band model links rotted
  for years; a research toolbox without packaging drowned in install issues.

## 2. VoxCPM — upstream of our `voxcpm2` engine

Tokenizer-free TTS on a MiniCPM-4 backbone. Current model is **VoxCPM2**
(Apr 2026): 2B params, 30 languages + 9 Chinese dialects, 48 kHz, ~8 GB VRAM,
RTF ~0.30 (0.13 with Nano-vLLM). Latest tag v2.0.3 (May 2026); main has
unreleased seed support and timestamp alignment. Apache-2.0, healthy cadence,
~868k monthly HF downloads.

**Sync items for our integration** (we install `voxcpm` unpinned):

1. **Floor the install at `voxcpm>=2.0.3`** — it carries the MPS
   audio-quality fix (low-precision dtypes promoted to float32 on Apple
   Silicon). Directly relevant to our default-platform-parity rule.
2. **v2.0.1 removed reference-audio auto-trim** — if we hand raw user clips
   to cloning, we now own trim/normalize. Verify our clone path; cloning
   quality may have silently regressed when upstream released 2.0.1.
3. **Trailing-audio guard**: end-of-audio gibberish/hallucination is a known
   open upstream bug (#352). A trailing-silence/garbage trim on our side is
   cheap insurance.
4. **Later, when tagged**: seed support (reproducible generation — currently
   buggy upstream, #351) and timestamp alignment (useful for dub sync);
   `generate_streaming()` is a candidate for `tts_stream.py`.
5. **Risk**: unpinned dependency + active upstream = next release lands
   silently in fresh installs. Consider pinning a tested range.

## 3. ebook2audiobook — the audiobook playbook

Any-format ebook (epub/pdf/docx/even scanned images via OCR) → Calibre
normalize to EPUB → TOC/spine chapters ("blocks") → per-language sentence
split → per-sentence TTS → chapterized m4b with metadata/cover. Gradio UI +
headless CLI + Docker for every accelerator. Engine roster is 2023-era Coqui
(XTTSv2 default, Bark, Piper, MMS…), with voice-conversion post-processing to
fake cloning on non-cloning engines. 19.5k stars, near-weekly releases, only
4 open issues.

This is the mature version of exactly the surface where we're weakest: our
audiobook/stories feature is a thin UI over per-chapter render caching, with
no server-side ebook parsing and no per-segment regeneration.

**Take (prioritized):**
1. **Per-sentence render cache + content-hashed blocks + missing-file
   resume.** Every sentence is its own file; restart re-renders only what's
   missing; editing a block invalidates only that block. This closes our
   biggest audiobook gap (per-chapter cache, no crash resume) and is the same
   span-level model spec 03 already calls for — dub's `incremental.py`
   pattern, extended to longform.
2. **Normalize-to-EPUB ingestion** (Calibre `ebook-convert`) instead of
   building N format parsers; blocks carry keep/drop flags for front matter.
3. **Engine-agnostic text-normalization pre-pass**: per-language abbreviation
   maps, num2words, roman numerals, and a non-text character filter that
   kills TTS hallucination triggers. Benefits every engine we ship, not just
   audiobooks.
4. **Chapterized m4b output** (ffmpeg FFMETADATA chapters, cover art, VTT
   sidecar) — small work, high perceived value.
5. **Inline voice/pause tags** for multi-voice narration — our cloning
   quality makes this worth more to us than it is to them.

**Where we already win:** native desktop UX, modern engine quality
(CosyVoice3/IndexTTS2/VoxCPM2 vs 2023 Coqui), real zero-shot cloning without
VC hacks, no Calibre-wall install, and a commercially-clean default engine
(their default XTTS weights are CPML non-commercial).

## 4. VideoLingo — dub-pipeline techniques

"Netflix-quality subtitles + dubbing" as a 14-stage Streamlit pipeline:
yt-dlp → WhisperX word-level ASR → spaCy + LLM two-candidate semantic split →
summarize-first terminology glossary → 3-step Translate–Reflect–Adapt →
length-constrained subtitles → duration-aware dub-chunk planning →
per-chunk reference audio → TTS → merge. Its recommended path is
cloud-heavy (API LLM/TTS, optionally API ASR); fully-local is possible but
fragile. Single-speaker only — it explicitly gave up on diarized multi-voice
dubbing. Apache-2.0, ~17.7k stars, bursty maintenance, install pain on
Windows/CUDA.

**Take (prioritized):**
1. **Translate–Reflect–Adapt** — add a reflection/critique pass to our
   per-segment translation prompt. Prompt-level change, meaningful quality
   win on idiomatic output.
2. **Summarize-first glossary** — extract theme + terminology once per video,
   inject into every segment's translation. Fixes term drift on long videos.
3. **Duration-aware chunk planning** — estimate TTS duration *before*
   generating; classify each line ok / needs-speedup / impossible; borrow
   inter-subtitle gap time and merge adjacent segments before resorting to
   atempo; for impossible lines, LLM-trim filler from the dub text instead of
   chipmunking. Our smart-fit handles the tail of this; their pre-planning
   avoids generating doomed audio at all.
4. **Two-candidate split prompt** — generate two `[br]` segmentations, have
   the LLM pick, instead of accepting the first.

**Where we already win:** fully local by design, per-segment regeneration +
directorial AI (they have coarse folder-state resume, no per-segment redo),
cross-platform installers, cloning stable across languages. Their
single-speaker ceiling is our opening if diarized multi-voice dubbing ever
ships.

## 5. voicebox — the direct competitor

Jamie Pine's (Spacedrive founder) "open-source AI voice studio. Clone,
dictate, create." — architecturally a near-twin: **Tauri + React/TS +
FastAPI/Python + SQLite**, MIT, local-first, explicitly pitched as
ElevenLabs-out + WisprFlow-in replacement. Launched Jan 29, 2026; the launch
post did ~17M views on X, and it sits at **~40.2k stars** with ~10 community
contributors and heavy AI co-authorship. Latest tagged release v0.5.0
(Apr 2026); main is active but untagged for ~10 weeks, with **434 open
issues / 105 open PRs** — a polished happy path with thin edges.

Engines: Qwen3-TTS 0.6B/1.7B (flagship cloner), Qwen CustomVoice, LuxTTS,
Chatterbox Multilingual (23 langs) + Turbo, HumeAI TADA, Kokoro. Features
where they lead: global-hotkey dictation overlay with LLM transcript cleanup
(macOS-verified), Pedalboard post-FX chain, generation versioning/starring,
multi-track Stories editor, **MCP per-client voice bindings** ("Claude Code
speaks in your cloned voice") used as a viral wedge, DirectML/Intel-Arc
coverage, and an agent-facing CONTRIBUTING pattern that farms drive-by
contributions.

Two strategic facts:

- **They are adding accounts.** "Log in with browser" auth for a
  `voicebox.sh` cloud tier merged July 5 (their PR #812). Open-core with a
  paid cloud is visibly forming — which cuts against the pitch that won them
  their audience.
- **Press already flagged their missing consent/misuse policy** — we ship
  watermarking by default and consent attestation in `.ovsvoice`.

**Where we're ahead:** 646 languages vs 23, video dubbing (they have none),
voice design from text descriptions (roadmap item for them, shipped for us),
engine breadth (CosyVoice3/VoxCPM2/IndexTTS2/GPT-SoVITS/sherpa-onnx), and
backward-compat/release discipline.

**Take:**
1. **Positioning: own "no accounts, ever."** Their cloud login is our
   opening — state the local-first guarantee in the README as a permanent
   commitment, next to the 646-language and dubbing advantages they can't
   match today.
2. **Tell the MCP agent-voice story loudly.** We already ship an MCP server
   and Agent Skills; per-client voice bindings + a speak-in-your-voice demo
   was their single best growth hook and costs us mostly marketing effort.
3. **Generation versioning/starring and post-FX presets** — cheap,
   high-perceived-value Studio features worth absorbing.
4. **Watch their triage debt** (434 open issues): our absorb-or-decline
   queue discipline is a real contributor-trust differentiator — keep it.

## Consolidated priorities

Ordered by (user impact on already-shipped surfaces) × (effort):

1. **voxcpm2 upstream sync** (§2 items 1–3): version floor, ref-clip trim
   audit, trailing-audio guard. Small, protects an engine users already run.
2. **Dub translation quality loop** (§4 items 1–2): reflect pass + glossary.
   Prompt-level, no new deps, lifts the flagship dubbing feature.
3. **Audiobook maturity via per-sentence cache + resume** (§3 item 1): the
   established pattern for the feature the maturity survey ranked weakest —
   and it's the same architecture spec 03 already prescribes.
4. **Text-normalization pre-pass** (§3 item 3): engine-agnostic hallucination
   reduction; pairs with the pronunciation dictionary we already shipped.
5. **Duration-aware dub planning** (§4 item 3) and **chapterized m4b export**
   (§3 item 4): next tier, both self-contained.
6. **Competitive positioning vs voicebox** (§5 items 1–2): own "no accounts,
   ever" while they onboard a cloud tier, and tell the MCP agent-voice story
   we already technically ship.
7. **RTVC comparison/migration page** (§1): marketing, not engineering;
   cheap and honest.

*Method note: compiled from five parallel research passes over the repos'
READMEs, releases, issues, and (for ebook2audiobook) source; figures as of
2026-07-10.*
