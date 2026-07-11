"""prefs.json mutation thread-safety.

Writers run on many threads — FastAPI's request threadpool plus background
workers (the sidecar-engine installer persists its install dir from a worker
thread). Each ``set_``/``delete`` is a load-modify-save of the whole JSON
file; before the module-level mutation lock, two concurrent writers could
interleave (both load, both save) and the later save silently dropped the
other's key. Fail-before/pass-after: this test loses keys reliably on the
unlocked implementation.
"""
import os
import threading

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

from core import prefs


def test_concurrent_set_never_drops_keys(tmp_path, monkeypatch):
    monkeypatch.setattr(prefs, "_PREFS_PATH", str(tmp_path / "prefs.json"))
    n_threads, n_keys = 8, 25
    barrier = threading.Barrier(n_threads)

    def writer(tid: int) -> None:
        barrier.wait()  # maximize interleaving
        for i in range(n_keys):
            prefs.set_(f"t{tid}.k{i}", tid * 1000 + i)

    threads = [threading.Thread(target=writer, args=(tid,)) for tid in range(n_threads)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    data = prefs._load()
    expected = {f"t{tid}.k{i}" for tid in range(n_threads) for i in range(n_keys)}
    missing = expected - set(data)
    assert not missing, f"concurrent writers dropped {len(missing)} keys: {sorted(missing)[:5]}…"


def test_concurrent_set_and_delete_serialize(tmp_path, monkeypatch):
    monkeypatch.setattr(prefs, "_PREFS_PATH", str(tmp_path / "prefs.json"))
    prefs.set_("keep", 1)
    barrier = threading.Barrier(2)

    def setter():
        barrier.wait()
        for i in range(50):
            prefs.set_(f"s{i}", i)

    def deleter():
        barrier.wait()
        for i in range(50):
            prefs.delete(f"absent{i}")  # churns load-save alongside the setter

    t1, t2 = threading.Thread(target=setter), threading.Thread(target=deleter)
    t1.start(); t2.start(); t1.join(); t2.join()

    data = prefs._load()
    assert data.get("keep") == 1
    assert all(data.get(f"s{i}") == i for i in range(50))
