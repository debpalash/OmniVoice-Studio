"""The rebuilt preview manifest must never describe a build it isn't shipping.

`Rebuild + verify the preview updater manifest, then publish` (release.yml)
exists because tauri-action stopped refreshing `latest.json` while the nightly
job kept replacing the version-less macOS tarballs — so the manifest's darwin
signatures described bytes that no longer existed and every macOS Preview update
failed verification for two weeks, with CI green throughout (#1327).

Rebuilding from the release's *real* assets closes that. What these tests cover
is the part that kept being subtly wrong — three separate review findings were
all about **which artifacts may be described together**:

* the AppImage and MSI are picked independently by run number, so a matrix
  where one leg failed leaves them at different numbers and the manifest would
  advertise a version that describes only some of its own payload;
* the darwin tarballs carry no run number at all, and signature verification
  cannot save them, because a stale tarball and its stale `.sig` match each
  other perfectly.

The selection rules live in ``scripts/build_preview_manifest.py`` rather than a
YAML heredoc precisely so they can be called directly here — a heredoc can only
be tested by extracting it and stubbing a shell, which is how the earlier
version of this file ended up asserting against `gh` stubs instead of against
the rules.
"""
import datetime
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

from build_preview_manifest import (  # noqa: E402
    MAC_AARCH64,
    MAC_X86_64,
    ManifestRefused,
    build_manifest,
    required_assets,
)

REPO = "debpalash/VoiceStudio"
_T0 = datetime.datetime(2026, 8, 4, 12, 0, tzinfo=datetime.timezone.utc)


def _iso(minutes_after=0):
    return (_T0 + datetime.timedelta(minutes=minutes_after)).isoformat().replace("+00:00", "Z")


def _assets(appimage_n=7, msi_n=7, version="0.4.3", mac_offset=0, versioned_offset=0):
    """A published-asset list, with each artifact's `.sig` companion."""
    appimage = f"VoiceStudio_{version}-{appimage_n}_amd64.AppImage"
    msi = f"VoiceStudio_{version}-{msi_n}_x64_en-US.msi"
    rows = []
    for name in (appimage, msi):
        rows.append({"name": name, "updatedAt": _iso(versioned_offset)})
    for name in (MAC_AARCH64, MAC_X86_64):
        rows.append({"name": name, "updatedAt": _iso(mac_offset)})
    rows += [{"name": r["name"] + ".sig", "updatedAt": r["updatedAt"]} for r in list(rows)]
    return rows


def _sigs(assets):
    return {n: f"sig-for-{n}\n" for n in required_assets(assets)}


def _build(assets, **kw):
    return build_manifest(assets, REPO, signatures=_sigs(assets), pub_date=_T0, **kw)


def test_a_coherent_release_produces_a_manifest():
    assets = _assets()
    manifest = _build(assets)
    assert manifest["version"] == "0.4.3-7"
    # Every platform the stable channel serves must be present, or those users
    # silently stop getting preview updates.
    assert set(manifest["platforms"]) == {
        "darwin-aarch64", "darwin-aarch64-app",
        "darwin-x86_64", "darwin-x86_64-app",
        "linux-x86_64", "linux-x86_64-appimage",
        "windows-x86_64", "windows-x86_64-msi",
    }
    published = {a["name"] for a in assets}
    for plat, info in manifest["platforms"].items():
        assert info["url"].rsplit("/", 1)[-1] in published, plat
        assert info["signature"], plat


@pytest.mark.parametrize("appimage_n,msi_n", [(8, 7), (7, 8)])
def test_mismatched_run_numbers_are_refused(appimage_n, msi_n):
    """One leg failed or was re-run. Taking the larger N would advertise a
    version that describes only one of the two artifacts it points at — the
    same drift this job exists to end, reintroduced by the fix for it."""
    with pytest.raises(ManifestRefused, match="different runs"):
        _build(_assets(appimage_n=appimage_n, msi_n=msi_n))


def test_a_stale_macos_bundle_is_refused():
    """The darwin case, which no signature check can catch.

    A run whose macOS legs never uploaded leaves the PREVIOUS build's tarball
    and its matching `.sig` in place — they verify against each other perfectly.
    The manifest would advertise this version while serving Mac users the old
    build, and because those clients keep reporting the old version, the updater
    re-offers the same update forever.
    """
    with pytest.raises(ManifestRefused, match="EARLIER build"):
        _build(_assets(mac_offset=-90, versioned_offset=0))


