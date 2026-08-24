"""Structural guards on the worker protocol contract.

These are the wire-shape decisions the architecture review found were either
prohibitively expensive to retrofit (reserved fields, fencing, versioning) or
actively dangerous to get wrong (results on the control stream, model paths in
assignments). They are mechanical rules, so they belong in a deterministic test
rather than in review attention every time the proto is touched.

Deliberately parses the ``.proto`` as text: adding ``grpcio-tools`` as a test
dependency is a packaging decision with real cross-platform cost (frozen
PyInstaller builds on four targets, plus Docker CUDA/ROCm), and it is not owed
just to assert these invariants.
"""
from __future__ import annotations

import os
import re

import pytest

from worker.protocol.gen import worker_v1_pb2 as pb
from worker.transport.server import (
    MIN_SUPPORTED_VERSION,
    PROTOCOL_VERSION,
    REQUIRED_FEATURES,
    WorkerServicer,
)

_PROTO = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "backend",
    "worker",
    "protocol",
    "worker_v1.proto",
)


@pytest.fixture(scope="module")
def proto() -> str:
    with open(_PROTO, encoding="utf-8") as fh:
        return fh.read()


def _message_body(text: str, name: str) -> str:
    """Extract one message body by matching braces.

    Brace counting rather than a lazy regex: several messages are written on a
    single line, and ``.*?^\\}`` happily runs past their closing brace and
    swallows the messages that follow — which made the field-number uniqueness
    check report duplicates that were really two different messages' tags.
    """
    match = re.search(rf"^message {re.escape(name)}\s*\{{", text, re.M)
    assert match, f"message {name} is missing from the protocol"
    depth, start = 1, match.end()
    for index in range(start, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[start:index]
    raise AssertionError(f"message {name} is not closed")


# ── Versioning ─────────────────────────────────────────────────────────────


def test_package_is_version_scoped(proto):
    """Additive-only evolution needs the version in the package name, so a v2
    can exist beside v1 during the N-2 skew window."""
    assert "package omnivoice.worker.v1;" in proto


def test_registration_negotiates_a_version_range(proto):
    body = _message_body(proto, "RegisterRequest")
    assert "protocol_version_min" in body
    assert "protocol_version_max" in body


def test_registration_declares_semantic_features(proto):
    assert "repeated string features = 17;" in _message_body(proto, "RegisterRequest")


def test_durable_registration_excludes_v1_in_both_directions():
    """A v1 peer cannot safely participate in the two-phase handshake."""
    assert MIN_SUPPORTED_VERSION == PROTOCOL_VERSION == 2


@pytest.mark.asyncio
async def test_v1_outbound_worker_is_refused_before_registration():
    servicer = object.__new__(WorkerServicer)

    response = await servicer.Register(
        pb.RegisterRequest(
            protocol_version_min=1,
            protocol_version_max=1,
            features=sorted(REQUIRED_FEATURES),
        ),
        None,
    )

    assert response.error.code == "UPGRADE_REQUIRED"


@pytest.mark.asyncio
async def test_v1_inbound_node_is_refused_before_registration():
    servicer = object.__new__(WorkerServicer)

    response = await servicer.register_inbound(
        None,
        pb.RegisterRequest(
            protocol_version_min=1,
            protocol_version_max=1,
            features=sorted(REQUIRED_FEATURES),
        ),
        address="",
    )

    assert response.error.code == "UPGRADE_REQUIRED"


@pytest.mark.asyncio
async def test_old_worker_is_visibly_refused_before_running_wrong_audio():
    """An old peer can share v1's protobuf shape while missing render parity.

    Registration must fail by name, before authentication or task dispatch,
    instead of allowing a clone with no reference audio to report SUCCESS.
    """
    servicer = object.__new__(WorkerServicer)
    response = await servicer.Register(
        pb.RegisterRequest(
            protocol_version_min=PROTOCOL_VERSION,
            protocol_version_max=PROTOCOL_VERSION,
        ),
        None,
    )

    assert response.error.code == "UPGRADE_REQUIRED"
    assert "missing required protocol features" in response.error.message
    assert "task_inputs_v1" in response.error.message
    assert "no task was run" in response.error.message
    assert REQUIRED_FEATURES


def test_remote_tts_render_parity_is_a_required_worker_feature():
    """Do not let an old worker silently bypass the canonical TTS pipeline."""
    assert "remote_tts_render_v1" in REQUIRED_FEATURES


# ── Control / data plane separation ────────────────────────────────────────


def test_artifact_transfer_has_its_own_rpcs(proto):
    """A multi-hundred-MB dub result on the control stream head-of-line blocks
    heartbeats, so the worker delivering it gets declared dead mid-delivery."""
    assert "rpc UploadResult" in proto
    assert "rpc DownloadArtifact" in proto


def test_result_message_references_artifacts_rather_than_carrying_them(proto):
    body = _message_body(proto, "TaskResult")
    assert "repeated ArtifactRef artifacts" in body
    # An inline path may exist for small payloads, but it must be bounded by a
    # negotiated threshold rather than being the only way to return a result.
    assert "inline_payload" in body
    assert "inline_result_threshold_bytes" in _message_body(proto, "ConfigUpdate")


def test_uploads_are_resumable(proto):
    """A 2 GB result failing at 95% on a consumer uplink must not restart."""
    assert "offset" in _message_body(proto, "ResultChunk")
    assert "bytes_received" in _message_body(proto, "ResultAck")


# ── Fencing ────────────────────────────────────────────────────────────────


def test_task_reference_carries_attempt_and_epoch(proto):
    """Without these, a half-open previous stream can drive a live task and a
    superseded attempt can commit over the winner."""
    body = _message_body(proto, "TaskRef")
    assert "task_id" in body
    assert "attempt_id" in body
    assert "session_epoch" in body


def test_reconnect_reports_in_flight_work(proto):
    """The worker is the source of truth for what is executing on it; without
    this a control-plane restart orphans every live task."""
    body = _message_body(proto, "RegisterRequest")
    assert "in_flight" in body
    assert "completed_unacked" in body


def test_server_replies_with_its_authoritative_view(proto):
    assert "authoritative_in_flight" in _message_body(proto, "RegisterResponse")


# ── Hosted-future fields (cheap now, fleet upgrade later) ──────────────────


@pytest.mark.parametrize("field", ["trace_id", "tenant_id", "sequence"])
def test_envelope_reserves_hosted_fields(proto, field):
    assert field in _message_body(proto, "Envelope")


def test_results_carry_usage_for_metering(proto):
    """Billing must not be blocked behind a fleet-wide protocol upgrade."""
    assert "UsageReport usage" in _message_body(proto, "TaskResult")


def test_registration_reserves_replay_and_key_fields(proto):
    body = _message_body(proto, "RegisterRequest")
    assert "key_id" in body
    assert "nonce" in body
    assert "labels" in body


# ── Identity ───────────────────────────────────────────────────────────────


def test_reconnect_proves_key_possession(proto):
    """A server-assigned worker id is a name, not an authenticator."""
    body = _message_body(proto, "RegisterRequest")
    assert "public_key" in body
    assert "challenge_signature" in body


# ── Safety ─────────────────────────────────────────────────────────────────


def test_assignment_names_a_model_and_never_a_path(proto):
    """Model loading is pickle-backed in this ecosystem, so accepting a path or
    URL here is remote code execution on every worker in the fleet."""
    body = _message_body(proto, "TaskAssignment")
    assert "string model_id" in body
    assert not re.search(r"\b(model_path|model_url|model_uri)\b", body)


def test_config_update_is_an_enumerated_allowlist(proto):
    """An open-ended config channel is an execution channel."""
    body = _message_body(proto, "ConfigUpdate")
    assert not re.search(r"\bmap<string, *string>\b", body)
    assert not re.search(r"\b(script|command|path|exec)\b", body, re.I)


# ── Deadlines and capability shape ─────────────────────────────────────────


def test_deadlines_are_phased_not_a_single_clock(proto):
    body = _message_body(proto, "Deadlines")
    for field in (
        "accept_seconds",
        "model_load_seconds",
        "execution_seconds",
        "progress_lease_seconds",
        "result_delivery_seconds",
    ):
        assert field in body, f"Deadlines is missing {field}"


def test_model_loading_is_its_own_reported_phase(proto):
    """Folding a cold load into the execution deadline quarantines healthy
    hardware for doing normal work."""
    assert "message TaskModelLoading" in proto
    assert "TaskModelLoading model_loading" in _message_body(proto, "WorkerMessage")


def test_capability_distinguishes_supported_installed_downloaded_resident(proto):
    """All four states are distinct scheduling inputs — 'supported' does not
    mean the weights are on disk, and only 'resident' is fast."""
    body = _message_body(proto, "ModelCapability")
    for field in ("supported", "installed", "downloaded", "resident"):
        assert f"bool {field}" in body, f"ModelCapability is missing {field}"


def test_concurrency_is_reported_as_derived(proto):
    """Static per-model concurrency corrupts output under torch.compile thread
    affinity (#315) and aborts the process on small cards (#567)."""
    assert "derived_concurrency" in _message_body(proto, "ModelCapability")


def test_heartbeat_does_not_promise_gpu_utilisation(proto):
    """Unobtainable on Apple without sudo powermetrics and absent on CUDA
    without a new NVML dependency. Slots and queue depth are the load signal."""
    body = _message_body(proto, "Heartbeat")
    assert not re.search(r"\bgpu_utilization|gpu_util\b", body)
    assert "available_slots" in body


def test_heartbeat_reports_residency(proto):
    assert "resident_models" in _message_body(proto, "Heartbeat")


# ── Fleet operations ───────────────────────────────────────────────────────


def test_drain_exists_for_multi_instance_control_planes(proto):
    """Cheap to reserve now; a fleet-wide upgrade to add later."""
    assert "message Drain" in proto
    assert "reconnect_to" in _message_body(proto, "Drain")


def test_result_ack_is_a_distinct_message(proto):
    """The worker may only drop its copy once the server says it is durable."""
    assert "ResultAckMessage result_ack" in _message_body(proto, "ServerMessage")


def test_field_numbers_are_unique_within_each_message(proto):
    """Renumbering or reusing a tag silently corrupts every deployed worker."""
    for name in re.findall(r"^message (\w+) \{", proto, re.M):
        body = _message_body(proto, name)
        # Strip nested oneof braces; tags are still flat within the message.
        tags = [int(t) for t in re.findall(r"=\s*(\d+)\s*;", body)]
        assert len(tags) == len(set(tags)), f"duplicate field number in {name}"
