from dataclasses import dataclass

@dataclass
class _Caps:
    family: str = "rocm"
    device_name: str = "AMD Radeon RX 6700 XT"


class _TorchEngine:
    execution_evidence_loaded = True
    gpu_compat = ("rocm", "cpu")
    _device = "cuda:0"
    _dtype = "float16"


class _FasterWhisper:
    execution_evidence_loaded = True
    gpu_compat = ("cuda", "cpu")
    _device = "cpu"
    _compute_type = "int8"


class _OnnxEngine:
    execution_evidence_loaded = True
    gpu_compat = ("cpu",)
    _provider = "CPUExecutionProvider"
    _dtype = "int8"


class _SidecarEngine:
    execution_evidence_loaded = True
    gpu_compat = ("rocm", "cpu")
    runs_out_of_process = True
    _device = "cuda:0"


class _LoadFallbackEngine:
    execution_evidence_loaded = True
    gpu_compat = ("cuda", "cpu")
    _device = "cpu"
    _fallback_reason = "CUDA memory was exhausted while loading the engine"
    _fallback_stage = "model_load"


def _snap(cls, routing):
    from services.engine_evidence import snapshot

    return snapshot(
        engine_id=cls.__name__, engine_cls=cls, instance=cls(), routing=routing, caps=_Caps()
    )


def test_loaded_rocm_torch_engine_reports_actual_device():
    evidence = _snap(_TorchEngine, {"routing_status": "accelerated", "routing_reason": None})
    assert evidence["actual_execution_device"] == "cuda:0"
    assert evidence["precision_or_quantization"] == "float16"
    assert evidence["gpu_name"] == "AMD Radeon RX 6700 XT"


def test_faster_whisper_cpu_fallback_names_reason_and_stage():
    evidence = _snap(
        _FasterWhisper,
        {"routing_status": "cpu_fallback", "routing_reason": "ROCm is unsupported"},
    )
    assert evidence["actual_execution_device"] == "cpu"
    assert evidence["cpu_fallback_reason"] == "ROCm is unsupported"
    assert evidence["cpu_fallback_stage"] == "routing_preflight"


def test_cpu_onnx_and_subprocess_observability_are_explicit():
    cpu = _snap(_OnnxEngine, {"routing_status": "cpu_only", "routing_reason": None})
    sidecar = _snap(_SidecarEngine, {"routing_status": "accelerated", "routing_reason": None})
    assert cpu["actual_execution_provider"] == "CPUExecutionProvider"
    assert cpu["parent_memory_observable"] is True
    assert sidecar["parent_memory_observable"] is False


def test_subprocess_state_follows_live_child_not_wrapper_presence():
    from services.engine_evidence import snapshot

    class _Process:
        def __init__(self, returncode):
            self.returncode = returncode

        def poll(self):
            return self.returncode

    class _OpaqueSidecar:
        gpu_compat = ("cpu",)
        runs_out_of_process = True

        def __init__(self, process):
            self._proc = process

        def execution_evidence_loaded(self):
            return self._proc is not None and self._proc.poll() is None

    routing = {"routing_status": "cpu_only", "routing_reason": None}
    for process, expected in (
        (None, "not_loaded"),
        (_Process(1), "not_loaded"),
        (_Process(None), "subprocess_loaded_provider_unreported"),
    ):
        evidence = snapshot(
            engine_id="opaque",
            engine_cls=_OpaqueSidecar,
            instance=_OpaqueSidecar(process),
            routing=routing,
            caps=_Caps(),
        )
        assert evidence["evidence_state"] == expected


def test_public_inventory_replaces_nested_private_fallback_detail():
    from api.public_engine_metadata import public_backends

    entry = {
        "routing_status": "cpu_fallback",
        "routing_reason": "/home/alice/private driver error",
        "execution_evidence": {"cpu_fallback_reason": "/home/alice/private driver error"},
    }
    public = public_backends([entry])[0]
    expected = "GPU acceleration is unavailable; this engine will use CPU."
    assert public["routing_reason"] == expected
    assert public["execution_evidence"]["cpu_fallback_reason"] == expected


def test_constructed_in_process_backend_is_not_loaded_until_contract_says_so():
    from services.engine_evidence import snapshot

    class _Lazy:
        gpu_compat = ("cpu",)
        execution_evidence_loaded = False
        _device = "cpu"

    routing = {"routing_status": "cpu_only", "routing_reason": None}
    evidence = snapshot(
        engine_id="lazy", engine_cls=_Lazy, instance=_Lazy(), routing=routing, caps=_Caps()
    )
    assert evidence["evidence_state"] == "not_loaded"
    assert evidence["actual_execution_device"] is None