def test_macos_bundles_uploaded_slightly_earlier_are_accepted():
    """The matrix legs finish minutes apart; the check must tolerate that or it
    fails every healthy run."""
    assert _build(_assets(mac_offset=-1, versioned_offset=0))["version"] == "0.4.3-7"


def test_macos_bundles_uploaded_later_are_fine():
    """Ordering within a run is not fixed — the macOS legs often finish last."""
    assert _build(_assets(mac_offset=5))["version"] == "0.4.3-7"


class TestBindingByRunStart:
    """Tying the darwin tarballs to the RUN rather than to their siblings.

    The 2026-08-05 nightly refused its own healthy build: all four matrix legs
    were green, but the macOS bundles had uploaded ~3 minutes before the last
    versioned artifact, and the leg-to-leg comparison reads that as "from an
    earlier build". Legs finishing minutes apart is normal — the fast
    Apple-Silicon leg routinely beats a slow Windows leg by more than any
    slack worth allowing — so the comparison itself was the bug. Everything
    uploaded after the run began is this run's.
    """

    def test_a_healthy_build_whose_mac_legs_finished_early_is_accepted(self):
        # Exactly the 2026-08-05 shape: mac legs 3 minutes ahead of the
        # slowest versioned leg, both well after the run started.
        assets = _assets(mac_offset=0, versioned_offset=3)
        manifest = _build(assets, run_started_at=_iso(-20))
        assert manifest["version"] == "0.4.3-7"

    def test_the_genuinely_stale_case_is_still_refused(self):
        # macOS legs never uploaded: their bundles are last night's, i.e.
        # from before this run existed. This is what the check is for.
        assets = _assets(mac_offset=-600, versioned_offset=0)
        with pytest.raises(ManifestRefused, match="EARLIER build"):
            _build(assets, run_started_at=_iso(-20))

    def test_clock_skew_at_the_boundary_does_not_refuse(self):
        # Asset timestamps and run timestamps come from different services;
        # a bundle stamped a minute "before" the run started is skew, not a
        # stale artifact from a run that would have been hours earlier.
        assets = _assets(mac_offset=-1, versioned_offset=0)
        assert _build(assets, run_started_at=_iso(0))["version"] == "0.4.3-7"

    def test_without_a_run_timestamp_the_old_comparison_still_applies(self):
        # Direct/manual invocation has no run context; the fallback must keep
        # catching the stale case rather than silently accepting anything.
        with pytest.raises(ManifestRefused, match="EARLIER build"):
            _build(_assets(mac_offset=-90, versioned_offset=0))

    def test_an_unreadable_run_timestamp_is_refused_not_ignored(self):
        # Falling back silently would hide that the binding never ran.
        with pytest.raises(ManifestRefused, match="upload times"):
            _build(_assets(), run_started_at="not-a-timestamp")


def test_the_workflow_binds_the_manifest_to_the_run_that_built_it():
    """The rule above is only worth having if release.yml actually passes the
    timestamp — and passes `created_at`, not `run_started_at`: the latter
    resets on re-run, so re-running this job alone would judge the bundles its
    own earlier attempt uploaded as stale and refuse a healthy build."""
    body = _preview_step()["run"]
    assert "run_started_at=" in body, (
        "release.yml no longer passes a run timestamp to build_manifest, so the "
        "darwin bundles fall back to the leg-to-leg comparison that refused a "
        "healthy nightly"
    )
    # The API field `run_started_at` RESETS on re-run; reading it would make a
    # re-run of this job alone judge its own earlier attempt's uploads stale.
    assert ".run_started_at" not in body, (
        "release.yml must not read the API's `run_started_at`, which resets on "
        "every re-run"
    )
    assert "/jobs?filter=latest" in body and ".started_at" in body, (
        "the anchor must be this run's earliest JOB start: the run's own "
        "`created_at` is stamped while it is still QUEUED, so a run waiting on "
        "the concurrency group would accept the run ahead of it uploading macOS "
        "bundles as its own"
    )
    assert "| min" in body, "taking anything but the earliest job start reintroduces the false refusal"


def test_the_preview_job_can_actually_read_its_run_metadata():
    """`contents: write` alone 403s the Actions Runs API (greptile), which
    under `set -e` would take the whole publish down — the outage this change
    exists to end, with a different cause."""
    import yaml

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, ".github", "workflows", "release.yml"), encoding="utf-8") as fh:
        wf = yaml.safe_load(fh)
    perms = wf["jobs"]["preview-notes"]["permissions"]
    assert perms.get("actions") == "read", (
        "preview-notes reads repos/…/actions/runs/<id>; without `actions: read` "
        "that call 403s"
    )


