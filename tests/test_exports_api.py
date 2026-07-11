"""Tests for the export router (`backend/api/routers/exports.py`).

Covers the full route surface — /export, /export/record, /export/history,
/export/reveal — which previously had zero dedicated tests (only two smoke
checks in test_router_smoke.py):

* happy paths: copy-to-destination + history recording, record-only, history
  listing order, reveal (with subprocess mocked so no Finder/Explorer opens);
* the security guards: source traversal (`_safe_source` accepts basenames
  only, resolved inside OUTPUTS_DIR), destination validation (absolute path
  required, parent must exist);
* the regression for the dead `isabs` check: `os.path.realpath()` absolutizes
  a relative destination against the server's cwd, so relative destinations
  used to silently export to a cwd-dependent location instead of the
  documented 400 (fail-before/pass-after: `_safe_destination` now checks
  `isabs` before realpath);
* error mapping: copy failure → 500, reveal of a missing path → 404,
  reveal spawn failure → 500;
* the mp4 branch: visible watermark disabled → plain copy; ffmpeg overlay
  failure → plain-copy fallback (the user still gets their file).
"""
import os
import subprocess

import pytest

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")


@pytest.fixture(scope="module")
def client():
    # Same self-sufficient pattern as test_router_smoke.py: lazy import, and
    # seed the schema explicitly because a bare TestClient never runs the app
    # lifespan (where init_db() lives).
    from fastapi.testclient import TestClient
    from main import app
    import core.db

    core.db.init_db()
    return TestClient(app, client=("127.0.0.1", 50000))


@pytest.fixture
def outputs_dir(tmp_path, monkeypatch):
    """A throwaway OUTPUTS_DIR wired into the router's frozen import."""
    import api.routers.exports as exports

    out = tmp_path / "outputs"
    out.mkdir()
    monkeypatch.setattr(exports, "OUTPUTS_DIR", str(out))
    return out


def _make_source(outputs_dir, name="clip.wav", data=b"RIFFxxxxWAVE-test-audio"):
    p = outputs_dir / name
    p.write_bytes(data)
    return p


# ── route shapes ─────────────────────────────────────────────────────────────
def test_route_shapes(client):
    from main import app

    routes = {r.path: r.methods for r in app.routes if hasattr(r, "methods")}
    assert "POST" in routes["/export"]
    assert "POST" in routes["/export/record"]
    assert "GET" in routes["/export/history"]
    assert "POST" in routes["/export/reveal"]


