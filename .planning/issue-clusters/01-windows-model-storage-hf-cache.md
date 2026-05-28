# [plan-01] Windows Model Storage & HF Cache — symlink-safe, relocatable model dir

## Defect
On Windows the Hugging Face cache uses symlinks and a `scan_cache_dir` traversal that hit `WinError 448 "untrusted mount point"` under `%LOCALAPPDATA%\OmniVoice\hf_cache`, immediately followed by `Errno 22 Invalid argument`. The downloader retries 5× and gives up, leaving the app with no models. The model directory is also hard-pinned to the system partition with no way to relocate it to a larger/faster drive.

## Children
- #118 — MSI installer: `k2-fsa/OmniVoice` + `faster-whisper-large-v3` download fails, `WinError 448` → `Errno 22`, loops 5×, app unusable (with or without HF_TOKEN)
- #117 — same `scan_cache_dir` `WinError 448` → `Errno 22` via `bun run dev`
- #64 — (feature) allow choosing the model/weights download directory; the symlink-safe-cache fix naturally yields a configurable path

## Fix sequence
1. Disable HF symlink behavior on Windows (`HF_HUB_DISABLE_SYMLINKS=1` / `local_dir_use_symlinks=False`) so extraction stays inside user space.
2. Make `scan_cache_dir` failures non-fatal — fall back to a direct snapshot check instead of aborting the download.
3. Surface a configurable models directory in Settings, backed by `HF_HOME` / `HF_HUB_CACHE`, defaulting to a writable per-user path; honor it in the subprocess env.
4. Migration: detect an existing populated cache and reuse it (no re-download for current users).

## Test matrix
| OS | Cache location | Symlink support | Required behavior |
|---|---|---|---|
| Windows 11 | default %LOCALAPPDATA% | no | download + load succeeds, no WinError 448 |
| Windows 11 | user-chosen drive (e.g. D:\) | no | models land in chosen dir, loads on restart |
| macOS / Linux | default ~/.cache | yes | unchanged (no regression) |

## Out of scope
Missing-dependency runtime failures (→ plan-02). Restricted-network Python bootstrap (→ plan-03).
