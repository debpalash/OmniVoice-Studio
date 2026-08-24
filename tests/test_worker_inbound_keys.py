"""Admission for inbound mode: per-panel keys, hashing, throttling.

Inbound uses a pinned TLS certificate as its transport identity and a per-panel
API key for admission. These tests cover the parts invisible in normal use:
pinning metadata, hashing at rest, per-key revocation and auth throttling.
"""

from __future__ import annotations

import errno
import json
import os
import stat

import pytest


@pytest.fixture
def store(tmp_path):
    from worker.inbound.keys import KeyStore

    return KeyStore(str(tmp_path / "inbound-keys.json"))


def test_the_plaintext_key_is_never_written_to_disk(store, tmp_path):
    """The node can replace a key but must never be able to show it again."""
    issued = store.issue("Alice laptop")

    on_disk = (tmp_path / "inbound-keys.json").read_text(encoding="utf-8")
    assert issued.secret not in on_disk
    assert issued.key.secret_hash in on_disk

    # And nothing in the API hands it back either — a "reveal key" button is
    # the feature this shape exists to make impossible to build by accident.
    assert all("secret" not in row for row in store.list_keys())


def test_artifact_rpc_authentication_does_not_persist_telemetry(store, monkeypatch):
    issued = store.issue("Panel")
    writes = 0

    def count_write():
        nonlocal writes
        writes += 1
        raise AssertionError("artifact authentication attempted a disk write")

    monkeypatch.setattr(store, "_save_locked", count_write)

    assert (
        store.authenticate(
            issued.secret, peer="10.0.0.1", record_seen=False
        )
        is not None
    )
    assert writes == 0
    row = store.list_keys()[0]
    assert row["last_seen_at"] == 0
    assert row["last_seen_peer"] == ""


def test_attach_authentication_coalesces_last_seen_writes(tmp_path, monkeypatch):
    from worker.inbound.keys import KeyStore

    clock = [100.0]
    store = KeyStore(
        str(tmp_path / "inbound-keys.json"), now=lambda: clock[0]
    )
    issued = store.issue("Panel")
    real_save = store._save_locked
    writes = 0

    def count_write():
        nonlocal writes
        writes += 1
        real_save()

    monkeypatch.setattr(store, "_save_locked", count_write)

    assert store.authenticate(issued.secret, peer="10.0.0.1") is not None
    for _ in range(20):
        clock[0] += 1.0
        assert store.authenticate(issued.secret, peer="10.0.0.1") is not None
    assert writes == 1

    clock[0] = 160.0
    assert store.authenticate(issued.secret, peer="10.0.0.2") is not None
    assert writes == 2
    row = store.list_keys()[0]
    assert row["last_seen_at"] == 160.0
    assert row["last_seen_peer"] == "10.0.0.2"


def test_failed_last_seen_write_restores_in_memory_telemetry(store, monkeypatch):
    issued = store.issue("Panel")

    def fail_write():
        raise OSError("disk full")

    monkeypatch.setattr(store, "_save_locked", fail_write)

    with pytest.raises(OSError, match="disk full"):
        store.authenticate(issued.secret, peer="10.0.0.1")

    row = store.list_keys()[0]
    assert row["last_seen_at"] == 0.0
    assert row["last_seen_peer"] == ""


def test_revoking_one_panel_leaves_the_others_working(store):
    """The whole reason keys are per-panel rather than one shared node key."""
    alice = store.issue("Alice")
    bob = store.issue("Bob")

    assert store.revoke(alice.key.key_id) is True

    assert store.authenticate(alice.secret, peer="10.0.0.1") is None
    assert store.authenticate(bob.secret, peer="10.0.0.2") is not None


