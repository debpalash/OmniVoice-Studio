# Downloading models — speed & troubleshooting

OmniVoice downloads models from the Hugging Face Hub on first use. This page
explains how downloads are made fast, how to read the progress, and what to do
on slow or restricted networks.

## Download backend: legacy LFS by default (accurate progress)

OmniVoice ships `hf_xet` (Hugging Face's chunked, parallel, dedup transfer
backend — the IDM/uGet-style fast path), **but currently runs with Xet
disabled** (`HF_HUB_DISABLE_XET=1`, set by the app). Reason: Xet's transfer
reports progress out-of-band and bypasses the byte-level progress hook, so the
download UI couldn't show real bytes/speed. Until a proper Xet progress hook
lands, the app forces the **classic LFS path**, which streams through the
standard progress reporter and gives accurate downloaded/remaining/speed.

To keep that path **fast** despite Xet being off, the app runs a built-in
**multi-connection (segmented) downloader on by default** — it fetches each file
over parallel byte-ranges (IDM/uGet style), so the legacy-LFS path is no longer
single-stream. It reports real live speed/ETA and **falls back to the normal
download on any error**, so it can never compromise a correct install. Adding a
free Hugging Face token (first-run setup, or Settings → Credentials) makes this
faster still — authenticated downloads get higher rate limits and fewer stalls.
To force the old single-stream path, set `OMNIVOICE_SEGMENTED_DOWNLOAD=0`.

State is reported at **Settings → About** / `GET /system/info`:

- `fast_download.xet_installed` — `hf_xet` present (true)
- `fast_download.xet_active` — whether Xet actually drives downloads (false by
  default, because of `HF_HUB_DISABLE_XET`)
- the **⚡ fast download** badge in **Settings → Models** appears only when Xet
  is *active*.

The backend logs one line at startup, e.g.
`downloads: Xet disabled → legacy LFS (hf_xet 1.4.2 installed=True)`.

### Re-enabling Xet (advanced, opt-in)

Power users who want Xet's speed and don't mind coarser progress can set
`HF_HUB_DISABLE_XET=0`. With Xet active, the overall bar advances by file and
snaps to the exact total on completion (per-file *byte* speed isn't shown,
which is exactly why it's off by default). Xet needs a 64-bit OS (all supported
OmniVoice platforms).

## Reading the progress

When a download starts you'll see, in order:

1. **Resolving** — the app fetches the file list and computes an exact plan:
   total size, how much is already cached, and how much will actually
   download (shown before any bytes move).
2. **Downloading** — one overall bar with the file count (e.g. `3/7 files`),
   total size, and — on networks where per-byte progress is reported — live
   speed and ETA.
3. **Done** — the bar lands on 100% at the true total size.

> Note: the exact total and "already cached / to download" split are known
> up front (a pre-flight resolve), so remaining is accurate from the start.
> Live per-byte speed appears once a file is large enough to stream over
> several seconds; very small/fast files may jump straight to done. The bar
> always lands on the exact total at completion. (If Xet is re-enabled,
> progress becomes file-granular — see above.)

## Advanced / opt-in tuning

These apply to every platform identically. Set them as environment variables (or
via **Settings → API keys / environment**). The segmented accelerator is **on by
default** (set its var to `0` to disable); the rest default **off**.

| Setting | Env var | Effect |
|---|---|---|
| Segmented accelerator | `OMNIVOICE_SEGMENTED_DOWNLOAD=0` | **On by default** (see above). Set to `0` to force the old single-stream legacy-LFS download instead of the parallel byte-range one. |
| Max parallel files | `OMNIVOICE_DOWNLOAD_MAX_WORKERS` (default 8) | Files fetched at once. Xet already parallelises *within* a file, so raising this rarely helps and uses more memory. |
| High-performance mode | `HF_XET_HIGH_PERFORMANCE=1` | Maximum throughput. Needs lots of RAM and bandwidth — can **hurt** low-RAM machines. Leave off unless you have headroom. |
| Spinning-disk (HDD) | `HF_XET_RECONSTRUCT_WRITE_SEQUENTIALLY=1` | Sequential writes; avoids parallel-write thrash on HDDs. Leave off on SSD/NVMe. |

## Restricted networks / mirrors (e.g. China)

If `huggingface.co` is slow or blocked, point the client at a mirror:

```
HF_ENDPOINT=https://hf-mirror.com
```

Set it as an environment variable (or in **Settings → environment**) before
downloading. Caveats:

- A mirror serves the **classic** download path, **not Xet** — you lose
  chunk-dedup and Xet's parallel fetch, but you gain reachability. On the
  classic path, per-byte speed/ETA **is** shown continuously.
- Russia and some networks have no official mirror; use a VPN/tunnel.

## Cancelling a download

**Settings → Models** lets you cancel an in-flight install. Cancellation stops
further retries and clears the failure cooldown so you can restart
immediately. A file that's already streaming finishes first — cancellation
takes effect at the next retry boundary.

## Troubleshooting

- **Stuck on "Resolving…"** — the Hub is slow to return metadata, or you're
  rate-limited without a token. Add a token (see
  [docs/setup/huggingface-token.md](setup/huggingface-token.md)) and retry.
- **Very slow / stalling** — try a mirror (above), or a wired connection.
  High-performance mode only helps if RAM and bandwidth are plentiful.
- **"download finished but no model weights were found"** — the download was
  interrupted and left a partial snapshot. Delete the model in
  **Settings → Models** and install it again.
- **Out of disk** — model sizes are shown in the catalog; free space or change
  the cache location with `HF_HOME` / `HF_HUB_CACHE`.
