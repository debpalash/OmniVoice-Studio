"""One-click sidecar-engine provisioner (services.sidecar_install).

The provisioner replaces IndexTTS-2's four manual terminal steps (clone,
venv, `uv pip install -e .`, set OMNIVOICE_INDEXTTS_DIR) with a resumable
background job. These tests run the job with git/uv/httpx/HF mocked and
cover: the happy path, the disk-space preflight, the git-absent tarball
fallback, partial-install repair, already-installed detection, uninstall
safety (never delete a user's own clone), and the router wiring.
"""
import io
import os
import subprocess
import sys
import tarfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest

from services import sidecar_install as si


_GIB = 1024 ** 3


# ── fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch, tmp_path):
    """Hermetic per-test state: managed root under tmp, no leaked jobs/env.

    Rebinds the module-level ``si`` to the LIVE ``services.sidecar_install``
    module: other suites purge ``sys.modules["services"]`` for DB isolation,
    so the object imported at collection time can differ from the one the
    engines router imports at call time — patching the stale copy would make
    the router tests order-dependent.
    """
    import importlib
    global si
    si = importlib.import_module("services.sidecar_install")
    monkeypatch.setattr(si, "DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(si, "_jobs", {})
    monkeypatch.delenv("OMNIVOICE_INDEXTTS_DIR", raising=False)
    monkeypatch.delenv("OMNIVOICE_FAKE_SIDE_DIR", raising=False)
    monkeypatch.delenv("OMNIVOICE_DESKTOP_CONTAINED", raising=False)
    yield


def _mk_spec(**over) -> si.SidecarSpec:
    calls = over.pop("_calls", {})
    defaults = dict(
        engine_id="fake-side",
        display_name="Fake Sidecar",
        repo_url="https://github.com/example/fake-side.git",
        tarball_url="https://github.com/example/fake-side/archive/refs/heads/main.tar.gz",
        checkout_dirname="fake-side",
        env_var="OMNIVOICE_FAKE_SIDE_DIR",
        probe_module="fake_side.infer",
        weights_repo_id=None,
        required_bytes=1 * _GIB,
        invalidate=lambda: calls.setdefault("invalidated", 0) or calls.update(
            invalidated=calls.get("invalidated", 0) + 1
        ),
        installed_probe=lambda: False,
    )
    defaults.update(over)
    return si.SidecarSpec(**defaults)


def _fake_run_logged(created: list):
    """A _run_logged stand-in that fabricates git/uv side effects on disk."""

    def run(job, argv, *, timeout, env=None):
        created.append(argv)
        prog = os.path.basename(argv[0])
        if prog.startswith("git") and argv[1] == "clone":
            checkout = Path(argv[-1])
            checkout.mkdir(parents=True, exist_ok=True)
            (checkout / "pyproject.toml").write_text("[project]\nname='fake'\n")
        elif prog.startswith("uv") and argv[1] == "venv":
            venv = Path(argv[2])
            py = si._venv_python(venv)
            py.parent.mkdir(parents=True, exist_ok=True)
            py.write_text("#!fake python\n")
        # uv pip install: nothing to fabricate
        return 0

    return run


def _stub_verify_ok(monkeypatch):
    monkeypatch.setattr(
        si.subprocess, "run",
        lambda *a, **k: SimpleNamespace(returncode=0, stderr=b"", stdout=b""),
    )


def _run(spec):
    job = si._new_job(spec.engine_id)
    si._run_install(spec, job)
    return job


def _step_states(job):
    return {s["id"]: s["state"] for s in job["steps"]}


# ── happy path ─────────────────────────────────────────────────────────────


def test_happy_path_installs_and_persists(monkeypatch):
    calls = {}
    prefs_written = {}
    spec = _mk_spec(_calls=calls)
    argvs = []
    monkeypatch.setattr(si, "_locate_uv", lambda: "/fake/uv")
    monkeypatch.setattr(si, "disk_free_bytes", lambda p: 100 * _GIB)
    monkeypatch.setattr(si.shutil, "which", lambda n: "/usr/bin/git" if n == "git" else None)
    monkeypatch.setattr(si, "_run_logged", _fake_run_logged(argvs))
    _stub_verify_ok(monkeypatch)
    monkeypatch.setattr("core.prefs.set_", lambda k, v: prefs_written.update({k: v}))

    job = _run(spec)

    assert job["state"] == "succeeded", (job["error"], list(job["log"]))
    states = _step_states(job)
    assert states["preflight"] == "done"
    assert states["fetch_source"] == "done"
    assert states["create_venv"] == "done"
    assert states["install_deps"] == "done"
    assert states["verify"] == "done"
    assert states["fetch_weights"] == "skipped"       # no weights_repo_id
    assert states["persist"] == "done"
    checkout = si.managed_checkout(spec)
    # Engine usable immediately: env var set in THIS process…
    assert os.environ["OMNIVOICE_FAKE_SIDE_DIR"] == str(checkout)
    # …and persisted for the next launch via the env.* prefs mechanism.
    assert prefs_written == {"env.OMNIVOICE_FAKE_SIDE_DIR": str(checkout)}
    # Memoised venv resolution invalidated so it re-probes without restart.
    assert calls.get("invalidated") == 1
    # uv pip install targeted the sidecar venv's own python (isolation
    # preserved — the parent app's env is never touched).
    pip = next(a for a in argvs if a[1:3] == ["pip", "install"])
    assert pip[pip.index("--python") + 1] == str(si._venv_python(checkout / ".venv"))
    assert pip[-1] == str(checkout)


def test_rerun_after_success_skips_completed_steps(monkeypatch):
    spec = _mk_spec()
    argvs = []
    monkeypatch.setattr(si, "_locate_uv", lambda: "/fake/uv")
    monkeypatch.setattr(si, "disk_free_bytes", lambda p: 100 * _GIB)
    monkeypatch.setattr(si.shutil, "which", lambda n: "/usr/bin/git" if n == "git" else None)
    monkeypatch.setattr(si, "_run_logged", _fake_run_logged(argvs))
    _stub_verify_ok(monkeypatch)
    monkeypatch.setattr("core.prefs.set_", lambda k, v: None)

    assert _run(spec)["state"] == "succeeded"
    argvs.clear()
    job2 = _run(spec)
    assert job2["state"] == "succeeded"
    # No re-clone, no re-venv; only the idempotent pip repair pass runs.
    assert all(a[1:3] == ["pip", "install"] for a in argvs), argvs
    states = _step_states(job2)
    assert states["fetch_source"] == "done" and states["create_venv"] == "done"


# ── disk-space preflight ───────────────────────────────────────────────────


def test_disk_space_preflight_fails_early_with_numbers(monkeypatch):
    spec = _mk_spec(required_bytes=10 * _GIB)
    monkeypatch.setattr(si, "_locate_uv", lambda: "/fake/uv")
    monkeypatch.setattr(si, "disk_free_bytes", lambda p: 2 * _GIB)

    job = _run(spec)

    assert job["state"] == "failed"
    assert _step_states(job)["preflight"] == "error"
    # Nothing after preflight ran.
    assert _step_states(job)["fetch_source"] == "pending"
    # The error names what's needed and what's free, so the user can act.
    assert "10.0 GB" in job["error"] and "2.0 GB" in job["error"]
    assert "disk space" in job["remediation"].lower() or "disk space" in job["error"].lower()


def test_disk_preflight_subtracts_partial_install(monkeypatch, tmp_path):
    # 1 GiB required, 0.9 GiB already on disk from a prior partial run →
    # only the remainder (+headroom) must fit, so a resume isn't blocked.
    spec = _mk_spec(required_bytes=1 * _GIB)
    root = si.managed_root(spec)
    checkout = si.managed_checkout(spec)
    root.mkdir(parents=True)
    monkeypatch.setattr(si, "_source_present", lambda _spec, _checkout: True)
    monkeypatch.setattr(
        si,
        "_dir_size_bytes",
        lambda path: int(0.9 * _GIB) if path == checkout else 0,
    )
    monkeypatch.setattr(si, "disk_free_bytes", lambda p: (si.MIN_FREE_GB + 1) * _GIB)
    assert si.disk_space_error(spec) is None


def test_disk_preflight_subtracts_partial_install_from_peak_requirement(monkeypatch):
    spec = _mk_spec(required_bytes=1 * _GIB, temporary_free_bytes=4 * _GIB)
    checkout = si.managed_checkout(spec)
    monkeypatch.setattr(si, "_source_present", lambda _spec, _checkout: True)
    monkeypatch.setattr(
        si,
        "_dir_size_bytes",
        lambda path: int(0.9 * _GIB) if path == checkout else 0,
    )
    monkeypatch.setattr(si, "disk_free_bytes", lambda _path: (si.MIN_FREE_GB + 2) * _GIB)
    assert "3.1 GB" in si.disk_space_error(spec)


def test_disk_preflight_does_not_credit_weights_against_dependency_peak(monkeypatch):
    spec = _mk_spec(
        required_bytes=12 * _GIB,
        temporary_free_bytes=12 * _GIB,
        weights_repo_id="Example/Weights",
    )
    checkout = si.managed_checkout(spec)
    weights = checkout / spec.weights_subdir
    monkeypatch.setattr(si, "_source_present", lambda _spec, _checkout: True)
    monkeypatch.setattr(
        si,
        "_dir_size_bytes",
        lambda path: 7 * _GIB if path == checkout else 6 * _GIB if path == weights else 0,
    )
    monkeypatch.setattr(si, "disk_free_bytes", lambda _path: (si.MIN_FREE_GB + 10) * _GIB)

    assert "11.0 GB" in si.disk_space_error(spec)


def test_disk_preflight_does_not_credit_checkout_that_fetch_will_delete(monkeypatch):
    spec = _mk_spec(required_bytes=4 * _GIB, source_revision="new-revision")
    checkout = si.managed_checkout(spec)
    checkout.mkdir(parents=True)
    (checkout / "pyproject.toml").write_text("[project]\nname='fake'\n")
    (checkout / si._SOURCE_REVISION_MARKER).write_text("stale-revision\n")
    monkeypatch.setattr(si, "_dir_size_bytes", lambda _path: 3 * _GIB)
    monkeypatch.setattr(si, "disk_free_bytes", lambda _path: (si.MIN_FREE_GB + 2) * _GIB)

    assert "4.0 GB" in si.disk_space_error(spec)


def test_missing_uv_is_actionable(monkeypatch):
    spec = _mk_spec()
    monkeypatch.setattr(si, "_locate_uv", lambda: None)
    job = _run(spec)
    assert job["state"] == "failed"
    assert "uv" in job["error"]
    assert "docs.astral.sh/uv" in job["remediation"]


# ── git-absent tarball fallback ────────────────────────────────────────────


def _tarball_bytes(root_name: str, with_pyproject: bool = True) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        if with_pyproject:
            data = b"[project]\nname='fake'\n"
            info = tarfile.TarInfo(f"{root_name}/pyproject.toml")
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        data2 = b"print('hi')\n"
        info2 = tarfile.TarInfo(f"{root_name}/fake_side/__init__.py")
        info2.size = len(data2)
        tf.addfile(info2, io.BytesIO(data2))
    return buf.getvalue()


class _FakeStream:
    def __init__(self, payload: bytes):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def raise_for_status(self):
        return None

    def iter_bytes(self):
        yield self._payload


def test_git_absent_falls_back_to_tarball(monkeypatch):
    spec = _mk_spec()
    urls = []
    monkeypatch.setattr(si.shutil, "which", lambda n: None)   # no git anywhere
    import httpx

    def fake_stream(method, url, **kw):
        urls.append((method, url))
        return _FakeStream(_tarball_bytes("fake-side-main"))

    monkeypatch.setattr(httpx, "stream", fake_stream)

    job = si._new_job(spec.engine_id)
    step = si._job_step(job, "fetch_source")
    step["state"] = "running"
    si._step_fetch_source(spec, job)

    assert urls == [("GET", spec.tarball_url)]
    checkout = si.managed_checkout(spec)
    assert (checkout / "pyproject.toml").is_file()
    assert (checkout / "fake_side" / "__init__.py").is_file()
    assert step["detail"] == "source tarball"


def test_git_failure_falls_back_to_tarball(monkeypatch):
    """A present-but-failing git (proxy block, DNS, …) must not dead-end."""
    spec = _mk_spec()
    monkeypatch.setattr(si.shutil, "which", lambda n: "/usr/bin/git" if n == "git" else None)
    monkeypatch.setattr(si, "_run_logged", lambda job, argv, timeout: 128)  # git exits 128
    import httpx
    monkeypatch.setattr(
        httpx, "stream",
        lambda m, u, **k: _FakeStream(_tarball_bytes("fake-side-main")),
    )
    job = si._new_job(spec.engine_id)
    si._job_step(job, "fetch_source")["state"] = "running"
    si._step_fetch_source(spec, job)
    assert (si.managed_checkout(spec) / "pyproject.toml").is_file()


def test_legacy_kill_fallback_uses_only_direct_stable_handle(monkeypatch):
    calls = {}
    monkeypatch.setattr(si.os, "name", "nt")
    monkeypatch.setattr(
        si.subprocess, "run",
        lambda argv, **kw: calls.setdefault("argv", argv) or SimpleNamespace(returncode=0),
    )
    proc = SimpleNamespace(pid=4242, kill=lambda: calls.setdefault("plain_kill", True))
    si._kill_tree(proc)
    assert calls == {"plain_kill": True}


def test_desktop_installer_needs_no_unmanaged_spawn_flags(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_DESKTOP_CONTAINED", "1")
    monkeypatch.setattr(si.os, "name", "posix")
    assert si._install_containment_kwargs() == {}


def test_standalone_installer_also_delegates_to_nested_owner(monkeypatch):
    monkeypatch.delenv("OMNIVOICE_DESKTOP_CONTAINED", raising=False)
    monkeypatch.setattr(si.os, "name", "posix")
    assert si._install_containment_kwargs() == {}


def test_desktop_windows_timeout_never_taskkills_a_reusable_pid(monkeypatch):
    calls = {}
    monkeypatch.setenv("OMNIVOICE_DESKTOP_CONTAINED", "1")
    monkeypatch.setattr(si.os, "name", "nt")
    monkeypatch.setattr(
        si.subprocess,
        "run",
        lambda *args, **kwargs: calls.setdefault("taskkill", True),
    )
    proc = SimpleNamespace(pid=4242, kill=lambda: calls.setdefault("handle_kill", True))
    si._kill_tree(proc)
    assert calls == {"handle_kill": True}


def test_windows_job_timeout_waits_for_terminated_tree():
    events = []

    def timed_out_wait(timeout=None):
        events.append(("wait", timeout))
        raise subprocess.TimeoutExpired("operation.exe", timeout)

    child = SimpleNamespace(
        stdin=None,
        stdout=None,
        stderr=None,
        wait=timed_out_wait,
    )
    kernel = SimpleNamespace(
        TerminateJobObject=lambda job, code: events.append(("terminate", job, code)),
        CloseHandle=lambda job: events.append(("close", job)),
    )
    proc = si.WindowsJobPopen(child, 99, kernel)

    si._kill_tree(proc)

    assert events == [("terminate", 99, 1), ("close", 99), ("wait", 5)]


def test_desktop_installer_timeout_kills_nested_helper_before_it_can_mutate(
    monkeypatch, tmp_path
):
    """A timed-out uv/git root must not leave its pipe-owning helpers alive."""
    marker = tmp_path / "late-mutation"
    monkeypatch.setenv("OMNIVOICE_DESKTOP_CONTAINED", "1")
    drain_read, drain_write = os.pipe()
    monkeypatch.setenv("OMNIVOICE_DESKTOP_DRAIN_FD", str(drain_write))
    child_script = (
        "import os,time; time.sleep(1); "
        "open(os.environ['OMNIVOICE_TIMEOUT_MARKER'], 'w').write('bad')"
    )
    script = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable, '-c', {child_script!r}]); "
        "time.sleep(60)"
    )
    env = os.environ.copy()
    env["OMNIVOICE_TIMEOUT_MARKER"] = str(marker)
    job = si._new_job("fake-side")

    try:
        assert si._run_logged(job, [sys.executable, "-c", script], timeout=0.2, env=env) == -1
        time.sleep(1.2)
        assert not marker.exists()
    finally:
        os.close(drain_write)
        os.close(drain_read)


