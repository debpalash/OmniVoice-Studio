"""Worker identity, enrollment tokens, and sessions.

The property under test throughout: a server-assigned worker ID is a *name*,
and names are not authentication. Everything that grants access must come back
to possession of a private key the worker generated and never sent.
"""
from __future__ import annotations

import os
import stat
import sys

import pytest

from worker import identity
from worker.identity import (
    EnrollmentToken,
    WorkerKeypair,
    challenge_message,
    issue_session,
    mint_enrollment_token,
    new_challenge,
    verify_signature,
)


# ── Keypairs ───────────────────────────────────────────────────────────────


def test_keypair_round_trips_through_raw_bytes():
    kp = WorkerKeypair.generate()
    restored = WorkerKeypair.from_private_bytes(kp.private_bytes())
    assert restored.public_bytes() == kp.public_bytes()
    assert restored.key_id == kp.key_id


def test_key_id_is_stable_and_short():
    kp = WorkerKeypair.generate()
    assert kp.key_id == identity.key_id_for(kp.public_bytes())
    assert len(kp.key_id) == 16


def test_distinct_keypairs_have_distinct_ids():
    assert WorkerKeypair.generate().key_id != WorkerKeypair.generate().key_id


def test_signature_verifies_only_for_the_right_key():
    alice, mallory = WorkerKeypair.generate(), WorkerKeypair.generate()
    message = b"prove it"
    signature = alice.sign(message)

    assert verify_signature(alice.public_bytes(), message, signature) is True
    assert verify_signature(mallory.public_bytes(), message, signature) is False


def test_tampered_message_fails_verification():
    kp = WorkerKeypair.generate()
    signature = kp.sign(b"original")
    assert verify_signature(kp.public_bytes(), b"tampered", signature) is False


def test_malformed_public_key_is_rejected_not_raised():
    assert verify_signature(b"too-short", b"m", b"s") is False


# ── Challenge binding ──────────────────────────────────────────────────────


def test_challenge_binds_worker_epoch_and_nonce():
    """A bare random challenge would let a captured signature be replayed
    against a different worker record or a stale epoch."""
    challenge, nonce = new_challenge(), b"n" * 32
    base = challenge_message(challenge=challenge, worker_id="w1", session_epoch=4, nonce=nonce)

    assert base != challenge_message(challenge=challenge, worker_id="w2", session_epoch=4, nonce=nonce)
    assert base != challenge_message(challenge=challenge, worker_id="w1", session_epoch=5, nonce=nonce)
    assert base != challenge_message(challenge=challenge, worker_id="w1", session_epoch=4, nonce=b"x" * 32)


def test_signature_for_one_epoch_does_not_verify_for_another():
    kp = WorkerKeypair.generate()
    challenge, nonce = new_challenge(), b"n" * 32
    signed = kp.sign(challenge_message(challenge=challenge, worker_id="w1", session_epoch=4, nonce=nonce))
    replayed = challenge_message(challenge=challenge, worker_id="w1", session_epoch=5, nonce=nonce)

    assert verify_signature(kp.public_bytes(), replayed, signed) is False


def test_challenges_are_unique():
    assert len({new_challenge() for _ in range(50)}) == 50


# ── Enrollment tokens ──────────────────────────────────────────────────────


def test_token_round_trips_through_its_encoded_form():
    token = mint_enrollment_token(endpoint="https://host:7443", cert_fingerprint="ab" * 32, now=0)
    decoded = EnrollmentToken.decode(token.encode())

    assert decoded.token_id == token.token_id
    assert decoded.secret == token.secret
    assert decoded.endpoint == token.endpoint
    assert decoded.cert_fingerprint == token.cert_fingerprint


def test_token_carries_the_cert_fingerprint_for_pinning():
    """The token is the trust anchor — it is what makes connecting to a
    self-signed desktop control plane safe, with no skip-verification mode."""
    token = mint_enrollment_token(endpoint="https://host", cert_fingerprint="deadbeef", now=0)
    assert EnrollmentToken.decode(token.encode()).cert_fingerprint == "deadbeef"


def test_token_is_prefixed_for_identification():
    token = mint_enrollment_token(endpoint="e", cert_fingerprint="f", now=0)
    assert token.encode().startswith("ovw_")


