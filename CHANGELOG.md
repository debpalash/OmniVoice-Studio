# Changelog

All notable changes to OmniVoice Studio.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).
Versions track the desktop app (`tauri.conf.json` + `frontend/src-tauri/Cargo.toml`).
The bundled TTS model package (`pyproject.toml`) is versioned independently.

## [0.3.8] — 2026-07-01

A stability-focused release that makes first-run and Windows "just work," ships
**live, faster-than-real-time local dictation** and a **user pronunciation
dictionary**, and gives **Settings a full redesign**. It clears the wave of
**"Can't reach the local backend"** reports at the source — the 8 GB-card OOM
crash, the slow-load future-scheduling break, a Windows-only WhisperX load
failure, an ASR engine that couldn't load CTranslate2 on newer Linux/WSL, and
both transcription **and generation** stalls that *looked* like a dead backend
(a wedged GPU job now resets the worker pool and returns an actionable timeout)
are all fixed or now fail with a clear, actionable message. **macOS gets native file drag-and-drop back**
(including macOS 26 Tahoe). Downloads are faster out of the box (parallel
segmented transfer on by default) and the Hugging Face token that speeds them up
is front-and-center on setup. Plus multi-voice story casting, faster long-form
previews on Windows, and a friendlier, more honest batch of error messages
across dub, generate, and design (a corrupt-binary failure no longer poses as
"out of memory," a bad model id self-heals, and a stale dub job resets cleanly).

### Added

