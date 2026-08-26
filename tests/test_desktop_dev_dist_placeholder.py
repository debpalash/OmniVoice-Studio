"""`bun run desktop` on a fresh clone must compile without a prior `vite build`.

`frontend/dist` is a `bundle.resources` entry in tauri.conf.json, and Tauri's
build script refuses to compile when a listed resource path is missing — even
under `tauri dev`, where the UI is served by Vite and no `dist` is ever
produced. A fresh clone therefore died with
"resource path `../../frontend/dist` doesn't exist" before the window appeared.

`scripts/desktop-dev.mjs` owns the fix: it creates the (possibly empty)
directory before spawning `tauri dev`. This pins that guard so a refactor of
the launcher can't silently reintroduce the first-run wall (#1664).
"""
import os

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEV = os.path.join(_ROOT, "scripts", "desktop-dev.mjs")


def test_desktop_dev_creates_dist_before_tauri_dev():
    src = open(_DEV, encoding="utf-8").read()
    mk = src.find('mkdirSync(join(process.cwd(), "dist"), { recursive: true })')
    spawn = src.find('spawnSync("bun", ["run", "tauri", "dev"')
    assert mk != -1, "desktop-dev.mjs must create frontend/dist (tauri bundle resource)"
    assert spawn != -1
    assert mk < spawn, "frontend/dist must exist before `tauri dev` compiles"
