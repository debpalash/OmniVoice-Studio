# Downloading models — speed & troubleshooting

OmniVoice downloads models from the Hugging Face Hub on first use. This page
explains how downloads are made fast, how to read the progress, and what to do
on slow or restricted networks.

## Fast downloads (Xet) — on by default

OmniVoice uses **Xet**, Hugging Face's chunked transfer backend. Instead of
pulling each file as one stream, Xet splits files into content-defined chunks
and fetches many byte-ranges **in parallel**, skips chunks you already have
(dedup), and resumes automatically after an interruption. This is the same
idea as a multi-connection download manager (IDM/uGet), built into the Hub
client — so there is nothing to install or enable.

You can confirm it's active: **Settings → Models** shows a **⚡ fast download**
badge, and **Settings → About** / `GET /system/info` reports
`fast_download.xet_enabled: true` with the `hf_xet` version. The backend also
logs one line at startup: `fast download: Xet on (hf_xet X.Y)`.

> Requirement: Xet needs a 64-bit OS (every supported OmniVoice platform).

## Reading the progress

When a download starts you'll see, in order:

1. **Resolving** — the app fetches the file list and computes an exact plan:
   total size, how much is already cached, and how much will actually
   download (shown before any bytes move).
2. **Downloading** — one overall bar with the file count (e.g. `3/7 files`),
   total size, and — on networks where per-byte progress is reported — live
   speed and ETA.
3. **Done** — the bar lands on 100% at the true total size.

> Note: with Xet, files are fetched chunk-by-chunk out of band, so the live
> *per-byte* speed isn't always observable mid-download — the bar advances by
> file and snaps to the exact total on completion. Classic (non-Xet) and
> mirror downloads report continuous byte speed.

## Advanced / opt-in tuning

All of these default **off** and apply to every platform identically. Set them
as environment variables (or via **Settings → API keys / environment**).

| Setting | Env var | Effect |
|---|---|---|
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