def test_post_load_fallback_overrides_preflight_prediction():
    evidence = _snap(
        _LoadFallbackEngine,
        {"routing_status": "accelerated", "routing_reason": None},
    )
    assert evidence["actual_execution_device"] == "cpu"
    assert evidence["cpu_fallback_stage"] == "model_load"
    assert "memory" in evidence["cpu_fallback_reason"]


def test_lifecycle_probe_lookup_and_call_failures_are_explicit():
    from services.engine_evidence import snapshot

    class _RaisingDescriptor:
        gpu_compat = ("cpu",)

        @property
        def execution_evidence_loaded(self):
            raise RuntimeError("descriptor failed")

    class _RaisingCallable:
        gpu_compat = ("cpu",)

        def execution_evidence_loaded(self):
            raise RuntimeError("probe failed")

    routing = {"routing_status": "cpu_only", "routing_reason": None}
    for cls in (_RaisingDescriptor, _RaisingCallable):
        evidence = snapshot(
            engine_id="broken-probe",
            engine_cls=cls,
            instance=cls(),
            routing=routing,
            caps=_Caps(),
        )
        assert evidence["evidence_state"] == "probe_error"
        assert evidence["actual_execution_device"] is None


def test_public_runtime_fallback_overrides_accelerated_preflight_category():
    from api.public_engine_metadata import public_backends

    public = public_backends(
        [{
            "routing_status": "accelerated",
            "routing_reason": None,
            "execution_evidence": {
                "cpu_fallback_reason": "/private/model load failed with hf_secret",
                "cpu_fallback_stage": "model_load",
            },
        }]
    )[0]
    assert public["execution_evidence"]["cpu_fallback_reason"] == (
        "GPU acceleration is unavailable; this engine will use CPU."
    )


def test_stopped_asr_sidecar_invalidates_cached_loaded_evidence(monkeypatch):
    from services import asr_backend

    class _StoppedProcess:
        def poll(self):
            return 0

    class _StoppedSidecar:
        id = "stopped"
        display_name = "Stopped sidecar"
        gpu_compat = ("cpu",)
        _is_subprocess_isolated = True
        runs_out_of_process = True

        def __init__(self):
            self._proc = _StoppedProcess()

        @classmethod
        def is_available(cls):
            return True, "ready"

        def execution_evidence_loaded(self):
            return self._proc.poll() is None

    monkeypatch.setattr(asr_backend, "_REGISTRY", {"stopped": _StoppedSidecar})
    monkeypatch.setattr(asr_backend, "_ISOLATED_INSTANCES", {"stopped": _StoppedSidecar()})
    monkeypatch.setattr(
        asr_backend,
        "_RUNTIME_EVIDENCE",
        {"stopped": {"evidence_state": "loaded", "actual_execution_device": "cuda:0"}},
    )
    row = asr_backend.list_backends()[0]
    assert row["execution_evidence"]["evidence_state"] == "not_loaded"
    assert "stopped" not in asr_backend._RUNTIME_EVIDENCE


def test_unloaded_in_process_asr_invalidates_cached_loaded_evidence(monkeypatch):
    from services import asr_backend

    class _Backend:
        id = "released"
        display_name = "Released backend"
        gpu_compat = ("cuda", "cpu")

        def __init__(self):
            self._model = object()

        @classmethod
        def is_available(cls):
            return True, "ready"

        def execution_evidence_loaded(self):
            return self._model is not None

        def unload(self):
            self._model = None

    instance = _Backend()
    monkeypatch.setattr(asr_backend, "_REGISTRY", {"released": _Backend})
    monkeypatch.setattr(asr_backend, "_RUNTIME_INSTANCES", {"released": instance})
    monkeypatch.setattr(
        asr_backend,
        "_RUNTIME_EVIDENCE",
        {"released": {"evidence_state": "loaded", "actual_execution_device": "cuda:0"}},
    )

    instance.unload()
    row = asr_backend.list_backends()[0]

    assert row["execution_evidence"]["evidence_state"] == "not_loaded"
    assert row["execution_evidence"]["actual_execution_device"] is None
    assert "released" not in asr_backend._RUNTIME_EVIDENCE
