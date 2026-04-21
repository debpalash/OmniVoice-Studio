# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for OmniVoice Studio backend.
#
# Produces a one-folder bundle at dist/omnivoice-backend/ that Tauri launches
# as a sidecar binary. Kept intentionally permissive with collect_all(...)
# on the heavy ML deps because PyInstaller's static analysis misses their
# runtime-imported submodules, C extensions, and data files.
#
# Run:  uv run pyinstaller backend.spec --noconfirm --clean
from PyInstaller.utils.hooks import collect_data_files, collect_all

datas = []
binaries = []
hiddenimports = [
    # Web stack
    'uvicorn', 'uvicorn.logging', 'uvicorn.loops', 'uvicorn.loops.auto',
    'uvicorn.protocols', 'uvicorn.protocols.http', 'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets', 'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan', 'uvicorn.lifespan.on',
    'fastapi', 'fastapi.responses', 'starlette',
    'multipart',

    # Core
    'uuid', 'asyncio',

    # Audio / ML
    'torch', 'torchaudio', 'soundfile', 'scipy', 'numpy',
    'numpy.random._pickle',

    # Pipeline
    'yt_dlp', 'demucs', 'demucs.separate',

    # OmniVoice's own package
    'omnivoice', 'omnivoice.models', 'omnivoice.models.omnivoice',

    # MLX Whisper on Apple Silicon (primary ASR path)
    'mlx', 'mlx_whisper',
]

# The nuclear option on heavy ML libs — pull every submodule, C ext, and
# data file. Cost: bigger bundle. Benefit: we don't ship a binary that
# ImportErrors the first time a user hits a code path.
for pkg in ('torch', 'torchaudio', 'soundfile', 'scipy', 'numpy',
            'omnivoice', 'mlx', 'mlx_whisper', 'demucs', 'yt_dlp',
            'fastapi', 'uvicorn'):
    try:
        tmp_datas, tmp_binaries, tmp_hidden = collect_all(pkg)
        datas += tmp_datas
        binaries += tmp_binaries
        hiddenimports += tmp_hidden
    except Exception as e:  # noqa: BLE001
        print(f"[backend.spec] collect_all({pkg!r}) skipped: {e}")

# Include the backend's own modules as data so imports like
# `api.routers.dub_generate` resolve inside the frozen bundle.
datas += [
    ('backend/api', 'api'),
    ('backend/core', 'core'),
    ('backend/services', 'services'),
    ('backend/schemas', 'schemas'),
    ('backend/migrations', 'migrations'),
]

a = Analysis(
    ['backend/main.py'],
    pathex=['backend', '.'],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Desktop-only bloat we don't need inside the frozen backend.
        'tkinter', 'matplotlib', 'PIL.ImageQt', 'PyQt5', 'PyQt6',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='omnivoice-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,              # UPX often corrupts ML native libs — disabled.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='omnivoice-backend',
)
