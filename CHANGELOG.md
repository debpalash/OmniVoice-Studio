# Changelog

All notable changes to OmniVoice Studio.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).
Versions track the desktop app (`tauri.conf.json` + `frontend/src-tauri/Cargo.toml`).
The bundled TTS model package (`pyproject.toml`) is versioned independently.

## [Unreleased]

### Added

- **IndexTTS-2 installs itself now — one click in Settings → Engines.** The emotion-controlled cloning engine used to demand four terminal steps (clone the repo, create a venv, `uv pip install`, set an environment variable); the row now has an Install button that does all of it — source fetch (git, with a no-git tarball fallback), an isolated venv that keeps its `transformers<5` away from the app, the ~6 GB model weights (via your configured/auto-selected Hugging Face endpoint), and configuration — with step-by-step progress, a disk-space check before anything is written, and resumable repair if anything is interrupted. The engine is usable the moment the job finishes, no restart; existing manual installs are detected and left untouched, and the manual steps remain as a collapsible fallback. The provisioner is parametrized so future sidecar engines (MOSS-v1.5, dots.tts, Confucius4) can reuse it. (#1083)

- **Model downloads now find a reachable Hugging Face endpoint on their own.** On networks where huggingface.co is blocked or slow (the class of first-run dead-ends behind #984), the app quietly probes the official endpoint and the hf-mirror.com community mirror, picks whichever actually works, remembers the choice, and re-checks only when a download fails or the pick goes stale — so a restricted-network first run reaches a working voice instead of a wall of connection errors. Anyone who already set a mirror (env var, pref, or Settings) stays exactly where they pointed: explicit choices are never auto-switched, and Settings → Models → Hugging Face mirror now shows the automatic pick with its measured latency plus a "Test again" button. Probes only touch the two download hosts — no geo-IP, no telemetry — and every download stays checksum-verified by `huggingface_hub` regardless of endpoint.

## [0.3.17] — 2026-07-11

The polish release. The dubbing workspace can no longer trap you — an interrupted dub session used to relaunch into an eternal spinner that even reinstalling couldn't clear (thank you @nanai97 for the screenshot that cracked it). A 58-finding audit of every Settings panel got fixed end to end, **FFmpeg and yt-dlp stopped being your problem** (the app provisions its own, with a new Audio tools panel when you want control), the Engines and Models pages went compact and tabbed, the launcher stopped trusting half-dead backends, and the app finally opens at 100% scale.

### Added

- **FFmpeg, FFprobe, and yt-dlp stopped being your problem.** The setup wizard no longer lists them as system requirements with "brew install" homework — the app provisions them itself: shipped installs already bundle them, and when nothing is found the backend downloads its own checksum-pinned static build in the background, showing a single actionable card only if that fails. A new **Settings → Audio tools** panel gives back the control: per-tool version and origin (App package / Bundled / System / Custom), update / use-system / choose-file / restore-bundled — and **one-click yt-dlp updates** that survive app upgrades, because video-site support changes faster than releases. Install docs updated to match. (#1071)

- **The Engines and Models pages got compact and tabbed.** Engines is now one section with TTS / ASR / LLM tabs; every engine is a strict two-line, fixed-height row with truncated text and aligned status / GPU / isolation / action columns, so the whole engine list fits one screen — details like "Why unavailable?" expand below the row instead of stretching it. Models rows tightened the same way. (#1072)

- **The Engines and Models pages got a full readability-and-features pass.** Every engine row now carries a small identity mark and honest capability badges (voice cloning, device routing with the reason on hover, sidecar isolation), and engines that are ready-but-have-advice finally say so — upgrade hints used to be dropped before reaching the UI. The model store gains a filter, disk-space context next to downloads, "in memory — safe to unload" indicators, copyable setup snippets for opt-in engines, and empty states that tell you what to do next. (#1058)

### Fixed

- **The app no longer attaches to a "zombie" backend that looks alive but fails everything.** If a backend process survived while its install was replaced or deleted underneath it, it kept answering health checks from memory — so the next launch attached to it and every real request failed with a confusing access-control error. The launcher now runs a deeper probe (an endpoint that actually touches the database) before attaching, and replaces any backend that fails it. The local dev/test scripts also now terminate running instances before wiping data, which is how this state was produced. (#1077)

- **The app opens at 100% scale by default.** New installs rendered everything at 130% zoom, which read as oversized on typical displays. Fresh sessions now start at native size; if you already picked a scale in Settings → Appearance, your choice is kept. (#1074)

- **The app no longer relaunches into a dead "generating" dub session — the blank-pane-and-spinner trap.** The saved dub session was restoring its in-flight state verbatim: quit (or crash) while a dub was generating and every subsequent launch waited forever for work that died with the process — and reinstalling couldn't clear it. Interrupted sessions now reopen on the segment editor with all your work intact (or the upload screen if nothing was transcribed yet). Thanks to @nanai97 for the screenshot that told the whole story. (#1067)

- **A 58-finding audit of every Settings panel, fixed end to end.** Highlights: the About page linked to the wrong project's GitHub; Arabic rendered left-to-right (RTL wiring was missing); a saved proxy could never be cleared after a reload; the HF-mirror and refinement panels vanished entirely when the backend was down; "Test now" on the HF token served five-minute-old cached results; factory reset only cleared part of what it promised; pronunciation previews ignored language-scoped entries; the hotkey recorder swallowed invalid presses in silence; Settings search could strand you with an empty sidebar — plus first component tests for previously untested panels, full i18n for five all-English panels, accessible names across inputs, confirmed destructive actions, deep links instead of dead-end advice, temp-file reclaim, and log-sharing workflows. (#1059, #1060, #1061, #1063, #1064)

## [0.3.16] — 2026-07-11

The quality release. Three long-standing frictions got structural fixes: **regenerating no longer destroys good takes** (a takes rail with starring and restore), **audiobooks stop redoing finished work** (per-sentence caching — edit one line, re-render one line; crashes resume where they stopped), and **dub translations stay consistent and fit their timeline** (auto-glossary + a naturalness pass, plus fit prediction before any GPU time is spent). Under the hood, every text path now speaks numbers, times, and abbreviations correctly, the VoxCPM2 engine gained upstream-alignment guards, and a Windows first-run breaker — model downloads completing but the cache ending up with broken file links — now self-heals automatically. Thank you @dmnobunaga for the razor-sharp diagnosis on that last one.

### Fixed

- **Windows: model downloads that finished but wouldn't load now repair themselves.** On machines without Developer Mode, the model cache could end up with all its multi-gigabyte files downloaded but the snapshot's file links broken — and the app reported a misleading "does not appear to have a file named model.safetensors". The app now detects the broken links on load failure, restores just the missing pieces (reusing everything already downloaded, and falling back to real file copies where links can't be trusted), and retries once; if repair is impossible, the error finally names the actual cache folder to delete. Root-caused in the wild by @dmnobunaga — thank you. (#1056)

- **VoxCPM2: cloning reference clips are now conditioned, and outputs lose their silent tails.** Reference audio used to reach the model completely raw; it now gets edge-silence trimming and a 30-second cap (fail-open — short clean clips pass through untouched), and generated audio gets a trailing-silence trim. The install hint also moved to `voxcpm>=2.0.3`, which carries an important Apple-Silicon audio-quality fix — older installs keep working and see an upgrade hint in the logs. (#1055)

- **Streaming TTS requests without an `emo_alpha` field no longer crash.** A minimal `/ws/tts` request hit a `KeyError` and returned an error frame instead of audio — found while giving that route its first tests. (#1054)

- **Long generations no longer risk a multi-gigabyte memory spike while being watermarked.** The invisible watermark (on by default) pushed the entire waveform through AudioSeal in a single call, and its memory use grows with audio length — a multi-minute generation demanded a single ~2 GB allocation, enough to fail outright on a 16 GB machine already holding a model ("DefaultCPUAllocator: not enough memory"). Watermark embedding — and the Verify-audio detector, which had the same flaw with uploaded files — now processes audio in ~30-second chunks, so peak memory stays flat no matter how long the audio is. Detection also got sharper for spliced files: it now reports the strongest chunk instead of a whole-file average. (#1045)

- **The ⊕ Insert token list no longer climbs out of the viewport.** In the voice-clone script panel, the insert popover (expression tags, CMU phoneme chips) always opened *upward* from the textarea — and since that input sits at the very top of the panel, the list disappeared past the top of the window with no way to see or scroll it. It now opens below the input, where there's always room. (owner-reported)

### Added

- **Edit one sentence, re-render one sentence.** Audiobook and Stories renders now cache every synthesized sentence individually (content-addressed, under the existing chapter cache): fixing a single line in a chapter reuses all the untouched audio, and an interrupted render — crash, quit, power loss — resumes from the sentences that already finished instead of redoing the whole chapter. One byte cap bounds both cache layers, and chapter caches from released versions keep working. (#1048)

- **Numbers, times, and abbreviations are spoken correctly in every engine.** A conservative normalization pass now runs before TTS everywhere (Studio, dubbing, audiobooks): "3:30" is read as a time, "2" as "two" (29 languages), "Dr." as "Doctor" — while stray control characters and markup remnants that trigger engine hallucinations are stripped. Deliberately cautious: when a rewrite could be wrong, the text is left alone, and your pronunciation-dictionary entries always have the final say. Toggleable (`text_normalization_enabled`, default on). The OpenAI-compatible API, streaming TTS, and the batch queue run the same pass, so every door into the engines speaks text identically. (#1049, #1054)

- **Dub translations stay consistent and sound natural (LLM engine).** Before translating, one pass over the whole transcript builds a terminology glossary (your manual glossary entries always win) that rides along on every segment, so names and terms stop drifting mid-video. After each segment's direct translation, an optional reflect pass critiques and rewrites stiff lines into natural spoken dialogue — any failure silently keeps the direct translation. Both toggleable in the Dub tab; the reflect toggle states its 3-calls-per-segment cost. (#1050)

- **The Dub tab now predicts which lines won't fit — before wasting GPU time on them.** After translation, each segment gets a duration estimate (self-calibrating to your engine and language from the segments already rendered) and a "Tight fit" or "Won't fit +Ns" badge when the dubbed audio can't match the timeline even with speed-up. An opt-in "Suggest shorter lines" option asks the LLM for a meaning-preserving shorter rewrite you can apply per segment — never applied automatically. (#1051)

- **Generation takes: star the good ones, restore any of them.** Regenerating no longer means losing the previous result — recent takes appear in the workspace history with replay, star/unstar, and one-click restore as the active output. History is now capped (Settings → Storage, default 200 takes): the oldest unstarred takes are pruned, starred ones are kept forever, and an audio file is only deleted when nothing else references it. (#1052)

- **A persistent mini-player for all the audio that used to play "invisibly".** Generated output, voice-profile and dub-segment previews, story lines, Gallery voices, and Projects renders all played through a bare audio pipe — no waveform, no seek, no time, and (until v0.3.15's stop pill) no way to stop them. A slim player bar now docks above the Logs footer whenever such audio plays, on every page: live waveform (decoded once from the audio already in memory — nothing is re-fetched), click/drag/keyboard seek, play/pause, elapsed/total time, what's-playing label, and a stop button. It replaces the stop-only pill, and because it's part of the app's layout rather than a floating overlay, the pill's "covers the Production Overrides row at 1440×900" overlap class can't come back. Stories line previews also route through it — which makes them stoppable *and* fixes them being silent on the macOS/Linux desktop builds (their old playback path used blob: URLs, which WebKit refuses to play). (no issue — owner request following #1032's stop-pill band-aid)

## [0.3.15] — 2026-07-10

The cold-start release. Three "why is this broken on my machine" mysteries got solved at their roots: **first generations stop dying at 300 seconds** (the timeout was counting the model download as generation time — @moduvoice measured it on a Tesla T4: 0% GPU for the full window), **updates stop deleting engines you installed yourself** (the updater's dependency sync removed anything not in the app's lockfile — including things our own UI told you to install), and **the "slower than v0.3.5" regression is found and fixed** (clone profiles without a transcript were silently re-running a full Whisper transcription on every single generate). Also: Clear History is back, auto-played audio is finally stoppable, @stronghamjji hardened the dub pipeline against wedged transcribes, and @shakib30's community Colab notebook is now the linked no-GPU path. Thank you all.


### Added

- **Agent Skills: `npx skills add debpalash/omnivoice-studio`.** Two installable [skills](https://skills.sh) now ship in the repo — `omnivoice` teaches any AI agent (Claude Code, Cursor, Codex, …) to speak and transcribe through your local install via the OpenAI-compatible API, including your cloned voices; `oss-maintainer` packages the maintainer methodology this project is run with.

### Fixed

- **A fresh install's first generation no longer dies at 300 seconds while the model is still downloading.** The generate timeout was one clock around everything — including the engine's lazy multi-GB weight download on a cold start — so first requests burned the whole budget on the download (0% GPU the entire time, as a contributor's Tesla T4 verification measured) and failed with a misleading "too heavy for the available compute" error. Model loading now runs first under its own, much larger budget; the generate clock starts only once the engine is warm. A genuinely stalled download gets a new error that says so and points at Settings → Models. (#1033, #1037, evidence from #1014)
- **The OpenAI-compatible speech endpoint stops silently discarding quality settings.** `POST /v1/audio/speech` accepted `num_step` and `guidance_scale` in the request body with a 200 OK — and dropped them without a word, so API callers couldn't reach the model's documented quality preset (`num_step: 32`). Both are now declared, validated, and passed through to the engine, matching the native `/generate` endpoint. Caught by a contributor's measured Tesla T4 verification pass. (#1014)
- **Updating no longer uninstalls engines you added yourself.** Optional engines installed with pip into the app's environment (VoxCPM2, KittenTTS — exactly what Settings → Engines' own install hints say to do) were silently deleted by every app update, because the update's dependency sync removed anything not in the app's lockfile. Routine updates now leave your additions alone; the repair path ("Clean & Retry") still restores the exact known-good state, since a broken environment is sometimes *caused* by an extra package. (#1029)
- **Voice cloning stops re-transcribing the same reference clip on every generate.** Since v0.3.6, a profile saved without a transcript (the default) triggered a full ASR model load *plus* a transcription of the reference on every single synthesis — the "TTS got much slower than v0.3.5, same settings" regression. The first auto-transcription is now saved onto the profile, and repeated ad-hoc uploads of the same clip reuse a content-keyed transcript cache — so the cost is paid once, not per request. A transcript you typed yourself is never overwritten. (#1032)
- **The Clear History button is back.** The workspace redesign moved generation history into the right-side panels but dropped the old sidebar's clear-all control, leaving one-by-one deletion as the only way to empty a long history. Both the Voice and Dub history panels now have a Clear History button (with a confirmation), scoped to that workspace's history. (#1032)
- **The audio that auto-plays after a render can finally be stopped anywhere.** The finished-render playback has no on-screen player, and the only stop control lived in the Voice workspace's action bar — audio started from the Dub workspace, a profile preview, or after navigating away simply played to the end. A stop button now appears above the status area whenever such playback is active, on every page. The existing Settings → Appearance "Auto-play preview" toggle now also governs this playback, as its description always promised. (#1032)

## [0.3.14] — 2026-07-09

A fast follow to v0.3.13: **every engine family now has a visible picker.** Settings → Engines showed only a TTS table, with the ASR and LLM pickers hidden behind a low-discoverability tab — so the 10 transcription engines (including the new OpenAI-compatible backend) looked unswitchable without env vars. Now all three families get their own table. Also in: the Linux AppImage's white-screen auto-workaround now checks the WebKitGTK it actually ships (not whatever your system reports), and installing to a different drive on Windows is properly documented.

### Added

- **ASR engines get the same Settings picker TTS has.** Settings → Engines now shows a visible picker table per family — TTS, ASR, and LLM — instead of a single TTS-titled table with the other families tucked behind a tab (README even promised a Settings ASR picker that didn't exist). The OpenAI-compatible backend and the 9 local ASR engines become selectable with one click, no env vars needed; an explicit `OMNIVOICE_ASR_BACKEND` still wins over the Settings pick, so pinned setups behave exactly as before. (no issue — UX gap found during #877)

### Fixed

- **The Linux AppImage's white-screen auto-workaround now checks the right WebKitGTK.** The launcher decided whether to apply the compositing workaround by asking the *system's* `pkg-config` — but the version that actually runs is the *bundled* one, which the AppImage prioritizes. On any machine where the two diverge (e.g. building from source with newer dev packages installed), the detection read the wrong number and could skip a workaround the running library needed. The build now stamps the bundled version into the AppImage at package time, and the launcher reads that stamp — correct by construction. The launcher's shell tests also now run in CI, which they previously never did. (#961 follow-up)

### Docs

- **Windows: installing to a different drive is documented** — the wizard's directory picker works for any local drive; mapped network drives are a Windows Installer limitation (not installable-to by design); and the big data (models/voices) moves independently via Settings → Storage or Portable mode. (#938)

## [0.3.13] — 2026-07-09

The community-fixes release. Two contributors didn't just report bugs — they diagnosed them to the exact line and submitted the fixes that shipped: **voice cloning on mlx-audio's CSM model works for the first time**, and **macOS live recording finally gets its microphone permission prompt** (both @MahdiHedhli). A third reporter's A/B analysis fixed **cross-language dubs speaking the wrong language**. On top of that: a backend shutdown race that produced confusing crash-on-quit reports is fixed, the Linux AppImage stops shipping a stale WebKitGTK that white-screened current distros, and a new OpenAI-compatible transcription backend opens a path to Qwen3-ASR today. Thank you to everyone who filed, diagnosed, and contributed — this release is mostly yours.

### Added

- **A path to Qwen3-ASR today: generic OpenAI-compatible transcription.** The direct integration is still blocked on `transformers>=5.13` stabilizing upstream, but a community member proposed splitting the work — add a backend that talks to any OpenAI-compatible transcription server right now. Point OmniVoice at a self-hosted Qwen3-ASR/FunASR/SenseVoice server, or OpenAI's own API, configured in Settings → Models. No install; audio does leave your machine to whichever server you configure, unlike every other ASR engine. (#877)

### Fixed

- **The Linux AppImage no longer white-screens on current distros with a healthy system WebKitGTK.** The release build ran on an older CI base image, and the resulting AppImage bundles whatever `libwebkit2gtk` that image's apt repos resolve — which the AppImage's own `LD_LIBRARY_PATH` then prioritizes over your system's newer, healthy copy at runtime. A from-source build (which links straight against your system library) worked fine on the exact same machine where the shipped AppImage didn't — that split was the tell. Bumped the release build to a current Ubuntu LTS. Raises the AppImage's minimum host to glibc 2.39 (Ubuntu 24.04+); no reports from anyone on an older distro. (#961)
- **Backend shutdown no longer races a still-loading model, surfacing a confusing crash on restart.** Quitting the app while a model was still loading in the background let shutdown report itself "done" while a background thread was still mid-import; tearing the process down under that thread produced a misleading error (a generic transformers import-failure message, unrelated to the real cause) that looked like a real crash rather than a timing issue. All background tasks are now properly cancelled and awaited before shutdown proceeds. (#1000, likely the same class behind #941 and #979)
- **Cross-language dub no longer speaks the source-language reference line verbatim.** Auto-generated speaker clones pair an audio slice with the ASR segment's own text field, assuming the two agree — but ASR segment text and its timestamps routinely drift (a trailing word audible in the clip but missing from the text, or vice versa). A mismatched (reference audio, reference text) pair breaks zero-shot TTS prompt priming badly enough that the clone can emit the reference text itself instead of the target-language line it was asked to speak. Each reference clip is now re-transcribed after it's written, so the pair matches by construction — reported with an exceptionally clear root-cause diagnosis and a working A/B repro. (#1004)
- **Voice Gallery errors now say what actually went wrong.** "Use voice", "Preview", search, upload, save, delete, and trim in the Gallery all showed the same hardcoded guess ("the engine may be loading") on ANY failure — a 500, a validation error, a genuinely unrelated bug — discarding the real, already-clean backend error message in the process. Every one of those now shows the actual error.
- **Voice cloning on mlx-audio's CSM model no longer crashes with an opaque "list index out of range".** `MLXAudioBackend.generate()` read `voice`/`ref_audio`/`language`/`speed` from its kwargs but silently dropped `ref_text` — CSM only builds its cloning context when both `ref_audio` and `ref_text` are present, so cloning on this engine could never have worked as shipped. Reported with the exact root cause and a working fix. (#1012, #1013)
- **A dub segment's free-text style tags no longer 400 the segment preview.** A validator-safe instruct builder already keeps Studio and Clone generation from round-tripping a 400 on unsupported free-text (a preset's raw attrs, an old profile's stray descriptive phrase) — but the Dub tab's segment preview, and saving a profile from a clone or from history, built their instruct strings directly and skipped it. Same guard now applies everywhere an instruct string is sent. (#1010)
- **The dub editor's play button no longer sticks permanently disabled after an audio-decode hiccup.** When the initial WaveSurfer decode fails, the timeline falls back to loading pre-computed peaks — the waveform draws fine, but the button's enabled state only relied on the `ready` event firing again for that recovery load, which it didn't reliably do. Each fallback path now confirms readiness explicitly once it settles.
- **macOS: live recording finally works — the microphone permission prompt now actually appears.** The app never showed up in System Settings → Privacy & Security → Microphone because macOS never saw a legitimate request: Tauri enables Hardened Runtime by default, which blocks microphone hardware access unless the matching entitlement is in the signed bundle — and it wasn't. Diagnosed to the exact mechanism and fixed by a community contributor (@MahdiHedhli), who also corrected our initial mis-read of this as an upstream WebKit limitation. (#1013, #1016)
- **Quitting during a slow model load waits longer before giving up.** A post-merge code review of the shutdown-race fix flagged that its 3-second wait could still be outrun by a cold model import on a slow disk, reproducing the original confusing-crash-on-quit in rare cases. The wait is now 20 seconds — imperceptible on a normal quit (tasks finish or cancel in milliseconds), only felt in the exact case it protects. (#1020)

### Changed

- **Removed the donate heart from the nav rail.** Support OmniVoice is still one click away from Settings and the Contact page.

### CI

- **The "flaky trio" is root-caused and neutralized.** Three tests failed intermittently on CI — never locally — across unrelated PRs, costing a re-run each time. Cause: a leaked half-precision torch default from some earlier test in CI's ordering (the giveaway: a failing assertion's observed value was exactly float16(0.1)). An autouse test-suite guard now resets the leak between tests and names the offending test in CI output when it fires. (#1021)

## [0.3.12] — 2026-07-08

A community-issue sweep — nineteen open reports triaged in one pass, most fixed same-day. The through-line: **your active engine selection is now honored everywhere** (dubbing, batch, and — new in this release — MLX-Audio's own curated models are finally selectable instead of always silently defaulting to Kokoro), **first-run stops dead-ending users on restricted networks or behind corporate TLS proxies**, and a run of sharp community diagnoses (a one-line ROCm index fix, a Windows-only focus-stealing bug, a genuine crash regression) got fixed largely because reporters did the hard diagnostic work themselves. Thank you.

### Added

- **MLX-Audio's other 6 curated models are finally selectable.** The engine multiplexes Kokoro, CSM, Qwen3-TTS, Dia, Chatterbox, MeloTTS, and OuteTTS, but there was no way anywhere in the UI or API to pick which one loads — downloading a model via Settings → Models did nothing, since the backend always defaulted to Kokoro regardless. Settings → Engines now shows a model picker on the mlx-audio row; switching takes effect immediately, no restart needed. (#981)

### Fixed

- **First-run no longer dead-ends behind restricted networks (e.g. China).** The system check probed hardcoded huggingface.co, and any failure locked the Continue button — users behind the Great Firewall were stuck on the very first screen, even when they had already configured a working mirror. The check now probes the Hugging Face endpoint actually in effect, an unreachable endpoint is a warning instead of a blocker (models already on disk keep working offline), and when huggingface.co is blocked but the hf-mirror.com community mirror answers, the wizard says so and offers a one-click mirror switch right on the check screen — no restart needed. (#984)
- **Installs behind a corporate or antivirus TLS-inspecting proxy no longer fail with a raw SSL error.** `SSLV3_ALERT_HANDSHAKE_FAILURE` happens when a proxy re-signs HTTPS traffic with a root CA your OS trusts but Python's bundled certificate list doesn't — a different failure mode from the network-blocking case above. OmniVoice now trusts your OS's certificate store directly, which should resolve the handshake outright rather than just explain it better. (#976)
- **The loaded-models panel now says when a resident model is not your active engine.** Switching TTS engines keeps the previous model in VRAM (so switching back is instant) — but the panel showed it with no context, so "OmniVoice TTS — 1.9 GB" after selecting VoxCPM2 looked like the selection was ignored. A field report confirmed the confusion. Resident-but-inactive models are now tagged "not active — safe to unload", and the API self-describes each entry's engine. (#985)
- **Voices no longer ship with a hidden echo.** Every non-raw synthesis was getting a small room reverb baked in by the mastering pre-stage — on top of whatever effect preset you chose, so even "Podcast" (which promises *no reverb*) had some, and Cinematic/Warm got it twice. A field report ("a lot of echo/reverb on some of the voices") led straight to it. The mastering stage is now highpass + compressor only; reverb happens only when a preset explicitly declares it. Also documented: cloned voices reproduce the reference clip's room acoustics — dry, close-mic references clone cleanest. (#986)
- **Your engine selection now actually applies to Dubbing and Batch TTS.** Both hardcoded OmniVoice regardless of what was picked in Settings → Engines — pick VoxCPM2, dub anyway with OmniVoice, no error. Both now resolve the active engine up front; an engine that can't clone from reference audio (KittenTTS, Sherpa-ONNX, Supertonic 3 — fixed preset voices only) fails the job immediately with a clear message naming which engines do support it, instead of silently substituting OmniVoice or mis-cloning every speaker into one voice. Batch only requires cloning when a specific voice is pinned — an unpinned batch job runs on any engine. (#987)
- **AMD ROCm torch install no longer silently falls back to CPU.** A community member (Kaihui-AMD) diagnosed it precisely: the ROCm wheel index we pointed at tops out at PyTorch 2.5.1, but the app pins `torch==2.8.0` — the reinstall was unsatisfiable and silently kept the default CUDA build, which runs on CPU on an AMD GPU. Bumped the default index to one that actually carries the pinned version. (#972)
- **mlx-audio no longer crashes on unsupported languages.** Selecting a language like Dutch, Spanish, or Portuguese with mlx-audio's Kokoro model crashed with a raw, unreadable internal-details dump instead of a real error — the code was guessing an ISO language code by truncating the language name, which only worked by coincidence for a few languages. Unsupported languages now fail cleanly with a message naming what's actually supported, and no engine can leak a raw crash-internals dump into an error message again. (#977)
- **The voice-design panel no longer crashes on certain saved voice profiles.** A genuine regression: an earlier translation fix accidentally introduced a crash when a saved design profile's data was incomplete (possible from an older app version or a partial save). Fixed at every layer — the render no longer crashes, both places that restore saved data complete it first, and profiles can no longer be *saved* with incomplete data in the first place. (#983)
- **Windows: the dictation pill no longer steals focus.** Pressing the dictation shortcut activated the pill window, which meant the auto-paste landed back in OmniVoice instead of whatever app you were dictating into, and the pill would get stuck on screen. Precisely diagnosed by a community reporter; fixed to match how this already worked on macOS. (#982)
- **The nemo-parakeet ASR engine's install hint no longer breaks your backend.** Following the in-app "pip install nemo_toolkit[asr]" instruction silently downgraded core packages your backend needs to start — the install reported success, and the breakage only showed up on the next restart. The hint now says plainly that this isn't safe to install into the shared environment. (#974)
- **A stuck generate now tells you the actual fix.** When a job times out from GPU/VRAM contention, the error explained why but never mentioned Flush/Unload — the one action that actually resolves it, and one the sibling ASR-timeout error already recommended. (#939)

### Changed

- **README and Linux docs no longer advertise a `.deb` package that isn't published.** `.deb` bundling is disabled in the release pipeline pending a tauri-cli fix; the docs now say so honestly instead of pointing at a file that was never in any release. (#961 investigation, #990)
- **Linux install docs mention `yt-dlp` as an optional prerequisite** — previously only surfaced via an in-app warning after the fact. (#973)
- **A benign Tauri startup warning no longer looks like an app problem.** On some Windows configurations, Tauri's own internal IPC fallback logs a warning that's fully harmless (it silently and successfully falls back to another transport) — it was spuriously flipping the Settings → Logs footer to show "1 warning" on every launch. Filtered out of the diagnostic capture. (#975)

## [0.3.11] — 2026-07-05

The multi-language release — dubbing into several languages at once is finally a mature, honest workflow: **"Generate N dubs" now translates each language before rendering it** (with visible per-language progress), **switching languages never destroys your work** (every track keeps its own text, subtitles, and audio cache), completed tracks always show their tabs, and dialogue stops starting seconds early because of footsteps — a community reporter's theory, confirmed exactly. Around it, a reliability sweep driven by same-day field reports: your LLM provider finally survives a restart, SOCKS-proxy users can synthesize again (installed models now load without touching the network at all), timeline boxes are visible on every WebView2 runtime, running from source works again — and when the backend crashes, **it now tells you the exit code and attaches the evidence to your bug report automatically**.

### Added

- **Backend crashes are now self-documenting.** When the local backend process dies (a native GPU abort, an out-of-memory kill), the app used to show only "Can't reach the backend" — undiagnosable without logs nobody sends. The launcher now records every unexpected backend death (exit code, how long it ran, the last 40 log lines), tells you honestly that it *crashed* and is restarting, offers a "View crash details" panel, attaches the evidence to in-app bug reports automatically (paths scrubbed), and stops silent crash-loops after 3 deaths in 10 minutes with the details on screen. Intentional shutdowns, restarts, and app quits are never misreported as crashes. (#969)
- **"Generate N dubs" now actually translates each language first.** Multi-language generation used to synthesize every track from whatever text was in the editor — so at most one of your N dubs was really in its language. The batch now runs translate → generate per language with a visible "Translating → Bengali (2/3)…" phase, skips (and reports) any language whose translation fails instead of rendering a wrong-language track, and your multi-language picks and export-track selection are saved with the project instead of vanishing on tab switch. (#957)
- **Switching dub languages no longer destroys your work — every track keeps its own text and audio.** Translations are now stored per language (switching the target swaps the editor text non-destructively; manual edits stay with their language), subtitles export each track's own text instead of N identical files, burned-in subs match their track, and the per-segment audio cache is keyed by language — "Regen changed" can no longer splice another language's audio into the track you're rebuilding, and staleness is tracked per track. Fully backward-compatible: existing projects and caches keep working; a pre-upgrade project's first "Regen changed" simply regenerates cleanly once. (#958)

### Fixed

- **Timeline segment boxes are visible on every WebView2 runtime.** The v0.3.10 flicker fix switched box colors to a newer CSS feature (`color-mix`) applied as an inline style — on WebView2 runtimes older than ~March 2023 (pinned enterprise/offline installs) that renders as *fully transparent*, turning "flickering boxes" into "no boxes at all" while looking perfect on up-to-date machines. Colors are now pre-blended in plain JavaScript to universally-supported `rgb()` values — pixel-identical on modern runtimes, theme-aware, and guarded by a test that fails if an engine-dependent color ever reaches the timeline again. (#968)
- **Dubbed dialogue stops starting seconds early because of footsteps.** Dialogue starts are snapped to the first detected sound — and a single 20 ms burst (footsteps, a door, a sigh) counted as "speech", with no limit on how far a start could jump, and the snap even ran on the raw mix when vocal separation had failed. Onsets now require sustained speech-like energy, long jumps are only allowed across genuinely silent spans (so the original fix for whisper's stretched starts keeps working), and snapping turns off entirely when vocals weren't separated. Credit to the community reporter whose "footsteps theory" was exactly right. (#967)
- **Completed dub tracks always show their video tabs.** Opening a project with a finished dubbed track hid the Original/track switcher until you re-selected the language — visibility was keyed to the language dropdown instead of the project's tracks, and restored projects couldn't set the language because the history database froze it at empty forever. Tabs now render from the tracks themselves, history keeps its language (existing projects heal without migration), restoring a project can no longer 404 the video preview, and track pills gained duration/timing tooltips plus an accurate now-playing indicator. (#956)
- **Running from source works again, and the install docs stop lying.** `bun run desktop-prod` broke when the frontend became a workspace (`bunx` could fetch the wrong "tauri" package from npm — fixed everywhere including CI); the Linux white-screen guidance now leads with the variable that actually fixes modern Ubuntu (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, with the exact `EGL_BAD_PARAMETER` error quoted); Windows docs now state plainly that GPU acceleration is NVIDIA-only there; the Linux docs document the ROCm support that already shipped (the "planned follow-up" note was stale); and prerequisites are split installer-vs-source with git and curl included. (#964)
- **Your LLM provider now survives a restart.** Setting up Ollama (or any provider), testing it, and saving looked like it worked — then a restart forgot the selection: only the separate "Save & use for translation" button ever persisted it, and a leftover setting from the retired (≤0.3.7) translation panel could silently steal the choice back to "Custom" on every launch. An explicit save now activates the provider when none was chosen yet, the leftover legacy settings are migrated into the Custom provider once and removed, and the panel says "Saved — not yet used for translation" instead of staying silent when your edit isn't the active provider. (#965)
- **SOCKS-proxy users can synthesize again — and an installed model can never again be blocked by a broken network stack.** With a system-wide SOCKS proxy set, clicking Synthesize 500'd with a raw "socksio not installed" error: loading an already-downloaded model still constructed a network session first, which failed at creation. The app now ships SOCKS support (including in the packaged installers), resolves installed models **cache-first** (no network session when the files are already on disk — the local-first guarantee at the loader level), warms up at startup even when the online check fails, degrades LLM extras instead of crashing on proxy errors, and classifies the error with an actionable hint if it ever does surface. (#966)

## [0.3.10] — 2026-07-05

The listening release — nine fixes in twenty-four hours, almost all driven by your v0.3.9 field reports (several with same-day turnaround). The dubbing pipeline stops lying: **Cinematic and Autofit can no longer invent dialogue**, the **speaker count you set is honored on every path** (and auto-cloning stops fabricating voices from guessed labels), and the timeline stops flashing invisible on Windows. Audiobook chapters with pauses render again. And one fix everyone should want: **updating can no longer leave you secretly running the old version** — a leftover backend from a previous install holding the port is now detected and replaced at launch. Plus: the Dub tab's LLM engine finally runs on the provider you configured in Settings, history timestamps stop reading "20617d ago", and the Engines page can't crash under concurrent load.

### Fixed

- **Audiobook/Stories chapters with a `[pause]` no longer fail to render.** Pause spans were built as 1-D silence while every TTS engine returns 2-D audio, so the chapter concatenation crashed with `Tensors must have same number of dimensions` — any chapter containing a pause failed on every attempt (reported with a precise trace in #897). Silence now matches the rendered audio's shape at the source, and the chunk concatenator defensively normalizes mixed ranks (including honest mono→stereo broadcast) so no engine can re-trigger the class. (#953)
- **Cinematic and Autofit dubbing can no longer invent dialogue.** The refine and slot-fit passes accepted any non-empty LLM reply for Latin-script languages — hallucinated lines, refusals, or the critique itself could ship as the dub. Every reply is now checked against the original line (length window, target script, critique echo — tunable via `OMNIVOICE_REFINE_RATIO_MIN/MAX`), rejected output falls back to the literal translation with an `adapt-diverged`/`fit-diverged` marker, lines too short to honestly fill their slot skip LLM expansion entirely, and both passes pin `temperature=0.2` like the Fast path. (#950)
- **Dub timeline boxes can no longer flash invisible during playback.** On some Windows GPU/WebView2 driver combos the segment boxes under the video vanished and reappeared while playing (first reported in #373; the earlier fix was incomplete) — the timeline lane still animated a CSS transform every playback tick, keeping the translucent boxes on a composited layer that the driver mis-painted. Boxes are now positioned in pure layout with fully opaque theme-aware fills (pixel-identical colors), removing the glitch class on every platform. (#951)
- **The dub "Speakers" count now actually does something — on every path.** The hint only reached pyannote; the common fallbacks silently ignored it (the no-diarization heuristic was hardcoded to alternate two speakers, and the FunASR shortcut never consulted it). The heuristic now cycles the requested count, an explicit count routes through pyannote when available, every path that can only approximate (or must ignore) the setting says so in a visible warning, and the legacy endpoint + a new CLI `--speakers` flag accept it too. Auto voice-cloning also stops fabricating voices from guessed labels: reference slices under 1.5s are rejected, slices bordering another speaker's turn are avoided, and cloning is skipped with an honest warning when speaker labels came from the gap heuristic instead of real diarization. (#952)
- **Settings → Engines can no longer 500 under concurrent loads.** The lazy TTS/ASR engine registries held a *live* dictionary iterator open across each engine's `is_available()` probe while `list_backends()` ran in a FastAPI threadpool — so a second concurrent `/engines` request materializing a lazy engine entry (`self[key] = cls`) mutated the dict mid-iteration and crashed the request with `RuntimeError: dictionary changed size during iteration`. Both registries now snapshot their keys before iterating (atomic under the GIL), immune to a concurrent insert; regression-tested for TTS and ASR. (#940)
- **The Dub tab's LLM translation engine now runs on your configured LLM provider.** Picking "LLM (OpenAI-compatible)" silently required three hand-set environment variables even when a provider was already configured and tested in Settings → LLM Providers; it now resolves through a new "Dub translation" LLM skill (route it to any provider — remote or local — in Settings → LLM Skills, independently of Cinematic refinement), keeps the `TRANSLATE_*` env vars as a power-user override, bounds every call with the LLM timeout instead of the SDK's 600-second default, tells the Engine dropdown whether the engine is actually ready (and via which provider), and — when nothing is configured — returns a clear pointer to Settings → LLM Providers instead of a raw 401 per segment. (#944)
- **Timestamps no longer show "20617d ago" in OmniDrive/Projects.** The backend stores record times in Unix seconds while some views assumed milliseconds, so generation-history cards rendered as ~1970 ("20617d ago") and sorted last; every relative-time label (OmniDrive, sidebar history, dub projects, batch queue, transcriptions) now goes through one unit-tolerant formatter, and records missing a timestamp show "—" instead of an epoch age.
- **Updating can no longer leave you secretly running the old version.** If a backend from a previous version was still holding the port (an orphan that survived an update), the new app "attached" to it because it answered health checks — so every fix in the update appeared to change nothing (the reported "bound port blocked the newer version"). The launcher now compares the running backend's version against the app before attaching: same version attaches as before, a stale one is killed and the bundled backend is started in its place — on macOS, Windows, and Linux. (#947)

## [0.3.9] — 2026-07-04

The dictation release — and a deep reliability pass driven by live-testing the entire app. **Dictation is rebuilt end-to-end**: instant feedback with a live waveform, words that commit about half a second after you stop speaking, clean punctuation, and text insertion that never lies about success. **LLM providers get one-click connection testing** with real diagnostics and model discovery, in all 21 languages. The app now **always opens maximized**, bottom buttons **can't hide under the footer** at small window sizes, and a wave of "out of memory / can't reach the backend / stuck at preparing" reports were traced to their real causes and fixed — including the silent VRAM crash on 8 GB cards, dead-IPC startup hangs after a Windows BSOD, and misleading error labels. Intel-Mac support status is now stated honestly, Confucius4-TTS is validated end-to-end, and Parakeet — roughly 20× faster than the default transcriber on CPU — is unlocked for every machine.

### Added

- **Sponsor OmniVoice.** A new `SPONSORS.md` (tiers, logo guidelines, how to sponsor), a README Sponsors section, and an in-app Sponsors area (Support page + a footer link) let people back the project — with a one-click "Become a sponsor" that opens a structured GitHub issue form, no account or token needed. Sponsorship is a thank-you, not a paywall: OmniVoice stays free and AGPL-3.0. (#923, #924)
- **OpenAPI reference in Settings.** A new Settings → OpenAPI page embeds an interactive Scalar reference for OmniVoice's local backend API, with a one-click footer button. Fully local — Scalar is bundled, not loaded from a CDN, and phones home to nothing. (#928)
- **Engine Self-test.** The Engines matrix gains a "Self-test" button for in-process TTS engines that runs a tiny real synthesis and reports duration + sample rate — proving an engine actually makes audio, not just imports — plus a copy-paste `export OMNIVOICE_*_DIR=…` setup line for opt-in engines right in the "Why unavailable?" panel. (#930)
- **One canonical HuggingFace-token store + incomplete-download visibility.** The Model Store token field now saves to and is cleared from the same encrypted store as Settings → Credentials (no more two-stores split), and a truncated model cache shows an "incomplete · N MB" state with one-click Repair and Delete instead of masquerading as "not installed". (#927)
- **Launchpad, reimagined as a deck of cards.** The seven feature cards now fan out with animated waveform faces in each card's accent color; hover or keyboard-focus any card and it comes forward while the rest tuck underneath, and the layout stays usable down to the minimum window size. (#904)
- **See exactly what OmniVoice keeps on disk — and get warned before space runs out.** Settings → Storage shows real usage for the model cache (with your largest models), app data, engine environments and temp files, plus a free-space gauge and low-disk / near-full-volume warnings with one-click paths to open folders or reclaim space. (#906)
- **A "What's new" changelog reader in Settings → Updates.** The available update's real release notes now render in-app, alongside an offline changelog viewer and a one-time "what's new" note after each update. (#909)
- **Route each AI feature to its own LLM — or switch it off.** A new Settings → LLM Skills panel lists every LLM-powered capability (Cinematic/Autofit translation, slot fitting, glossary auto-extract, direction parsing, dictation cleanup) with a per-skill toggle and provider picker, so sensitive work can stay on a local model while heavier jobs use a remote one. Disabled skills fall back to the exact non-LLM behavior. (#912)
- **A small thank-you moment, done right.** After a successful export, dub, audiobook, or batch run, OmniVoice may — rarely — show a friendly, dismissible note by the footer heart about supporting development: never more than once a session, at most every 7 days, never for brand-new users, with a permanent "don't ask again". The logs bar also gained an icon and the footer icons now share one size. (#898)

- **Dictation, rebuilt.** The dictation pill now shows a live waveform the moment the mic opens, streams words as you speak with real download/loading progress on first use, and finishes what you say in about half a second of silence instead of two-and-a-half. Transcripts come out properly capitalized and punctuated. Text insertion is now honest and safe: your clipboard is preserved and restored, failures show what to do (including a one-click jump to macOS Accessibility settings when permission is missing) instead of a false "Pasted", and Esc cancels cleanly at any point. The dictation model also pre-warms in the background after launch, so the first press of the hotkey no longer sits on a cold model load.

- **LLM Providers: one-click connection testing with real diagnostics.** The Test button in Settings → LLM Providers now measures round-trip latency and turns failures into plain-language guidance — bad key (401/403), wrong model or URL (404), rate-limited (429), or unreachable server — instead of a raw exception dump. A new "Fetch models" button lists every model your key can access so you pick from real names instead of guessing. The whole panel is now translated into all 21 languages, provider error messages never echo your API key, and the settings API gained full test coverage.

### Changed

- **A "Get in touch" page that actually guides you.** The Contact page is now clearly-labelled cards (report a bug, request a feature, get community help, support the project, report a security issue) with a sentence each on when to use them, instead of a flat link list. (#925)
- **Release titles are version-first.** GitHub's release-list sidebar truncates the title, so "OmniVoice Studio v0.3.8" hid the version; releases are now named "vX.Y.Z — OmniVoice Studio" so the version is always visible. (#922)
- **Launchpad feature cards now fill the window.** The seven cards (Voice Clone, Voice Design, Video Dubbing, Stories, Audiobook, Voice Gallery, Transcripts) span the full content width on a maximized display instead of a fixed ~780px fan, and reflow responsively (7→3→1 columns) down to the 900×600 minimum — driven by the shell's own width, keeping the animated card faces, hover/keyboard-focus raise, and reduced-motion fallback. (#915)
- **LLM Providers settings, de-confused.** The old inline "LLM endpoint" box in Translation is gone — LLM Providers is now the one place that owns it. Fields pinned by an environment variable are shown disabled with an explainer instead of silently reverting, the make-active button explains when a provider is env-pinned, and the Cloudflare Account ID is remembered and editable. (#907)
- **Intel Macs: honestly unsupported for the local backend.** PyTorch no longer ships Intel-Mac builds, so the backend cannot run there; instead of a cryptic dependency error, Intel users now get a clear explanation up front (with the remote-backend option), and the README/docs say so plainly. (#889, #891)

- **The app now always opens maximized (not fullscreen).** Window size and position are no longer carried over from the previous session — one manual resize used to make every later launch reopen at that smaller size, overriding the intended maximized default. Same behavior on macOS (zoomed window, not a fullscreen Space), Windows, and Linux.

### Fixed

- **Sherpa-ONNX "model not set" now reads as a setup problem, not out-of-memory.** Selecting the sherpa-onnx engine without `OMNIVOICE_SHERPA_MODEL` configured used to fail with a misleading "ran out of memory — press Flush" 500; it now names the exact variable, points at Settings → Engines, and the engine is marked unavailable-with-a-reason in the picker (with a copy-paste setup line) instead of selectable-but-broken. Generalized so any env-gated engine surfaces actionable setup guidance. (#919)
- **Cinematic & Autofit now actually run on every translation engine.** Picking Cinematic or Autofit on the default Argos engine (or NLLB) used to silently fall back to Fast with a success toast; it now runs the full LLM refine + fit pass, the Autofit fit pass is bounded by the same wall-clock budget as Cinematic, and provider errors are scrubbed of keys/user-ids. (#910)
- **Dictation no longer freezes on a slow or dead LLM.** Transcript refinement is now hard-bounded (default 4s): a placeholder key or unreachable endpoint falls back to clean unrefined text instead of stalling the paste ~51 seconds. The dictation model is genuinely pre-warmed and reused across sessions, REST transcription is polished like live dictation, and Settings flags a configured-but-failing LLM. (#911)
- **Model installs fail loudly, not silently.** Failed downloads keep their mirror-aware reason on the row with Retry/Dismiss instead of vanishing after a moment; installs check free disk space up front before overrunning it; in-progress installs get a Cancel button; and the HF-mirror setting only asks for a restart when it actually changed. (#908)
- **Engines settings, sharper and honest.** The Supertonic license "Accept" button works again (it was inert since it shipped), the engine matrix refreshes the instant you pick an engine, picking a GPU engine that lands on CPU now warns you with the reason, CPU-only engines stop being mislabelled "CPU fallback", and an in-process "Test engine" pass reads as a dependency check instead of a fake "0 ms" latency. (#905)
- **Updates can no longer cost you data.** Before any database migration runs on first launch of a new version, the database is snapshotted next to itself (newest three kept), and a failed migration stops with the backup path named instead of silently running on a half-upgraded database; the environment self-heal now verifies it's actually broken before rebuilding. (#909)
- **CUDA transcription now works on packaged NVIDIA installs — the cuDNN 8 compat libraries install automatically at launch.** The install step only existed in the dev-loop `scripts/setup.py`, which isn't bundled into the packaged app, so real installs never got the libs and WhisperX / faster-whisper failed with `Could not locate cudnn_ops_infer64_8.dll`. The Rust bootstrap now side-loads them on CUDA machines; CPU/AMD/ROCm boxes skip the download and cache the result so their launches stay instant. (#827, #869)
- **`scripts/setup.py` no longer fails with `No module named pip` when installing the cuDNN 8 libs in the dev loop.** `uv venv` doesn't seed pip into the venv, so `python -m pip install` always broke; the script now uses `uv pip install --python` instead. (#869)
- **Generation timeouts now give device-honest advice.** A CPU-only machine is no longer told the GPU is "VRAM-starved" or to "set the engine to CPU" — CPU hosts get compute-bound guidance (shorter text, the CPU-tuned GGUF/Supertonic-3 engines, the OMNIVOICE_GENERATE_TIMEOUT_S knob) while GPU hosts keep the VRAM-contention explanation. (#896)
- **Model-download failures now name the mirror that failed.** When a Hugging Face mirror is configured and unreachable, every affected surface (generate, dub, Model Store installs) names the mirror and points at the exact setting instead of leaking a raw network error; auto-repair failures now say *why* the repair failed. (#874, #890)
- **No more infinite "preparing" after an unclean shutdown.** If Windows corrupts the WebView cache (e.g. after a BSOD), the splash detects the dead IPC channel, proceeds via a direct backend health check, and — if truly stuck — offers a one-click "Repair and restart". (#879, #892)
- **"Out of memory" is no longer the default excuse.** A failed model download mid-generation was mislabeled as OOM with useless "flush VRAM" advice; network failures are now classified honestly, only real OOM signatures get the OOM treatment, and first-use engine downloads retry once with a fresh connection. (#880, #893)
- **Hung transcriptions recover the same way everywhere.** Chunked dub transcription now shares the same guarded-timeout + GPU-pool reset as the rest of the app, and repeated timeouts recommend the crash-isolated ASR engine — now properly selectable in Settings. (#730, #895)
- **A raw `[Errno 22]` transcribe error now tells you what to fix.** When the OS rejects the temporary WAV write during dub transcription (a missing, read-only, or full temp directory, or antivirus interference), the stream used to dead-end as *"Transcription produced no segments. [Errno 22] Invalid argument"* with no next step; it now classifies the EINVAL and appends an actionable temp-dir/disk/AV hint — the same treatment the ffmpeg and compute-type failure classes already get. (#763)

- **Buttons can no longer hide under the logs footer on small windows.** The bottom status/logs bar was a fixed overlay that pages had to compensate for with padding — any view that missed it (voice-card grids in Gallery and Community, bottom action rows) clipped under the bar at small window sizes, a class previously patched one page at a time (#476, #504). The footer is now a real row of the app shell, so content physically ends at its top edge at every window size, collapsed or expanded — guarded by a new layout test plus a 900×600 Playwright check at the app's minimum window size.

- **Confucius4-TTS is now validated end-to-end — and actually loads.** The opt-in engine's first live run (Apple Silicon, CPU) caught three scaffold-era faults: the sidecar could never import `confuciustts` (upstream ships no packaging, so the documented `pip install -e` fails — the sidecar and bootstrap probe now put the clone on `sys.path`, like upstream's own example), the assumed 24 kHz sample rate was wrong (confirmed **22 050 Hz**, now regression-tested), and the docs demanded an Amphion/MaskGCT install that doesn't exist (all weights auto-download from HuggingFace). CPU is ~17× realtime, so CUDA stays the recommended path; `gpu_compat` now advertises `("cuda", "cpu")`. (#590)

- **Parakeet TDT transcription now works without an NVIDIA GPU.** The `nemo-parakeet` ASR engine (parakeet-tdt-0.6b-v3, 25 languages, word timestamps) was hard-gated behind CUDA — but a live measurement on an Apple Silicon M2 shows it transcribing at ~10× realtime *on CPU*, roughly 20× faster than the default whisper-large-v3 on the same machine at equal accuracy. The false GPU gate is removed, so Mac and CPU-only users can now pick the dramatically faster engine in Settings → Engines.

- **8 GB GPUs: voice-clone/dub transcription no longer kills the backend.** On cards where the TTS model already held most of the VRAM (e.g. RTX 4060 Ti 8 GB), loading whisper `large-v3` in float16 for a reference-clip or dub transcription died as a *native* CUDA out-of-memory abort — the whole backend process vanished with no error logged, and the app showed "Can't reach the local OmniVoice backend." A new VRAM preflight re-checks free GPU memory right before the ASR load and steps down float16 → int8 → CPU instead of attempting a load that can't fit (opt-out: `OMNIVOICE_ASR_VRAM_PREFLIGHT=0`). (#723)

### CI

- **A migration can no longer silence the app's logs.** Alembic's startup config was disabling every existing logger process-wide (a latent bug the new pre-migration backup logging exposed); fixed, and the migration-safety tests are now immune to full-suite ordering. (#909, #917)
- **Deterministically green tests + real install proof.** Tests can no longer read the developer's real `.env` or app data (the order-dependent flake class, #878, #894), and a new cross-platform install-test workflow builds all four installers and proves a real first run — model download plus verified synthesis — on macOS, Windows, and Linux runners.

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