# ── /export happy path ───────────────────────────────────────────────────────
def test_export_copies_file_and_records_history(client, outputs_dir, tmp_path):
    src = _make_source(outputs_dir)
    dest_dir = tmp_path / "dest"
    dest_dir.mkdir()
    dest = dest_dir / "exported.wav"

    r = client.post("/export", json={
        "source_filename": "clip.wav",
        "destination_path": str(dest),
        "mode": "history",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert len(body["id"]) == 8

    assert dest.read_bytes() == src.read_bytes()

    hist = client.get("/export/history").json()
    entry = next(h for h in hist if h["id"] == body["id"])
    assert entry["filename"] == "clip.wav"
    assert entry["destination_path"] == os.path.realpath(str(dest))
    assert entry["mode"] == "history"


def test_export_destination_may_be_an_existing_directory(client, outputs_dir, tmp_path):
    # shutil.copy2 into a directory keeps the source basename.
    _make_source(outputs_dir, name="take2.wav")
    dest_dir = tmp_path / "outbox"
    dest_dir.mkdir()

    r = client.post("/export", json={
        "source_filename": "take2.wav",
        "destination_path": str(dest_dir),
    })
    assert r.status_code == 200
    assert (dest_dir / "take2.wav").is_file()


# ── /export source guards ────────────────────────────────────────────────────
@pytest.mark.parametrize("bad_name", [
    "../../../etc/passwd",       # classic traversal
    "..",                        # bare parent hop
    "sub/dir.wav",               # any separator is rejected (basename-only)
    "/etc/passwd",               # absolute path
    "",                          # empty
])
def test_export_rejects_non_basename_sources(client, outputs_dir, tmp_path, bad_name):
    r = client.post("/export", json={
        "source_filename": bad_name,
        "destination_path": str(tmp_path),
    })
    assert r.status_code == 400
    assert "unexpected name" in r.json()["detail"]


def test_export_404_when_source_gone(client, outputs_dir, tmp_path):
    r = client.post("/export", json={
        "source_filename": "never-generated.wav",
        "destination_path": str(tmp_path),
    })
    assert r.status_code == 404
    assert "isn't on disk" in r.json()["detail"]


def test_export_symlink_inside_outputs_pointing_outside_is_rejected(
    client, outputs_dir, tmp_path
):
    # A symlink planted in OUTPUTS_DIR must not let /export read arbitrary
    # files: realpath resolves it outside the root, failing containment.
    secret = tmp_path / "secret.txt"
    secret.write_bytes(b"credentials")
    (outputs_dir / "innocent.wav").symlink_to(secret)

    r = client.post("/export", json={
        "source_filename": "innocent.wav",
        "destination_path": str(tmp_path / "out.wav"),
    })
    assert r.status_code == 404


# ── /export destination guards ───────────────────────────────────────────────
@pytest.mark.parametrize("bad_dest", ["", "   "])
def test_export_rejects_empty_destination(client, outputs_dir, bad_dest):
    _make_source(outputs_dir)
    r = client.post("/export", json={
        "source_filename": "clip.wav",
        "destination_path": bad_dest,
    })
    assert r.status_code == 400
    assert "destination folder" in r.json()["detail"]


def test_export_rejects_relative_destination_even_when_cwd_resolvable(
    client, outputs_dir, tmp_path, monkeypatch
):
    """Regression: the isabs check ran on realpath()'s output, which is
    always absolute — so a relative destination fell through and exported to
    a directory relative to the server's cwd. Pass a relative path whose
    parent EXISTS under cwd: before the fix this returned 200 and wrote a
    cwd-dependent file; now it's the documented 400."""
    _make_source(outputs_dir)
    monkeypatch.chdir(tmp_path)
    (tmp_path / "rel_out").mkdir()

    r = client.post("/export", json={
        "source_filename": "clip.wav",
        "destination_path": os.path.join("rel_out", "exported.wav"),
    })
    assert r.status_code == 400
    assert "full path" in r.json()["detail"]
    assert not (tmp_path / "rel_out" / "exported.wav").exists()


def test_export_rejects_destination_with_missing_parent(client, outputs_dir, tmp_path):
    _make_source(outputs_dir)
    r = client.post("/export", json={
        "source_filename": "clip.wav",
        "destination_path": str(tmp_path / "no-such-dir" / "out.wav"),
    })
    assert r.status_code == 400
    assert "doesn't exist yet" in r.json()["detail"]


def test_export_copy_failure_maps_to_500(client, outputs_dir, tmp_path, monkeypatch):
    import api.routers.exports as exports

    _make_source(outputs_dir)

    def _boom(src, dest):
        raise OSError("disk full")

    monkeypatch.setattr(exports.shutil, "copy2", _boom)
    r = client.post("/export", json={
        "source_filename": "clip.wav",
        "destination_path": str(tmp_path / "out.wav"),
    })
    assert r.status_code == 500
    assert "disk full" in r.json()["detail"]


# ── /export mp4 watermark branch ─────────────────────────────────────────────
def test_export_mp4_plain_copy_when_visible_watermark_disabled(
    client, outputs_dir, tmp_path, monkeypatch
):
    from services import watermark

    src = _make_source(outputs_dir, name="dub.mp4", data=b"\x00\x00\x00\x1cftyp-fake-mp4")
    monkeypatch.setattr(watermark, "is_visible_video_enabled", lambda: False)

    called = []
    monkeypatch.setattr(
        subprocess, "run",
        lambda *a, **k: called.append(a) or (_ for _ in ()).throw(AssertionError("ffmpeg must not run")),
    )

    dest = tmp_path / "dub-export.mp4"
    r = client.post("/export", json={
        "source_filename": "dub.mp4",
        "destination_path": str(dest),
    })
    assert r.status_code == 200
    assert dest.read_bytes() == src.read_bytes()
    assert not called


def test_export_mp4_falls_back_to_plain_copy_when_ffmpeg_fails(
    client, outputs_dir, tmp_path, monkeypatch
):
    from services import watermark

    src = _make_source(outputs_dir, name="dub.mp4", data=b"\x00\x00\x00\x1cftyp-fake-mp4")
    monkeypatch.setattr(watermark, "is_visible_video_enabled", lambda: True)
    monkeypatch.setattr(
        watermark, "get_ffmpeg_overlay_args", lambda logo: ["-filter_complex", "overlay"]
    )

    def _ffmpeg_dies(cmd, **kw):
        raise subprocess.CalledProcessError(1, cmd)

    monkeypatch.setattr(subprocess, "run", _ffmpeg_dies)

    dest = tmp_path / "dub-export.mp4"
    r = client.post("/export", json={
        "source_filename": "dub.mp4",
        "destination_path": str(dest),
    })
    # The user still gets their file (unwatermarked) — never a hard failure.
    assert r.status_code == 200
    assert dest.read_bytes() == src.read_bytes()


# ── /export/record ───────────────────────────────────────────────────────────
def test_record_export_writes_history_row(client):
    r = client.post("/export/record", json={
        "filename": "narration.wav",
        "destination_path": "~/Downloads",
        "mode": "file",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True

    hist = client.get("/export/history").json()
    entry = next(h for h in hist if h["id"] == body["id"])
    assert entry["filename"] == "narration.wav"
    assert entry["destination_path"] == "~/Downloads"
    assert entry["mode"] == "file"


def test_record_export_defaults(client):
    # ExportRecordRequest defaults: destination "~/Downloads", mode "file".
    r = client.post("/export/record", json={"filename": "only-name.wav"})
    assert r.status_code == 200
    hist = client.get("/export/history").json()
    entry = next(h for h in hist if h["id"] == r.json()["id"])
    assert entry["destination_path"] == "~/Downloads"
    assert entry["mode"] == "file"


# ── /export/history ──────────────────────────────────────────────────────────
def test_history_is_newest_first(client):
    a = client.post("/export/record", json={"filename": "older.wav"}).json()["id"]
    b = client.post("/export/record", json={"filename": "newer.wav"}).json()["id"]
    hist = client.get("/export/history").json()
    ids = [h["id"] for h in hist]
    assert ids.index(b) < ids.index(a)
    assert len(hist) <= 50


# ── /export/reveal ───────────────────────────────────────────────────────────
@pytest.mark.parametrize("bad_path", ["", "   "])
def test_reveal_rejects_empty_path(client, bad_path):
    r = client.post("/export/reveal", json={"path": bad_path})
    assert r.status_code == 400
    assert "nothing to reveal" in r.json()["detail"].lower()


def test_reveal_404_when_path_missing(client, tmp_path):
    r = client.post("/export/reveal", json={"path": str(tmp_path / "gone.wav")})
    assert r.status_code == 404
    assert "no longer on disk" in r.json()["detail"]


def test_reveal_file_spawns_file_manager_without_shell(client, tmp_path, monkeypatch):
    import api.routers.exports as exports

    target = tmp_path / "show-me.wav"
    target.write_bytes(b"x")

    calls = []

    def _fake_popen(cmd, *a, **kw):
        calls.append((cmd, kw))
        return None

    monkeypatch.setattr(exports.subprocess, "Popen", _fake_popen)
    r = client.post("/export/reveal", json={"path": str(target)})
    assert r.status_code == 200
    assert r.json() == {"success": True}

    assert len(calls) == 1
    cmd, kw = calls[0]
    # List argv, no shell interpolation — the security contract of the route.
    assert isinstance(cmd, list)
    assert kw.get("shell") is not True
    # Whatever the platform's opener is, the target (or its folder) is an arg.
    resolved = os.path.realpath(str(target))
    assert any(resolved in str(part) or os.path.dirname(resolved) in str(part)
               for part in cmd)


def test_reveal_directory_opens_the_folder_itself(client, tmp_path, monkeypatch):
    import api.routers.exports as exports

    calls = []
    monkeypatch.setattr(
        exports.subprocess, "Popen", lambda cmd, *a, **kw: calls.append(cmd)
    )
    r = client.post("/export/reveal", json={"path": str(tmp_path)})
    assert r.status_code == 200
    assert len(calls) == 1
    assert any(os.path.realpath(str(tmp_path)) in str(part) for part in calls[0])


def test_reveal_spawn_failure_maps_to_500(client, tmp_path, monkeypatch):
    import api.routers.exports as exports

    target = tmp_path / "cursed.wav"
    target.write_bytes(b"x")

    def _no_opener(*a, **kw):
        raise OSError("no file manager available")

    monkeypatch.setattr(exports.subprocess, "Popen", _no_opener)
    r = client.post("/export/reveal", json={"path": str(target)})
    assert r.status_code == 500
    assert "no file manager" in r.json()["detail"]
