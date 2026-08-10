> **Archival note (2026-07-12):** moved here from `.planning/` in the root cleanup.
> Internal `.planning/` / `specs/` paths below are historical — those trees were removed; see git history.

# Decision — AppImage `AppRun` injection strategy

**Date:** 2026-05-20
**Phase:** 01 (install + token persistence + docs + error UX)
**Wave:** 3
**Plan:** `01-03-PLAN.md`
**Issue:** #56 (AppImage white-screen on Fedora 44 / Ubuntu 24.04)
**Open Question resolved:** #1 from RESEARCH.md ("Where does AppRun live in this Tauri tree?")

---

## TL;DR

Tauri 2's AppImage bundler auto-generates an `AppRun` shell launcher inside the
`.AppImage` squashfs. There is no first-class `bundle.linux.appimage.template`
config key in Tauri 2.x as of this writing. The chosen injection strategy is:

> **A custom `AppRun` template sourced from `frontend/src-tauri/appimage/AppRun`
> is installed into Tauri's project-local AppImage tool cache by a
> `beforeBundleCommand`. Tauri then copies that launcher into the AppDir.**

The script that seeds the cache lives at `scripts/inject-apprun.sh`. The final
release smoke test extracts the AppImage and compares its `AppRun` byte-for-byte
with the source template, so a stock launcher cannot ship silently again.

---

## Background — what Tauri 2's auto-generated AppRun does

When `cargo tauri build --bundles appimage` runs, Tauri's bundler:

1. Creates a staging directory under `target/release/bundle/appimage/${appname}.AppDir/`
2. Drops the main binary at `usr/bin/${binary_name}`
3. Generates an `AppRun` shell script at `${appname}.AppDir/AppRun` that:
   - Sets `LD_LIBRARY_PATH` to the bundled libs
   - Sets `XDG_DATA_DIRS` to include the AppDir's `usr/share`
   - `exec`s `usr/bin/${binary_name}` with `"$@"`
4. Packs the AppDir into a single-file AppImage via `appimagetool`

The auto-generated `AppRun` does **not** set
`WEBKIT_DISABLE_COMPOSITING_MODE`. On Fedora 44 (and any distro shipping
WebKitGTK 2.44.x / 2.46.x with Wayland), this manifests as a white screen on
first launch — the GPU compositing path in those WebKit versions has a
documented regression that blanks out the surface.

---

## Strategies considered

### A. Custom `AppRun` template via `tauri.conf.json` config key

Status: **does not exist in Tauri 2 stable as of 2026-05.**
Tauri's `bundle.linux.appimage` accepts `bundleMediaFramework: bool` and
`files: HashMap<PathBuf, PathBuf>` but **not** an `appRun` / `template` key.
Tracking issue: `tauri-apps/tauri#7616` is still open.

### B. Replace the staged AppDir from `beforeBundleCommand` (REJECTED)

`beforeBundleCommand` runs before `tauri-bundler` creates the AppDir. The old
implementation globbed for that future directory, found nothing, exited zero,
and v0.4.2 shipped Tauri's stock launcher. This timing cannot be made reliable.

### C. Seed Tauri's local AppImage tool cache (CHOSEN)

With `bundle.useLocalToolsDir`, Tauri reads its launcher from
`target/.tauri/AppRun-<arch>` and copies it into the newly created AppDir. The
hook installs our launcher at that existing extension point before the bundler
runs. `bundle.linux.appimage.files` carries the generated WebKitGTK version
marker into `usr/lib`, where the launcher reads it.

### D. Post-bundle re-pack with `appimagetool`

Status: **rejected.** This would require unpacking the AppImage's squashfs
after Tauri produces it, replacing AppRun, re-running `appimagetool --no-appstream`,
re-signing. Doable but doubles bundle time and adds appimagetool as an explicit
release-pipeline dep. Strategy B avoids both.

---

## Chosen strategy

**Strategy C — project-local Tauri tool cache + custom AppRun template.**

### Files

| Path | Purpose |
|---|---|
| `frontend/src-tauri/appimage/AppRun` | The custom launcher shell script (source of truth, version-controlled) |
| `frontend/src-tauri/appimage/AppRun.test.sh` | Shell unit test (W-1) — 4 cases for the WebKit version conditional |
| `scripts/inject-apprun.sh` | Seed `target/.tauri/AppRun-<arch>` and generate the bundled WebKitGTK marker |
| `scripts/inject-apprun.test.sh` | Regression test for cache seeding, executable mode and version stamping |
| `frontend/src-tauri/tauri.conf.json` | Enable the local tool cache and package its generated marker |
| `.github/workflows/release.yml` | Extract the final artifact and reject a stock launcher or missing marker |

### Wire-up

```jsonc
// frontend/src-tauri/tauri.conf.json
{
  "build": {
    "beforeBundleCommand": "bash ../scripts/inject-apprun.sh"
    // ... existing keys
  }
}
```

The hook is a no-op on non-Linux hosts. On Linux, an unknown architecture or
missing WebKitGTK version is a build failure rather than a silently broken
artifact.

### Why `WEBKIT_DISABLE_COMPOSITING_MODE` is conditional, not unconditional

Per Pitfall #3 in RESEARCH.md: setting this env var on healthy WebKit versions
(2.48+) re-introduces the very compositing bug it was meant to work around on
Apple Silicon Linux ports. We detect the WebKit version via `pkg-config`
(both `webkit2gtk-4.1` and `webkit2gtk-4.0` are queried) and only set the
env var on the known-broken `2.44.x` and `2.46.x` ranges, plus the `pkg-config
absent / unknown version` fallback (fail-safe to the workaround).

---

## Future maintenance

When Tauri 2 ships a first-class `appRun` template key (see open
`tauri-apps/tauri#7616`), the migration is:

1. Move `frontend/src-tauri/appimage/AppRun` content into the new config key
2. Delete `scripts/inject-apprun.sh` and its cache-seeding test
3. Remove the `beforeBundleCommand` line that invokes it
4. Keep `AppRun.test.sh` as-is — it still validates the conditional logic

Until then, the strategy here is the documented path.

---

## Sources

- [Tauri 2 — `beforeBundleCommand` hook](https://v2.tauri.app/reference/config/#beforebundlecommand) — HIGH
- [Tauri issue #7616 — custom AppRun template support](https://github.com/tauri-apps/tauri/issues/7616) — HIGH (status: open)
- [WebKitGTK 2.44 bug tracker — Wayland white-screen on Fedora](https://bugs.webkit.org/show_bug.cgi?id=262007) — HIGH
- [AppImage AppRun reference](https://docs.appimage.org/reference/appdir.html#apprun) — HIGH