def test_preview_runs_cannot_overlap():
    """Two preview runs publish to the SAME rolling release, and the
    version-less macOS tarballs carry nothing identifying their run — so an
    overlap lets one run's manifest describe another run's Mac binaries
    (greptile). Serialization is what makes 'uploaded after this run started'
    mean 'belongs to this run'."""
    import yaml

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, ".github", "workflows", "release.yml"), encoding="utf-8") as fh:
        wf = yaml.safe_load(fh)
    assert "concurrency" in wf, "release.yml has no concurrency group — preview runs can overlap"
    # Per-REF, or a `v*` tag release queues behind a nightly (and a group that
    # lost its ref scoping would still pass a bare existence check).
    assert "${{ github.ref }}" in wf["concurrency"]["group"], (
        "the concurrency group must be scoped per ref, or unrelated releases "
        "serialize against each other"
    )
    assert wf["concurrency"].get("cancel-in-progress") is False, (
        "cancelling an in-flight preview mid-upload would leave a half-uploaded "
        "asset set for the next run to describe"
    )


def test_unreadable_timestamps_are_refused_not_ignored():
    """Missing `updatedAt` means the freshness check cannot run. Proceeding
    would silently drop the only thing tying the darwin bundles to this run."""
    assets = _assets()
    for row in assets:
        if row["name"] == MAC_AARCH64:
            row["updatedAt"] = None
    with pytest.raises(ManifestRefused, match="upload times"):
        _build(assets)


def test_a_missing_signature_companion_is_refused():
    """A `.sig` that never uploaded means the artifact is unverifiable —
    publishing its entry hands every client a check it cannot pass."""
    assets = [a for a in _assets() if a["name"] != MAC_AARCH64 + ".sig"]
    with pytest.raises(ManifestRefused, match="sig companion missing"):
        _build(assets)


def test_a_missing_darwin_tarball_is_refused():
    """Intel Mac silently dropping out of the manifest is how those users stop
    getting preview updates without anyone noticing."""
    assets = [a for a in _assets() if not a["name"].startswith(MAC_X86_64)]
    with pytest.raises(ManifestRefused, match="artifact missing"):
        _build(assets)


def test_no_versioned_artifacts_at_all_is_refused():
    assets = [a for a in _assets() if "amd64.AppImage" not in a["name"]]
    with pytest.raises(ManifestRefused, match="missing versioned"):
        _build(assets)


def test_empty_signature_content_is_refused():
    """An empty `.sig` file is present-but-useless; it must not become an empty
    `signature` field that every client fails on."""
    assets = _assets()
    sigs = {n: "" for n in required_assets(assets)}
    with pytest.raises(ManifestRefused, match="no signature content"):
        build_manifest(assets, REPO, signatures=sigs, pub_date=_T0)


def test_required_assets_matches_what_the_manifest_references():
    """The caller fetches `.sig` files from this list; if it disagreed with the
    selection, the build would fail on a signature it was never asked to get."""
    assets = _assets()
    manifest = _build(assets)
    referenced = {i["url"].rsplit("/", 1)[-1] for i in manifest["platforms"].values()}
    assert referenced == set(required_assets(assets))


def _preview_step():
    import yaml

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, ".github", "workflows", "release.yml"), encoding="utf-8") as fh:
        wf = yaml.safe_load(fh)
    for job in wf["jobs"].values():
        for step in job.get("steps", []):
            if "build_preview_manifest" in step.get("run", ""):
                return step
    return None


def test_the_workflow_still_calls_this_module():
    """The rules are only worth testing where they are used. A workflow that
    grew its own inline copy would pass every test above and ship the old bug."""
    assert _preview_step() is not None, (
        "release.yml no longer imports build_preview_manifest — check it has not "
        "reinlined the selection rules these tests cover"
    )


def test_the_workflow_verifies_before_it_uploads():
    """Order is load-bearing (greptile): uploading first and checking afterwards
    leaves a manifest that failed the check live and served, with the job merely
    red. Pin that the upload comes last."""
    body = _preview_step()["run"]
    upload = body.index("gh release upload preview")
    verify = body.index("Refusing to publish: manifest is broken")
    assert verify < upload, (
        "the signature verification runs after the upload, so a broken manifest "
        "is published and stays served while the job goes red"
    )