def test_revocation_replace_fsyncs_its_parent_directory(store, tmp_path, monkeypatch):
    from worker.inbound import keys as keys_module

    issued = store.issue("Alice")
    events = []
    directory_descriptor = 900_001
    directory_flag = getattr(keys_module.os, "O_DIRECTORY", 0x10000)
    real_open = keys_module.os.open
    real_fsync = keys_module.os.fsync
    real_close = keys_module.os.close
    real_replace = keys_module.os.replace

    monkeypatch.setattr(keys_module.os, "O_DIRECTORY", directory_flag, raising=False)

    def tracked_open(path, flags, mode=0o777, *, dir_fd=None):
        if str(path) == str(tmp_path) and flags == keys_module.os.O_RDONLY | directory_flag:
            events.append("open-parent")
            return directory_descriptor
        if dir_fd is None:
            return real_open(path, flags, mode)
        return real_open(path, flags, mode, dir_fd=dir_fd)

    def tracked_fsync(descriptor):
        if descriptor == directory_descriptor:
            events.append("fsync-parent")
            return None
        return real_fsync(descriptor)

    def tracked_close(descriptor):
        if descriptor == directory_descriptor:
            events.append("close-parent")
            return None
        return real_close(descriptor)

    def tracked_replace(source, destination):
        events.append("replace")
        return real_replace(source, destination)

    monkeypatch.setattr(keys_module.os, "open", tracked_open)
    monkeypatch.setattr(keys_module.os, "fsync", tracked_fsync)
    monkeypatch.setattr(keys_module.os, "close", tracked_close)
    monkeypatch.setattr(keys_module.os, "replace", tracked_replace)

    assert store.revoke(issued.key.key_id) is True

    assert events == ["replace", "open-parent", "fsync-parent", "close-parent"]


def test_revocation_reports_a_real_parent_directory_fsync_failure(
    store, tmp_path, monkeypatch
):
    from worker.inbound import keys as keys_module

    issued = store.issue("Alice")
    directory_descriptor = 900_002
    directory_flag = getattr(keys_module.os, "O_DIRECTORY", 0x10000)
    real_open = keys_module.os.open
    real_fsync = keys_module.os.fsync
    real_close = keys_module.os.close
    monkeypatch.setattr(keys_module.os, "O_DIRECTORY", directory_flag, raising=False)

    def failing_open(path, flags, mode=0o777, *, dir_fd=None):
        if str(path) == str(tmp_path) and flags == keys_module.os.O_RDONLY | directory_flag:
            return directory_descriptor
        if dir_fd is None:
            return real_open(path, flags, mode)
        return real_open(path, flags, mode, dir_fd=dir_fd)

    def failing_fsync(descriptor):
        if descriptor == directory_descriptor:
            raise OSError(errno.EIO, "directory writeback failed")
        return real_fsync(descriptor)

    def tracked_close(descriptor):
        if descriptor == directory_descriptor:
            return None
        return real_close(descriptor)

    monkeypatch.setattr(keys_module.os, "open", failing_open)
    monkeypatch.setattr(keys_module.os, "fsync", failing_fsync)
    monkeypatch.setattr(keys_module.os, "close", tracked_close)

    with pytest.raises(OSError) as exc_info:
        store.revoke(issued.key.key_id)

    assert exc_info.value.errno == errno.EIO
    # The replacement may already be visible even though its crash durability
    # is unknown, so failure remains fail-closed in this process.
    assert store.authenticate(issued.secret, peer="10.0.0.1") is None


def test_failed_revocation_stays_denied_and_retries_persistence(
    store, tmp_path, monkeypatch
):
    from worker.inbound.keys import KeyStore

    issued = store.issue("Alice")
    real_save = store._save_locked
    attempts = 0

    def fail_once():
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OSError("disk full")
        real_save()

    monkeypatch.setattr(store, "_save_locked", fail_once)

    with pytest.raises(OSError, match="disk full"):
        store.revoke(issued.key.key_id)
    assert store.authenticate(issued.secret, peer="10.0.0.1") is None

    assert store.revoke(issued.key.key_id) is True
    reopened = KeyStore(str(tmp_path / "inbound-keys.json"))
    assert reopened.authenticate(issued.secret, peer="10.0.0.1") is None
    assert attempts == 2


