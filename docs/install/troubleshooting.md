# OmniVoice Studio — Install Troubleshooting

The top 10 errors users have actually hit on `v0.2.x`, with their causes and
fixes. Most have a deeplink anchor that the in-app error UI's "Open docs for
this error" button targets directly.

## Start here: self-diagnosis

<a id="self-diagnosis"></a>

Before digging through the entries below, let the app diagnose itself:

- **In the app:** **Settings → About → "Run self-check"** verifies your
  compute device (CUDA/MPS/CPU), ffmpeg, HuggingFace token, disk space,
  data-directory permissions, RAM, installed TTS engines, and hub
  reachability — each with a hint when something's off.
- **Headless / terminal:**

  ```bash
  uv run python backend/main.py --diagnose          # same checks, exits 1 on failure
  uv run python backend/main.py --diagnose --deep   # also loads the active engine
                                                    # and synthesizes a test utterance
  ```

  `--deep` catches "installed but broken" engines. On a fresh install it may
  cold-load the model (minutes, plus a large download).

- **Filing an issue?** **Settings → About → "Save diagnostic bundle"**
  produces a zip (self-check report, recent classified errors, scrubbed log
  tails) you can drag straight onto the GitHub issue. Home paths and
  anything token-shaped are redacted before they leave your machine.

## 1. `pkg_resources` missing (ModuleNotFoundError)

<a id="pkg_resources-missing"></a>

**Symptom:** the splash screen shows `ModuleNotFoundError: No module named
'pkg_resources'` during WhisperX import, and the app never advances past the
"Setting up models" step.

**Cause:** WhisperX (and a couple of its transitive deps) still imports
`pkg_resources`, which `setuptools >= 80` dropped. `pyproject.toml` pins
`setuptools>=75,<80` so it stays present — but the venv can still lose it two
other ways: **(a)** antivirus (commonly Windows Defender) quarantines
`pkg_resources`' files, or **(b)** a partial/interrupted extract. In both cases
setuptools' *metadata* remains, so `uv`/`pip` report it "already satisfied" and
a plain install **no-ops** — the files are never restored.

**Fix:** in the backend venv, **force a reinstall** (a plain install won't work
for the reasons above):

```
uv pip install --reinstall 'setuptools>=75,<80'
```

then restart. If it recurs, your antivirus is removing the files again — add the
backend **`.venv`** folder to its exclusions (Windows Security → Virus & threat
protection → Exclusions). The app's auto-repair now uses `--reinstall` too, so a
fresh install heals itself.

