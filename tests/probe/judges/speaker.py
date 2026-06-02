"""L4 speaker-similarity judge — the correctness check for voice cloning.

Embed the reference clip and the generated audio with a speaker-verification
model and take cosine similarity. High similarity ⇒ the clone matches the target
identity.

Honest caveats (this is a *relative* gate, never an absolute one):
  - There is no universal "same speaker" cosine cutoff; it is model- and
    dataset-dependent. Calibrate per-engine on known same/different pairs and
    alert on *drops* vs a baseline rather than trusting an absolute number.
  - The default Resemblyzer encoder is documented English-biased — similarity
    for non-English voices may be unreliable. For a 646-language app, stronger
    multilingual embedders (ECAPA-TDNN / WavLM) are preferable; both plug in
    behind the :class:`Embedder` protocol below.
  - Similarity says nothing about intelligibility — always pair with
    ``asr_wer_below``.

The embedder is optional: if no backend is installed, the judge returns a
*skipped* result (passed=None) instead of failing, so the harness stays green in
environments without the heavy dependency.
"""

from __future__ import annotations

from typing import Protocol

import numpy as np

from ..spec import JudgeResult


class Embedder(Protocol):
    """Anything that turns an audio file path into a fixed-length embedding."""

    def embed(self, path: str) -> np.ndarray: ...


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    a = np.asarray(a, dtype=np.float64).ravel()
    b = np.asarray(b, dtype=np.float64).ravel()
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


class ResemblyzerEmbedder:
    """Default backend; lazily imports Resemblyzer (NOT in the base venv —
    `uv add resemblyzer` to enable). English-biased; see module docstring."""

    def __init__(self):
        self._enc = None

    def _load(self):
        if self._enc is None:
            from resemblyzer import VoiceEncoder, preprocess_wav  # noqa: F401

            self._enc = VoiceEncoder()
        return self._enc

    def embed(self, path: str) -> np.ndarray:
        from resemblyzer import preprocess_wav

        enc = self._load()
        return enc.embed_utterance(preprocess_wav(path))


def _default_embedder() -> Embedder | None:
    """Return a real embedder if one is importable, else None (→ skip)."""
    import importlib.util

    if importlib.util.find_spec("resemblyzer") is not None:
        return ResemblyzerEmbedder()
    return None


def speaker_similarity_above(
    ref: str,
    gen: str,
    min: float = 0.70,
    embedder: Embedder | None = None,
) -> JudgeResult:
    if embedder is None:
        embedder = _default_embedder()
    if embedder is None:
        return JudgeResult(
            name="speaker_similarity_above",
            passed=None,  # skipped — no embedder available
            detail="skipped: no speaker-embedding backend installed "
            "(`uv add resemblyzer`, or inject an ECAPA/WavLM embedder)",
        )
    sim = cosine_similarity(embedder.embed(ref), embedder.embed(gen))
    return JudgeResult(
        name="speaker_similarity_above",
        passed=sim >= float(min),
        measured=round(sim, 4),
        detail=f"cosine={sim:.3f} (min {min}) — RELATIVE gate, calibrate per-engine",
    )