def test_failed_key_issue_restores_the_previous_collision_entry(
    store, monkeypatch
):
    from worker.inbound import keys as keys_module

    monkeypatch.setattr(keys_module.secrets, "token_urlsafe", lambda _size: "fixed")
    original = store.issue("Original")
    real_save = store._save_locked

    monkeypatch.setattr(
        store,
        "_save_locked",
        lambda: (_ for _ in ()).throw(OSError("disk full")),
    )
    with pytest.raises(OSError, match="disk full"):
        store.issue("Replacement")

    rows = store.list_keys()
    assert len(rows) == 1
    assert rows[0]["label"] == "Original"
    monkeypatch.setattr(store, "_save_locked", real_save)
    assert store.authenticate(original.secret, peer="10.0.0.1") is not None


def test_panel_key_count_is_bounded_and_revoked_slots_are_reclaimed(
    store, monkeypatch
):
    from worker.inbound import keys as keys_module

    monkeypatch.setattr(keys_module, "MAX_PANEL_KEYS", 2)
    first = store.issue("First")
    store.issue("Second")

    with pytest.raises(keys_module.KeyLimitExceeded, match="as many panel keys"):
        store.issue("Third")

    assert store.revoke(first.key.key_id) is True
    replacement = store.issue("Replacement")
    rows = store.list_keys()
    assert len(rows) == 2
    assert replacement.key.key_id in {row["key_id"] for row in rows}
    assert first.key.key_id not in {row["key_id"] for row in rows}


def test_failed_key_write_restores_a_pruned_revoked_slot(store, monkeypatch):
    from worker.inbound import keys as keys_module

    monkeypatch.setattr(keys_module, "MAX_PANEL_KEYS", 1)
    first = store.issue("First")
    assert store.revoke(first.key.key_id) is True
    monkeypatch.setattr(
        store,
        "_save_locked",
        lambda: (_ for _ in ()).throw(OSError("disk full")),
    )

    with pytest.raises(OSError, match="disk full"):
        store.issue("Replacement")

    rows = store.list_keys()
    assert len(rows) == 1
    assert rows[0]["key_id"] == first.key.key_id
    assert rows[0]["revoked"] is True


def test_a_wrong_key_is_throttled_before_it_can_be_guessed(store, monkeypatch):
    """A bearer credential with no second factor has only this between it and
    unlimited LAN guesses."""
    from worker.inbound import keys as keys_module

    store.issue("Alice")

    for _ in range(keys_module._MAX_FAILURES):
        assert store.authenticate("ovnode_wrong", peer="10.0.0.9") is None

    assert store.locked_out("10.0.0.9") is True


def test_one_panel_typing_a_stale_key_cannot_lock_out_another(store):
    """The throttle is per source address on purpose: a shared counter turns
    one person's stale bookmark into an outage for everybody else."""
    from worker.inbound import keys as keys_module

    good = store.issue("Bob")

    for _ in range(keys_module._MAX_FAILURES + 2):
        store.authenticate("ovnode_wrong", peer="10.0.0.9")

    assert store.locked_out("10.0.0.9") is True
    assert store.locked_out("10.0.0.10") is False
    assert store.authenticate(good.secret, peer="10.0.0.10") is not None


def test_a_locked_out_peer_is_refused_even_with_the_right_key(store):
    """Otherwise the throttle is decorative: an attacker who eventually
    guesses correctly is admitted on the guess that succeeds."""
    from worker.inbound import keys as keys_module

    good = store.issue("Bob")
    for _ in range(keys_module._MAX_FAILURES):
        store.authenticate("ovnode_wrong", peer="10.0.0.9")

    assert store.authenticate(good.secret, peer="10.0.0.9") is None


def test_failed_key_throttle_ignores_ephemeral_source_ports(store):
    """Reconnects from one host must contribute to the same lockout."""
    from worker.inbound import keys as keys_module

    store.issue("Alice")

    for port in range(41000, 41000 + keys_module._MAX_FAILURES):
        store.authenticate("ovnode_wrong", peer=f"10.0.0.9:{port}")

    assert store.locked_out("10.0.0.9:49999") is True


