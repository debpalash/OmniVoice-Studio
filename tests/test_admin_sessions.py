"""Short-lived remote-admin credentials: lifecycle and concurrency contracts."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hmac
import importlib
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from services.admin_sessions import (
        ADMIN_SESSION_PREFIX,
        SESSION_TTL_SECONDS,
        WS_TICKET_PREFIX,
        WS_TICKET_TTL_SECONDS,
        AdminSessionStore,
    )


MASTER = "MASTER_DO_NOT_LEAK_7d29"
_SESSION_TOKEN_PREFIX = "ovs_admin_session_"
_SESSION_SYMBOLS = (
    "ADMIN_SESSION_PREFIX",
    "SESSION_TTL_SECONDS",
    "WS_TICKET_PREFIX",
    "WS_TICKET_TTL_SECONDS",
    "AdminSessionStore",
)


@pytest.fixture(autouse=True)
def _resolve_active_session_module():
    """Bind the active app module after any sys.modules test isolation."""
    module = importlib.import_module("services.admin_sessions")
    globals().update({name: getattr(module, name) for name in _SESSION_SYMBOLS})


class FakeClock:
    def __init__(self) -> None:
        self.monotonic_value = 1_000.0
        self.wall_value = 1_800_000_000.0

    def monotonic(self) -> float:
        return self.monotonic_value

    def wall(self) -> float:
        return self.wall_value

    def advance(self, seconds: float) -> None:
        self.monotonic_value += seconds
        self.wall_value += seconds


class _ExpiryReadProbe:
    """Count expiry reads while preserving the wrapped record's behavior."""

    def __init__(self, record, counter: list[int]) -> None:
        self._record = record
        self._counter = counter

    def __getattr__(self, name: str):
        if name == "expires_monotonic":
            self._counter[0] += 1
        return getattr(self._record, name)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def store(clock: FakeClock, _resolve_active_session_module) -> AdminSessionStore:
    return AdminSessionStore(
        monotonic=clock.monotonic,
        wall_time=clock.wall,
        pepper=b"p" * 32,
    )


def _assert_ticket_index_consistent(store: AdminSessionStore) -> None:
    expected: dict[str, set[str]] = {}
    for ticket_hash, ticket in store._tickets.items():
        expected.setdefault(ticket.session_hash, set()).add(ticket_hash)
    assert store._ticket_hashes_by_session == expected
    assert set(expected).issubset(store._sessions)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"session_ttl_seconds": 0},
        {"ws_ticket_ttl_seconds": -1},
        {"max_sessions": 0},
        {"max_tickets": -1},
        {"pepper": b"short"},
    ],
)
def test_constructor_rejects_unsafe_lifetime_capacity_and_pepper(kwargs):
    with pytest.raises(ValueError):
        AdminSessionStore(**kwargs)


def test_issue_rejects_an_empty_master(store: AdminSessionStore):
    with pytest.raises(ValueError, match="configured API key"):
        store.issue("   ")


def test_token_source_must_return_exactly_256_bits(clock: FakeClock):
    store = AdminSessionStore(
        monotonic=clock.monotonic,
        wall_time=clock.wall,
        token_bytes=lambda _size: b"x" * 31,
        pepper=b"p" * 32,
    )

    with pytest.raises(RuntimeError, match="exactly 32 bytes"):
        store.issue(MASTER)


def test_repeated_token_source_collision_fails_closed(clock: FakeClock):
    store = AdminSessionStore(
        monotonic=clock.monotonic,
        wall_time=clock.wall,
        token_bytes=lambda _size: b"x" * 32,
        pepper=b"p" * 32,
    )
    store.issue(MASTER)

    with pytest.raises(RuntimeError, match="repeated collisions"):
        store.issue(MASTER)


def test_issue_returns_a_namespaced_256_bit_token_once(store: AdminSessionStore):
    issued = store.issue(MASTER)

    assert issued.token.startswith(ADMIN_SESSION_PREFIX)
    # 32 random bytes encode to 43 unpadded base64url characters.
    assert len(issued.token.removeprefix(ADMIN_SESSION_PREFIX)) == 43
    assert issued.expires_at == 1_800_000_000.0 + SESSION_TTL_SECONDS
    assert MASTER not in repr(issued)
    assert issued.token not in repr(issued)