def test_session_token_uses_a_different_namespace():
    """A worker enrollment token must never be mistakable for a session."""
    session = issue_session(worker_id="w1", key_id="k1", epoch=1, now=0)
    assert session.token.startswith("ovs_")
    assert not session.token.startswith("ovw_")


@pytest.mark.parametrize("bad", ["", "nonsense", "ovw_@@@@", "ovs_abc"])
def test_malformed_tokens_raise_a_clear_error(bad):
    with pytest.raises(ValueError):
        EnrollmentToken.decode(bad)


def test_token_expiry_is_honoured():
    token = mint_enrollment_token(endpoint="e", cert_fingerprint="f", ttl_seconds=600, now=1000.0)
    assert token.expired(now=1500.0) is False
    assert token.expired(now=1601.0) is True


def test_tokens_are_unique_and_high_entropy():
    secrets_seen = {
        mint_enrollment_token(endpoint="e", cert_fingerprint="f", now=0).secret for _ in range(50)
    }
    assert len(secrets_seen) == 50
    assert all(len(s) >= 40 for s in secrets_seen)


def test_only_the_hash_is_suitable_for_storage():
    token = mint_enrollment_token(endpoint="e", cert_fingerprint="f", now=0)
    assert token.secret_hash != token.secret
    assert len(token.secret_hash) == 64
    assert identity.hash_secret(token.secret) == token.secret_hash


# ── Sessions ───────────────────────────────────────────────────────────────


def test_session_expires():
    session = issue_session(worker_id="w1", key_id="k1", epoch=1, ttl_seconds=3600, now=0.0)
    assert session.expired(now=3599.0) is False
    assert session.expired(now=3600.0) is True


def test_session_is_bound_to_a_worker_and_epoch():
    session = issue_session(worker_id="w1", key_id="k1", epoch=9, now=0)
    assert session.worker_id == "w1"
    assert session.epoch == 9


# ── Credential storage ─────────────────────────────────────────────────────


def test_saved_key_is_not_world_readable(tmp_path):
    """Follows the repo's precedent for machine-local secrets: 0600, atomic."""
    path = tmp_path / "keys" / "worker.key"
    kp = WorkerKeypair.generate()
    identity.save_worker_key(str(path), kp)

    assert identity.load_worker_key(str(path)).public_bytes() == kp.public_bytes()
    if sys.platform != "win32":
        mode = stat.S_IMODE(os.stat(path).st_mode)
        assert mode == 0o600, f"expected 0600, got {oct(mode)}"


def test_no_temp_file_is_left_behind(tmp_path):
    path = tmp_path / "worker.key"
    identity.save_worker_key(str(path), WorkerKeypair.generate())
    assert not (tmp_path / "worker.key.tmp").exists()


def test_partial_private_key_write_never_replaces_the_identity(
    tmp_path, monkeypatch
):
    path = tmp_path / "worker.key"
    original = WorkerKeypair.generate()
    identity.save_worker_key(str(path), original)
    original_bytes = path.read_bytes()
    real_write = identity.os.write
    writes = 0

    def short_then_fail(fd, payload):
        nonlocal writes
        writes += 1
        if writes == 1:
            return real_write(fd, payload[:16])
        raise OSError("disk full")

    monkeypatch.setattr(identity.os, "write", short_then_fail)

    with pytest.raises(OSError, match="disk full"):
        identity.save_worker_key(str(path), WorkerKeypair.generate())

    assert writes == 2
    assert path.read_bytes() == original_bytes
    assert not (tmp_path / "worker.key.tmp").exists()


def test_load_or_create_is_stable_across_calls(tmp_path):
    path = str(tmp_path / "worker.key")
    first = identity.load_or_create_worker_key(path)
    second = identity.load_or_create_worker_key(path)
    assert first.public_bytes() == second.public_bytes()


def test_missing_or_corrupt_key_file_returns_none(tmp_path):
    assert identity.load_worker_key(str(tmp_path / "absent.key")) is None
    corrupt = tmp_path / "corrupt.key"
    corrupt.write_bytes(b"not a key")
    assert identity.load_worker_key(str(corrupt)) is None


def test_corrupt_key_is_replaced_rather_than_crashing(tmp_path):
    path = tmp_path / "worker.key"
    path.write_bytes(b"garbage")
    kp = identity.load_or_create_worker_key(str(path))
    assert kp.public_bytes() == identity.load_worker_key(str(path)).public_bytes()
