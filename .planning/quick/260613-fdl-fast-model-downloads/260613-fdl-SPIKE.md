# SPIKE — FDL-00: Catalog Xet vs LFS classification

**Date:** 2026-06-13 · **Method:** HF API `GET /api/models/{repo}?expand[]=xetEnabled` (authoritative).

## Result: 25 / 25 catalog repos are Xet-backed

| backend | count |
|---------|-------|
| xet     | 25    |
| lfs     | 0     |
| unknown | 0     |

Every repo in `backend/config/models.yaml` — including both first-run defaults (`k2-fsa/OmniVoice` TTS, `Systran/faster-whisper-large-v3` ASR) — returns `xetEnabled: true`. Full list: all entries under TTS / ASR / Diarisation (k2-fsa, Systran×5, mlx-community×9, openai, nvidia×2, UsefulSensors×2, pyannote, OpenMOSS, KittenML, deepdml).

## Detection caveat (important for the executor)

The installed client is **huggingface_hub 1.7.2**, whose `repo_info(..., files_metadata=True)` siblings expose only `blob_id, lfs, rfilename, size` — **no `xet_file`, and no `xet_enabled` on the info object.** A first pass that inferred backend from siblings wrongly reported "0/25 xet, all LFS." Do **not** classify Xet status from `repo_info` siblings on this client version. The reliable signal is the Hub API `xetEnabled` expand field (used here) or `hf_xet` actually engaging at download time. Re-check after any `huggingface_hub` bump — newer versions surface `xet_enabled` directly.

## Verdict for Wave 3 (segmented accelerator): LOW priority

Because the entire current catalog is Xet-backed and `hf_xet` is installed, Xet already provides chunked parallel range-gets (the IDM/uGet behavior) for **every** model we ship. The custom segmented downloader (Wave 3) is therefore **not needed to speed up any current default model** — it remains valuable only for:
- the **mirror / restricted-network path** (Wave 4: `HF_ENDPOINT` falls back to classic LFS, no Xet), and
- any **future non-Xet repo** a user adds.

**Recommendation:** proceed with W1 (maximize/guarantee Xet) and W2 (accurate progress) as the real wins for today's catalog; keep W3 as opt-in, build it alongside W4's mirror path where it actually pays off. This matches the PLAN's original framing — confirmed, not changed.

## Consequence for W1/W2 framing
W1 "guarantee the Xet fast path" is correctly the primary lever: these repos download via Xet **only if** the client engages it (hf_xet installed ✓ + huggingface_hub recent ✓). The W2 live smoke test should confirm Xet is actually used (fast parallel aggregate progress on a real install), since `xetEnabled=true` is a Hub-side capability, not proof the client took the Xet path.
