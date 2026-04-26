#!/usr/bin/env python3
"""Post-install setup for CUDA environments.

Ensures cuDNN 8 libraries are available for CTranslate2 (faster-whisper /
WhisperX) alongside PyTorch 2.8+'s cuDNN 9. Run automatically as part of
`bun run setup:api` — no user action required.

Cross-platform:
  - Linux:   installs .so.8 libs into cudnn8_compat/
  - Windows: installs .dll libs into cudnn8_compat/
  - macOS:   skipped (no CUDA)
"""
import os
import sys
import subprocess
import glob


def _find_compat_dir():
    """Return the cudnn8_compat target directory, auto-detecting venv layout."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    venv_dir = os.path.join(project_root, ".venv")

    if not os.path.isdir(venv_dir):
        return None

    if sys.platform == "win32":
        # Windows: .venv/Lib/site-packages/
        sp = os.path.join(venv_dir, "Lib", "site-packages", "cudnn8_compat")
    else:
        # Linux: .venv/lib/pythonX.Y/site-packages/
        pyver = f"python{sys.version_info.major}.{sys.version_info.minor}"
        sp = os.path.join(venv_dir, "lib", pyver, "site-packages", "cudnn8_compat")

    return sp


def _cudnn8_lib_dir(compat_dir):
    """Return the cuDNN lib subdirectory within the compat install."""
    if sys.platform == "win32":
        return os.path.join(compat_dir, "nvidia", "cudnn", "bin")
    return os.path.join(compat_dir, "nvidia", "cudnn", "lib")


def _count_cudnn8_libs(lib_dir):
    """Count cuDNN 8 shared libraries in the given directory."""
    if sys.platform == "win32":
        return len(glob.glob(os.path.join(lib_dir, "cudnn*64_8.dll")))
    return len(glob.glob(os.path.join(lib_dir, "libcudnn*.so.8")))


def main():
    # macOS — no CUDA, nothing to do
    if sys.platform == "darwin":
        return

    compat_dir = _find_compat_dir()
    if compat_dir is None:
        return

    lib_dir = _cudnn8_lib_dir(compat_dir)

    # Already installed?
    if os.path.isdir(lib_dir):
        n = _count_cudnn8_libs(lib_dir)
        if n >= 5:
            print(f"✓ cuDNN 8 compat: {n} libraries ready")
            return

    # Check if CUDA is available before installing GPU-only libs
    try:
        result = subprocess.run(
            [sys.executable, "-c", "import torch; print(torch.cuda.is_available())"],
            capture_output=True, text=True, timeout=30,
        )
        if result.stdout.strip() != "True":
            print("✓ No CUDA — cuDNN 8 compat not needed")
            return
    except Exception:
        pass  # Can't detect CUDA — install anyway, it's harmless on CPU

    print("⚙ Installing cuDNN 8 compatibility libraries for CTranslate2...")
    try:
        subprocess.run(
            [
                sys.executable, "-m", "pip", "install",
                "--no-deps", "--target", compat_dir,
                "nvidia-cudnn-cu12==8.9.7.29",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=180,
        )
        n = _count_cudnn8_libs(lib_dir)
        print(f"✓ cuDNN 8 installed: {n} libraries")
    except subprocess.CalledProcessError as e:
        print(f"⚠ cuDNN 8 install failed (transcription may not work on CUDA):")
        print(f"  {(e.stderr or '')[:300]}")
    except Exception as e:
        print(f"⚠ cuDNN 8 install skipped: {e}")


if __name__ == "__main__":
    main()
