# RESEARCH — Fast HuggingFace model downloads (2026)

**Date:** 2026-06-13 · **For:** 260613-fdl-PLAN.md

## Bottom line
As of mid-2026 the fast path is **hf-xet, on by default** in modern `huggingface_hub`. Xet is itself a chunk-level, content-defined, massively-parallel downloader with adaptive concurrency — it **is** the "IDM/uGet-style segmented download," done for you and dedup-aware. `hf_transfer` is **deprecated**. Rolling your own segmented downloader or bridging to aria2 is **not worth it as a default**; the only thing we must build is (a) better driving + progress UI and (b) an **opt-in** segmented path for the legacy-LFS long tail (repos Xet doesn't back).

Installed in this repo: `huggingface_hub 1.7.2`, `hf_xet` present. `snapshot_download` here supports `max_workers`, `tqdm_class`, `endpoint`, `dry_run` (confirmed via inspect).

## 1. hf-xet — USE (default, no action needed beyond pinning)
Content-defined chunks grouped into blocks ("xorbs") in a content-addressable store; download = send file SHA256 → get reconstruction metadata + presigned URLs → fetch needed xorb ranges **in parallel** → reassemble; already-present chunks skipped (dedup). Auto-used by `snapshot_download`/`hf_hub_download` for Xet-backed repos since huggingface_hub 0.32. 2–3× over Git-LFS, up to ~1 GB/s.
Knobs (defaults already tuned): `HF_XET_NUM_CONCURRENT_RANGE_GETS` (16), adaptive concurrency ON (max 64), `HF_XET_DATA_MAX_CONCURRENT_FILE_DOWNLOADS` (8), chunk cache disabled by default (better for pure download), `HF_XET_HIGH_PERFORMANCE=1` (opt-in max throughput, needs RAM/bandwidth), `HF_XET_RECONSTRUCT_WRITE_SEQUENTIALLY=1` (HDD). **64-bit only.**
- https://huggingface.co/docs/huggingface_hub/en/guides/download
- https://huggingface.co/docs/hub/en/xet/using-xet-storage
- https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables

## 2. hf_transfer — AVOID (deprecated)
`HF_HUB_ENABLE_HF_TRANSFER` flagged deprecated; Xet supersedes it. Historically **broke tqdm progress / had no callbacks** — directly conflicts with the accurate-progress goal. Successor for max throughput is `HF_XET_HIGH_PERFORMANCE=1`.
- https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables
- https://github.com/huggingface/hf_transfer/issues/63

## 3. huggingface_hub native concurrency — USE defaults
`snapshot_download(max_workers=...)` = parallel FILES (default 8), orthogonal to Xet's intra-file chunk parallelism. For OmniVoice's 1–few-large-file models the win is mostly Xet's intra-file parallelism; don't crank max_workers (multiplies buffer pressure). Resume is automatic via cache + ETag (no `resume_download` flag to manage).
- https://huggingface.co/docs/huggingface_hub/en/package_reference/file_download

## 4. Custom IDM-style Range downloader — AVOID as default, BUILD as opt-in for LFS
`/resolve/<rev>/<file>` 302-redirects to CDN (Cloudfront) which honors Range + parallel byte-ranges. Catch: follow redirect, **do NOT forward Authorization to the CDN host** (presigned URL carries auth), verify ETag/sha256, auth on first hop only. Redundant vs Xet for Xet-backed repos (HF closed issue #3232 as "use Xet"), **but genuinely helps non-Xet/legacy-LFS repos** which get no intra-file parallelism. → our Wave 3 opt-in.
- https://github.com/huggingface/huggingface_hub/issues/3232

## 5. aria2 — OPTIONAL, rejected for OmniVoice
`aria2c -x16 -s16 -c --header="Authorization: Bearer <token>"` is 3–5× on plain LFS, but: no dedup (worse than Xet for Xet repos), per-OS GPLv2 binary to package (parity burden — would have to be opt-in anyway), stdout/RPC progress scraping. The custom httpx path covers the same need with no binary. → not bundled.
- https://gist.github.com/padeoe/697678ab8e528b85a2a7bddafea1fa4f

## 6. Mirrors / HF_ENDPOINT — OPTIONAL, region-gated, breaks Xet
`HF_ENDPOINT=https://hf-mirror.com` redirects Hub traffic (standard for China). **Xet CAS/presigned URLs point at HF infra → mirrors generally don't serve the Xet protocol → traffic falls back to classic LFS** (no dedup, no Xet parallelism). So mirror and Xet fast-path are mutually exclusive; the realistic China stack is mirror + LFS + (our opt-in) segmented accelerator. → our Wave 4 opt-in, per-call `endpoint=` not process-wide.

## 7. Progress / speed — USE `tqdm_class` (xet-aware) + `dry_run` preflight
Unlike hf_transfer, **Xet reports progress through the same tqdm interface**; huggingface_hub aggregates per-file/thread bytes into a shared bar and feeds the `tqdm_class` you pass. So `snapshot_download(tqdm_class=...)` yields reliable aggregate bytes/total/rate/ETA even under parallel fetch. `snapshot_download(dry_run=True)` returns per-file sizes + cached flags → use for "will download X of Y, N GB" preflight. Speed sampling tunable via `HF_XET_DATA_PROGRESS_UPDATE_INTERVAL` (200ms).
- https://huggingface.co/docs/huggingface_hub/en/package_reference/file_download
- https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/_snapshot_download.py

## Recommended architecture (→ plan)
Pin `huggingface_hub>=1.7` + `hf-xet`; let Xet be the default (it IS the IDM technique). Drive `snapshot_download(repo_id, tqdm_class=OmniVoiceProgress, max_workers=8, endpoint=<opt-in mirror>)`; `dry_run=True` first for total/remaining; aggregate bytes in a backend tracker → one overall bar (speed/remaining/ETA). Opt-in only: `HF_XET_HIGH_PERFORMANCE` (max speed), `HF_XET_RECONSTRUCT_WRITE_SEQUENTIALLY` (HDD), a custom httpx **segmented downloader for legacy-LFS repos**, and an `HF_ENDPOINT` mirror (classic-LFS fallback). Never enable hf_transfer; never bundle aria2; never make the segmented path the default.