def test_store_retains_only_the_token_hash(store: AdminSessionStore):
    issued = store.issue(MASTER)
    expected_hash = hmac.digest(b"p" * 32, issued.token.encode("utf-8"), "sha256").hex()

    assert tuple(store._sessions) == (expected_hash,)
    assert issued.token not in repr(store._sessions)
    assert MASTER not in repr(store._sessions)


def test_resolve_returns_expected_admin_capabilities(store: AdminSessionStore):
    issued = store.issue(MASTER)

    record = store.resolve(issued.token, MASTER)

    assert record is not None
    assert record.credential_id == hmac.digest(
        b"p" * 32,
        issued.token.encode(),
        "sha256",
    ).hex()
    assert record.capabilities == frozenset({"consume", "admin"})
    assert "native" not in record.capabilities


def test_expiry_boundary_is_closed_at_deadline(store: AdminSessionStore, clock: FakeClock):
    issued = store.issue(MASTER)
    clock.advance(SESSION_TTL_SECONDS - 0.001)
    assert store.resolve(issued.token, MASTER) is not None

    clock.advance(0.001)
    assert store.resolve(issued.token, MASTER) is None


def test_wall_clock_rollback_does_not_extend_a_session(store: AdminSessionStore, clock: FakeClock):
    issued = store.issue(MASTER)
    clock.wall_value -= 86_400
    clock.monotonic_value += SESSION_TTL_SECONDS

    assert store.resolve(issued.token, MASTER) is None


def test_logout_revokes_immediately_and_is_idempotent(store: AdminSessionStore):
    issued = store.issue(MASTER)

    assert store.revoke(issued.token) is True
    assert store.resolve(issued.token, MASTER) is None
    assert store.revoke(issued.token) is False


def test_invalid_revocation_identifiers_fail_without_mutation(store: AdminSessionStore):
    issued = store.issue(MASTER)

    assert store.revoke("not-a-session") is False
    assert store.revoke_by_credential(None) is False
    assert store.revoke_by_credential("short") is False
    assert store.resolve(issued.token, MASTER) is not None


def test_key_rotation_invalidates_all_sessions(store: AdminSessionStore):
    first = store.issue(MASTER)
    second = store.issue(MASTER)

    assert store.resolve(first.token, "ROTATED_MASTER") is None
    assert store.resolve(second.token, "ROTATED_MASTER") is None
    assert store.active_session_count == 0


def test_key_removal_invalidates_all_sessions(store: AdminSessionStore):
    issued = store.issue(MASTER)

    assert store.resolve(issued.token, "   ") is None
    assert store.active_session_count == 0


def test_process_store_starts_empty(clock: FakeClock):
    first = AdminSessionStore(monotonic=clock.monotonic, wall_time=clock.wall)
    issued = first.issue(MASTER)
    restarted = AdminSessionStore(monotonic=clock.monotonic, wall_time=clock.wall)

    assert restarted.resolve(issued.token, MASTER) is None
    assert restarted.active_session_count == 0


def test_expired_sessions_are_purged_before_capacity_eviction(clock: FakeClock):
    store = AdminSessionStore(
        monotonic=clock.monotonic,
        wall_time=clock.wall,
        session_ttl_seconds=10,
        max_sessions=2,
    )
    expired = store.issue(MASTER)
    clock.advance(10)
    live_one = store.issue(MASTER)
    live_two = store.issue(MASTER)

    assert store.resolve(expired.token, MASTER) is None
    assert store.resolve(live_one.token, MASTER) is not None
    assert store.resolve(live_two.token, MASTER) is not None


def test_capacity_evicts_oldest_live_session_deterministically(clock: FakeClock):
    store = AdminSessionStore(
        monotonic=clock.monotonic,
        wall_time=clock.wall,
        max_sessions=2,
    )
    oldest = store.issue(MASTER)
    clock.advance(1)
    middle = store.issue(MASTER)
    clock.advance(1)
    newest = store.issue(MASTER)

    assert store.resolve(oldest.token, MASTER) is None
    assert store.resolve(middle.token, MASTER) is not None
    assert store.resolve(newest.token, MASTER) is not None