def test_failed_key_throttle_normalises_bracketed_ipv6_ports(store):
    from worker.inbound import keys as keys_module

    store.issue("Alice")

    for port in range(41000, 41000 + keys_module._MAX_FAILURES):
        store.authenticate("ovnode_wrong", peer=f"[fd00::9]:{port}")

    assert store.locked_out("[fd00::9]:49999") is True


def test_an_empty_key_never_authenticates(store):
    """A missing metadata header arrives as "" and must not match a key whose
    hash happens to be falsy-adjacent."""
    store.issue("Alice")
    assert store.authenticate("", peer="10.0.0.1") is None


def test_keys_survive_a_restart(store, tmp_path):
    from worker.inbound.keys import KeyStore

    issued = store.issue("Alice")

    reopened = KeyStore(str(tmp_path / "inbound-keys.json"))

    assert reopened.authenticate(issued.secret, peer="10.0.0.1") is not None


def test_failed_worker_id_save_never_becomes_in_memory_truth(store, monkeypatch):
    """Every callback must retry until the panel-assigned id is durable."""
    issued = store.issue("Alice")
    attempts = []

    def fail_save():
        attempts.append(1)
        raise OSError("disk full")

    monkeypatch.setattr(store, "_save_locked", fail_save)

    for _ in range(2):
        with pytest.raises(OSError, match="disk full"):
            store.remember_worker_id(issued.key.key_id, "panel-worker")
        assert store.worker_id_for(issued.key.key_id) == ""

    assert len(attempts) == 2


def test_a_revoked_key_cannot_persist_a_registration_identity(store):
    issued = store.issue("Alice")
    assert store.revoke(issued.key.key_id) is True

    with pytest.raises(PermissionError, match="revoked"):
        store.remember_worker_id(issued.key.key_id, "panel-worker")

    assert store.worker_id_for(issued.key.key_id) == ""


def test_partial_worker_id_write_keeps_the_previous_file_and_identity(
    store, tmp_path, monkeypatch
):
    """A short write followed by disk failure must not replace valid keys."""
    issued = store.issue("Alice")
    path = tmp_path / "inbound-keys.json"
    original = path.read_bytes()
    real_write = os.write
    writes = 0

    def short_then_fail(fd, payload):
        nonlocal writes
        writes += 1
        if writes == 1:
            return real_write(fd, payload[:8])
        raise OSError("disk full")

    monkeypatch.setattr(os, "write", short_then_fail)

    with pytest.raises(OSError, match="disk full"):
        store.remember_worker_id(issued.key.key_id, "panel-worker")

    assert writes == 2, "the save must continue after a short write"
    assert path.read_bytes() == original
    assert store.worker_id_for(issued.key.key_id) == ""
    assert not path.with_suffix(".json.tmp").exists()


def test_pasted_connection_secrets_use_the_protected_key_file(store, tmp_path):
    from worker.inbound.keys import KEY_PREFIX, KeyStore

    secret = KEY_PREFIX + "s" * 40
    store.remember_connection_secret("10.0.0.2:7444", secret)

    reopened = KeyStore(str(tmp_path / "inbound-keys.json"))

    assert reopened.connection_secret("10.0.0.2:7444") == secret
    if os.name != "nt":
        assert stat.S_IMODE((tmp_path / "inbound-keys.json").stat().st_mode) == 0o600


def test_legacy_saved_connection_is_migrated_out_of_settings(store, monkeypatch):
    from worker.inbound import service as inbound_service
    from worker.inbound.connection_string import format_connection
    from worker.inbound.keys import KEY_PREFIX

    secret = KEY_PREFIX + "s" * 40
    fingerprint = "a" * 64
    legacy = format_connection(
        host="10.0.0.2", port=7444, secret=secret, fingerprint=fingerprint
    )
    settings = {inbound_service._SAVED_KEY: legacy}
    monkeypatch.setattr(
        inbound_service,
        "_setting",
        lambda name, default="": settings.get(name, default),
    )
    monkeypatch.setattr(
        inbound_service,
        "_set_setting",
        lambda name, value: settings.__setitem__(name, value),
    )

    outbound = inbound_service.OutboundNodes(store)

    assert outbound.saved() == ["10.0.0.2:7444"]
    assert secret not in settings[inbound_service._SAVED_KEY]
    assert store.connection_secret("10.0.0.2:7444") == secret
    assert store.connection_fingerprint("10.0.0.2:7444") == fingerprint


