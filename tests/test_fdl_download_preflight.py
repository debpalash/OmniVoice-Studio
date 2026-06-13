"""FDL-05 / FDL-06: dry-run preflight summary + overall download aggregator."""
from __future__ import annotations

import time
import types

from api.routers.setup.download import compute_plan
from utils import download_aggregator as da
from utils import hf_progress


def _f(filename, size, *, cached=False, will=None):
    """A stand-in for huggingface_hub.DryRunFileInfo."""
    return types.SimpleNamespace(
        filename=filename,
        file_size=size,
        is_cached=cached,
        will_download=(not cached) if will is None else will,
    )


# ── compute_plan (preflight summary) ────────────────────────────────────────

def test_compute_plan_totals_and_cached_split():
    plan = [
        _f("model.safetensors", 1000, cached=False),
        _f("config.json", 50, cached=True),
        _f("tokenizer.json", 200, cached=True),
    ]
    s = compute_plan(plan)
    assert s["total_bytes"] == 1250
    assert s["cached_bytes"] == 250
    assert s["to_download_bytes"] == 1000  # only the uncached file downloads
    assert s["n_files"] == 3
    assert s["n_cached"] == 2


def test_compute_plan_all_cached_means_nothing_to_download():
    plan = [_f("a.bin", 500, cached=True), _f("b.bin", 500, cached=True)]
    s = compute_plan(plan)
    assert s["to_download_bytes"] == 0
    assert s["total_bytes"] == 1000
    assert s["n_cached"] == 2


def test_compute_plan_empty():
    s = compute_plan([])
    assert s == {
        "total_bytes": 0, "cached_bytes": 0, "to_download_bytes": 0,
        "n_files": 0, "n_cached": 0,
    }


# ── DownloadAggregator ──────────────────────────────────────────────────────

def test_aggregator_sums_bytes_across_parallel_byte_bars():
    agg = da.DownloadAggregator("r/x", total_bytes=100, files_total=2)
    agg.update_byte_bar("k1", 50, 50)
    agg.update_byte_bar("k2", 25, 50)
    agg.update_files(1, 2)              # "Fetching N files" count bar
    snap = agg.snapshot()
    assert snap["bytes_done"] == 75
    assert snap["total_bytes"] == 100
    assert snap["files_done"] == 1
    assert snap["files_total"] == 2
    assert snap["phase"] == "aggregate"


def test_close_credit_counts_full_size_even_if_n_never_advanced():
    # The Xet case: a byte bar whose n stayed 0 during transfer, credited its
    # full size only on close(). bytes_done must reflect the completed file.
    agg = da.DownloadAggregator("r/z", total_bytes=1000, files_total=1)
    agg.credit_complete("barkey", 1000)
    assert agg.snapshot()["bytes_done"] == 1000


def test_count_bar_does_not_pollute_byte_total():
    agg = da.DownloadAggregator("r/x", total_bytes=1000, files_total=4)
    da_feed_count = agg.update_files
    da_feed_count(2, 4)                 # 2 of 4 files — NOT 2 bytes
    assert agg.snapshot()["bytes_done"] == 0
    assert agg.snapshot()["files_done"] == 2


def test_aggregator_add_increments():
    agg = da.DownloadAggregator("r/x", total_bytes=None)
    agg.add("blob", 10)
    agg.add("blob", 5)
    assert agg.snapshot()["bytes_done"] == 15


def test_aggregator_rate_and_eta_windowed():
    agg = da.DownloadAggregator("r/x", total_bytes=1000)
    t0 = 1000.0
    agg.snapshot(now=t0)               # seed sample at 0 bytes
    agg.update_byte_bar("f", 200, 1000)
    snap = agg.snapshot(now=t0 + 2.0)  # 200 bytes over 2s -> 100 B/s
    assert snap["rate"] > 0
    assert snap["eta_seconds"] is not None
    assert 5 < snap["eta_seconds"] < 12


def test_registry_feed_routes_by_unit_and_finish_clears():
    events = []
    lid = hf_progress.register_listener(
        lambda e: events.append(e) if e.get("phase") == "aggregate" else None
    )
    try:
        da.install()  # wires the byte sink
        da.start("r/y", total_bytes=100, files_total=1)
        # byte bar (unit 'B') accumulates bytes; complete=True credits full size
        da.feed("r/y", "k1", "B", 40, 100, False)
        time.sleep(da._EMIT_THROTTLE_S + 0.05)
        da.feed("r/y", "k1", "B", 0, 100, True)   # close-credit
        agg = da._get("r/y")
        assert agg.snapshot()["bytes_done"] == 100
        assert any(e.get("repo_id") == "r/y" for e in events)
        # after finish, feed is a no-op (no aggregator) and must not raise
        da.finish("r/y")
        before = len(events)
        da.feed("r/y", "k1", "B", 100, 100, False)
        assert len(events) == before
    finally:
        hf_progress.unregister_listener(lid)


def test_feed_without_start_is_noop():
    da.finish("never/started")
    da.feed("never/started", "k", "B", 1, 1, False)  # must not raise


def test_complete_sets_total_not_double_after_segmented_bytes():
    # The segmented path accumulates real bytes via add(); complete() must land
    # on exactly total, not add another full total on top (was a 2x bug).
    da.start("r/seg", total_bytes=1000, files_total=2)
    da.add_bytes("r/seg", "fileA", 600)
    da.add_bytes("r/seg", "fileB", 400)
    assert da._get("r/seg").snapshot()["bytes_done"] == 1000
    da.complete("r/seg")
    snap = da._get("r/seg").snapshot()
    assert snap["bytes_done"] == 1000          # not 2000
    assert snap["files_done"] == snap["files_total"] == 2
    da.finish("r/seg")
