"""The conftest torch-dtype guard resets a leaked default dtype between tests.

The CI "flaky trio" (test_effects_chain / test_generation_audio_guard /
test_persona_bundle) failed intermittently on CI-Linux with signatures that
all trace to one leak: some earlier test leaves
``torch.set_default_dtype(torch.float16)`` behind. Reproduced locally with a
simulated polluter — ``torch.tensor([0.1, …])`` under fp16 yields exactly the
0.0999755859375 CI observed, and Pedalboard refuses fp16 audio outright
("only supports 32-bit and 64-bit floating point"), silently returning
unmodified audio for every preset so their outputs compare identical.

These two tests are order-dependent BY DESIGN (pytest runs tests within a
file in definition order): the first leaks, the second proves the autouse
guard in conftest.py reset the leak before the next test began.
"""
import torch


def test_a_deliberate_dtype_leak():
    # Simulates the CI polluter. The conftest guard must clean this up (and
    # emit a UserWarning naming this exact test as the offender).
    torch.set_default_dtype(torch.float16)
    assert torch.get_default_dtype() is torch.float16


def test_b_next_test_starts_back_at_float32():
    # If the guard is ever removed/broken, this fails — and so, eventually,
    # does the flaky trio on CI, much less legibly.
    assert torch.get_default_dtype() is torch.float32
    # The exact fp16 signature the trio's CI failures showed, as documentation:
    assert torch.tensor([0.1]).item() != 0.0999755859375