def test_a_corrupt_key_file_is_reported_rather_than_read_as_no_keys(tmp_path, caplog):
    """Silently becoming "no keys configured" reads to the user as "my keys
    vanished", with the cause nowhere."""
    from worker.inbound.keys import KeyStore

    path = tmp_path / "inbound-keys.json"
    path.write_text("{not json", encoding="utf-8")

    with caplog.at_level("ERROR"):
        store = KeyStore(str(path))

    assert store.list_keys() == []
    assert "unreadable" in caplog.text


def test_authentication_records_who_connected_and_from_where(store):
    issued = store.issue("Alice laptop")

    store.authenticate(issued.secret, peer="10.0.0.5")

    row = store.list_keys()[0]
    assert row["label"] == "Alice laptop"
    assert row["last_seen_peer"] == "10.0.0.5"
    assert row["last_seen_at"] > 0


# ── Connection string ──────────────────────────────────────────────────────


def test_the_connection_string_round_trips(store):
    from worker.inbound.connection_string import format_connection, parse_connection

    issued = store.issue("Alice")
    fingerprint = "a" * 64
    text = format_connection(
        host="192.168.0.110",
        port=7444,
        secret=issued.secret,
        fingerprint=fingerprint,
    )

    parsed = parse_connection(text)

    assert parsed.host == "192.168.0.110"
    assert parsed.port == 7444
    assert parsed.secret == issued.secret
    assert parsed.fingerprint == fingerprint
    assert parsed.endpoint == "192.168.0.110:7444"


def test_an_ipv6_node_is_bracketed_for_grpc():
    """gRPC's resolver reads an unbracketed IPv6 address as host:port and
    fails on the wrong half of it."""
    from worker.inbound.connection_string import format_connection, parse_connection
    from worker.inbound.keys import KEY_PREFIX

    text = format_connection(
        host="fd00::1",
        port=7444,
        secret=KEY_PREFIX + "a" * 32,
        fingerprint="b" * 64,
    )

    assert parse_connection(text).endpoint == "[fd00::1]:7444"


def test_the_secret_never_appears_in_the_loggable_form():
    from worker.inbound.connection_string import format_connection, parse_connection
    from worker.inbound.keys import KEY_PREFIX

    connection = parse_connection(
        format_connection(
            host="10.0.0.2",
            port=7444,
            secret=KEY_PREFIX + "s" * 40,
            fingerprint="c" * 64,
        )
    )

    redacted = connection.redacted()

    assert connection.secret not in redacted
    assert "10.0.0.2:7444" in redacted


@pytest.mark.parametrize(
    "text, expected",
    [
        ("192.168.0.110:7444", "without a key"),
        ("ovnode://192.168.0.110:7444", "no key in it"),
        ("https://192.168.0.110:7444", "connection string"),
        ("ovnode://ovnode_short@10.0.0.1:7444", "not in the expected format"),
        ("", "Paste the connection string"),
    ],
)
def test_a_malformed_connection_string_says_what_is_wrong(text, expected):
    """Every one of these otherwise surfaces as "cannot connect", which is the
    same thing a firewall, a wrong port and a dead node all say."""
    from worker.inbound.connection_string import (
        InvalidConnectionString,
        parse_connection,
    )

    with pytest.raises(InvalidConnectionString) as excinfo:
        parse_connection(text)

    assert expected in str(excinfo.value)


def test_pasting_an_outbound_enrollment_token_says_so():
    """The two credentials look alike and go in opposite directions; "invalid
    key" would send someone hunting for a typo that is not there."""
    from worker.inbound.connection_string import (
        InvalidConnectionString,
        parse_connection,
    )

    with pytest.raises(InvalidConnectionString) as excinfo:
        parse_connection("ovnode://ovw_" + "a" * 40 + "@10.0.0.1:7444")

    assert "other direction" in str(excinfo.value)


