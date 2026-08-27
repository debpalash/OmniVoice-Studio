"""Worker persistence: enrollment, revocation, epochs, authentication.

The durability rules under test are the ones a desktop control plane makes
load-bearing — it restarts constantly, so anything that only lives in memory
effectively does not exist.
"""
from __future__ import annotations

import sqlite3

import pytest

from worker import identity, registry
from worker.identity import WorkerKeypair


@pytest.fixture
def db(tmp_path, monkeypatch):
    """Point the store at a throwaway DB built from the canonical schema.

    Building it from ``_BASE_SCHEMA`` rather than hand-written DDL is the
    point: if the real schema and these tests drift, this fixture breaks.

    The patch targets the globals ``db_conn`` actually reads rather than a
    freshly imported ``core.db``. ``tests/backend/conftest.py`` purges
    ``core.*`` from ``sys.modules`` after every test it runs, so in a combined
    run ``import core.db`` here hands back a *different* module object than the
    one ``worker.registry`` bound at import time — patching that one silently
    does nothing and the writes land in the real user database.
    """
    from worker import registry as wr

    db_globals = wr.db_conn.__wrapped__.__globals__
    path = str(tmp_path / "userdata.db")
    with sqlite3.connect(path) as conn:
        conn.executescript(db_globals["_BASE_SCHEMA"])
    monkeypatch.setitem(db_globals, "DB_PATH", path)
    return path


def _enroll(name="desktop", **kw) -> tuple[registry.RemoteWorker, WorkerKeypair]:
    kp = WorkerKeypair.generate()
    worker = registry.enroll_worker(name=name, public_key=kp.public_bytes(), **kw)
    return worker, kp


# ── Schema ─────────────────────────────────────────────────────────────────


def test_tables_exist_in_the_canonical_schema(db):
    with sqlite3.connect(db) as conn:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"remote_workers", "remote_worker_enrollments"} <= tables


def test_existing_database_gains_the_tables_without_migration(tmp_path, monkeypatch):
    """Backward compatibility: an existing omnivoice_data/ picks the tables up
    on next open, and a user who never enables the feature sees no change."""
    from core import db as core_db

    path = str(tmp_path / "old.db")
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE voice_profiles (id TEXT PRIMARY KEY, name TEXT, created_at REAL)")
        conn.execute("INSERT INTO voice_profiles VALUES ('p1', 'Morgan', 1.0)")
        conn.commit()

    with sqlite3.connect(path) as conn:
        conn.executescript(core_db._BASE_SCHEMA)

    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT name FROM voice_profiles WHERE id='p1'").fetchone()[0] == "Morgan"
        assert conn.execute("SELECT COUNT(*) FROM remote_workers").fetchone()[0] == 0


# ── Enrollment tokens ──────────────────────────────────────────────────────


def test_token_is_stored_hashed_never_in_plaintext(db):
    token = registry.create_enrollment(endpoint="https://host", cert_fingerprint="ab" * 32)
    with sqlite3.connect(db) as conn:
        rows = conn.execute("SELECT secret_hash FROM remote_worker_enrollments").fetchall()
    assert rows[0][0] == identity.hash_secret(token.secret)
    assert token.secret not in rows[0][0]


def test_token_can_be_redeemed_exactly_once(db):
    """Single-use is enforced with a conditional UPDATE so two workers racing
    the same token cannot both win."""
    token = registry.create_enrollment(endpoint="e", cert_fingerprint="f")
    assert registry.redeem_enrollment(token, worker_id="w1") is True
    assert registry.redeem_enrollment(token, worker_id="w2") is False


def test_worker_insert_failure_does_not_spend_the_enrollment_token(
    db, monkeypatch
):
    token = registry.create_enrollment(endpoint="e", cert_fingerprint="f")
    keypair = WorkerKeypair.generate()
    real_insert = registry._insert_worker

    def fail_insert(_conn, _worker):
        raise sqlite3.OperationalError("disk full")

    monkeypatch.setattr(registry, "_insert_worker", fail_insert)
    with pytest.raises(sqlite3.OperationalError, match="disk full"):
        registry.enroll_with_token(
            token, name="GPU", public_key=keypair.public_bytes()
        )

    assert registry.get_by_key_id(keypair.key_id) is None
    monkeypatch.setattr(registry, "_insert_worker", real_insert)
    enrolled = registry.enroll_with_token(
        token, name="GPU", public_key=keypair.public_bytes()
    )
    assert enrolled is not None
    assert enrolled.key_id == keypair.key_id


def test_expired_token_is_refused(db):
    token = registry.create_enrollment(endpoint="e", cert_fingerprint="f", ttl_seconds=60, now=1000.0)
    assert registry.redeem_enrollment(token, worker_id="w1", now=1061.0) is False


def test_unknown_token_is_refused(db):
    forged = identity.mint_enrollment_token(endpoint="e", cert_fingerprint="f", now=0)
    assert registry.redeem_enrollment(forged, worker_id="w1") is False


def test_token_with_a_wrong_secret_is_refused(db):
    """Knowing a token id is not knowing the token."""
    real = registry.create_enrollment(endpoint="e", cert_fingerprint="f")
    forged = identity.EnrollmentToken(
        token_id=real.token_id,
        secret="wrong",
        endpoint=real.endpoint,
        cert_fingerprint=real.cert_fingerprint,
        expires_at=real.expires_at,
    )
    assert registry.redeem_enrollment(forged, worker_id="w1") is False


def test_expired_unused_tokens_are_purgeable(db):
    registry.create_enrollment(endpoint="e", cert_fingerprint="f", ttl_seconds=60, now=1000.0)
    assert registry.purge_expired_enrollments(now=2000.0) == 1
    assert registry.purge_expired_enrollments(now=2000.0) == 0


