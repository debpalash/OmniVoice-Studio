# Changelog

All notable changes to OmniVoice Studio.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).
Versions track the desktop app (`tauri.conf.json` + `frontend/src-tauri/Cargo.toml`).
The bundled TTS model package (`pyproject.toml`) is versioned independently.

## [Unreleased]

_Nothing yet — `main` is at v0.3.7 + 1 patch. New work lands here._

## [0.3.7] — 2026-06-20

A stabilization release that clears the wave of issues reported on the 0.3.6
line — across voice design, dubbing, transcription, install, and the Linux/web
UI — and lands two more opt-in cloning engines. The throughline is **non-English
correctness and cross-platform playback**: cloned and designed voices now hold
their language end-to-end, and audio plays inline in Linux/Android browsers,
not just macOS. It also carries the v0.3.6 startup-crash fixes, so anyone still
hitting "Can't reach the local backend" on v0.3.5/v0.3.6 only needs to update.

### Added

- **Two opt-in heavyweight TTS engines: MOSS-TTS-v1.5 (8B) and dots.tts (2B).**
  Both are zero-shot voice-cloning engines, each running in its own isolated
  subprocess venv (they pin a `transformers` version that conflicts with the
  parent's `>=5.3` — MOSS `==5.0`, dots.tts `==4.57`) via the same dedicated-venv
  pattern as IndexTTS-2, so they can't disturb the default install or its
  lockfile. Point `OMNIVOICE_MOSS_TTS_V15_DIR` / `OMNIVOICE_DOTS_TTS_DIR` at a
  local clone to enable. CUDA/CPU only — neither claims Apple-Silicon MPS, and
  dots.tts is gated off on Windows (upstream is Linux/macOS only). See
  [docs/engines/moss-tts-v15.md](docs/engines/moss-tts-v15.md) and
  [docs/engines/dots-tts.md](docs/engines/dots-tts.md). (#498)

### Fixed

- **Non-English voices drifted to English / the wrong language.** Three
  independent root causes, all in the language path: (1) a voice profile's
  stored language was never read back into generation, so a German archetype
  that *previewed* in German *generated* in English (the preview passed the
  language; the user's Generate call didn't); (2) the audiobook/longform synth
  hardcoded `language=None`, letting the engine re-autodetect per chunk so a
  non-English clone could flip language mid-render on short/ambiguous lines; and
  (3) the duration estimator weighted Unicode combining marks at zero, so
  decomposed (NFD) diacritic text — common for Vietnamese — under-allocated
  frames and came out rushed. The profile/request language is now threaded
  through both the single-shot and longform paths (request wins, profile fills
  the gap), and text is NFC-normalized before duration estimation. Each fix has
  a fail-before/pass-after regression test. (#533, #505, #502)
- **Audio playback on Linux Firefox/Chrome and Android Chrome.** Two separate
  root causes both masquerade as "the play button doesn't work" on non-macOS
  browsers — and both are invisible when developing on macOS, which is why they
  shipped. (1) The backend served `.wav` / `.flac` with Python's default
  `audio/x-wav` / `audio/x-flac` (vendor-experimental, never IANA-registered);
  macOS CoreAudio MIME-sniffs leniently and plays anyway, but Linux FFmpeg and
  Android ExoPlayer strictly honor the declared type and prompt to download.
  Fixed by registering the canonical `audio/wav` / `audio/flac` types before
  any `StaticFiles` mount. (2) WaveSurfer's `AudioContext` is constructed at
  component-mount time — i.e. before any user gesture — so on Linux FF/Chrome
  and Android Chrome it stays `suspended`, `decodeAudioData` hangs, the
  `ready` event never fires, and the play button never enables. macOS
  Safari/Chrome auto-resume on first interaction. Fixed by patching
  `window.AudioContext` to track every instance and resuming them on the first
  `pointerdown` / `keydown` / `touchstart`, plus resuming inline on the play
  click itself. The MIME fix has a backend regression test; the unlock path
  has a Vitest unit test covering idempotency, post-unlock contexts, and
  error isolation. (#510)
- **Voice Studio "Save design as profile" poisoned the profile with
  "[object Object]" and then 400'd every generation** ("Unsupported instruct
  items found in [object Object]"). The save passed the instruct *builder
  object* to the form instead of its string. Fixed at the source + defended with
  a coercion helper; the engine now tolerates the sentinel, and a migration
  heals already-saved profiles. (#550, #545, #542, #537, #530, #525)
- **Profile / persona / consent endpoints 500'd with `no such column:
  consent_audio_path`** (and the same class for `kind`/`vd_states`/…) after an
  in-place upgrade. The alembic migration existed but couldn't always apply
  (stamped at a removed revision, or alembic not importable) and the failure was
  swallowed. The runtime schema now self-heals — it ADDs any missing additive
  column from the canonical schema on startup. (#552, #547)
- **Stories: the global reading-speed slider was ignored by preview and stem
  export.** The #415 global speed only flowed through the full longform export;
  per-segment preview and stem export still resolved a hardcoded `track.speed ||
  1.0`, so audio played at 1.0× even with the global set to e.g. 0.70×. A shared
  `effectiveSpeed(track, global)` helper (per-line override → global → engine
  default) now drives all three generation paths. (#508)
- **Generate / Settings / Clone buttons were missing / unpressable on Linux.**
  The UI-scale fix round-trips correctly on Chromium, but older WebKitGTK treats
  `zoom` as a layout no-op, leaving a ~23% black band that pushed the bottom CTAs
  off-screen. The shell now probes the engine and fills the window when `zoom`
  doesn't lay out. (#523, #524)
- **Settings tabs with little content rendered as a stunted box in a black
  void** (reported on Appearance). The page is now a flex column with a
  min-height floor — short tabs fill the panel, tall tabs grow and scroll
  exactly as before. The Appearance panel's previously hardcoded English
  strings ("UI scale", "Color theme", "Font") were also routed through i18n,
  per the localization rule. (#507)
- **The engine "Install" button 500'd with "No virtual environment found."**
  `uv pip install` now targets the running interpreter (`--python
  sys.executable`) instead of relying on a venv it couldn't auto-discover.
  (#529, #527)
- **Transcription failed with "no segments" on GPUs without efficient float16.**
  Both CTranslate2 ASR backends now fall back float16 → int8 instead of crashing
  at model load; a transcribe stream can no longer close without a terminal
  error event; and an incomplete `transformers` install reports an actionable
  message instead of "Could not import module 'AutoFeatureExtractor'".
  (#551, #549, #516)
- **Audiobook import 500'd** with `'AudiobookPlan' object has no attribute
  'chapter_count'` for every format (.txt/.md/.epub/.pdf). (#543)
- **Windows: generated audio auto-played in a separate, un-closeable black
  window.** Renders now play in-app through the shared playback manager. (#532)
- **Cryptic video-download errors** now carry actionable hints: an unsupported
  link shape ("paste a direct video page, not a share/feed link") vs a transient
  network drop ("just retry — the partial download was cleaned up"). (#554, #536)
- **A relocated, copied, or restored backend venv ("No module named
  'encodings'") now self-heals** (rebuilds once) instead of failing on every
  launch.
- **The donate goal bar showed fabricated progress** ($137.50 / $200, 23
  sponsors). It now reflects the real figures ($10 / $200, 1 sponsor) in both the
  runtime JSON and the TypeScript fallback. (#513)
- The **"Can't reach the local backend" startup-crash wave** (pkg_resources
  #248, `scalar_fastapi` #307, exit-106 broken venv) was fixed in v0.3.6 — this
  release carries those fixes, so updating from v0.3.5/older resolves them.

### Changed

- **Version is now single-sourced from `frontend/package.json`.** Five
  hand-maintained literals drifting is exactly what shipped a 0.3.6 build that
  called itself 0.3.5. `package.json` is canonical (vite already injects it as
  `__APP_VERSION__`), `tauri.conf.json` reads its bundle version from it
  (`"version": "../package.json"`), and the remaining toolchain-required mirrors
  (Cargo.toml, pyproject.toml, the frozen-backend fallback) are CI-guarded to
  stay in lockstep. (#503)
- **Updater: the Preview channel actually tracks `main` again.** It was stuck at
  `0.3.5-41` because its only build trigger was a manual dispatch; a nightly
  rebuild now enforces "preview = main" (no-opping on days `main` didn't move).
  Two latent hazards are closed: the `preview` release is re-asserted as a
  prerelease every run (a non-prerelease preview could hijack the Stable
  channel's "Latest"), and its manifest can no longer silently drop the
  Intel-Mac (darwin-x86_64) target. (#500)

### Internal

- **The frozen desktop backend reported `0.3.5` regardless of its real version.**
  In a synced env, `core.version.APP_VERSION` resolves from package metadata
  (correct, so CI stayed green), but the PyInstaller-frozen build has no
  `.dist-info`, hit `PackageNotFoundError`, and fell back to a hardcoded literal.
  The spec now bundles `omnivoice` metadata so the primary path works frozen too,
  and the resolution chain is metadata → pyproject → named fallback. This also
  fixes **About → Version rendering blank** in the web/Pinokio build (no Tauri,
  backend idle), which now falls back to the build-time version. (#501)

## [0.3.6] — 2026-06-16

A large release (168 commits since v0.3.5). The headline is the **Longform
suite** — produce full audiobooks and multi-voice stories from text, EPUB, or
PDF — alongside a real **engine-routing** layer that tells you up front when an
engine will fall back to CPU instead of finding out mid-synth. Dubbing,
first-run, and install reliability all get a pass too.

### Added

- **Longform: Stories + Audiobook editors.** Two new tabs turn long text into
  finished audio. **Audiobook** takes a script (or imports plain text / EPUB /
  PDF), auto-splits it into chapters, and renders a chaptered `.m4b` with
  metadata, cover art, and per-chapter preview/resume. **Stories** is a
  multi-voice editor — assign a different voice per line, preview, and export
  the whole thing through the same server-side renderer. Both share one render
  core (loudness, metadata, cover art) and one live SSE progress stream, and
  you can convert a project between Story and Audiobook in place.
  (#402, #403, #404, #408, #409, #411, #412, #413, #426, #435, #436, #447)
- **Longform: PDF & EPUB ingest.** "Import" on the Audiobook tab accepts EPUB
  and PDF (not just plain text) and auto-chapters the result, so an existing
  ebook becomes an audiobook without manual copy-paste. (#412, #459)
- **Longform: two-pass loudnorm mastering.** Audiobook/Story exports now run a
  measure-then-normalize loudnorm pass for accurate ACX/podcast loudness
  targets. A slow or broken measure pass degrades gracefully to single-pass
  rather than aborting the render. (#449, #455)
- **Longform: crash-resume.** An interrupted render is resumable without
  re-submitting the original input — the compiled plan is persisted to the job
  dir and finished chapters are reused, so a crash mid-book doesn't cost you the
  whole render. (#470)
- **Longform: pronunciation control + SSML-lite prosody.** A per-render
  pronunciation lexicon (word respelling) plus an in-app pronunciation editor
  and markup reference, and inline prosody markers — `[slow]` / `[fast]` /
  `[emphasis]` / `[spell]` — for fine-grained delivery. (#419, #421, #422)
- **Stories: global reading-speed control.** A toolbar slider (0.5–2.0×) sets
  one speed for every line that doesn't have its own per-line override; the
  per-line slider still wins. Persisted as a UI preference. (#415, #416)
- **Unified LongformProject store.** Audiobook metadata, scripts, and prefs
  persist in a single project store (with a `v4→v5` migration), and finished
  books/stories now show up alongside other work in **Projects**. (#417, #443,
  #444)
- **Portable personas (`.ovsvoice`).** Export any voice as a self-contained,
  fully-local persona bundle — identity, optional reference clip, consent
  attestation, SPDX license, and a watermarked preview — and import it back into
  another OmniVoice install. A privacy toggle ships a **preview-only** bundle so
  no raw recording of your voice has to travel. Verified-own-voice status can't
  be forged by hand-editing a bundle (real recording + consent text + attestation
  required). Legacy `.omnivoice` files still import. See
  [docs/persona-format.md](docs/persona-format.md). (#29)
- **Engine routing — no more silent CPU fallback.** A host device probe and
  routing resolver now decide where each engine actually runs, and the verdict
  is surfaced before you hit Synthesize: the **Settings → Engines** picker shows
  a per-engine compatibility matrix, and **preflight** / **diagnose** report the
  active engine's GPU verdict (accelerated / caveat / CPU-fallback /
  unavailable). At synth time every TTS entry point (`/generate`,
  `/v1/audio/speech`) enforces the same routing — an engine that can't use this
  host's GPU returns an explicit error or an `X-OmniVoice-Routing` header instead
  of silently dropping to CPU or dying mid-synth. (#21)
- **Diagnostics suite.** New self-check tooling for when something's wrong: a
  `/system/diagnose` report (and matching backend `--diagnose`), a persistent
  **error journal** surfaced in Settings, and a scrubbed **diagnostic bundle**
  (home dirs stripped to `~/`, no tokens/keys) you can attach to a bug report.
  Paired with structured GitHub **Issue Forms** (bug / install / feature) for
  cleaner reports. (#433, #456)
- **Dubbing: multi-speaker per-speaker voice assignment.** When diarization
  detects multiple speakers, each segment is now bound to its speaker's cloned
  voice automatically instead of landing on "Default" and needing manual fixes;
  per-segment reference clips are still preferred for quality where present. Also
  adds an optional speaker-count hint for diarization. (#275, #486, #490)
- **Dubbing: Smart Fit timing + second-pass QC.** A Smart Fit timing strategy
  (planner, fingerprints, per-segment video retime + drift absorption + fitted
  subtitles) plus a second-pass ASR QC that flags lines whose dub drifts from the
  target timing — wired into the dub editor UI. Includes a timeline segment
  editor (drag, snap-to-onset, keyboard a11y), speech-onset alignment, regional
  dialect targeting, and per-segment clone references. (#280, #347, #350, #369,
  #370, #458)
- **Dubbing: dedicated Dub home.** A projects/history landing for dubbing with
  project rename. (#435)
- **Voice Console workspace.** Clone and Design are consolidated into one Voice
  workspace with right-side panels, a shared waveform player, an identity recipe
  line / Active-voice card, and a free-text "describe your voice" field that maps
  natural language to design parameters. (#317, #374, #376, #378, #395, #396,
  #397)
- **Unified first-run setup.** Nothing installs until you confirm a plan: pick an
  install mode (installed / portable), a storage location, and (on restricted
  networks) custom PyPI/HF/python-build-standalone mirrors — with a
  minimum-free-space gate before anything downloads. Followed by a guided
  studio-console wizard with platform-aware hints, resume reassurance, and
  download ETAs. (#286, #295, #297, #298)
- **Dictation: local-LLM refinement.** Opt-in local-LLM cleanup of final
  transcripts (collapsing Whisper hallucination loops), available on both live
  dictation and the REST `/transcribe` path; plus opt-in NLMS acoustic echo
  cancellation for dictating over playback. Configure a remote LLM endpoint
  (Ollama / vLLM / LM Studio) in Settings. (#356, #357, #363, #399, #400, #457)
- **Unlimited-length TTS + streaming.** Sentence-boundary chunking with
  crossfade removes the per-generation length cap, and a new sentence-by-sentence
  `/ws/tts` streams audio as it's produced. An inline `[pause Nms]` marker
  inserts measured silence in generated speech. (#276, #357, #358)
- **MCP server v1.** OmniVoice mounts an MCP server on `/mcp` (with a stdio shim
  and per-agent voice binding) so it can act as a local TTS/STT provider for
  agentic pipelines. (#368)
- **Remote-backend access.** Point the desktop UI at a remote backend URL with a
  bearer key (Tailscale-documented), and an opt-in Hugging Face token field in
  the setup flow. (#303, #364)
- **"Fund Claude Max" support experience.** The donate page gets a real goal bar
  with a "Join N supporters" social-proof line and suggested amounts, plus Pip
  the mascot and a non-blocking "postcard" toast that appears only *after* a
  success (a finished dub, a saved clone, a longform export) — never on errors,
  setup, or first run — with escalating cooldowns and a one-click "don't ask
  again". (#494)

### Fixed

- **Transcription/dubbing failed when ffmpeg wasn't on `PATH`** (notably on
  Windows). WhisperX now decodes audio through OmniVoice's own validated ffmpeg
  binary instead of a bare `PATH` lookup, so ASR works without a system ffmpeg
  install. (#479)
- **Translation defaulted the source language to English.** Dubbing/translation
  now guesses the source language from the text instead of assuming `en`,
  fixing wrong-direction translations. (#478)
- **Cinematic / LLM dubbing features failed out of the box** because `openai`
  wasn't bundled. The client is now a runtime dependency, so those paths work on
  a fresh install. (#484)
- **`pkg_resources missing` install dead-end (#248).** The auto-repair ran
  `uv pip install setuptools`, which `uv` treated as a no-op when setuptools
  *metadata* was present but its files had been removed (commonly by Windows
  Defender quarantine or a partial extract). Both repair sites now use
  `--reinstall` to force re-extraction, and the error/hint text suggests the
  working command plus an antivirus-exclusion note. (#248)
- **A stuck backend trapped users on a buttonless splash (#474).** The bootstrap
  splash now has a per-stage stall watchdog: if a non-terminal stage sits past
  its budget (20 min for dep install, 120 s otherwise), it flips to the failed
  state with actionable hints, the live log, and Retry / Clean-&-Retry — instead
  of polling forever with no way out. (#474)
- **Changing the model-download location in Settings had no effect (#480).** The
  desktop launcher injected a stale models dir that overrode the per-user value,
  so new downloads kept going to the old folder and "Effective location" stayed
  wrong. The per-user env file now wins, so the in-app Settings path is
  authoritative. (#480)
- **Backend crashed on app upgrade with a stale venv (#307).** Dependencies are
  now synced on upgrade, and a structurally broken venv self-heals instead of
  exiting `106`. `scalar_fastapi` is now optional so its absence can't break
  startup. (#307, #314)
- **`/generate` ignored the selected TTS engine (#312)** and GGUF speech-control
  parameters weren't forwarded — both now honored. (#306, #312)
- **TTS generation failed on some GPUs.** `torch.compile` failures now fall back
  to eager execution so generation never hard-fails on unsupported GPUs, and
  cudagraph-compiled inference is pinned to one dedicated thread to avoid
  crashes. (#278, #315)
- **Re-dub ignored transcript edits (#281).** Fingerprints are canonicalized, the
  preview cache is busted, and the mux is atomic, so editing the transcript and
  re-dubbing actually reflects your changes. Translated subtitles now burn in
  correctly and subtitle save no longer throws a JSON error. (#281, #309)
- **macOS: app wouldn't open without using Terminal.** Builds are now ad-hoc
  signed (with signing/notarization verification), so the app launches normally.
  (#290)
- **macOS dictation auto-paste stole focus**; it now writes the clipboard
  natively without grabbing focus, and microphone-permission handling adds OS
  usage descriptions, a WebView grant handler, and an actionable denied-state UI.
  (#287, #323)
- **Clone-reference transcription was broken** (it used a removed transformers
  pipeline); it now routes through the ASR registry. A crash-isolated
  faster-whisper subprocess backend keeps an ASR crash from taking down the app.
  (#308, #393)
- **Realtime status probe hit a gated route.** It now probes the auth-exempt
  `/health` instead of the gated `/model/status`, and the UI polls the backend
  over HTTP before opening the WebSocket to avoid startup `ECONNREFUSED`. (#439,
  #450)
- **Non-executable or unreachable engine binaries showed cryptic errors** — these
  now produce actionable messages. (#437, #438, #454, #466)
- **Design-profile save was coupled to a TTS render (#476)**, so saving a profile
  needlessly triggered synthesis; the two are now decoupled. (#476)
- **UI scale / black bands.** The app shell now scales via `transform: scale` and
  always fills the viewport, fixing the WebKitGTK black-band issue on Linux and
  cramped/black layouts at narrow widths — a permanent fix across platforms.
  (#445, #452)
- **Clone popover/CTA clipping and a non-resizable textarea** are fixed, the
  WaveformPlayer no longer pauses itself on play or ignores clicks, and several
  layout/history-display issues (phantom sidebar gap, title clamping, flicker)
  are cleaned up. (#379, #384, #398, #481)
- **Windows: `desktop-prod` now runs from cmd/PowerShell** via a cross-platform
  launcher, `tqdm` is disabled on non-TTY to avoid an `OSError`, and ffmpeg
  validation guards against `WinError 193`. (#282, #305, #377)
- **MLX import hardened** against PyInstaller dylib failures, with a proper
  platform gate so it's only loaded where it works. (#390)

### Changed

- **Restricted-network support.** A Hugging Face mirror (`HF_ENDPOINT`) setting,
  custom PyPI / HF / python-build-standalone mirrors in first-run setup, and
  region presets help installs complete behind restrictive networks. (#286, #391)
- **Engine memory management.** Subprocess-engine sidecars now unload on demand
  and idle-reap to free VRAM. (#401, #406)
- **Faster, more accurate model downloads** via a Xet fast path with accurate
  progress reporting, plus a model-management cleanup pass. (#424, #428)
- **Voice profiles unified** under one model with a `kind` discriminator and
  stored design params, and consent-locked profiles (`verified_own_voice` +
  spoken-consent flow). (#354, #376)
- **Updater** preview channel now offers the newest build across channels, and
  preview versions carry an MSI-legal numeric pre-release stamp. (#293, #326)
- **Performance.** Voice-clone prompt embeddings are cached, and dub retime
  batches seek to their window instead of decoding from frame 0. (#387, #427)

### License

- **Relicensed from FSL-1.1-ALv2 to AGPL-3.0 (open-core).** The project is now
  under the GNU Affero General Public License v3, with a paid commercial license
  retained for proprietary/closed-source use without AGPL obligations. The
  bundled `omnivoice/` TTS model package stays Apache-2.0 upstream
  (AGPL-compatible). Manifests declare `AGPL-3.0-only`; the in-app Commercial
  License copy and README are updated, and the old "converts to Apache 2.0 after
  two years" FAQ is removed. In-app commercial-license strings are translated
  across all 20 locales. (#292)

### CI

- **macOS Intel (x86_64) build target reinstated** on `macos-15-intel`, so Intel
  Mac users get installers again. (#342)
- **Docker Hub publishing.** Images now also publish to Docker Hub
  (`palashdeb/omnivoice-studio`), with the Docker Hub overview maintained in-repo
  and auto-synced from `main` (sync is non-fatal so it can't redden a build).
  (#375, #410, #414)
- **Docs-drift guard.** A daily job compares the canonical feature inventory
  against README / docs / registries to catch stale docs. (#353)
- **Security scans never cancel on `main`,** so merge trains no longer leave red
  ✗ on intermediate commits. (#340)

## [0.3.5] — 2026-06-03

### Fixed
- **Speaker diarization failed on PyTorch ≥ 2.6** (`Weights only load failed …
  Unsupported global: torch.torch_version.TorchVersion`) even with the pyannote
  license accepted. PyTorch 2.6 made `torch.load` default to
  `weights_only=True`, whose secure unpickler rejects the pyannote checkpoint's
  metadata globals. The diarization loader now registers the same safe-globals
  allowlist the WhisperX VAD load already uses, so the secure load succeeds.
  (#270)

## [0.3.4] — 2026-06-03

### Fixed
- **Transcription on Windows + NVIDIA failed with `Could not locate
  cudnn_ops_infer64_8.dll`.** WhisperX/faster-whisper need cuDNN 8 (via
  CTranslate2); when the side-loaded `cudnn8_compat` libs are missing, the
  **PyTorch Whisper** backend (Settings → Models) now works as a drop-in
  fallback — it builds its own transformers pipeline on PyTorch's cuDNN-9
  stack, with no CTranslate2/cuDNN-8 dependency and no
  `OMNIVOICE_PRELOAD_TTS_ASR=1` required. (#255)

## [0.3.3] — 2026-06-03

### Fixed
- **Settings → About showed the wrong architecture in the Docker/web build.**
  The "Architecture" row rendered the *client browser's* platform
  (`navigator.platform` → e.g. "Win32"); it now reports the **server's** CPU
  architecture from the backend (`platform.machine()`), correct for both the
  desktop app and Docker. The blank version/GPU/RAM/VRAM in the same report
  were the loopback-gate 403s already fixed in v0.3.2. (#262)

### CI
- The release SHA-256 checksum step no longer uses `mapfile` (a bash 4+
  builtin) — it broke on the macOS runner's bash 3.2 and dropped the macOS
  `SHA256SUMS` for v0.3.1/v0.3.2. Now portable to bash 3.2.

## [0.3.2] — 2026-06-03

### Fixed
- **"Loopback origin required" all over the Docker UI** (and a blank version).
  The `/system/*` and `/api/settings/*` routes are restricted to a loopback
  origin, but Docker's NAT makes every request look non-loopback, so the gate
  403'd the operator out of the admin UI — including `/system/info` (blanking
  the version) and HF-token entry. The Docker image now runs with
  `OMNIVOICE_SERVER_MODE=1`, which relaxes the gate for the headless
  deployment; exposure is governed by the `-p` port mapping plus the optional
  share PIN. Desktop builds are unaffected — their loopback boundary (and the
  denial of admin routes to LAN share guests) is unchanged. (#261)

## [0.3.1] — 2026-06-03

First tagged build of the 0.3 line off `main` — it ships the accumulated
`[0.3.0]` work below plus the fixes here. (The `[0.3.0]` milestone heading is
kept for the qualitative "actually useful" release.)

### Fixed
- **Voice-clone / export download crashed in the Docker & browser build** with
  `TypeError: Cannot read properties of undefined (reading 'invoke')`. The
  export button called the Tauri save dialog unconditionally; outside the
  desktop shell it now falls back to a standard browser download of the file
  served at `/audio/<path>`. (#256)
- **Docker container showed no version** (a dash) in Settings → About, and the
  desktop-only update-channel toggle appeared in the web build. The running
  version is now read from the backend (`/system/info` `app_version`, `/health`
  `version`); the updater UI is hidden outside Tauri. Also corrected the
  version-check command in the Docker docs (`omnivoice`, not
  `omnivoice-studio`). (#249)
- **Transcription failures were masked** by a generic "Transcribe stream
  dropped" message. The transcribe SSE stream now surfaces the real, sanitized
  cause (with an actionable hint) instead of silently dropping when model load
  or VRAM offload fails. (#255)

## [0.3.0] — Unreleased

### Added
- **Frameless dictation widget.** Global dictation upgraded from an in-app FAB to a true OS-level floating widget that hovers over any application. Transparent, decorations-free, always-on-top secondary Tauri window activated by `⌘+⇧+Space`. Auto-hides 2.5 s after a successful paste.
- **Standalone `CaptureWidget` component.** Refactored `CaptureButton` into `CaptureWidget`, running on an isolated route (`/?window=widget`).
- **Social preview image.** Added `social-preview.png` for GitHub SEO.

### Changed
- **README overhaul.** Compact 3-column feature grid, reorganized Quickstart (one-command install, Docker, Desktop App tips), updated comparison table, roadmap, and footer CTA.
- **Docker Compose profiles are mutually exclusive.** CPU service now requires `--profile cpu` (was the implicit default). Prevents port 3900 conflict when running `--profile gpu`. Usage: `docker compose --profile cpu up` or `docker compose --profile gpu up`.

### Fixed
- **Docker GPU detection false negative.** Preflight reported "No compatible GPU detected" inside Docker containers because `nvidia-smi` isn't present in the PyTorch base image. The GPU probe now falls back to `torch.cuda.is_available()` and `torch.cuda.get_device_name()`, correctly showing CUDA as available in containerized deployments.

---

## [0.2.6] — Unreleased

### License
- **Relicensed Studio under [Functional Source License (FSL-1.1-ALv2)](https://fsl.software/).** Free for personal, educational, internal-team, and non-commercial use. Each release converts automatically to Apache License, Version 2.0 on the second anniversary of its publication.
- The bundled `omnivoice/` Python TTS model package remains separately licensed under Apache 2.0 by its upstream authors — not relicensed here.
- In-app **Commercial License** page no longer publishes pricing tiers. Pricing is being finalized; the page now invites quote requests and links the FSL terms.

### Added
- **Single-instance enforcement.** Launching a second copy now focuses the existing window instead of starting a second backend that races for port 3900. Powered by `tauri-plugin-single-instance`.
- **Close-to-tray.** Clicking the window X (or `Cmd+W` on macOS) now hides the window and keeps the backend + tray menu alive. The tray "Quit" item is the only path that fully exits and shuts down the Python backend (cleanup moved to `RunEvent::ExitRequested`).
- **Recording-state tray icon.** Tray icon flips to a red-dot variant while a dictation recording is active and reverts when it stops or errors out.
- **Customizable global dictation hotkey.** New **Settings → Capture** tab. Record any modifier-plus-key combo, save it, and it's persisted in `config.json` and re-registered on every launch. Failed registrations (combo already taken by the OS) roll back to the previously-working binding instead of leaving the user with no shortcut.
- **WebSocket-final dictation path.** Capture now treats the streaming `final` message as the source of truth and skips the duplicate HTTP `POST /transcribe` that used to run on every dictation. Audio is transcribed once instead of twice — typical dictation latency roughly halved. New EOF text-frame protocol (server also accepts an empty binary frame as EOF). HTTP POST kept as fallback for WS error / timeout / WS-never-opened.
- **Chunk queueing during WS handshake.** The first 250 ms of audio is no longer dropped from the server's `final` transcript. `MediaRecorder` chunks captured while the WebSocket is still in `CONNECTING` state are queued and drained in `ws.onopen`.

### Changed
- **Docker default bind is loopback.** `docker-compose.yml` now publishes `127.0.0.1:3900:3900` instead of `3900:3900` — the API is no longer reachable from the LAN out of the box. To expose it deliberately, change the mapping to `0.0.0.0:3900:3900`. README documents the trade-off and recommends a reverse proxy with auth (Caddy `basic_auth`, nginx + htpasswd, Tailscale) for any non-loopback exposure.
- **Donate page trimmed.** Removed Patreon and the Bitcoin / Ethereum / Solana cryptocurrency cards. Removed the bundled `qrcode.react` dependency. The "Commercial License" CTA moves from the bottom of the page to the top-right of the page header.
- **WS dictation hostname** now derived from the configured `API_BASE` instead of a hardcoded `localhost:3900`, so deployments behind reverse proxies route correctly.
- **HTTP POST fallback timeout** scales with recording length (`max(15s, recordedMs + 10s)`) so long-form dictations don't trip the fallback and run the model twice.

### Fixed
- **Backend was killed on every window close** even if the user only intended to dismiss the window. Backend shutdown now fires only on real-quit (`RunEvent::ExitRequested`), not on the close-to-hide path.
- **Hotkey rollback.** `set_dictation_shortcut` previously left the user with no global shortcut if `register(new)` failed after `unregister(old)` succeeded. The previous binding is now restored on failure.
- **WebSocket dictation pipeline lost the first audio chunk.** `MediaRecorder` was started before the WebSocket finished its handshake, so the first 250 ms chunk — which carries the WebM EBML header — was dropped from the WS stream. Every subsequent server-side ffmpeg conversion then failed with `exit status 183` ("Invalid data found when processing input"), partials never appeared, and the HTTP fallback only fired after the full timeout. The WebSocket is now constructed before the recorder, every chunk is queued through `wsPendingRef` until `ws.onopen` drains it, and a server `error` message (or unexpected `onclose` after the recorder has stopped) fires the HTTP fallback immediately instead of waiting out the timeout.
- **Microphone access prompt on macOS.** Added an `Info.plist` with `NSMicrophoneUsageDescription` (and `NSCameraUsageDescription` for forward-compat) so getUserMedia no longer fails silently on macOS 10.14+ TCC. Tauri's bundler auto-merges the file at bundle time. Mic-denial toasts now also include platform-specific recovery hints (Settings paths for macOS/Windows, audio-group check for Linux).

### Infrastructure
- **uv bundled per-platform.** Release installers now ship the `uv` binary as a Tauri sidecar (`bundle.externalBin`). First launch no longer requires network access for the uv-download step — bootstrap uses the bundled binary directly. Adds ~12-15 MB per platform installer; falls back to PATH lookup, then standalone download, when the bundled file isn't present (dev builds, future targets). Pinned at `UV_VERSION = "0.11.7"`; bump the constant in [lib.rs](frontend/src-tauri/src/lib.rs) and the matching env var in [release.yml](.github/workflows/release.yml) together to refresh.
- **ffmpeg fetch removed from Tauri bootstrap.** The redundant download from `eugeneware/ffmpeg-static` (saved to `app_data/bin/`) was never used by the backend, which already resolves ffmpeg via `imageio_ffmpeg.get_ffmpeg_exe()` from the pip wheel pulled by `uv sync`. Net effect: one fewer first-run network round-trip, one fewer splash-screen stage, and the splash no longer shows the misleading "Downloading ffmpeg…" line.
- **CI cross-platform check.** PRs now run `cargo check` against the Tauri shell on macOS (Apple Silicon), Windows, and Linux in parallel — surfaces platform-specific Rust regressions before tag push without paying the full ~15 min/platform tauri-bundle cost (full bundling stays in `release.yml` on tag push).
- **Release notes from CHANGELOG.** `release.yml` now extracts the matching `## [X.Y.Z]` section from `CHANGELOG.md` and uses it as the GitHub Release body, replacing the prior placeholder "Auto-generated release. See commit log for changes."
- **Tests:** `tests/test_capture_ws.py` (3 cases) covers the EOF text-frame, empty-binary-frame, and legacy disconnect-finalize paths for `/ws/transcribe`.

### Internal
- New Tauri commands: `quit_app`, `set_tray_recording`, `get_dictation_shortcut`, `set_dictation_shortcut`.
- New Tauri state: `AppFlags { quitting }`, `TrayHandle { tray }`, `DictationShortcutState { current }`.
- New deps: `tauri-plugin-single-instance` 2.x, `tauri/image-png` feature flag (enables `Image::from_bytes` for in-memory tray-icon swap).

---

## [0.2.5] — 2026-04-29

Region selector, realtime download speed, retry buttons, recheck top-right, HF mirror support, splash bootstrap-log backfill. See git log `v0.2.4..v0.2.5` for the full set.

## Earlier releases

See [GitHub Releases](https://github.com/debpalash/OmniVoice-Studio/releases) for prior versions.