**Linked issues:** [#58](https://github.com/debpalash/OmniVoice-Studio/issues/58),
[#248](https://github.com/debpalash/OmniVoice-Studio/issues/248)

### 1a. Model load fails: `[Errno 2] No such file or directory: '…/transformers/…/modeling_*.py'`

**Symptom:** the System Check / model load fails with e.g.
`[Errno 2] No such file or directory:
'…/site-packages/transformers/models/qwen3/modeling_qwen3.py'`.

**Cause:** same class as §1 — a **corrupted/incomplete `transformers` install**.
A model load lazily resolves a module file that's **missing from `site-packages`**
(an interrupted `uv sync`, antivirus quarantine, or a partial update). The
package's metadata is intact, so a plain install no-ops and never restores the
file. Restarting does **not** help (the file is still gone).

**Fix:** force-reinstall transformers in the backend venv, then restart:

```
uv pip install --reinstall transformers
```

Or, as a quick workaround, switch ASR to **faster-whisper** in
**Settings → Models**. If it recurs, add the backend **`.venv`** to your
antivirus exclusions (see §1). Newer builds classify this error and show the
reinstall hint directly instead of a bare path + "try restarting".

## 2. HF 401 / pyannote license not accepted

**Symptom:** dubbing fails with `HfHubHTTPError: 401 Client Error: Unauthorized
for url …pyannote/speaker-diarization-3.1…`, or
diarization silently falls back to a single speaker.

**Cause:** `pyannote/speaker-diarization-3.1` is a **gated** model — even with a
valid HF token, you need to accept the model's license on its HuggingFace page
before the token works for downloads.

**Fix:**

1. Open **Settings → API Keys** in the app and paste a working HF token (or set
   `HF_TOKEN` in your env). See [docs/setup/huggingface-token.md](../setup/huggingface-token.md).
2. Visit https://huggingface.co/pyannote/speaker-diarization-3.1 while signed
   in with the same HF account → click **"Agree and access repository"**.
3. Retry the job. The token state in **Settings → API Keys** should now show
   the "App" row with a green check next to your username.

**Linked issue:** [#35](https://github.com/debpalash/OmniVoice-Studio/issues/35)

## 3. Gatekeeper quarantine on macOS

**Symptom:** "OmniVoice Studio.app is damaged and can't be opened."

**Cause:** the app is not yet notarised (signing is wired in `release.yml` and
activates once the maintainer adds the Apple cert secrets) — until then macOS
quarantines every download.

**Fix:** see [macos.md#gatekeeper-quarantine](macos.md#gatekeeper-quarantine).

## 4. AppImage white screen on Fedora 44 / Ubuntu 24.04

**Symptom:** the AppImage window opens fully white. No UI ever appears.

**Cause:** WebKitGTK 2.44 / 2.46 compositing-mode regression.

**Fix:** see [linux.md#appimage-white-screen-on-fedora-44--ubuntu-2404](linux.md#appimage-white-screen-on-fedora-44--ubuntu-2404).

## 5. Windows Triton / torch.compile OOM

**Symptom:** the first synthesis call fails with `OutOfMemoryError: CUDA out
of memory` or `RuntimeError: Triton compilation failed`, especially on
<16 GB VRAM GPUs.

**Cause:** the engine's `torch.compile` step compiles Triton kernels with a
peak memory footprint that exceeds free VRAM. Windows-only quirk.

**Fix:** see [windows.md#torch-compile-oom](windows.md#torch-compile-oom).

**Linked issue:** [#65](https://github.com/debpalash/OmniVoice-Studio/issues/65)

## 6. `uv venv` Python download fails (restricted network)

**Symptom:** during first launch, `uv` exits with a network error pulling
`python-build-standalone` from GitHub. Common in China, intermittently in
Russia, sometimes on corporate proxies.

**Fix:** see [linux.md#restricted-networks-china--russia](linux.md#restricted-networks-china--russia)
(same env vars work on macOS and Windows — `UV_PYTHON_INSTALL_MIRROR`,
`UV_HTTP_TIMEOUT=120`, `UV_HTTP_RETRIES=5`, `UV_PYTHON_PREFERENCE=only-system`).

**Linked issues:**
[#57](https://github.com/debpalash/OmniVoice-Studio/issues/57),
[#60](https://github.com/debpalash/OmniVoice-Studio/issues/60).

## 7. `.deb` ffprobe path conflict on upgrade

**Symptom:** after upgrading from a pre-v0.3 .deb, `ffprobe -version` reports
"OmniVoice bundled ffprobe" instead of the system ffmpeg, breaking other apps
that rely on `/usr/bin/ffprobe`.

**Fix:** see [linux.md#deb-ffprobe-conflict](linux.md#deb-ffprobe-conflict).

## 8. Docker LAN access — media preview 404

**Symptom:** OmniVoice loads on `http://<lan-ip>:3900` but the audio preview
pane shows 404s for `/media/...`.

**Cause:** pre-v0.3, the frontend hardcoded `localhost:3900` for media-preview
URLs, which is wrong when the UI is reached from a different LAN host.

**Fix:** the frontend derives its API/media base from the page's own origin.
When running behind a reverse proxy where the UI and API are on different
origins, set the runtime override `OMNIVOICE_PUBLIC_API_BASE` (works on the
prebuilt image via `docker run -e`) — see
[docker.md#lan-access](docker.md#lan-access).

## 9. Apple Silicon `mlx-whisper` unavailable on Intel mac

**Symptom:** on an Intel mac, OmniVoice logs `mlx-whisper backend unavailable;
falling back to faster-whisper`.

**Cause:** `mlx-whisper` and `mlx-audio` only build for arm64 (Apple Silicon).

**Fix:** none needed on Apple Silicon setups that log this transiently. Note
that Intel Macs can no longer run the local backend at all — PyTorch dropped
Intel-Mac wheels, so this entry only applies to historical installs (see
[macos.md](macos.md) and
[#889](https://github.com/debpalash/OmniVoice-Studio/issues/889)).

## 10. Windows: `Could not locate cudnn_ops_infer64_8.dll` during transcription

**Symptom:** on Windows + NVIDIA, transcription/dubbing fails and the backend
log shows `Could not locate cudnn_ops_infer64_8.dll`. Settings → Models shows
WhisperX or faster-whisper selected.

**Cause:** WhisperX and faster-whisper run on **CTranslate2**, which needs
**cuDNN 8**, but PyTorch 2.8 ships cuDNN 9. OmniVoice side-loads a cuDNN-8 copy
from `.venv\Lib\site-packages\cudnn8_compat\`; if that folder is missing
(some upgrade paths don't install it), CTranslate2 can't find the DLL.

**Fix:** switch the ASR backend to **PyTorch Whisper** in **Settings → Models**.
It runs on PyTorch's own stack (cuDNN 9, bundled with torch) and needs no
cuDNN-8 DLL — it loads its Whisper pipeline on demand (no extra env var). To
keep using faster-whisper/WhisperX instead, reinstall to restore the bundled
`cudnn8_compat` libraries.

## 11. IndexTTS / CosyVoice / ChatterboxTTS clash

**Symptom:** installing one of these engines breaks the others — e.g. after
installing CosyVoice, IndexTTS errors out with import conflicts.

**Cause:** these engines pin incompatible transformer / torch versions inside
their own engine venvs. Pre-v0.3 they shared a single venv.

**Fix:** Phase 2 ships subprocess isolation per engine (each engine runs in
its own venv). For v0.3, workaround: install only one of the conflicting
engines per OmniVoice copy. See [docs/engines/cosyvoice.md](../engines/cosyvoice.md)
for the dedicated CosyVoice path.

**Linked issue:** [#55](https://github.com/debpalash/OmniVoice-Studio/issues/55)

## 12. CUDA PyTorch wheel download fails on first run

**Symptom:** first-run setup stops at **Installing dependencies** with a failure
that mentions `torch` and a `download.pytorch.org` (or `download-r2.pytorch.org`)
URL — e.g. `Failed to download torch==2.8.0+cu128 …win_amd64.whl`. The app then
won't launch.

**Cause:** on Windows/Linux NVIDIA machines, OmniVoice installs the CUDA PyTorch
build (`torch` + `torchaudio`) from PyTorch's own index. That CUDA wheel is
large (~2.5 GB), so a flaky or restricted network drops it partway. This is a
download/network problem, **not** a bug in OmniVoice — but the CUDA wheels come
from a *named, explicit* index that a PyPI mirror (`UV_DEFAULT_INDEX`) cannot
redirect, so the generic mirror trick doesn't help here.

**Fix, in order:**

1. **Clean & Retry.** Large downloads frequently succeed on a second attempt —
   OmniVoice already retries each request 5× with long timeouts, and a fresh
   attempt restarts cleanly.
2. **Use a VPN** if your network throttles or blocks the PyTorch CDN.
3. **Provide the wheels manually (offline path).** Download the two wheels that
   match your machine from a source you *can* reach (the official
   [pytorch.org](https://pytorch.org/get-started/locally/) wheel index or a
   regional mirror), then drop them in the wheel folder and **Clean & Retry** —
   OmniVoice will install from your local copies instead of the network:
   - Folder: **`<env dir>/wheels`** (the exact path is printed in the error
     message and in the setup log; `<env dir>` is your chosen install/storage
     location).
   - Files: the `torch` **and** `torchaudio` wheels for your exact Python/OS/CUDA
     — e.g. `torch-2.8.0+cu128-cp311-cp311-win_amd64.whl` and the matching
     `torchaudio-2.8.0+cu128-cp311-cp311-win_amd64.whl`. They must match the
     pinned versions (shown in the failing URL).
   - On retry, OmniVoice re-resolves the install using those local wheels; the
     rest of the (small) dependencies still come from PyPI/your mirror.

If you don't have an NVIDIA GPU, you don't need the CUDA build at all — a CPU /
Apple-Silicon install skips this index entirely.

**Linked issue:** [#569](https://github.com/debpalash/OmniVoice-Studio/issues/569)

## 13. Stuck on the download page / incomplete model cache ("only `refs/`")

**Symptom:** the setup screen never finishes the model download and you can't
reach the main app. Looking in the HF cache, a model folder
(`models--k2-fsa--OmniVoice`, `models--Systran--faster-whisper-large-v3`) has
`refs/` and maybe `config.json` but **no weight files** (`blobs/` empty or tiny).

**Cause:** the download started but the large weight shards never finished —
almost always the connection **dropping, throttling, or being blocked** mid-pull
(corporate/school proxy, VPN, antivirus quarantining the multi-GB file, or a
region where `huggingface.co` is slow/blocked). The app retries and verifies
weights, but a connection that *trickles* rather than dies can stall for a long
time.

**Fix — force a clean re-download:**

1. **Fully quit OmniVoice.** Check Task Manager (Windows) / Activity Monitor
   (macOS) and end any leftover `omnivoice` / `python` process — a half-running
   one keeps the cache locked.
2. **Delete the incomplete model folder(s) entirely** from the HF cache (the
   whole `models--…` folder, not just `refs/`). Leave other models alone:
   - `models--k2-fsa--OmniVoice`
   - `models--Systran--faster-whisper-large-v3`
3. **Relaunch** — the download page re-pulls from scratch.

**If it stalls again at the same spot**, the download is being blocked — try, in
order:

- **Antivirus/firewall** — temporarily disable it for the download (large model
  files are a common false-positive quarantine), then re-enable.
- **Connection** — use a stable, direct connection; pause any VPN; avoid
  corporate/school networks.
- **Region mirror** — if `huggingface.co` is slow/blocked where you are, set a
  mirror **before** launching and relaunch:
  - macOS/Linux: `export HF_ENDPOINT=https://hf-mirror.com`
  - Windows (PowerShell): `[Environment]::SetEnvironmentVariable("HF_ENDPOINT","https://hf-mirror.com","User")`

**Manual fallback** (if downloads keep failing), pull the weights yourself into
the same cache, then relaunch:

```bash
pip install -U "huggingface_hub[cli]"
huggingface-cli download k2-fsa/OmniVoice
huggingface-cli download Systran/faster-whisper-large-v3
```

(If OmniVoice uses a custom models directory, set `HF_HOME` to it first so the
files land where the app looks.)

> Newer builds detect an incomplete cache and re-offer the download instead of
> stranding you on this page — update once the fix is in your channel.

**Linked issue:** [#622](https://github.com/debpalash/OmniVoice-Studio/issues/622)

## 14. "Can't reach the local backend" *during* generation / transcription / dubbing

**Symptom:** the app worked at startup (you reached the main menu and the model
loaded), but the moment you **generate audio, dub a video, transcribe, or
dictate**, it spins for a long time and then shows **"Can't reach the local
backend."** The backend log ends right after a line like `whisperx transcribing
…tmpXXXX.wav` (or a generate) with nothing after it — i.e. the backend is
**alive**, the GPU *job* is what stalled.

**Cause:** this is **not** a connection, download, or "network mirror" problem —
the backend started fine. A GPU job (a **generate** on the TTS model, or an ASR
transcribe with WhisperX/faster-whisper **large-v3**) is too heavy for the
available compute and runs for minutes; because it wedges its GPU-pool worker,
every *other* request — including the next generate and the health check — is
starved, which the UI surfaces as an unreachable backend. The usual trigger is
**VRAM starvation on NVIDIA**: models contend for memory on an 8 GB-class GPU
(the log shows e.g. `GPU pool sized … 7.0 GB free`). CPU-only machines hit the
same wall on long clips. This is the same root cause whether the last thing you
did was `generate:start (audio)`, a dub, or a dictation.

> There is **no "Network → Restricted/Global mirror" toggle** in Settings — that
> control (the footer/Sharing **Network** button) is for **LAN sharing**, not
> downloads. If someone pointed you there for this error, it was the wrong knob.

**Fix — reduce ASR load (any one of these):**

1. **Pick a smaller ASR model / engine** in **Settings → Models** — e.g.
   faster-whisper **medium** or **small**, instead of large-v3. Biggest win on
   low-VRAM GPUs.
2. **Free VRAM**: **Flush the TTS model** before dubbing so ASR isn't competing
   for memory, or
3. **Run ASR on CPU** (slower but reliable) if your GPU is small.
4. **Test with a 10-second clip** first — if that returns quickly, it confirms a
   compute/VRAM limit rather than a true hang.

Newer builds **bound** every GPU job — whole-file transcription **and** TTS
generation: instead of hanging forever and starving the backend, a wedged job now
fails after a timeout with this exact guidance, and the worker pool is reset so
capacity is restored automatically (no app restart needed). Tune the bounds with
`OMNIVOICE_ASR_TRANSCRIBE_TIMEOUT_S` (transcription) and
`OMNIVOICE_GENERATE_TIMEOUT_S` (generation) — both in seconds, default 300.
**Raise** them for very long single files/generations, **lower** them to fail
faster on a small machine.

## 15. Stuck at "preparing" forever after a crash / BSOD (Windows)

**Symptom:** after an unclean shutdown (Windows BSOD, forced power-off), every
launch sits on the "preparing" splash indefinitely — even though the backend is
actually healthy (its log shows models loaded, and
`http://127.0.0.1:3900/health` answers `{"status":"ok"}` in a browser). The
WebView log contains:

```
IPC custom protocol failed, Tauri will now use the postMessage interface instead
TypeError: Failed to fetch
```

**Cause:** the crash corrupted the WebView2 profile cache at
`%LOCALAPPDATA%\com.debpalash.omnivoice-studio\EBWebView`. Both the IPC custom
protocol *and* its postMessage fallback break, so the splash never hears the
"ready" signal from the app shell (issue #879).

**Fix:** current builds handle this automatically — if the splash gets no IPC
signal within ~10 s it checks the backend over plain HTTP and proceeds on its
own; if the backend isn't up either, after ~45 s a recovery panel appears with
**Repair and restart** (Windows), which clears the WebView cache and relaunches.
Your voices, projects, and settings are not touched — only browser display data
is cleared.

On older builds (≤ 0.3.8), or if the automatic repair fails, do it manually:
quit OmniVoice Studio, delete the folder below, then start the app again.

<!-- validate: skip -->
```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\com.debpalash.omnivoice-studio\EBWebView"
```

## Dub: "translation engine needs the optional … package"

**Symptom:** in the Dub tab, translating fails with e.g. *"The 'google'
translation engine needs the optional `deep_translator` Python package, which
isn't installed in this backend."*

**Cause:** the online translation engines (Google / DeepL / Microsoft / MyMemory
via `deep_translator`, and the LLM provider via `openai`) are **optional** and
not bundled. Only **Argos** and **NLLB** work out of the box.

**Fix:**
- **From-source / Docker install:** click the highlighted **Install** button next
  to the *Engine* label in the Dub tab (or run `uv pip install deep_translator`
  in the backend venv) and restart the backend.
- **Packaged installer build:** in-app install is disabled (read-only signed
  environment). Click the highlighted button to open the popover and **Switch to
  Argos (bundled, offline)** — or copy the command to run it in a from-source
  checkout.

Full guide: [dubbing/translation-engines.md](../dubbing/translation-engines.md#installing-optional-translation-engines-from-source-vs-packaged-build).

## First-run setup fails on a restricted network (GitHub/PyPI blocked)

On networks that block or can't resolve **GitHub**, the first-run bootstrap may
fail to download the managed Python (`uv venv ... failed`, often a DNS error).
OmniVoice now tries, in order: the default GitHub host → a gh-proxy mirror → your
**system Python** (if 3.11+ is installed). If all three fail:

1. **Install Python 3.11+** from <https://www.python.org/downloads/> (on Windows,
   tick *"Add Python to PATH"*), then relaunch — OmniVoice will use it.
2. **Point at a reachable mirror** for the Python download:
   - `UV_PYTHON_INSTALL_MIRROR=https://gh-proxy.com/https://github.com/astral-sh/python-build-standalone/releases/download`
3. **Point at a PyPI mirror** for the dependency install (`uv sync`):
   - China: `UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple` (or `https://mirrors.aliyun.com/pypi/simple`)
   - Fully-blocked networks (e.g. some regions): use a VPN — there is no
     government-blessed PyPI mirror to rely on.
4. The bootstrap already raises the network budget for you
   (`UV_HTTP_TIMEOUT=120`, `UV_HTTP_CONNECT_TIMEOUT=30`, `UV_HTTP_RETRIES=5`);
   you can raise them further in the environment if a mirror is very slow.

**Linked issues:** [#130](https://github.com/debpalash/OmniVoice-Studio/issues/130), [#60](https://github.com/debpalash/OmniVoice-Studio/issues/60), [#57](https://github.com/debpalash/OmniVoice-Studio/issues/57)