def test_backend_death_closes_control_pipe_and_kills_nested_operation(tmp_path):
    """Outer desktop teardown reaches an operation which owns a nested group."""
    marker = tmp_path / "mutation-after-backend-death"
    operation = (
        "import os,time; time.sleep(1); "
        "open(os.environ['OMNIVOICE_TIMEOUT_MARKER'], 'w').write('bad')"
    )
    backend = (
        "import os,sys,time; "
        "from core.contained_subprocess import spawn_owned; "
        f"spawn_owned([sys.executable, '-c', {operation!r}]); "
        "time.sleep(.2); os._exit(0)"
    )
    env = os.environ.copy()
    env["OMNIVOICE_DESKTOP_CONTAINED"] = "1"
    env["OMNIVOICE_TIMEOUT_MARKER"] = str(marker)
    env["PYTHONPATH"] = str(Path(__file__).parents[1] / "backend")

    run_kwargs = {}
    drain_fds = None
    if os.name == "posix":
        drain_fds = os.pipe()
        env["OMNIVOICE_DESKTOP_DRAIN_FD"] = str(drain_fds[1])
        run_kwargs["pass_fds"] = (drain_fds[1],)
    assert subprocess.run([sys.executable, "-c", backend], env=env, **run_kwargs).returncode == 0
    if drain_fds is not None:
        os.close(drain_fds[1])
        os.close(drain_fds[0])
    time.sleep(1.2)
    assert not marker.exists()


