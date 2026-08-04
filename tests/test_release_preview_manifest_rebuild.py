"""The rebuilt preview updater manifest must never describe files it isn't shipping.

`Rebuild preview updater manifest from published assets` (release.yml) exists
because tauri-action stopped refreshing `latest.json` while the nightly job kept
replacing the version-less macOS tarballs — so the manifest's darwin signatures
described bytes that no longer existed and every macOS Preview update failed
verification (#1327).

Rebuilding from the release's *real* assets closes that. But the rebuild picks
the AppImage and the MSI independently, by highest run number, and a matrix
where one leg failed or was re-run leaves those at different numbers. Taking
whichever is larger as *the* version then publishes a manifest advertising
`X.Y.Z-5` that hands Windows users the `-4` MSI — the same manifest/artifact
drift, reintroduced by the fix for it (CodeRabbit).

These tests run the step's real embedded Python (extracted from release.yml, so
it cannot drift) against synthetic asset lists, with the parts that talk to
GitHub stubbed out.
"""

import json
import os
import shutil
import stat
import subprocess
import sys

import pytest
import yaml

pytestmark = pytest.mark.skipif(
    sys.platform == "win32",
    reason="the step is a bash+python heredoc using POSIX /tmp paths",
)

_WORKFLOW = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    ".github", "workflows", "release.yml",
)
_STEP = "Rebuild preview updater manifest from published assets"

_MAC = ["OmniVoice.Studio_aarch64.app.tar.gz", "OmniVoice.Studio_x64.app.tar.gz"]


def _assets(appimage_n, msi_n, version="0.4.3"):
    """A published-asset list, plus the `.sig` companion each entry needs."""
    names = _MAC + [
        f"OmniVoice.Studio_{version}-{appimage_n}_amd64.AppImage",
        f"OmniVoice.Studio_{version}-{msi_n}_x64_en-US.msi",
    ]
    return names + [n + ".sig" for n in names]


def _step_script():
    with open(_WORKFLOW, encoding="utf-8") as fh:
        wf = yaml.safe_load(fh)
    for job in wf["jobs"].values():
        for step in job.get("steps", []):
            if step.get("name") == _STEP:
                return step["run"]
    raise AssertionError(f"step {_STEP!r} not found in release.yml")


def _run(tmp_path, names):
    """Run the step with `gh` stubbed; return (CompletedProcess, manifest|None).

    The stub answers `release view` from the supplied asset list, writes a
    placeholder for every `release download`, and records `release upload` by
    copying the manifest somewhere the test can read it.
    """
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    uploaded = tmp_path / "uploaded-latest.json"
    gh = bin_dir / "gh"
    gh.write_text(
        "#!/usr/bin/env bash\n"
        'if [ "$2" = "view" ]; then\n'
        f"  cat {str(tmp_path / 'assets.json')!r}\n"
        "  exit 0\n"
        "fi\n"
        # `gh release download preview --repo R -p NAME -D DIR`
        'if [ "$2" = "download" ]; then\n'
        "  pat=\"\"; dir=\"\"\n"
        '  while [ $# -gt 0 ]; do\n'
        '    case "$1" in -p) pat="$2"; shift 2 ;; -D) dir="$2"; shift 2 ;; *) shift ;; esac\n'
        "  done\n"
        # A minisign signature file: comment, sig line, trusted comment, global sig.
        '  printf "untrusted comment: sig\\nUlN%s\\ntrusted comment: t\\nUlN%s\\n" "$pat" "$pat" > "$dir/$pat"\n'
        "  exit 0\n"
        "fi\n"
        'if [ "$2" = "upload" ]; then\n'
        f'  cp "$4" {str(uploaded)!r}\n'
        "  exit 0\n"
        "fi\n"
        "exit 0\n"
    )
    gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
    (tmp_path / "assets.json").write_text(json.dumps(names))

    script = tmp_path / "step.sh"
    script.write_text(_step_script())
    env = dict(
        os.environ,
        PATH=f"{bin_dir}:{os.environ['PATH']}",
        GH_TOKEN="x",
        REPO="debpalash/OmniVoice-Studio",
    )
    proc = subprocess.run(
        [shutil.which("bash") or "/bin/bash", str(script)],
        capture_output=True, text=True, env=env, timeout=120,
    )
    manifest = json.loads(uploaded.read_text()) if uploaded.exists() else None
    return proc, manifest


def test_matched_run_numbers_produce_a_manifest(tmp_path):
    """The happy path: both versioned legs from run 7 → version 0.4.3-7."""
    proc, manifest = _run(tmp_path, _assets(7, 7))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert manifest is not None, "step succeeded without uploading a manifest"
    assert manifest["version"] == "0.4.3-7"
    # Every platform stable serves must be present, and each must point at a
    # file that was actually in the release.
    assert set(manifest["platforms"]) == {
        "darwin-aarch64", "darwin-aarch64-app",
        "darwin-x86_64", "darwin-x86_64-app",
        "linux-x86_64", "linux-x86_64-appimage",
        "windows-x86_64", "windows-x86_64-msi",
    }
    published = set(_assets(7, 7))
    for plat, info in manifest["platforms"].items():
        assert info["url"].rsplit("/", 1)[-1] in published, plat
        assert info["signature"], plat


@pytest.mark.parametrize("appimage_n,msi_n", [(8, 7), (7, 8)])
def test_mismatched_run_numbers_fail_loudly(tmp_path, appimage_n, msi_n):
    """One leg failed or was re-run — refuse rather than publish a lie.

    Taking the larger N would advertise a version that describes only one of
    the two artifacts the manifest points at, which is exactly the drift this
    job exists to end. Leaving the previous manifest in place is the safer
    outcome: it is a visible, already-understood state.
    """
    proc, manifest = _run(tmp_path, _assets(appimage_n, msi_n))
    assert proc.returncode != 0, (
        "step published a manifest from artifacts of two different runs:\n"
        + proc.stdout
    )
    assert manifest is None, "a mismatched manifest was uploaded anyway"
    assert "different runs" in (proc.stdout + proc.stderr)


def test_missing_signature_companion_fails(tmp_path):
    """A `.sig` that never got uploaded means the artifact is unverifiable —
    publishing its entry would hand every client a signature check it cannot
    pass, which is the #1327 outage in a different costume."""
    names = [n for n in _assets(7, 7)
             if n != "OmniVoice.Studio_aarch64.app.tar.gz.sig"]
    proc, manifest = _run(tmp_path, names)
    assert proc.returncode != 0, proc.stdout
    assert manifest is None
    assert "sig companion missing" in (proc.stdout + proc.stderr)


def test_missing_darwin_tarball_fails(tmp_path):
    """Intel Mac silently dropping out of the manifest is how those users stop
    getting preview updates without anyone noticing."""
    names = [n for n in _assets(7, 7)
             if not n.startswith("OmniVoice.Studio_x64.app.tar.gz")]
    proc, manifest = _run(tmp_path, names)
    assert proc.returncode != 0, proc.stdout
    assert manifest is None
    assert "updater artifact missing" in (proc.stdout + proc.stderr)