def test_a_connection_string_without_a_certificate_pin_is_refused(store):
    from worker.inbound.connection_string import (
        InvalidConnectionString,
        parse_connection,
    )

    issued = store.issue("Alice")
    with pytest.raises(InvalidConnectionString, match="certificate fingerprint"):
        parse_connection(f"ovnode://{issued.secret}@10.0.0.1:7444")


# ── Settings gate ──────────────────────────────────────────────────────────


def test_the_bind_is_localhost_until_someone_widens_it(monkeypatch):
    """The listener must never widen as a side effect of enabling it."""
    from worker.inbound import service as inbound_service

    monkeypatch.delenv("OMNIVOICE_INBOUND_BIND", raising=False)
    monkeypatch.setattr(inbound_service, "_setting", lambda name, default="": default)

    assert inbound_service.bind_host() == "127.0.0.1"
    assert inbound_service.is_exposed("127.0.0.1") is False


def test_a_wider_bind_is_reported_as_exposed():
    """The UI needs to say so at the point the bind is widened, not bury it."""
    from worker.inbound import service as inbound_service

    assert inbound_service.is_exposed("0.0.0.0") is True
    assert inbound_service.is_exposed("192.168.0.110") is True
    assert inbound_service.is_exposed("localhost") is False


def test_a_bracketed_ipv6_loopback_is_normalised_before_bind_and_advertise(
    monkeypatch,
):
    from worker.inbound import service as inbound_service

    monkeypatch.setenv("OMNIVOICE_INBOUND_BIND", "[::1]")
    saved = {}
    monkeypatch.setattr(
        inbound_service,
        "_set_setting",
        lambda name, value: saved.__setitem__(name, value),
    )

    assert inbound_service.bind_host() == "::1"
    assert inbound_service.advertised_host() == "::1"
    assert inbound_service.is_exposed("[::1]") is False
    inbound_service.set_bind_host("[::1]")
    assert saved[inbound_service._BIND_KEY] == "::1"


def test_inbound_is_off_unless_it_was_turned_on(monkeypatch):
    from worker.inbound import service as inbound_service

    monkeypatch.delenv("OMNIVOICE_INBOUND_NODE", raising=False)
    monkeypatch.setattr(inbound_service, "_setting", lambda name, default="": default)

    assert inbound_service.enabled() is False


@pytest.mark.asyncio
async def test_environment_override_rejects_ui_enablement_changes(monkeypatch):
    from fastapi import HTTPException

    from api.routers import workers as workers_router
    from worker.inbound import service as inbound_service

    monkeypatch.setenv("OMNIVOICE_INBOUND_NODE", "true")
    changed = []
    monkeypatch.setattr(inbound_service, "set_enabled", lambda value: changed.append(value))

    with pytest.raises(HTTPException) as excinfo:
        await workers_router.set_inbound_enabled(
            workers_router.InboundEnableRequest(enabled=False)
        )

    assert excinfo.value.status_code == 409
    assert changed == []
    assert inbound_service.enabled() is True


def test_a_wildcard_bind_never_reaches_the_connection_string(monkeypatch):
    """0.0.0.0 is legal to bind and meaningless to dial.

    Found on hardware: with the listener bound to every interface, the issued
    string came out as ovnode://…@0.0.0.0:7444, which fails on the far end with
    a connection error that names nothing. The string has to carry an address
    the other machine can actually reach.
    """
    from worker import tls
    from worker.inbound import service as inbound_service
    from worker.inbound.connection_string import parse_connection

    monkeypatch.setattr(inbound_service, "bind_host", lambda: "0.0.0.0")
    monkeypatch.setattr(inbound_service, "bind_port", lambda: 7444)
    monkeypatch.setattr(inbound_service, "advertised_host", lambda: "192.168.0.110")

    node = inbound_service.InboundNode()
    node._credentials = tls.generate_self_signed(hostnames=["127.0.0.1"])
    text = node.connection_string("ovnode_" + "k" * 40)

    assert "0.0.0.0" not in text
    assert parse_connection(text).host not in ("0.0.0.0", "", "*")


