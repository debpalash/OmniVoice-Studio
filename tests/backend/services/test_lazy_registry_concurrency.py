"""Regression: the lazy TTS/ASR registries must not raise "dictionary changed
size during iteration" when a lazy ``__getitem__`` inserts a resolved key while
another caller iterates — the ``/engines`` 500 seen in production logs.

FastAPI runs ``list_backends()`` in a threadpool, so two concurrent ``/engines``
requests race: one iterates ``_REGISTRY.items()`` (which held a *live* dict
iterator open across the slow per-engine ``is_available()`` probes) while the
other materializes the lazy entry via ``__getitem__`` (``self[key] = cls``).
The insert then tripped the open iterator. ``__iter__`` now snapshots the live
keys up front (``list(dict.__iter__(self))``, atomic under the GIL), so a
concurrent insert can no longer trip the iteration.

The tests drive the exact crash site (``__iter__``) deterministically: begin
iterating, insert mid-iteration, then drain. Pre-fix this raises on the drain;
post-fix it completes.
"""


def _assert_iter_survives_concurrent_insert(reg):
    it = iter(reg)                     # the generator items()/list_backends() drives
    first = next(it)                   # first yield → the real-key snapshot is taken here
    reg["zzz-concurrent-insert"] = object()  # a concurrent lazy insert, mid-iteration
    drained = [first, *it]             # must NOT raise "dictionary changed size during iteration"
    assert first in drained


def test_tts_lazy_registry_iter_survives_concurrent_insert():
    from services.tts_backend import _LazyRegistry

    reg = _LazyRegistry({"omnivoice": object(), "b": object(), "c": object()})
    _assert_iter_survives_concurrent_insert(reg)


def test_asr_lazy_registry_iter_survives_concurrent_insert():
    from services.asr_backend import _LazyASRRegistry

    reg = _LazyASRRegistry({"whisperx": object(), "faster-whisper": object()})
    _assert_iter_survives_concurrent_insert(reg)