def test_resolve_does_not_scan_every_live_credential(store: AdminSessionStore):
    sessions = [store.issue(MASTER) for _ in range(64)]
    for _ in range(128):
        store.issue_ws_ticket(sessions[-1].token, "/ws/events", MASTER)

    session_reads = [0]
    ticket_reads = [0]
    for token_hash, record in tuple(store._sessions.items()):
        store._sessions[token_hash] = _ExpiryReadProbe(record, session_reads)
    for token_hash, ticket in tuple(store._tickets.items()):
        store._tickets[token_hash] = _ExpiryReadProbe(ticket, ticket_reads)

    assert store.resolve(sessions[-1].token, MASTER) is not None
    # One read checks the oldest expiry; a second validates the requested
    # session. The number of reads must not grow with store occupancy.
    assert session_reads[0] <= 2
    assert ticket_reads[0] <= 1


def test_ticket_index_stays_consistent_across_mixed_removals(clock: FakeClock):
    store = AdminSessionStore(
        monotonic=clock.monotonic,
        wall_time=clock.wall,
        pepper=b"p" * 32,
        session_ttl_seconds=10,
        ws_ticket_ttl_seconds=30,
        max_sessions=2,
        max_tickets=3,
    )
    first = store.issue(MASTER)
    store.issue_ws_ticket(first.token, "/ws/events", MASTER)
    second = store.issue(MASTER)
    second_ticket = store.issue_ws_ticket(second.token, "/ws/events", MASTER)
    _assert_ticket_index_consistent(store)

    third = store.issue(MASTER)  # capacity eviction removes first and its ticket
    _assert_ticket_index_consistent(store)

    assert store.consume_ws_ticket(second_ticket.token, "/ws/transcribe", MASTER) is None
    store.issue_ws_ticket(third.token, "/ws/events", MASTER)
    _assert_ticket_index_consistent(store)

    clock.advance(10)
    assert store.debug_snapshot() == {"sessions": 0, "ws_tickets": 0}
    _assert_ticket_index_consistent(store)

    replacement = store.issue(MASTER)
    store.issue_ws_ticket(replacement.token, "/ws/events", MASTER)
    assert store.resolve(replacement.token, "ROTATED_MASTER") is None
    _assert_ticket_index_consistent(store)

    final = store.issue(MASTER)
    store.issue_ws_ticket(final.token, "/ws/events", MASTER)
    store.clear()
    _assert_ticket_index_consistent(store)


def test_session_capacity_eviction_removes_its_outstanding_tickets(clock: FakeClock):
    store = AdminSessionStore(
        monotonic=clock.monotonic,
        wall_time=clock.wall,
        max_sessions=1,
    )
    evicted = store.issue(MASTER)
    ticket = store.issue_ws_ticket(evicted.token, "/ws/events", MASTER)

    store.issue(MASTER)

    _assert_ticket_index_consistent(store)
    assert store.consume_ws_ticket(ticket.token, "/ws/events", MASTER) is None


@pytest.mark.parametrize(
    "token",
    [
        "",
        "   ",
        "not-a-session",
        _SESSION_TOKEN_PREFIX + "a" * 42,
        _SESSION_TOKEN_PREFIX + "a" * 44,
        _SESSION_TOKEN_PREFIX + "!" * 43,
        _SESSION_TOKEN_PREFIX + "a" * 5_000,
        None,
    ],
)
def test_malformed_and_oversized_tokens_fail_without_mutation(
    store: AdminSessionStore, token: str | None
):
    issued = store.issue(MASTER)
    before = store.debug_snapshot()

    assert store.resolve(token, MASTER) is None
    assert store.debug_snapshot() == before
    assert store.resolve(issued.token, MASTER) is not None


def test_session_and_worker_token_namespaces_do_not_overlap(store: AdminSessionStore):
    issued = store.issue(MASTER)

    assert issued.token.startswith("ovs_admin_session_")
    assert not issued.token.startswith("ovs_worker_session_")


def test_ticket_is_scoped_to_normalized_path(store: AdminSessionStore):
    session = store.issue(MASTER)
    ticket = store.issue_ws_ticket(session.token, "/ws/transcribe", MASTER)

    assert ticket.token.startswith(WS_TICKET_PREFIX)
    assert store.consume_ws_ticket(ticket.token, "/ws/events", MASTER) is None
    # A path mismatch consumes the one-use credential.
    assert store.consume_ws_ticket(ticket.token, "/ws/transcribe", MASTER) is None