# ── Workers ────────────────────────────────────────────────────────────────


def test_enrollment_binds_the_public_key(db):
    worker, kp = _enroll()
    assert worker.key_id == kp.key_id
    assert registry.get(worker.id).public_key == kp.public_bytes()


def test_enrolling_the_same_key_twice_is_idempotent(db):
    kp = WorkerKeypair.generate()
    first = registry.enroll_worker(name="a", public_key=kp.public_bytes())
    second = registry.enroll_worker(name="b", public_key=kp.public_bytes())
    assert first.id == second.id
    assert len(registry.list_workers()) == 1


def test_consent_is_recorded_per_worker(db):
    """Agreeing to use your own desktop is not agreeing to use another machine."""
    granted, _ = _enroll(name="mine", consent_granted=True)
    withheld, _ = _enroll(name="theirs", consent_granted=False)

    assert granted.schedulable is True
    assert withheld.schedulable is False

    registry.grant_consent(withheld.id)
    assert registry.get(withheld.id).schedulable is True


def test_disabled_worker_is_not_schedulable(db):
    worker, _ = _enroll()
    registry.set_enabled(worker.id, False)
    assert registry.get(worker.id).schedulable is False


def test_public_key_is_never_exposed_in_the_ui_shape(db):
    worker, _ = _enroll()
    payload = worker.to_dict()
    assert "public_key" not in payload
    assert payload["key_id"] == worker.key_id


def test_workers_sort_by_priority(db):
    low, _ = _enroll(name="low")
    high, _ = _enroll(name="high")
    registry.set_priority(low.id, 10)
    registry.set_priority(high.id, 90)
    assert [w.name for w in registry.list_workers()] == ["high", "low"]


def test_priority_is_clamped(db):
    worker, _ = _enroll()
    registry.set_priority(worker.id, 5000)
    assert registry.get(worker.id).priority == 100
    registry.set_priority(worker.id, -5)
    assert registry.get(worker.id).priority == 0


# ── Revocation ─────────────────────────────────────────────────────────────


def test_revocation_survives_a_restart(db):
    """A revocation that evaporates on quit is not a revocation. This is the
    reason it is a persisted row and not in-memory state."""
    worker, kp = _enroll()
    registry.revoke(worker.id)

    # Simulate a control-plane restart: nothing but the DB carries over.
    assert registry.is_revoked(kp.key_id) is True
    assert registry.get(worker.id).schedulable is False


def test_revoked_worker_is_a_tombstone_not_a_delete(db):
    """The row stays so a reconnect with the same key is recognised and
    refused, rather than looking like a stranger who can simply enroll again."""
    worker, kp = _enroll()
    registry.revoke(worker.id)

    assert registry.get_by_key_id(kp.key_id) is not None
    assert registry.list_workers() == []
    assert len(registry.list_workers(include_revoked=True)) == 1


def test_revoked_key_cannot_authenticate(db):
    worker, kp = _enroll()
    registry.revoke(worker.id)
    challenge, nonce = identity.new_challenge(), b"n" * 32
    signature = kp.sign(
        identity.challenge_message(
            challenge=challenge, worker_id=worker.id, session_epoch=1, nonce=nonce
        )
    )
    assert (
        registry.authenticate(
            key_id=kp.key_id,
            public_key=kp.public_bytes(),
            challenge=challenge,
            signature=signature,
            nonce=nonce,
            session_epoch=1,
        )
        is None
    )


# ── Sessions and epochs ────────────────────────────────────────────────────


def test_every_reconnect_bumps_the_epoch(db):
    """Epochs are what let the server drop messages from a half-open previous
    stream — the zombie-session race that delivers two accepts for one
    assignment."""
    worker, _ = _enroll()
    assert registry.begin_session(worker.id) == 1
    assert registry.begin_session(worker.id) == 2
    assert registry.get(worker.id).session_epoch == 2


# ── Authentication ─────────────────────────────────────────────────────────


def _auth(worker, kp, *, epoch=1, signer=None, key_id=None, public_key=None):
    challenge, nonce = identity.new_challenge(), b"n" * 32
    message = identity.challenge_message(
        challenge=challenge, worker_id=worker.id, session_epoch=epoch, nonce=nonce
    )
    signature = (signer or kp).sign(message)
    return registry.authenticate(
        key_id=key_id or kp.key_id,
        public_key=public_key or kp.public_bytes(),
        challenge=challenge,
        signature=signature,
        nonce=nonce,
        session_epoch=epoch,
    )


def test_valid_possession_proof_authenticates(db):
    worker, kp = _enroll()
    assert _auth(worker, kp).id == worker.id


def test_a_stolen_worker_id_without_the_key_proves_nothing(db):
    """The whole reason identity is a keypair: knowing the name must not be
    enough to receive someone's voice recordings."""
    worker, kp = _enroll()
    attacker = WorkerKeypair.generate()
    assert _auth(worker, kp, signer=attacker) is None


def test_key_id_that_does_not_match_the_public_key_is_refused(db):
    worker, kp = _enroll()
    other = WorkerKeypair.generate()
    assert _auth(worker, kp, public_key=other.public_bytes()) is None


def test_unknown_key_is_refused(db):
    worker, _ = _enroll()
    stranger = WorkerKeypair.generate()
    assert _auth(worker, stranger) is None


def test_capabilities_can_be_refreshed(db):
    worker, _ = _enroll()
    registry.update_capabilities(
        worker.id,
        capabilities=[{"engine": "indextts", "resident": True}],
        host={"os": "darwin"},
        max_concurrent_tasks=2,
    )
    reloaded = registry.get(worker.id)
    assert reloaded.capabilities[0]["engine"] == "indextts"
    assert reloaded.host["os"] == "darwin"
    assert reloaded.max_concurrent_tasks == 2
