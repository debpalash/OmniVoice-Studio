"""
omnivoice-dub — Phase 4.6 headless dubbing CLI (ROADMAP.md).

Drives the full dub pipeline from the command line: ingest → transcribe →
translate → generate → export. Uses the HTTP API under the hood so the same
orchestration logic that powers the UI runs here.

Requires the backend to be running (`uv run uvicorn main:app --app-dir backend`).
Auto-starts against `http://localhost:8000` unless `--api` is given.

Examples
--------

    # Straight MP4 input:
    omnivoice-dub video.mp4 --target de --voice profile_abc123

    # YouTube / URL ingest:
    omnivoice-dub --url https://youtu.be/... --target ja

    # Cinematic quality + glossary file (JSON: [{source,target,note}]):
    omnivoice-dub video.mp4 --target es --quality cinematic --glossary terms.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request


def _log(msg: str):
    print(msg, file=sys.stderr, flush=True)


def _post(api: str, path: str, body=None, files=None):
    """Minimal JSON/multipart POST. Avoids adding requests as a CLI dep."""
    import http.client
    url = urllib.parse.urlparse(api + path)
    conn = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=3600)
    if files:
        # Simple multipart encode.
        boundary = f"----ovbound{int(time.time()*1000)}"
        parts = []
        for name, val in (body or {}).items():
            parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{val}\r\n".encode())
        for name, (fname, data, ctype) in files.items():
            parts.append(
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{fname}\"\r\n"
                f"Content-Type: {ctype}\r\n\r\n".encode() + data + b"\r\n"
            )
        parts.append(f"--{boundary}--\r\n".encode())
        payload = b"".join(parts)
        conn.request("POST", url.path + (f"?{url.query}" if url.query else ""), payload, {
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        })
    else:
        payload = json.dumps(body or {}).encode()
        conn.request("POST", url.path + (f"?{url.query}" if url.query else ""), payload, {
            "Content-Type": "application/json",
        })
    r = conn.getresponse()
    data = r.read()
    if r.status >= 400:
        raise RuntimeError(f"POST {path} → {r.status}: {data.decode(errors='replace')[:400]}")
    if r.getheader("Content-Type", "").startswith("application/json"):
        return json.loads(data)
    return data


def _get(api: str, path: str):
    import http.client
    url = urllib.parse.urlparse(api + path)
    conn = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=3600)
    conn.request("GET", url.path + (f"?{url.query}" if url.query else ""))
    r = conn.getresponse()
    data = r.read()
    if r.status >= 400:
        raise RuntimeError(f"GET {path} → {r.status}: {data.decode(errors='replace')[:400]}")
    return json.loads(data) if r.getheader("Content-Type", "").startswith("application/json") else data


def _stream_task(api: str, task_id: str):
    """Tail `/tasks/stream/{task_id}` as SSE lines. Yields decoded event dicts."""
    import http.client
    url = urllib.parse.urlparse(api + f"/tasks/stream/{task_id}")
    conn = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=3600)
    conn.request("GET", url.path)
    r = conn.getresponse()
    if r.status >= 400:
        raise RuntimeError(f"stream {task_id} → {r.status}")
    buf = b""
    while True:
        chunk = r.read(4096)
        if not chunk:
            break
        buf += chunk
        while b"\n\n" in buf:
            frame, buf = buf.split(b"\n\n", 1)
            for line in frame.splitlines():
                if line.startswith(b"data: "):
                    try:
                        yield json.loads(line[6:])
                    except json.JSONDecodeError:
                        yield {"type": "raw", "raw": line[6:].decode(errors="replace")}


def main(argv=None):
    ap = argparse.ArgumentParser(prog="omnivoice-dub", description="Headless dubbing pipeline driver.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("file", nargs="?", help="Local video file to dub.")
    src.add_argument("--url", help="YouTube or direct video URL.")
    ap.add_argument("--target", required=True, help="Target language ISO code (e.g. de, ja, es).")
    ap.add_argument("--voice", help="Voice profile ID to apply to every segment.")
    ap.add_argument("--quality", choices=("fast", "cinematic"), default="fast")
    ap.add_argument("--glossary", help="Path to a JSON glossary: [{source,target,note}]")
    ap.add_argument("--api", default=os.environ.get("OMNIVOICE_API", "http://localhost:8000"))
    args = ap.parse_args(argv)

    api = args.api.rstrip("/")

    # 1. Ingest — upload or URL.
    if args.url:
        _log(f"→ ingesting URL: {args.url}")
        res = _post(api, "/dub/ingest-url", {"url": args.url})
    else:
        path = os.path.abspath(args.file)
        if not os.path.exists(path):
            ap.error(f"file not found: {path}")
        with open(path, "rb") as f:
            data = f.read()
        ctype = "video/mp4" if path.lower().endswith(".mp4") else "application/octet-stream"
        _log(f"→ uploading {path} ({len(data)/1e6:.1f} MB)")
        res = _post(api, "/dub/upload", None, files={"video": (os.path.basename(path), data, ctype)})

    job_id = res["job_id"]
    task_id = res["task_id"]
    _log(f"  job={job_id} task={task_id}")

    # 2. Wait for prep (extract + demucs + scene).
    for evt in _stream_task(api, task_id):
        etype = evt.get("type", "")
        if etype in {"download_start", "extract_start", "demucs_start", "scene_start"}:
            _log(f"  ... {etype}")
        if etype == "error":
            _log(f"  ✗ error at {evt.get('stage')}: {evt.get('error')}")
            return 1
        if etype == "ready":
            _log(f"  ✓ ready (duration {evt.get('duration')}s)")
            break
        if etype == "cancelled":
            _log("  ✗ cancelled"); return 1

    # 3. Transcribe (sync).
    _log("→ transcribing…")
    tx = _post(api, f"/dub/transcribe/{job_id}", {})
    segs = tx.get("segments", [])
    _log(f"  ✓ {len(segs)} segment(s), source={tx.get('source_lang')}")

    # 4. Translate.
    glossary = None
    if args.glossary:
        with open(args.glossary, "r", encoding="utf-8") as f:
            glossary = json.load(f)
    _log(f"→ translating to {args.target} ({args.quality})…")
    tr = _post(api, "/dub/translate", {
        "segments": [{"id": s["id"], "text": s.get("text_original") or s["text"], "target_lang": args.target} for s in segs],
        "target_lang": args.target,
        "quality": args.quality,
        "glossary": glossary,
    })
    translated_by_id = {t["id"]: t for t in tr.get("translated", [])}

    # Apply translations + optional voice to the job's segments.
    merged = []
    for s in segs:
        t = translated_by_id.get(s["id"])
        s = {**s, "target_lang": args.target}
        if args.voice:
            s["profile_id"] = args.voice
        if t and t.get("text"):
            s["text"] = t["text"]
        merged.append(s)

    # 5. Generate — kick off background task, stream events.
    _log("→ generating dub audio…")
    gen = _post(api, f"/dub/generate/{job_id}", {
        "segments": [{
            "start": s["start"], "end": s["end"],
            "text": s["text"], "target_lang": s.get("target_lang"),
            "profile_id": s.get("profile_id", ""),
            "instruct": s.get("instruct", ""),
            "speed": s.get("speed"), "gain": s.get("gain"),
        } for s in merged],
        "language": tr.get("target_lang", args.target),
        "language_code": args.target,
    })
    gen_task = gen["task_id"]
    n_done = 0
    for evt in _stream_task(api, gen_task):
        etype = evt.get("type", "")
        if etype == "progress":
            n = evt.get("current", 0)
            if n > n_done:
                _log(f"  seg {n}/{evt.get('total')}")
                n_done = n
        if etype == "error":
            _log(f"  ! seg {evt.get('segment')}: {evt.get('error')}")
        if etype == "done":
            _log(f"  ✓ done — tracks: {evt.get('tracks')}")
            break
        if etype == "cancelled":
            _log("  ✗ generation cancelled"); return 1

    _log(f"✓ job {job_id} complete. Download via /dub/download/{job_id}.mp4")
    return 0


if __name__ == "__main__":
    sys.exit(main())
