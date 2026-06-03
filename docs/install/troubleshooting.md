# OmniVoice Studio — Install Troubleshooting

The top 10 errors users have actually hit on `v0.2.x`, with their causes and
fixes. Most have a deeplink anchor that the in-app error UI's "Open docs for
this error" button targets directly.

## 1. `pkg_resources` missing (ModuleNotFoundError)

<a id="pkg_resources-missing"></a>

**Symptom:** the splash screen shows `ModuleNotFoundError: No module named
'pkg_resources'` during WhisperX import, and the app never advances past the
"Setting up models" step.

**Cause:** WhisperX (and a couple of its transitive deps) still imports
`pkg_resources`, which was removed from `setuptools >= 70`. Older `uv sync`
runs would resolve `setuptools` to a version that no longer ships it.

**Fix:** pull the latest `main`. `pyproject.toml` now pins
`setuptools>=70,<81` and the WhisperX dep is patched to import from
`importlib.metadata` first.

**Linked issue:** [#58](https://github.com/debpalash/OmniVoice-Studio/issues/58)

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

**Fix:** none needed — `faster-whisper` (CTranslate2) is the supported Intel
path and is still fast. If you want the latest CT2 wheels, run `uv sync`
from a fresh source checkout.

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
