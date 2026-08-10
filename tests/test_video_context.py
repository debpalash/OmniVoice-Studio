"""Pillow-backed video-context analysis stays deterministic across upgrades."""
from __future__ import annotations

import importlib
import tomllib
from pathlib import Path

from packaging.requirements import Requirement
from PIL import Image


def _analyse(frame_path):
    module = importlib.import_module("services.video_context")
    return module._analyse_frame_basic(str(frame_path))


def test_pillow_runtime_floor_is_declared():
    project = tomllib.loads(
        (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text()
    )
    requirements = [Requirement(item) for item in project["project"]["dependencies"]]
    pillow = next(req for req in requirements if req.name.lower() == "pillow")
    assert any(
        spec.operator == ">=" and spec.version == "12.1.0"
        for spec in pillow.specifier
    )
    assert pillow.specifier.contains("12.1.0")
    assert not pillow.specifier.contains("12.0.99")


def _save_jpeg(tmp_path, name: str, image: Image.Image):
    path = tmp_path / name
    image.save(path, format="JPEG", quality=100, subsampling=0)
    return path


def test_basic_analysis_decodes_and_resizes_real_jpegs(tmp_path):
    dark = _save_jpeg(tmp_path, "dark.jpg", Image.new("RGB", (16, 12), (20, 20, 20)))
    bright = _save_jpeg(tmp_path, "bright.jpg", Image.new("RGB", (640, 480), (230, 230, 230)))

    dark_result = _analyse(dark)
    bright_result = _analyse(bright)

    assert dark_result == {
        "brightness": "dark", "mood": "calm", "complexity": "simple",
        "avg_luminance": 20.0, "avg_saturation": 0.0,
    }
    assert bright_result == {
        "brightness": "bright", "mood": "calm", "complexity": "simple",
        "avg_luminance": 230.0, "avg_saturation": 0.0,
    }


def test_basic_analysis_preserves_color_and_edge_classes(tmp_path):
    vivid = _save_jpeg(tmp_path, "vivid.jpg", Image.new("RGB", (320, 240), (255, 0, 0)))
    stripes = Image.new("RGB", (320, 240))
    stripes.putdata([
        (255, 255, 255) if x % 2 else (0, 0, 0)
        for _y in range(240)
        for x in range(320)
    ])
    action = _save_jpeg(tmp_path, "action.jpg", stripes)

    assert _analyse(vivid)["mood"] == "vivid"
    assert _analyse(action)["complexity"] == "action"


def test_basic_analysis_degrades_cleanly_for_malformed_image(tmp_path):
    malformed = tmp_path / "frame.jpg"
    malformed.write_bytes(b"not an image")

    assert _analyse(malformed) == {
        "brightness": "unknown", "mood": "unknown", "complexity": "unknown",
    }