def test_safe_extract_members_blocks_tar_slip(tmp_path):
    """The pre-filter= fallback extractor must drop parent-dir escapes,
    absolute paths, and symlinks — mirroring extractall(filter='data')."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        good = tarfile.TarInfo("pkg/ok.txt")
        good.size = 2
        tf.addfile(good, io.BytesIO(b"ok"))
        evil = tarfile.TarInfo("../evil.txt")
        evil.size = 4
        tf.addfile(evil, io.BytesIO(b"pwnd"))
        absolute = tarfile.TarInfo("/abs.txt")
        absolute.size = 3
        tf.addfile(absolute, io.BytesIO(b"abs"))
        link = tarfile.TarInfo("pkg/link")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        tf.addfile(link)
    buf.seek(0)
    dest = tmp_path / "sandbox" / "out"
    dest.mkdir(parents=True)
    with tarfile.open(fileobj=buf, mode="r:gz") as tf:
        si._safe_extract_members(tf, str(dest))
    assert (dest / "pkg" / "ok.txt").read_text() == "ok"
    assert not (tmp_path / "sandbox" / "evil.txt").exists()
    assert not (dest / "pkg" / "link").exists()


def test_tarball_without_pyproject_fails_with_remediation(monkeypatch):
    spec = _mk_spec()
    monkeypatch.setattr(si.shutil, "which", lambda n: None)
    import httpx
    monkeypatch.setattr(
        httpx, "stream",
        lambda m, u, **k: _FakeStream(_tarball_bytes("fake-side-main", with_pyproject=False)),
    )
    job = si._new_job(spec.engine_id)
    si._job_step(job, "fetch_source")["state"] = "running"
    with pytest.raises(si._StepError) as ei:
        si._step_fetch_source(spec, job)
    assert "pyproject.toml" in str(ei.value)
    assert spec.env_var in ei.value.remediation


# ── partial-install repair ─────────────────────────────────────────────────


def test_half_fetched_checkout_is_refetched(monkeypatch):
    """A checkout without pyproject.toml (killed mid-clone) is wiped and
    re-fetched instead of being trusted or corrupting the install."""
    spec = _mk_spec()
    checkout = si.managed_checkout(spec)
    (checkout / "leftover").mkdir(parents=True)
    (checkout / "leftover" / "junk.txt").write_text("stale")
    argvs = []
    monkeypatch.setattr(si.shutil, "which", lambda n: "/usr/bin/git" if n == "git" else None)
    monkeypatch.setattr(si, "_run_logged", _fake_run_logged(argvs))

    job = si._new_job(spec.engine_id)
    si._job_step(job, "fetch_source")["state"] = "running"
    si._step_fetch_source(spec, job)

    assert (checkout / "pyproject.toml").is_file()
    assert not (checkout / "leftover").exists()
    assert any(a[1] == "clone" for a in argvs)


def _write_weights(
    wdir: Path,
    *,
    complete: bool,
    repo_id: str = "Example/Weights",
    revision: str = "",
    config_name: str = "config.yaml",
) -> None:
    """Fabricate a weights dir; ``complete=True`` adds the completion marker
    the installer writes after snapshot_download returns."""
    wdir.mkdir(parents=True, exist_ok=True)
    (wdir / config_name).write_text("model: fake\n")
    (wdir / "weights.safetensors").write_bytes(b"\0" * (6 * 1024 * 1024))
    if complete:
        (wdir / si._WEIGHTS_COMPLETE_MARKER).write_text(
            f"{repo_id}\n{revision}\n",
        )


def test_partial_install_is_not_already_installed(monkeypatch):
    """venv present but weights missing → NOT healthy → a re-run repairs it
    instead of short-circuiting with already_installed."""
    spec = _mk_spec(weights_repo_id="Example/Weights")
    checkout = si.managed_checkout(spec)
    checkout.mkdir(parents=True, exist_ok=True)
    (checkout / "pyproject.toml").write_text("[project]\nname='fake'\n")
    py = si._venv_python(checkout / ".venv")
    py.parent.mkdir(parents=True)
    py.write_text("#!fake\n")
    assert si._healthy(spec) is False

    # Complete the weights (incl. the completion marker) → healthy flips true.
    _write_weights(checkout / spec.weights_subdir, complete=True)
    assert si._healthy(spec) is True


def test_interrupted_multishard_weights_are_not_healthy(monkeypatch):
    """Regression: a killed-mid-download weights dir can hold config.yaml +
    plausible shards, but WITHOUT the completion marker it must stay
    unhealthy so a re-run resumes the download instead of reporting
    already_installed and failing later at model-load time."""
    spec = _mk_spec(weights_repo_id="Example/Weights")
    checkout = si.managed_checkout(spec)
    checkout.mkdir(parents=True, exist_ok=True)
    (checkout / "pyproject.toml").write_text("[project]\nname='fake'\n")
    py = si._venv_python(checkout / ".venv")
    py.parent.mkdir(parents=True)
    py.write_text("#!fake\n")
    _write_weights(checkout / spec.weights_subdir, complete=False)
    assert si._weights_present(spec) is False
    assert si._healthy(spec) is False
    monkeypatch.setitem(si.SPECS, "fake-side", spec)
    monkeypatch.setattr(si, "_run_install", lambda s, j: None)
    assert si.start_install("fake-side")["status"] == "started"  # repairs, not skips


def test_weights_step_downloads_via_endpoint_autoselect(monkeypatch):
    """The weights download must ride snapshot_download with the endpoint
    from services.endpoint_race — never a hardcoded huggingface.co URL."""
    spec = _mk_spec(weights_repo_id="Example/Weights")
    wdir = si.managed_checkout(spec) / spec.weights_subdir
    seen = {}

    def fake_snapshot_download(**kwargs):
        seen.update(kwargs)
        Path(kwargs["local_dir"]).mkdir(parents=True, exist_ok=True)
        (Path(kwargs["local_dir"]) / "config.yaml").write_text("ok\n")
        (Path(kwargs["local_dir"]) / "w.safetensors").write_bytes(b"\0" * (6 * 1024 * 1024))

    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "snapshot_download", fake_snapshot_download)
    from services import endpoint_race
    monkeypatch.setattr(endpoint_race, "effective_endpoint", lambda: "https://hf-mirror.example")
    monkeypatch.setattr("services.token_resolver.resolve", lambda: None)

    job = si._new_job(spec.engine_id)
    si._job_step(job, "fetch_weights")["state"] = "running"
    si._step_fetch_weights(spec, job)

    assert seen["repo_id"] == "Example/Weights"
    assert seen["endpoint"] == "https://hf-mirror.example"
    assert seen["local_dir"] == str(wdir)
    assert si._weights_present(spec)


def test_weights_revision_is_pinned_and_old_marker_forces_upgrade(monkeypatch):
    spec = _mk_spec(
        weights_repo_id="Example/Weights",
        weights_revision="a" * 40,
    )
    wdir = si.managed_checkout(spec) / spec.weights_subdir
    _write_weights(wdir, complete=True)  # legacy default-branch marker
    assert si._weights_present(spec) is False

    seen = {}

    def fake_snapshot_download(**kwargs):
        seen.update(kwargs)
        _write_weights(
            Path(kwargs["local_dir"]), complete=False,
            repo_id=kwargs["repo_id"], revision=kwargs["revision"],
        )

    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "snapshot_download", fake_snapshot_download)
    monkeypatch.setattr("services.endpoint_race.effective_endpoint", lambda: None)
    monkeypatch.setattr("services.token_resolver.resolve", lambda: None)
    job = si._new_job(spec.engine_id)
    si._job_step(job, "fetch_weights")["state"] = "running"
    si._step_fetch_weights(spec, job)
    assert seen["revision"] == "a" * 40
    assert si._weights_present(spec) is True


def test_weights_step_skips_when_already_present(monkeypatch):
    spec = _mk_spec(weights_repo_id="Example/Weights")
    wdir = si.managed_checkout(spec) / spec.weights_subdir
    _write_weights(wdir, complete=True)
    import huggingface_hub

    def boom(**kw):  # pragma: no cover — must not be reached
        raise AssertionError("snapshot_download must not run when weights exist")

    monkeypatch.setattr(huggingface_hub, "snapshot_download", boom)
    job = si._new_job(spec.engine_id)
    si._job_step(job, "fetch_weights")["state"] = "running"
    si._step_fetch_weights(spec, job)
    assert si._job_step(job, "fetch_weights")["state"] == "done"


# ── already-installed / already-running gating ────────────────────────────


def test_healthy_managed_install_reheals_lost_env_var(monkeypatch):
    """A complete managed install whose env var vanished (prefs.json wiped)
    is re-pointed by start_install instead of being reinstalled — and instead
    of returning already_installed while the engine stays unavailable."""
    spec = _mk_spec(weights_repo_id="Example/Weights")
    monkeypatch.setitem(si.SPECS, "fake-side", spec)
    checkout = si.managed_checkout(spec)
    checkout.mkdir(parents=True, exist_ok=True)
    (checkout / "pyproject.toml").write_text("[project]\nname='fake'\n")
    py = si._venv_python(checkout / ".venv")
    py.parent.mkdir(parents=True)
    py.write_text("#!fake\n")
    _write_weights(checkout / spec.weights_subdir, complete=True)
    prefs_written = {}
    monkeypatch.setattr("core.prefs.set_", lambda k, v: prefs_written.update({k: v}))
    assert "OMNIVOICE_FAKE_SIDE_DIR" not in os.environ

    res = si.start_install("fake-side")

    assert res["status"] == "already_installed"
    assert os.environ["OMNIVOICE_FAKE_SIDE_DIR"] == str(checkout)
    assert prefs_written == {"env.OMNIVOICE_FAKE_SIDE_DIR": str(checkout)}


def test_start_install_reports_already_installed_for_user_clone(monkeypatch):
    spec = _mk_spec(installed_probe=lambda: True)
    monkeypatch.setitem(si.SPECS, "fake-side", spec)
    monkeypatch.setenv("OMNIVOICE_FAKE_SIDE_DIR", "/home/user/own-clone")
    res = si.start_install("fake-side")
    assert res["status"] == "already_installed"


def test_start_install_reports_already_running(monkeypatch):
    spec = _mk_spec()
    monkeypatch.setitem(si.SPECS, "fake-side", spec)
    ran = threading.Event()
    monkeypatch.setattr(si, "_run_install", lambda s, j: ran.set())
    first = si.start_install("fake-side")
    assert first["status"] == "started"
    # Freeze the job as running to simulate the in-flight window.
    si._jobs["fake-side"]["state"] = "running"
    assert si.start_install("fake-side")["status"] == "already_running"
    assert ran.wait(5)


def test_start_install_unknown_engine_raises_keyerror():
    with pytest.raises(KeyError):
        si.start_install("definitely-not-an-engine")


def test_get_status_synthesizes_state_without_job(monkeypatch):
    spec = _mk_spec()
    monkeypatch.setitem(si.SPECS, "fake-side", spec)
    st = si.get_status("fake-side")
    assert st == {
        "engine_id": "fake-side",
        "installed": False,
        "managed": False,
        "install_dir": None,
        "job": None,
    }


# ── uninstall ──────────────────────────────────────────────────────────────


def test_uninstall_removes_managed_install_and_prefs(monkeypatch):
    spec = _mk_spec()
    monkeypatch.setitem(si.SPECS, "fake-side", spec)
    checkout = si.managed_checkout(spec)
    py = si._venv_python(checkout / ".venv")
    py.parent.mkdir(parents=True)
    py.write_text("#!fake\n")
    monkeypatch.setenv("OMNIVOICE_FAKE_SIDE_DIR", str(checkout))
    deleted = []
    monkeypatch.setattr("core.prefs.get", lambda k, d=None: str(checkout))
    monkeypatch.setattr("core.prefs.delete", lambda k: deleted.append(k))

    res = si.uninstall("fake-side")

    assert res["status"] == "uninstalled"
    assert not si.managed_root(spec).exists()
    assert "OMNIVOICE_FAKE_SIDE_DIR" not in os.environ
    assert deleted == ["env.OMNIVOICE_FAKE_SIDE_DIR"]


def test_uninstall_refuses_user_managed_clone(monkeypatch, tmp_path):
    spec = _mk_spec()
    monkeypatch.setitem(si.SPECS, "fake-side", spec)
    user_clone = tmp_path / "my-own-clone"
    user_clone.mkdir()
    monkeypatch.setenv("OMNIVOICE_FAKE_SIDE_DIR", str(user_clone))
    res = si.uninstall("fake-side")
    assert res["status"] == "not_managed"
    assert user_clone.exists()                      # never deleted
    assert os.environ["OMNIVOICE_FAKE_SIDE_DIR"] == str(user_clone)  # never cleared


def test_uninstall_clears_legacy_managed_preference(monkeypatch):
    spec = si.get_spec("indextts2")
    legacy = si.managed_root(spec) / "index-tts"
    legacy.mkdir(parents=True)
    monkeypatch.setenv(spec.env_var, str(legacy))
    deleted = []
    monkeypatch.setattr("core.prefs.get", lambda k, d=None: str(legacy))
    monkeypatch.setattr("core.prefs.delete", lambda k: deleted.append(k))

    assert si.uninstall(spec.engine_id)["status"] == "uninstalled"
    assert spec.env_var not in os.environ
    assert deleted == [f"env.{spec.env_var}"]


def test_uninstall_refuses_while_job_running(monkeypatch):
    spec = _mk_spec()
    monkeypatch.setitem(si.SPECS, "fake-side", spec)
    si._jobs["fake-side"] = si._new_job("fake-side")
    assert si.uninstall("fake-side")["status"] == "install_in_progress"


# ── indextts2 spec wiring (the engine this ships for) ─────────────────────


def test_indextts2_spec_matches_bootstrap_contract():
    spec = si.get_spec("indextts2")
    assert spec is not None
    # The env var must be the one engines/indextts/bootstrap.py actually
    # reads — anything else would install into a dir the engine never finds.
    assert spec.env_var == "OMNIVOICE_INDEXTTS_DIR"
    assert spec.probe_module == "indextts.infer_v2_5"
    # main.py loads from <dir>/checkpoints/, resolving whichever accepted
    # config name is on disk — the installer must put the weights there.
    assert spec.repo_ref == "indextts-2.5"
    assert spec.source_revision == "bf2e967fac7933197143b017a60820b1ad40c448"
    assert spec.source_required_path == "indextts/infer_v2_5.py"
    assert spec.weights_repo_id == "IndexTeam/IndexTTS-2.5"
    assert spec.weights_revision == "d0aa86e75bb6f3437f3831e95056fa72842d89ef"
    assert spec.weights_subdir == "checkpoints"
    assert spec.weights_config_names == ("config.yaml", "config_v2_5.yaml")
    assert spec.repo_url.endswith("index-tts.git")


def test_indextts25_health_accepts_either_config_name(monkeypatch):
    """#1611: this used to assert the OPPOSITE — that a checkout holding only
    config.yaml is unhealthy — which is what a clean IndexTeam/IndexTTS-2.5
    download actually produces, so every install failed. Both the upstream
    name and the hand-renamed one from the old workaround are healthy now;
    neither present is still a truncated download.
    """
    spec = si.get_spec("indextts2")
    monkeypatch.setenv(spec.env_var, str(si.managed_checkout(spec)))
    checkout = si.managed_checkout(spec)
    required = checkout / spec.source_required_path
    required.parent.mkdir(parents=True, exist_ok=True)
    required.write_text("class IndexTTS2: pass\n")
    (checkout / "pyproject.toml").write_text("[project]\nname='indextts'\n")
    (checkout / si._SOURCE_REVISION_MARKER).write_text(f"{spec.source_revision}\n")
    py = si._venv_python(checkout / ".venv")
    py.parent.mkdir(parents=True)
    py.write_text("#!fake\n")
    wdir = checkout / spec.weights_subdir
    _write_weights(
        wdir,
        complete=True,
        repo_id=spec.weights_repo_id,
        revision=spec.weights_revision,
    )
    # What a fresh upstream snapshot looks like.
    assert si._healthy(spec) is True
    # What the pre-fix workaround left behind.
    (wdir / "config.yaml").unlink()
    (wdir / "config_v2_5.yaml").write_text("model: fake\n")
    assert si._healthy(spec) is True
    # A genuinely truncated download is still caught.
    (wdir / "config_v2_5.yaml").unlink()
    assert si._healthy(spec) is False


def test_managed_indextts2_source_is_preserved_during_25_install(monkeypatch):
    spec = si.get_spec("indextts2")
    legacy = si.managed_root(spec) / "index-tts"
    legacy.mkdir(parents=True)
    (legacy / "pyproject.toml").write_text("[project]\nname='indextts'\n")
    (legacy / "old-v2-only.txt").write_text("old")
    monkeypatch.setenv(spec.env_var, str(legacy))
    checkout = si.managed_checkout(spec)
    argvs = []

    def fake_run(job, argv, *, timeout, env=None):
        argvs.append(argv)
        if argv[1] == "clone":
            checkout.mkdir(parents=True, exist_ok=True)
            (checkout / "pyproject.toml").write_text("[project]\nname='indextts'\n")
            required = checkout / spec.source_required_path
            required.parent.mkdir(parents=True, exist_ok=True)
            required.write_text("class IndexTTS2: pass\n")
        return 0

    monkeypatch.setattr(si.shutil, "which", lambda n: "/usr/bin/git")
    monkeypatch.setattr(si, "_run_logged", fake_run)
    job = si._new_job(spec.engine_id)
    si._job_step(job, "fetch_source")["state"] = "running"
    si._step_fetch_source(spec, job)
    clone = next(argv for argv in argvs if argv[1] == "clone")
    assert clone[clone.index("--branch") + 1] == "indextts-2.5"
    assert (legacy / "old-v2-only.txt").read_text() == "old"
    assert si._source_present(spec, checkout)


def test_indextts2_env_var_in_settings_allowlist():
    from api.routers.system import PERSISTENT_KEYS
    assert "OMNIVOICE_INDEXTTS_DIR" in PERSISTENT_KEYS


def test_list_backends_flags_indextts2_one_click():
    """Fail-before/pass-after: the Settings UI keys the Install button off
    this field — without it the engine stays a manual setup_snippet."""
    from services import tts_backend
    row = next(r for r in tts_backend.list_backends() if r["id"] == "indextts2")
    assert row["one_click_install"] is True
    other = next(r for r in tts_backend.list_backends() if r["id"] == "omnivoice")
    assert other["one_click_install"] is False


# ── router wiring ──────────────────────────────────────────────────────────


def test_sidecar_routes_never_shadow_literal_engine_routes():
    """Regression: the engines router registers BEFORE literal-path routers
    (e.g. sonitranslate), so a dynamic ``/engines/{engine_id}/install`` here
    would swallow ``POST /engines/sonitranslate/install``. The sidecar
    installer must keep its own literal namespace (/engines/sidecar/…)."""
    from api.routers import engines as engines_router
    install_paths = [
        r.path for r in engines_router.router.routes if "install" in r.path
    ]
    assert install_paths, "sidecar install routes missing"
    for p in install_paths:
        assert not p.startswith("/engines/{"), (
            f"{p} would shadow literal /engines/<x>/install routes registered later"
        )


def test_router_404s_engines_without_installer():
    from fastapi import HTTPException
    from api.routers import engines as engines_router
    with pytest.raises(HTTPException) as ei:
        engines_router.install_sidecar_engine("omnivoice")
    assert ei.value.status_code == 404
    with pytest.raises(HTTPException) as ei:
        engines_router.sidecar_install_status("omnivoice")
    assert ei.value.status_code == 404
    with pytest.raises(HTTPException) as ei:
        engines_router.uninstall_sidecar_engine("omnivoice")
    assert ei.value.status_code == 404


def test_router_uninstall_maps_refusals_to_http_errors(monkeypatch):
    from fastapi import HTTPException
    from api.routers import engines as engines_router
    spec = _mk_spec()
    monkeypatch.setitem(si.SPECS, "fake-side", spec)
    si._jobs["fake-side"] = si._new_job("fake-side")
    with pytest.raises(HTTPException) as ei:
        engines_router.uninstall_sidecar_engine("fake-side")
    assert ei.value.status_code == 409
    si._jobs.pop("fake-side")
    monkeypatch.setenv("OMNIVOICE_FAKE_SIDE_DIR", "/somewhere/else")
    with pytest.raises(HTTPException) as ei:
        engines_router.uninstall_sidecar_engine("fake-side")
    assert ei.value.status_code == 400