def test_ticket_covers_every_first_party_ws_route(store: AdminSessionStore):
    """Backend allowlist must carry every route the UI mints tickets for
    (authSession.ts ALLOWED_WS_PATHS); a missing route fails silently in the
    UI — #1769's live dub preview over /ws/tts was the first casualty."""
    session = store.issue(MASTER)
    for path in ("/ws/events", "/ws/transcribe", "/ws/tts"):
        wrong = "/ws/events" if path != "/ws/events" else "/ws/tts"
        ticket = store.issue_ws_ticket(session.token, path, MASTER)
        assert store.consume_ws_ticket(ticket.token, wrong, MASTER) is None
        ticket = store.issue_ws_ticket(session.token, path, MASTER)
        assert store.consume_ws_ticket(ticket.token, path, MASTER) is not None


@pytest.mark.parametrize(
    "path",
    [
        "ws/transcribe",
        "/ws/transcribe?api_key=x",
        "/ws/transcribe#fragment",
        "//evil.test/ws/transcribe",
        "/ws/../system",
        "/not-a-websocket",
        "",
    ],
)
def test_ticket_rejects_noncanonical_or_unapproved_paths(
    store: AdminSessionStore, path: str
):
    session = store.issue(MASTER)

    with pytest.raises(ValueError, match="WebSocket path"):
        store.issue_ws_ticket(session.token, path, MASTER)


def test_ticket_issuance_rejects_invalid_or_inactive_sessions(store: AdminSessionStore):
    with pytest.raises(PermissionError, match="valid admin session"):
        store.issue_ws_ticket("not-a-session", "/ws/events", MASTER)
    with pytest.raises(PermissionError, match="valid admin session"):
        store.issue_ws_ticket_for_credential("short", "/ws/events", MASTER)

    session = store.issue(MASTER)
    credential_id = store.resolve(session.token, MASTER).credential_id
    store.revoke(session.token)
    with pytest.raises(PermissionError, match="valid admin session"):
        store.issue_ws_ticket_for_credential(credential_id, "/ws/events", MASTER)


def test_ticket_issuance_and_consumption_fail_after_key_removal(store: AdminSessionStore):
    session = store.issue(MASTER)
    credential_id = store.resolve(session.token, MASTER).credential_id

    with pytest.raises(PermissionError, match="valid admin session"):
        store.issue_ws_ticket_for_credential(credential_id, "/ws/events", None)

    replacement = store.issue(MASTER)
    ticket = store.issue_ws_ticket(replacement.token, "/ws/events", MASTER)
    assert store.consume_ws_ticket(ticket.token, "/ws/events", None) is None


def test_ticket_expires_at_thirty_seconds(store: AdminSessionStore, clock: FakeClock):
    session = store.issue(MASTER)
    ticket = store.issue_ws_ticket(session.token, "/ws/events", MASTER)
    assert ticket.expires_at == clock.wall() + WS_TICKET_TTL_SECONDS

    clock.advance(WS_TICKET_TTL_SECONDS)
    assert store.consume_ws_ticket(ticket.token, "/ws/events", MASTER) is None


def test_ticket_cannot_be_redeemed_twice(store: AdminSessionStore):
    session = store.issue(MASTER)
    ticket = store.issue_ws_ticket(session.token, "/ws/events", MASTER)

    assert store.consume_ws_ticket(ticket.token, "/ws/events", MASTER) is not None
    assert store.consume_ws_ticket(ticket.token, "/ws/events", MASTER) is None


def test_invalid_ticket_token_fails_without_mutating_live_session(store: AdminSessionStore):
    session = store.issue(MASTER)

    assert store.consume_ws_ticket("not-a-ticket", "/ws/events", MASTER) is None
    assert store.resolve(session.token, MASTER) is not None


def test_revoking_session_invalidates_its_outstanding_tickets(store: AdminSessionStore):
    session = store.issue(MASTER)
    ticket = store.issue_ws_ticket(session.token, "/ws/events", MASTER)
    store.revoke(session.token)

    _assert_ticket_index_consistent(store)
    assert store.consume_ws_ticket(ticket.token, "/ws/events", MASTER) is None


def test_revoking_by_credential_invalidates_outstanding_tickets(store: AdminSessionStore):
    session = store.issue(MASTER)
    record = store.resolve(session.token, MASTER)
    ticket = store.issue_ws_ticket(session.token, "/ws/events", MASTER)

    assert record is not None
    assert store.revoke_by_credential(record.credential_id) is True
    _assert_ticket_index_consistent(store)
    assert store.consume_ws_ticket(ticket.token, "/ws/events", MASTER) is None