- **"Autofit" translation quality — the dub keeps the video's timing.** A new
  quality alongside Fast and Cinematic: the LLM rewrites each translated line so
  its target-language reading time fits *within* the segment's slot (a strict
  "never overrun" bound, per-language pronunciation-speed aware), so long
  translations no longer force the audio into a stressed >1.3× time-stretch.
  Cinematic still applies its reflect/adapt polish; Autofit adds the hard
  fit-to-slot pass on top. Needs an LLM (below); falls back to Fast with a clear
  notice if none is set. (#838)
- **A new LLM Providers settings page — bring your own high-quality LLM.**
  Settings → System → **LLM Providers** configures the LLM that powers Cinematic
  and Autofit translation. One page for **16 providers** — OpenAI, OpenRouter,
  Groq, Cerebras, Google AI (Gemini), Mistral, Cohere, NVIDIA, GitHub Models,
  Cloudflare, Hugging Face, SambaNova, SiliconFlow, plus **local Ollama / LM
  Studio** (fully offline, no key) and a **Custom** OpenAI-compatible endpoint.
  Paste a key, pick a model, **Test** the connection in one click, and "use for
  translation" to make it active. Keys are stored **encrypted** (the same
  at-rest protection as the HF token) and never leave the machine unless you
  choose a cloud provider; env vars still override for power users. The dub
  translate menu now routes you straight here when you pick a high-quality
  style without an LLM, instead of dead-ending on a toast. (#838)
- **A dedicated Network pane.** The HTTP/SOCKS proxy and FFmpeg-path controls
  (previously buried in General → Advanced) are promoted to their own category.
- **Factory reset in Storage.** A confirm-dialog-guarded action that clears the
  locally-saved UI preferences and reloads — without touching your voices,
  projects, or generated audio on disk.
- **Proactive, highlighted "Install" affordance for translation engines.** When
  you pick a Dub translation engine whose optional package isn't installed yet
  (e.g. Google / DeepL via `deep_translator`), the Engine selector now surfaces a
  bright accent **Install** button *before* you hit Translate — no more
  discovering the missing package only via a translate-time 400. On a from-source
  install it one-click installs into the backend's own interpreter; on a
  read-only **packaged build** it opens a popover with the exact `uv pip install …`
  command (copy-to-clipboard), a one-click **Switch to Argos (bundled, offline)**
  escape hatch, and a docs link. The install command is single-sourced in the
  backend registry, so the button and the 400 error can never disagree. New guide:
  `docs/dubbing/translation-engines.md`.

- **A user pronunciation dictionary that actually changes the audio.** Settings →
  General → Pronunciation lets you teach the engine how to say tricky words —
  each entry replaces a term with a respelling (`GIF` → `jiff`) right before
  synthesis, so it works on **every** engine, not just one. Scope an entry
  Global or to a single language (a German rule never fires on an English
  render), with longest-match-first, word-boundary-aware, case-insensitive
  substitution. For one-offs, write `[[word|respelling]]` inline in your text —
  it overrides the dictionary for that occurrence and never persists. A built-in
  Test field previews the substitution with no model call. Pure text transform,
  identical on macOS/Windows/Linux; plain text stays byte-identical, existing
  data upgrades cleanly via an additive migration. (Expressive-TTS Spec 01)

- **Live, faster-than-real-time dictation via a new sherpa-onnx ASR engine.**
  Pick one of seven small ONNX speech-to-text models (Parakeet TDT v3/v2,
  streaming Zipformer EN/ZH/bilingual, streaming Paraformer, multilingual
  Whisper Tiny) for dictation, and watch text appear *as you speak*. Streaming
  models emit partials frame-by-frame and commit a sentence on natural silence;
  offline models surface live partials too by re-decoding a growing buffer.
  Runs CPU-only and identically on macOS, Windows, and Linux — no GPU, no cloud,
  no extra setup beyond a ~75–180 MB one-time model download. Parakeet TDT v3 is
  the recommended default; existing Whisper/MLX/NeMo dictation engines are
  untouched and still the fallback.

- **New "Voice" settings panel for live dictation.** Settings → Capture now
  leads with a Voice card: an Enable Voice Dictation toggle (showing your real
  registered shortcut), a Toggle/Hold mode switch, and a Speech Model dropdown
  that lists all seven models with offline/streaming + recommended badges, size,
  one-line descriptions, the installed checkmark, and inline download/delete —
  reusing the model-store download progress. Picking an uninstalled model starts
  its download and switches to it once ready. **Toggle vs Hold** is wired for
  both the desktop global hotkey and the in-app Ctrl/Cmd+Shift+Space fallback, so
  the behaviour is identical on macOS, Windows, and Linux. While you speak, the
  dictation pill shows the transcript building **live**, and words type straight
  into the focused field *as you speak* — self-correcting with backspaces as the
  streaming recognizer refines, with clipboard-paste as an automatic fallback.

- **Tagged scripts auto-cast into a multi-voice podcast/audiobook.** Paste a
  `[Alice] … [Bob] …` script into Stories and hit Auto-cast: it now recognizes
  the `[Name]` tag format (alongside the existing `NAME:` screenplay and quoted
  prose), builds the cast, and assigns a voice per character automatically.
  Editing one line only re-synthesizes that line on export (the chapter cache
  is content-addressed), and inline markers like `[pause]` / `[voice:…]` are
  never mistaken for speakers. (#487)
- **A dedicated Contact page.** Discord, email, GitHub issues, and the project
  website (palash.dev) as clean one-tap rows, reachable from the footer — so
  reaching the maker is never more than a click away.
- **Live download speed, remaining size, and ETA on first-run setup.** The
  Models & Engines step now shows `38% · 5.2 MB/s · 1.2 GB left · ~3m` while a
  model downloads, instead of a bare "downloading…". (#657)
- **Turn off auto-play of the preview after a render.** New Settings →
  Appearance toggle, "Auto-play preview" (on by default) — switch it off so a
  finished clip doesn't start playing on its own, ideal when batch-generating
  segments. (#666)
- **App version in the status bar, one click from updates.** A `v<version>`
  badge sits by the network icon in the bottom bar; clicking it opens Settings →
  Updates, and it grows a pulsing dot the moment a new version is ready to
  install. (#671)

### Changed

- **Settings is now a sidebar-nav hub instead of an 11-tab strip.** The whole
  page was rebuilt from scratch as a grouped left-rail navigator (with a
  search/filter box) plus a scrollable content pane — the macOS System Settings /
  VS Code layout. Settings are organized into four groups and sixteen
  categories: **General** (Appearance · General), **Voice & Engines** (Engines ·
  Models · Dictation · Pronunciation · Translation), **System** (Performance &
  Device · Storage · Network · Sharing & Remote · Credentials), and **App**
  (Updates · Privacy & Reporting · Logs · About). Every existing control keeps
  its behavior and store/API bindings — this is a reorganization, not a rewrite.
  Typing in the search box filters the category list and jumps to the first
  match, and the rail collapses to a dropdown navigator below 760px so the full
  IA stays reachable on a narrow window. Categories whose changes need a backend
  restart (Models, Performance & Device, Sharing & Remote) carry a "restart
  required" badge.

- **The Settings pages got a full redesign — cleaner, denser, responsive.** A
  shared design system replaces the old patchwork: a left icon nav-rail,
  sentence-case section titles (no more debug-log uppercase), exactly one muted
  description per row, unified toggles/inputs, full-width content with proper
  padding, and horizontal font/theme pickers. Premium and compact instead of
  sparse and cluttered, and it adapts cleanly to window width. (#686, #690, #696)
- **Adding a Hugging Face token on first-run is now a one-line input right by
  Continue.** Was a bulky card buried at the bottom of the model list; it's now a
  compact "paste a token, Save" bar pinned next to the "Waiting for required
  models…" button, so you can add it (for faster, authenticated downloads)
  without scrolling. (#687, #688)
- **First-run setup is calmer and surfaces the best models for your machine.**
  Dimmed and tightened the setup descriptions (less wordy, more compact). The
  "Models & engines" step now shows the **platform-tuned** optional models up-front
  with a green "recommended" tag and their catalog note — e.g. MLX Whisper on
  Apple Silicon, CUDA-tuned variants on NVIDIA — instead of burying every optional
  model behind the fold (the universal long tail still folds).

- **Donations now go through Ko-fi or PayPal (GitHub Sponsors removed).** GitHub
  Sponsors isn't available, so the Support page no longer routes there: pick an
  amount (now $10 / $20 / $50) and then choose Ko-fi or PayPal — PayPal carries
  the amount straight into checkout. `.github/FUNDING.yml` and the README badges
  were updated to match.
- **Simplified the Commercial License page.** Trimmed the six-tile benefit grid
  and FAQ down to the three things that actually drive the decision (you own the
  output, no per-minute cost, direct support) plus one clear "request a quote"
  contact — less wall-of-text, faster to act on.
- **Model downloads are faster out of the box.** The built-in multi-connection
  (segmented) downloader — parallel byte-ranges with live speed/ETA — is now on
  by default, so the legacy-LFS path is no longer single-stream and slow. It
  falls back to the normal download on any error, so it can never compromise a
  correct install (`OMNIVOICE_SEGMENTED_DOWNLOAD=0` to disable). (#669)
- **The Hugging Face token is now front-and-center on first-run.** Was a
  collapsed "advanced" fold almost nobody opened; it's now a prominent card right
  above Continue, framed around what it actually buys you — authenticated, faster,
  more reliable downloads (higher rate limits, fewer stalls) — with a one-click
  "get a free token" link. (#657, #669)
### Fixed

- **Bug reports redact more secrets and every Windows username casing.** The
  opt-in bug-report scrubber now catches more credential shapes (JWT/Bearer,
  Google, Slack, AWS keys, and `?token=`/`?api_key=` URL secrets), redacts
  Windows home paths regardless of `Users`/`users` casing, and stops a superstring
  username (`/Users/john` vs `/Users/johnny`) from leaking a fragment. The
  prefilled-issue URL is now bounded by its *encoded* length so a large report
  can't silently truncate. Nothing new leaves the machine — this only makes the
  existing local-first, user-reviewed report stricter. (#856)

- **A hung TTS generate can no longer brick the backend ("Can't reach the local
  backend").** A GPU job that wedges on some Windows + CUDA setups occupies its
  worker forever — Python can't cancel the thread — so on the 1–2 worker pools we
  ship, one stuck job starved every other request and the next action surfaced as
  the misleading "Can't reach the local backend" even though the process was
  alive. ASR/dub/model-load already bounded and reset the pool on hang (#730); but
  **every generate path** — Studio synthesis, the streaming path, batch, the dub
  per-segment + preview render, archetype previews, and the OpenAI-compatible
  `/v1/audio/speech` API — was still an unguarded GPU dispatch, and the residual
  reports all failed on `generate:start (audio)`. Every one is now bounded by the
  same wall-clock guard (`OMNIVOICE_GENERATE_TIMEOUT_S`, default 300s) that
  abandons the wedged worker and rebuilds the pool, so capacity is restored
  automatically and you get an actionable timeout instead of a dead backend.
  Closes the whole class of GPU-job-hang reports (#851 — #850, #802, #755, #723,
  #721, and the 0.3.7 cohort, all tracked in #730).

- **An unsupported GPU now falls back to CPU instead of 500-ing every generate.**
  When the installed PyTorch build has no kernels for your GPU's compute
  capability — a too-old card (Pascal / GTX 10-series) or a too-new one
  (Blackwell RTX 50-series on pre-cu128 wheels) — CUDA failed at launch with the
  cryptic `CUDA error: no kernel image is available for execution`. The backend
  now detects that up front and runs on CPU (slower, but it works), and any raw
  occurrence is reported as "your GPU isn't supported — switch to CPU or install a
  matching PyTorch," not a Flush-the-memory dead end. Force the GPU anyway with
  `OMNIVOICE_FORCE_CUDA=1`. (#756)

- **The "TRANSLATION FAILED" banner now dismisses and clears itself.** The Dub
  translation-error banner used to be sticky — it survived a successful re-try and
  never went away. It now has a close (×), auto-clears on the next corrective
  action (re-translating, changing the engine, or installing the package), and
  self-clears after a short timeout — fixing the whole class of translate/pipeline
  banners that outlived the state that caused them.

- **Dubbing a video URL no longer fails with "ffmpeg is not installed."** yt-dlp
  downloads video and audio as separate streams and muxes them with ffmpeg, but
  it only looked on PATH — so on Windows (where OmniVoice's ffmpeg is a bundled
  sidecar / `imageio-ffmpeg` binary off PATH) the merge aborted before the dub
  could start. yt-dlp is now pointed at the same ffmpeg OmniVoice resolves. (#712)
- **A synth that succeeded no longer 500s because of a history-logging hiccup.**
  If the local database somehow missed schema init, recording the clip to
  generation history failed with *"no such table: generation_history"* and
  surfaced as a 500 — even though the audio had already been generated and saved.
  The write now self-heals the schema and retries, and a history-logging failure
  never fails the generation: you get your audio regardless. (#710)
- **Long-video dubs no longer spike RAM during assembly.** Dub generation used
  to hold every segment's audio in memory until the whole track was mixed, so a
  50-video batch or a single feature-length dub could exhaust RAM and crash. Each
  segment now streams to disk as it's rendered and the final track is assembled
  from those files via a 30s-chunk memmap writer, keeping memory flat regardless
  of video length. Per-segment download WAVs and the final track stay correctly
  watermarked (marked once at synthesis, no double-mark), and zero/negative-length
  segments no longer crash the run. (#639)
- **A corrupt or wrong-architecture native component no longer masquerades as
  "out of memory."** A synth failure caused by a bad `.dll`/`.pyd`/`.exe` on
  Windows (`[WinError 193] %1 is not a valid Win32 application` — e.g. torch,
  ffmpeg, or an engine binary) was labelled *"ran out of memory — try Flush,"*
  sending users down the wrong path. It now says the component is corrupt or
  built for the wrong architecture and to reinstall/repair it. (#705)
- **A "[Errno 32] Broken pipe" mid-generation no longer poses as "out of
  memory."** When the desktop app that launched the backend closes or relaunches,
  the backend's output pipe breaks and a synth can fail with `[Errno 32] Broken
  pipe`. That was labelled *"ran out of memory — try Flush,"* which never helps;
  it now tells you the backend lost its pipe and to restart the app. (#715)
- **Settings content no longer sprawls or spills out of view.** The content
  column capped at 1280px, so on wide windows rows stretched edge-to-edge with a
  big empty gap between each label and its control ("too spread out"), and a few
  panels (API keys, the shared button rows, appearance scale) used rigid pixel
  widths that pushed controls past the card's padding on narrow content. Now the
  content sits at a readable measure (a single `--settings-measure` token), the
  shared button/badge rows wrap instead of overflowing, rigid widths can shrink,
  and rows decide whether to sit side-by-side or stack based on their **actual**
  width (a container query) — not the viewport, which the 168px nav rail skews.
  Everything stays inside its padding, edge to edge, on every width. (#696)
- **File drag-and-drop works on macOS again.** The app's drop zones use HTML5
  file drops, but Tauri intercepts OS drag-and-drop by default (`dragDropEnabled`)
  and swallowed the files before the webview saw them — most visibly on macOS
  WKWebView, and fully broken on macOS 26 (Tahoe), where dropping a file did
  nothing. Disabled the interception so the webview handles native HTML5 drops
  on every platform. (#700)
- **A misconfigured `OMNIVOICE_MODEL` no longer bricks model load with a 500.**
  A stale or leaked TTS *engine id* (e.g. `omnivoice`) reaching the model loader
  used to fail every launch with *"omnivoice is not a local folder and is not a
  valid model identifier."* It now self-heals — only a real HF repo id
  (`org/repo`) or an explicit local path is honored; anything else falls back to
  the default with a logged warning. Every consumer of the setting routes through
  the same resolver, so a bad value also can't silently disable model warm-up,
  mislabel the Settings checkpoint, or get baked into an exported persona bundle.
  (#693)
- **ASR no longer crashes the dub/transcribe preflight when CTranslate2's native
  library can't load.** On hardened kernels / newer glibc (e.g. WSL2) the
  CTranslate2 `.so` is rejected with *"cannot enable executable stack"* — an
  OSError the WhisperX/faster-whisper checks didn't catch, so it took down the
  whole preflight. They now report the engine as unavailable and auto-detect
  falls back to PyTorch-Whisper instead of dead-ending. (#692)
- **A wedged transcription can no longer take the whole backend offline ("Can't
  reach the local backend").** On some Windows + CUDA setups a whisperx/CTranslate2
  transcribe hangs hard and never returns. Because ASR shares a small (1–2 worker)
  GPU pool with TTS, one stuck worker starved every other request — so the next
  thing you did (often a TTS *generate*) failed with "can't reach backend" even
  though the process was alive. Two fixes: every transcribe path — whole-file
  (dub whole-file, batch, live dictation) **and** the chunked dub stream — is now
  wall-clock **bounded** like the dub QC / dictation / OpenAI paths already were;
  and on timeout the poisoned GPU worker is **abandoned and the pool rebuilt**, so
  capacity is restored without restarting the app. You still get an actionable
  message (Flush VRAM / pick a smaller ASR model) for the durable fix. (#730)
- **The stale-dub-session recovery now also covers the first upload/ingest, not
  just retry/import.** A dubbing job that vanished server-side during the initial
  transcribe flow showed the scary *"Job not found … report a bug"* toast; it
  now resets gracefully and invites a fresh upload, like the other paths. (#695)
- **In-app preview of finished audiobooks/stories now plays on Windows.**
  The preview decoded the entire render into one in-memory PCM buffer via Web
  Audio `decodeAudioData`, which fails on long-form `.m4b`/AAC under WebView2
  (`EncodingError: Unable to decode audio data`), and the blob-URL fallback can't
  play in a Tauri `<audio>` element — so nothing played. The fallback now uploads
  to the preview endpoint (ffmpeg-extracts a streamable WAV) and plays the HTTP
  URL, the same path video previews use. Short TTS previews are unchanged. (#653)

- **First-run setup splash no longer shows a raw `bootstrap.lines` key in English.**
  The log-line counter string was present in 4 locales but missing from the `en`
  reference, so English (and 16 other locales falling back to it) rendered the
  literal key instead of "{{count}} lines". Added it to `en`. Also removed 160
  dead `gallery.cat_*` keys (renamed to `archetypes.use_*` long ago) orphaned
  across 20 non-English locales, clearing the i18n orphan-key advisory.

- **Backend no longer hangs on startup (unreachable, no error) on Apple-Silicon Macs.**
  The MCP session manager could hang on its anyio task group during lifespan
  startup (observed on M1, #632); because that start was awaited before the server
  began serving, "Application startup complete" never fired and the whole backend
  was unreachable. The MCP start is now timeout-bounded (`OMNIVOICE_MCP_START_TIMEOUT_S`,
  default 30s) — a hang becomes a logged warning and the backend serves normally
  without MCP, instead of wedging. (#632)

- **Dubbing a URL no longer fails with `[Errno 22] Invalid argument` on Windows.**
  yt-dlp stamps the downloaded file's modified-time with the video's upload
  date; an out-of-range/invalid timestamp makes the `os.utime` call raise
  `[Errno 22]` and aborts the whole URL ingest. OmniVoice downloads to a throwaway
  file and never uses its mtime, so it now skips the stamp entirely
  (`updatetime=False`). (#642)

- **Dubbing a YouTube link that 403s now retries with a different player
  client.** Some videos serve their formats signature-protected to the default
  player client, so the media download fails with `HTTP Error 403: Forbidden`
  even though extraction worked — and a plain retry keeps 403ing. The URL
  download now escalates the YouTube player client (tv → android → web_safari)
  on a 403, which commonly bypasses it, before surfacing the actionable error.
  (#625)
- **A synth glitch that produced unreadable audio is now caught instead of a
  misleading "out of memory".** A numerical glitch in the model (seen on Apple
  Silicon/MPS) could leave NaN/∞ samples, which wrote a WAV that then failed
  decoding with an opaque `ffmpeg returned error code: 183 / Invalid data` — and
  the generic error handler labelled it "ran out of memory". Non-finite samples
  are now sanitized to silence before any encode (so the WAV is always
  decodable), and a genuine decode failure is reported as "unreadable audio —
  Flush and regenerate", not OOM. (#629)
- **A silent startup hang now leaves a diagnostic instead of nothing.** On some
  setups the backend could load all model weights and then hang forever before
  "Application startup complete" — no error, no crash, an unusable app (reported
  as a Mac M1 hang after `Loading weights: 527/527`, #632). A startup watchdog
  now dumps every thread's stack to the error log if startup stalls past a
  window (default 5 min, `OMNIVOICE_STARTUP_WATCHDOG_S` to tune, `0` to disable),
  so the deadlock is captured rather than invisible. It's disarmed the instant
  startup finishes, so a normal (even slow-first-download) boot never trips it.
  (#632)
- **First-run demo voice is back.** The bundled demo clip
  (`backend/assets/samples/demo_voice.wav`) was a build artifact that never got
  committed, so it shipped absent — onboarding logged "Demo audio not found" and
  seeded nothing, leaving a brand-new install with an empty Launchpad and no
  `/demo_audio` route. The clip is now committed (it's already un-ignored and
  bundled via the Tauri `backend` resource), so first-run seeds the demo voice
  on every platform; onboarding still degrades gracefully (with a regenerate
  hint) if it's ever absent. (#621)
- **Multi-speaker dubbing: two speakers' turns merged onto one line are now
  split apart.** Segmentation groups words into sentences *before* diarization
  runs, so a back-and-forth exchange could land in a single segment; the speaker
  pass then only *relabelled* that segment with its majority speaker, losing the
  turn boundary (the second half of #486; the per-speaker voice auto-assign was
  fixed earlier in #490). A new post-diarization pass re-splits any segment whose
  words span more than one speaker at the word-level boundary, assigning each
  piece its own speaker. Single-speaker segments pass through **byte-for-byte
  unchanged**, so single-speaker dubs and their timing never move, and a lone
  mis-attributed word (diarization noise) is smoothed rather than causing a
  spurious split. (#486)
- **Designed voices saved with a bad style no longer render wrong or crash
  generation.** A designed voice could persist an `instruct` the engine
  validator rejects — either the literal `"[object Object]"` from an old build,
  or freeform prose typed into the style field — which made every generation or
  dub that used the voice fail with `Unsupported instruct items found in …`
  (surfacing to users as a 400/500 and, when it tore down mid-render, "Can't
  reach the local backend"). The previous fix only *blanked* `"[object Object]"`,
  which silently dropped the design — so an Indonesian **female** voice came out
  **male**. Now the stored instruct is sanitized down to valid tags at every
  seam (save, edit, and when a profile drives Generate or Dub), and when the
  stored value is unusable the tags are **rebuilt from the design's saved
  category picks (`vd_states`)** so the intended gender/age/pitch/accent survive.
  A migration (0007) heals existing poisoned profiles in place — no reinstall,
  no manual fix. (#550 #571 #594 #596)
- **"Transcribe stream dropped … Likely ASR backend failed to load" now shows
  the *real* reason.** When transcription failed to load its ASR model (the
  reported case was WhisperX on Windows — typically a faster-whisper /
  CTranslate2-cuDNN mismatch, a missing model download, or the torch-2.6
  weights-only VAD regression), the UI dead-ended on a generic "stream dropped"
  message with no actionable cause. Two root causes: (1) WhisperX loads lazily
  *inside* transcription, so the load failure was buried in per-chunk errors and
  retried on every chunk; the transcribe pre-flight now eagerly loads the ASR
  model (new `ASRBackend.ensure_loaded()`), surfacing the genuine cause once, up
  front, as a structured error. (2) Pre-flight and audio-load errors closed the
  SSE stream with a bare `error` and no terminal `done`, so the browser's native
  EventSource connection-drop could race and win against the structured error —
  discarding the real cause and falling back to the generic message; every
  terminal error now emits `done`, and the frontend latches the structured cause
  so a connection drop can't overwrite it. Net: WhisperX load failures are
  diagnosable instead of a silent dead-end. Fail-before/pass-after regression
  test included. (#578)
- **Dubbing: the PLAY button on the dubbed-video preview did nothing.** Same
  autoplay-policy trap that #510 fixed for the standalone audio player, but the
  dub editor's timeline player was missed. WaveSurfer builds its `AudioContext`
  at mount — before any user gesture — so on Windows WebView2 (and Linux
  Firefox/Chrome, Android Chrome) it stays `"suspended"`; `playPause()` then
  resolves with no sound and the preview just sits there. Every playback entry
  point in the dub timeline (the toolbar Play button and the per-segment "play
  this slot") now resumes the context via the shared `unlockAudio()` on the
  click before starting playback, and swallowed play() rejections are logged
  instead of hidden. A source-contract regression test pins the invariant so a
  future refactor can't quietly reintroduce a silent play path. macOS is
  unaffected (its context was never blocked). (#595)
- **Voice design: the script text field couldn't be expanded.** The Script
  textarea was a `flex: 1` item inside a flex column, so flex-grow recomputed
  its height on every reflow and snapped the user's drag back — `resize:
  vertical` is silently ignored on a flex-grown item in Chromium/WebView2. The
  field now owns its own height (starts taller, and the corner grip grows it
  reliably on every platform). (#595)
- **An interrupted model download now self-repairs instead of dead-ending.**
  When the OmniVoice TTS cache was missing weight shards (the usual aftermath of
  an interrupted first download), the next synthesize failed with a 500 and a
  "delete the model and install it again" instruction — a manual dead-end. The
  backend now detects the truncated-cache error on load, re-fetches just the
  missing files via `snapshot_download` (already-present blobs are skipped, so a
  near-complete cache repairs in seconds and a healthy cache is never touched),
  and retries the load automatically. Offline mode (`HF_HUB_OFFLINE`) is
  respected — repair never makes a network call the user opted out of — and if
  the re-fetch still can't fix it, the actionable delete-and-reinstall message
  is preserved as the fallback. (#581) The repair now also **retries** the
  re-fetch (3 attempts, resuming each time) so a single transient blip — the very
  thing that interrupts a download in the first place — doesn't bounce you back
  to a manual reinstall; tune with `OMNIVOICE_MODEL_REPAIR_RETRIES`. And if a
  resume-repair still won't load — the signature of a *corrupt* file that kept
  its size, which a resume trusts and never re-fetches — it now **force
  re-downloads** the model files once before giving up, so even a bit-rotted
  cache self-heals without a manual reinstall. (#739)
- **Dubbing a YouTube URL no longer dies on a transient "Broken pipe."**
  Pasting a video link could fail outright with `download: Unable to download
  video: [Errno 32] Broken pipe` — a broken pipe raised while the write side of
  a pipe closes mid-stream (a killed ffmpeg merge child, a CDN reset during
  muxing). yt-dlp's own per-fragment retries don't cover that case, so a single
  transient blip aborted the whole ingest. The URL download now retries up to
  twice on broken-pipe / network-drop failures, wiping the partial download
  between attempts, and only surfaces the (already-actionable) "connection
  dropped — just retry" hint after the retries are exhausted. Unsupported links
  still fail fast with their own hint — no wasted retries. (#579, #598)
- **`No module named 'omnivoice'` on installs whose venv lost its editable
  record.** An interrupted or offline `uv sync` (common during an in-place
  upgrade) could install all dependencies yet never lay the editable install of
  the project's own `omnivoice` package — or an antivirus quarantine could
  remove it. The venv still started uvicorn, so the bootstrap's health gate
  passed it through, and the app only failed at the first generate/dub with
  `No module named 'omnivoice'`. The bootstrap now also verifies `omnivoice` is
  importable (via a cheap `find_spec`, no torch load) and forces a repair
  `uv sync` that re-lays the editable install when it isn't; the backend also
  resolves `omnivoice` from its bundled source tree at runtime as a safety net.
  No reinstall needed — relaunch and it self-repairs. (#564)
- **"cannot schedule new futures after shutdown" no longer breaks generate/dub
  after a slow first load.** When a model load timed out, the backend reset its
  GPU worker pool to recover — but several request handlers had captured the old
  pool object at import time and kept submitting to it, so every subsequent
  generate, dub, transcribe, or translate failed with `cannot schedule new
  futures after shutdown` (a 500, or "Can't reach the local backend" when it
  took the worker down). The GPU pool is now a single self-healing handle whose
  worker pool is rebuilt on demand, so a reset can never strand an in-flight or
  later request. No settings change; the recovery is automatic. (#589 #599)
- **Transcription / dubbing works on Windows again.** WhisperX failed to load on
  Windows because speechbrain's guard that suppresses stray optional-integration
  imports used a POSIX-only path check, so a `k2_fsa` import error aborted the
  whole transcription. Fixed cross-platform — covers the entire class of optional
  integrations, not just k2. (#630 #611 #647)
- **A slow transcription no longer looks like a dead backend.** Whole-file
  transcribe paths (dub QC, dictation, OpenAI-compat) ran unbounded, so a
  VRAM-starved `large-v3` could spin for minutes and hold a GPU worker — surfacing
  as "Can't reach the local backend". They're now time-bounded and return a clear,
  actionable 504 (free VRAM / pick a smaller ASR model / use CPU) instead of
  hanging. New troubleshooting section documents it. (#656)
- **Windows preview playback fixed.** The audiobook/clone preview's streaming
  fallback fetched `localhost`, which on Windows resolves to IPv6 and missed the
  IPv4-only backend — so previews failed with "decode error" / "no supported
  sources". The preview API now targets `127.0.0.1` (matching the main client),
  and the expected decode→stream fallback is logged calmly instead of as a scary
  error. (#653 #659)
- **A stale dub session resets cleanly instead of erroring.** Reopening the Dub
  tab after the backend restarted tried to resume a job that no longer existed and
  surfaced "Job not found" as a bug-report error. It now quietly clears the dead
  session and invites a fresh upload. (#660)
- **A bad voice-style instruct is a clear 400, not a scary 500.** Typing free-form
  prose (or a non-English description) into the style/instruct field returned a
  500 telling you to Flush for memory you never ran out of; it now returns a clean
  400 that lists the valid style tags. The Voice Clone UI also drops unrecognized
  style text locally and generates anyway. (#664 #612)
- **The ⊕ Insert token popover stays on screen.** On Voice Clone it could grow
  tall enough to clip off the top of the window; it's now a compact, scrollable
  box anchored above the button. (#672)
- **First-run no longer hangs on Apple Silicon.** The MCP session-manager startup
  is now timeout-bounded so a slow/stuck mount can't wedge the whole backend boot
  on M1. (#632)

### CI

- **Feature-coverage test system.** A backend route-inventory test diffs all 213
  HTTP/WebSocket endpoints against a committed snapshot (plus a critical-endpoint
  guard and a route-count floor), and a frontend feature-coverage test asserts
  every app mode is wired to a page and every feature has its i18n namespace — so
  an endpoint or page silently disappearing now fails CI on every PR.
- **`bun desktop` no longer kills its own dev backend.** The dev launcher runs the
  API and the Tauri app side-by-side, but the app's backend manager would "take
  ownership" of port 3900 and kill the API the moment it booted (before it was
  healthy), tearing the whole session down. The dev app now sets
  `TAURI_SKIP_BACKEND` so it attaches to the running API instead of fighting it —
  production launch is unaffected. (#745)

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
