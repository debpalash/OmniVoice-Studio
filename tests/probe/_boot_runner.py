"""Out-of-process first-run boot, executed by env.capture_first_run().

Runs in its OWN process so it never mutates the parent test session's module
table or environment (in-process booting purges/re-imports the backend, which
corrupts DB_PATH for other tests — see env.py). Boots the FastAPI app against a
fresh data dir, probes the first-run endpoints, and writes the captured context
as JSON to the output path. Not a test module (underscore-prefixed).

argv: <data_dir> <output_json_path>
"""

import glob
import json
import os
import sys
import time

# First-run endpoints a brand-new user implicitly hits (GET, loopback-safe).
ENDPOINTS = [("/health", "health"), ("/system/info", "sysinfo"), ("/model/status", "model")]


def main() -> int:
    data_dir, out_path = sys.argv[1], sys.argv[2]
    os.environ["OMNIVOICE_MODEL"] = "test"  # short-circuit the 2.4 GB model load
    os.environ["OMNIVOICE_DISABLE_FILE_LOG"] = "1"
    os.environ["OMNIVOICE_DATA_DIR"] = data_dir

    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    backend = os.path.join(repo_root, "backend")
    if backend not in sys.path:
        sys.path.insert(0, backend)  # mirror tests/conftest.py (--app-dir backend)

    from fastapi.testclient import TestClient
    from main import app

    ctx: dict = {}
    with TestClient(app, client=("127.0.0.1", 50000)) as client:  # ctx-enter fires lifespan → init_db()
        for path, prefix in ENDPOINTS:
            t0 = time.perf_counter()
            resp = client.get(path)
            ctx[f"{prefix}_ms"] = (time.perf_counter() - t0) * 1000.0
            ctx[f"{prefix}_status"] = resp.status_code
            try:
                ctx[f"{prefix}_body"] = resp.json()
            except Exception:  # noqa: BLE001
                ctx[f"{prefix}_body"] = None

    ctx["data_dir"] = data_dir
    ctx["db_path"] = ""
    for pat in ("*.sqlite3", "*.sqlite", "*.db"):
        hits = glob.glob(os.path.join(data_dir, "**", pat), recursive=True)
        if hits:
            ctx["db_path"] = hits[0]
            break

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(ctx, fh)
    return 0


if __name__ == "__main__":
    sys.exit(main())