def test_concurrent_ticket_redemption_has_exactly_one_winner(store: AdminSessionStore):
    session = store.issue(MASTER)
    ticket = store.issue_ws_ticket(session.token, "/ws/events", MASTER)

    def redeem(_index: int) -> bool:
        return store.consume_ws_ticket(ticket.token, "/ws/events", MASTER) is not None

    with ThreadPoolExecutor(max_workers=16) as executor:
        winners = list(executor.map(redeem, range(64)))

    assert winners.count(True) == 1


def test_concurrent_session_issuance_produces_unique_tokens(store: AdminSessionStore):
    with ThreadPoolExecutor(max_workers=16) as executor:
        issued = list(executor.map(lambda _index: store.issue(MASTER), range(128)))

    assert len({item.token for item in issued}) == 128
    assert store.active_session_count == 128


def test_ticket_capacity_is_bounded(clock: FakeClock):
    store = AdminSessionStore(
        monotonic=clock.monotonic,
        wall_time=clock.wall,
        max_tickets=2,
    )
    session = store.issue(MASTER)
    oldest = store.issue_ws_ticket(session.token, "/ws/events", MASTER)
    clock.advance(1)
    middle = store.issue_ws_ticket(session.token, "/ws/events", MASTER)
    clock.advance(1)
    newest = store.issue_ws_ticket(session.token, "/ws/events", MASTER)

    _assert_ticket_index_consistent(store)
    assert store.consume_ws_ticket(oldest.token, "/ws/events", MASTER) is None
    assert store.consume_ws_ticket(middle.token, "/ws/events", MASTER) is not None
    assert store.consume_ws_ticket(newest.token, "/ws/events", MASTER) is not None
    _assert_ticket_index_consistent(store)


def test_repr_and_debug_snapshot_contain_no_raw_credentials(store: AdminSessionStore):
    session = store.issue(MASTER)
    ticket = store.issue_ws_ticket(session.token, "/ws/events", MASTER)

    rendered = repr(store.debug_snapshot()) + repr(store)

    assert MASTER not in rendered
    assert session.token not in rendered
    assert ticket.token not in rendered
    assert store.debug_snapshot() == {"sessions": 1, "ws_tickets": 1}


def test_clear_removes_sessions_tickets_and_key_generation(store: AdminSessionStore):
    session = store.issue(MASTER)
    store.issue_ws_ticket(session.token, "/ws/events", MASTER)

    store.clear()

    assert store.debug_snapshot() == {"sessions": 0, "ws_tickets": 0}
    assert store._key_generation is None


def test_key_generation_is_stable_pepper_scoped_and_unicode_safe():
    first = AdminSessionStore(pepper=b"a" * 32)
    second = AdminSessionStore(pepper=b"b" * 32)
    master = "clé-administrateur-\ud800"

    generation = first._generation(master)

    assert len(generation) == 32
    assert first._generation(master) == generation
    assert first._generation(master + "x") != generation
    assert second._generation(master) != generation


def test_module_reload_and_reimport_cannot_fork_the_process_store():
    """Reloading/re-importing the module must not split the auth store (#1528).

    Auth is process-global: the module copy that issued a session and any
    later copy must resolve it identically. Test suites reload ``main`` and
    purge whole ``services.*`` trees from ``sys.modules`` (test_mcp_bindings'
    ``client`` fixture); before the anchor fix that forked the singleton —
    ``api.routers.auth`` issued into a fresh store while ``core.auth`` kept
    resolving from the old one, so a just-set admin cookie stopped resolving.
    """
    import importlib
    import sys

    import services.admin_sessions as first

    first.admin_session_store.clear()
    issued = first.admin_session_store.issue(MASTER)
    try:
        # Fork vector 1: in-place importlib.reload re-executes module code.
        reloaded = importlib.reload(first)
        assert reloaded.admin_session_store is first.admin_session_store
        assert reloaded.admin_session_store.resolve(issued.token, MASTER) is not None

        # Fork vector 2: sys.modules purge + fresh import (fresh module dict).
        sys.modules.pop("services.admin_sessions", None)
        fresh = importlib.import_module("services.admin_sessions")
        assert fresh.admin_session_store is reloaded.admin_session_store
        assert fresh.admin_session_store.resolve(issued.token, MASTER) is not None
    finally:
        importlib.import_module("services.admin_sessions").admin_session_store.clear()
