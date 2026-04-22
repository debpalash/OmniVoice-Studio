"""Disable torch.compile / dynamo / inductor in PyInstaller-frozen builds.

`torch.compile` uses a mix of C++ ABI magic and source-file introspection
that breaks inside a frozen bundle:
- Dynamo's FX graph builder walks `__file__` paths that no longer exist
  once the Python source is shipped as PYC inside the bundle.
- TorchInductor tries to read and JIT-compile additional C++ kernels at
  runtime, relying on a compiler toolchain the end user's Mac won't have.
- Frozen modules load in a different order than the source tree, which
  occasionally surfaces circular-import issues inside dynamo guards.

Setting these env vars before torch is imported anywhere else is enough
to keep PyTorch on its eager path. Negligible perf hit for inference-only
workloads — we're not training here.
"""
import os

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
os.environ.setdefault("TORCH_COMPILE_DISABLE", "1")
os.environ.setdefault("TORCHINDUCTOR_DISABLE", "1")
os.environ.setdefault("PYTORCH_DISABLE_PER_OP_PROFILING", "1")