def test_an_explicit_bind_is_advertised_as_given(monkeypatch):
    """Only wildcards are substituted — a user who typed a specific address
    meant that address, including one this host cannot introspect."""
    from worker.inbound import service as inbound_service

    monkeypatch.setattr(inbound_service, "bind_host", lambda: "192.168.0.202")

    assert inbound_service.advertised_host() == "192.168.0.202"


# ── Idle-unload tunables ───────────────────────────────────────────────────


def test_the_idle_threshold_can_be_shortened_for_testing(monkeypatch):
    """Ten minutes is right in production and useless to observe by hand."""
    from services import tts_backend

    monkeypatch.setenv("OMNIVOICE_ENGINE_IDLE_UNLOAD_SECONDS", "60")
    assert (
        tts_backend._idle_seconds_from_env(
            "OMNIVOICE_ENGINE_IDLE_UNLOAD_SECONDS", 600.0, floor=5.0
        )
        == 60.0
    )


def test_a_zero_or_junk_idle_threshold_is_refused(monkeypatch, caplog):
    """A zero threshold unloads an engine the instant it goes idle, so a busy
    machine reloads it for every request. Falling back loudly beats honouring
    a value that quietly destroys throughput."""
    from services import tts_backend

    for bad in ("0", "-5", "abc", "2"):
        monkeypatch.setenv("OMNIVOICE_ENGINE_IDLE_UNLOAD_SECONDS", bad)
        with caplog.at_level("WARNING"):
            value = tts_backend._idle_seconds_from_env(
                "OMNIVOICE_ENGINE_IDLE_UNLOAD_SECONDS", 600.0, floor=5.0
            )
        assert value == 600.0, f"{bad!r} should not have been honoured"
    assert "Ignoring" in caplog.text


def test_the_sweep_interval_can_be_shortened_with_the_threshold(monkeypatch):
    """Shortening only the threshold still means waiting a full minute to see
    a thirty-second rule fire, which reads as a broken sweep."""
    from worker import agent

    monkeypatch.setenv("OMNIVOICE_IDLE_SWEEP_SECONDS", "5")
    assert agent._sweep_seconds_from_env() == 5.0

    monkeypatch.setenv("OMNIVOICE_IDLE_SWEEP_SECONDS", "0")
    assert agent._sweep_seconds_from_env() == 60.0


# ── Preload on a node ──────────────────────────────────────────────────────


def test_a_worker_machine_does_not_preload_a_model(monkeypatch, caplog):
    """A node has no local user to warm the model for.

    The startup preload exists so the first /generate feels instant for the
    person in front of the app. On a headless GPU node there is nobody there,
    so it is several GB held from boot against a request that may never
    arrive — and the idle sweep cannot reclaim it, because the sweep owns the
    worker executor's engines while this is the default local model. Observed
    on hardware: a node that had run nothing still sat at 2.4 GB.
    """
    import asyncio

    from services import model_manager

    monkeypatch.setenv("OMNIVOICE_WORKER_MODE", "1")
    monkeypatch.setattr(model_manager, "model", None)
    loaded = {"count": 0}
    monkeypatch.setattr(
        model_manager,
        "_checkpoint_in_local_cache",
        lambda *a, **k: loaded.__setitem__("count", loaded["count"] + 1) or True,
    )

    with caplog.at_level("INFO"):
        asyncio.run(model_manager.preload_model())

    assert loaded["count"] == 0, (
        "a worker machine still went looking for a model to preload"
    )
    assert "loads on first request" in caplog.text


def test_a_desktop_machine_still_preloads(monkeypatch):
    """A machine that is both an app and a worker keeps the warm-up — there is
    a real user in front of it and the whole point of preloading stands."""
    from services import model_manager

    monkeypatch.delenv("OMNIVOICE_WORKER_MODE", raising=False)

    assert model_manager._headless_worker() is False
