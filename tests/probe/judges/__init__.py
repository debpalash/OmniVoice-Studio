"""probe judges — deterministic, metric-based verdicts.

Every judge is a pure-ish function that takes an artifact (a file path, a
transcript, an embedding) plus thresholds, and returns a :class:`JudgeResult`.
Judges never call an LLM and never make a pass/fail decision based on model
*opinion* — only on measurable quantities (RMS, duration, WER, cosine
similarity). Naturalness predictors that *do* rely on learned opinion are
exposed only through the ``advisory`` lane and never gate.
"""
