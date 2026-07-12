# Uninstalling OmniVoice Studio

OmniVoice is **fully local** — it has no accounts, no cloud state, and no
background services. Removing it is just deleting the app plus the folders it
wrote on your machine. This page lists every one of those folders per platform,
and ships a script that finds and removes them for you (with a dry-run first).

> **TL;DR (the space hogs):** the two folders worth deleting are the **model
> cache** (the Hugging Face weights — several GB) and the **managed Python
> environment** (`project/.venv` — a few GB). Everything else is small.

## In the app (easiest — no repo needed)

**Settings → Storage → Remove all data.** It lists every folder this install
owns with its real size, lets you opt in (separately) to the shared Hugging Face
model cache, asks you to type `DELETE`, then removes everything and quits.

This is the right path if you installed the **.dmg / .msi / AppImage** — you
don't have the repo, so the script below isn't available to you.

> **You may not need to uninstall.** Right above it, **Reset & remove** does the
> same job at any scale you like — and leaves you with a working app instead of
> no app. See [Resetting](#resetting-instead-of-uninstalling) below.

## Resetting instead of uninstalling

**Settings → Storage → Reset & remove** puts part — or all — of OmniVoice back to
how it shipped, without removing the app. Every option shows its real size before
you commit, and the app restarts itself when it's done.

| Option | What it removes | What it keeps |
| --- | --- | --- |
| **UI preferences only** | Theme, layout, language, dub settings | Everything on disk |
| **All settings** | The above, plus saved settings on disk (engine choices, voice defaults) | Voices, projects, audio, models |
| **Downloaded assets & models** | Model weights, sidecar engines, audio tools, caches | Everything you made |
| **Everything OmniVoice did** | All of the above, plus voices, projects, generated audio, history, logs | The app itself, and the Python environment it runs on |

"Choose exactly what to remove" opens the same list as individual checkboxes, so
you can drop just the model weights, just a wedged sidecar engine, or just the
history — whatever is actually wrong.

Two things it deliberately does **not** touch:

- **Your storage locations.** If you pointed OmniVoice at a custom data or model
  directory, a settings reset keeps that pointer. Clearing it would strand
  gigabytes of already-downloaded weights at a path the app no longer looks in.
- **The managed Python environment.** "Everything OmniVoice did" still leaves you
  with a working app that restarts on the first-run screen. If you want the
  interpreter gone too, that's **Remove all data** — the section above.

The shared Hugging Face model cache is called out separately wherever it applies:
on macOS and Linux it's the standard cache other AI tools use too, so removing it
may delete models OmniVoice never downloaded. (On Windows, and in portable
installs, the cache is OmniVoice's own — there's nothing to share, and the app
says so.)

## The one-command uninstaller (from a clone)

From a clone or the source tarball:

```bash
# macOS / Linux — prints what it WOULD delete, with sizes, and stops:
scripts/uninstall.sh

# actually delete, after you've read the dry-run:
scripts/uninstall.sh --yes
```

```powershell
# Windows (PowerShell) — dry-run, then delete:
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -Yes
```

The script honors your custom locations: if you set `OMNIVOICE_DATA_DIR`,
`OMNIVOICE_CACHE_DIR`, `HF_HOME`, or `HF_HUB_CACHE` (or picked custom
data/model folders during setup), export the same variables before running it
and it will target those instead of the defaults. It never touches anything
outside the OmniVoice folders, and it does **not** delete the app binary itself
(see "Remove the app" below) — so it's safe to run even if you only want to
reclaim disk space and keep the app installed.

## What OmniVoice writes, and where

Four kinds of data, in up to four locations:

| What | Size | Notes |
|---|---|---|
| **Model cache** (Hugging Face weights) | GBs | The big one. Shared HF cache — see the caveat below. |
| **Managed Python env** (`project/.venv`) | GBs | Rebuilt automatically if you reinstall. |
| **App data** (voices, projects, DB, generated audio, logs) | small–MBs | Your voice profiles and history live here. |
| **App config + logs** (`config.json`, window state, Tauri logs) | tiny | Settings and desktop-shell logs. |

### macOS

```
~/Library/Application Support/OmniVoice/                       ← app data (voices, projects, omnivoice.db, outputs, omnivoice.log)
~/Library/Application Support/com.debpalash.omnivoice-studio/  ← config.json + the managed Python env (project/.venv)
~/Library/Logs/OmniVoice/                                      ← backend logs (backend.log, backend_err.log)
~/Library/Logs/com.debpalash.omnivoice-studio/                ← desktop-shell log (tauri.log)
~/.config/omnivoice/                                           ← saved env file (cache location, HF token)
~/.cache/huggingface/                                          ← model weights (shared HF cache — see caveat)
```

### Linux (AppImage / .deb)

```
~/.omnivoice/                                     ← app data (voices, projects, omnivoice.db, outputs, omnivoice.log)
~/.local/share/com.debpalash.omnivoice-studio/    ← config.json, shell logs, AND the managed Python env (project/.venv)
~/.local/state/OmniVoice/                         ← backend logs (backend.log, backend_err.log)
~/.config/omnivoice/                              ← saved env file (cache location, HF token)
~/.cache/huggingface/                             ← model weights (shared HF cache — see caveat)
```

### Windows

```
%APPDATA%\OmniVoice\                              ← app data (voices, projects, omnivoice.db, outputs, omnivoice.log)
%LOCALAPPDATA%\com.debpalash.omnivoice-studio\    ← config.json, shell logs, AND the managed Python env (project\.venv)
%LOCALAPPDATA%\OmniVoice\Logs\                    ← backend logs (backend.log, backend_err.log)
%USERPROFILE%\.config\omnivoice\                  ← saved env file (cache location, HF token)
%LOCALAPPDATA%\OmniVoice\hf_cache\                ← model weights (OmniVoice uses a short path here to dodge MAX_PATH)
```

On Windows, if `HF_HOME` isn't set, OmniVoice redirects the model cache to
`%LOCALAPPDATA%\OmniVoice\hf_cache` (instead of `~/.cache/huggingface`) so deep
model paths don't hit the 260-character `MAX_PATH` limit.

### Custom / portable locations

- **Custom folders:** if you chose a custom data or model folder in setup (or
  set `OMNIVOICE_DATA_DIR` / `OMNIVOICE_CACHE_DIR` / `HF_HOME` /
  `HF_HUB_CACHE`), your data is there instead of the defaults above.
- **Portable mode:** everything lives in an `OmniVoiceStudio-Data/` folder next
  to the app binary — delete that one folder and you're done.
- **Optional engine sidecars:** if you installed IndexTTS-2, CosyVoice, or
  another sidecar engine, its isolated venv lives under the app-config folder
  above and is removed with it.

> **Shared HF cache caveat:** `~/.cache/huggingface/` is the **standard Hugging
> Face cache**, shared by any tool that uses `huggingface_hub` (other ML apps,
> `transformers`, etc.). If you use other Hugging Face tools, deleting the whole
> folder removes *their* cached models too. To remove only OmniVoice's models,
> delete the `models--*` subfolders you recognize under
> `~/.cache/huggingface/hub/`, or just let it be — it's only a cache and any
> tool re-downloads what it needs. The uninstaller script prints the cache size
> and asks about it separately for this reason.

## Remove the app itself

The steps above clear the **data**; removing the installed **app** is the
normal per-platform step:

- **macOS:** drag **OmniVoice Studio.app** from `/Applications` to the Trash.
- **Windows:** **Settings → Apps → Installed apps → OmniVoice Studio →
  Uninstall** (or via "Add or remove programs").
- **Linux (AppImage):** delete the `.AppImage` file. If you integrated it into
  your menu (e.g. with AppImageLauncher or a hand-written `.desktop` file),
  also remove `~/.local/share/applications/*omnivoice*.desktop` and any icon
  under `~/.local/share/icons/`.
- **Linux (.deb):** `sudo apt remove omnivoice-studio` (this removes the
  program; your data folders above are user data and are left in place — delete
  them with the script or by hand).

## Reinstalling later

Nothing above is required before reinstalling — a fresh install rebuilds the
Python env and re-downloads models on demand. Keep `~/Library/Application
Support/OmniVoice/` (macOS) / `~/.omnivoice/` (Linux) / `%APPDATA%\OmniVoice\`
(Windows) if you want to preserve your **voice profiles and projects** across a
reinstall; delete it too for a truly clean slate.
