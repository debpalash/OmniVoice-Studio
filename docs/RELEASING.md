# Releasing — self-updating builds for mac / linux / windows

This doc covers the release workflow after the auto-updater wiring landed. Read top-to-bottom the first time. After that, cutting a release is the three commands in §5.

## 1. One-time repo setup

The signing key was generated locally at `~/.tauri/omnivoice-updater.key` (private) and `~/.tauri/omnivoice-updater.key.pub` (public). The public key is already embedded in `frontend/src-tauri/tauri.conf.json` — that's what shipping clients use to verify updates.

The private key needs to live in **GitHub Actions Secrets** so CI can sign each release:

1. Read the private key contents:
   ```
   cat ~/.tauri/omnivoice-updater.key
   ```
2. GitHub → Settings → Secrets and variables → Actions → **New repository secret** (on `debpalash/OmniVoice-Studio`, which is where the updater endpoint points):
   - Name: `TAURI_SIGNING_PRIVATE_KEY`
   - Value: paste the full contents (including the `untrusted comment:` header line)
3. Add a second secret:
   - Name: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   - Value: leave blank (the key was generated without a password)

**Back the key up.** Copy `~/.tauri/omnivoice-updater.key` to a password manager or encrypted vault. If you lose it, you can never ship an update for any client that has the current public key — they'll be stranded and need a manual reinstall.

## 2. One-time account setup (you)

**Rotate the leaked GH token** (the `ghp_...` in `origin` remote). See the session transcript — already flagged. Do this before anything else.

No Apple Developer / Windows signing certs needed for v1. Apps ship unsigned; first-launch shows "unverified developer" warnings that users bypass with right-click → Open (mac) or "Run anyway" (Windows SmartScreen). Self-update still works — Tauri's updater verifies via its own signing key, independent of OS code signing.

## 3. What the updater does

On every app launch, the webview:
1. Fetches `https://github.com/debpalash/OmniVoice-Studio/releases/latest/download/latest.json`
2. Compares the version in `latest.json` to the running app's version (from `tauri.conf.json`)
3. If newer, shows a native dialog: *"A new version (x.y.z) is available. Download and install now?"*
4. If user accepts, downloads the signed update bundle, verifies the minisign signature against the embedded pubkey, replaces the app in place, relaunches.

Failures (no network, 404, signature mismatch) are silent — the app continues to launch normally. Check the frontend devtools console for `Updater check failed` messages if you're debugging.

## 4. Version bumps

Two files must agree before you tag a release:

- `frontend/src-tauri/tauri.conf.json` → `"version": "0.2.0"`
- `frontend/src-tauri/Cargo.toml` → `version = "0.2.0"`

(Not `frontend/package.json` — Tauri ignores it.)

Keep bumps monotonic. Tauri updater uses semver comparison, so `v0.2.0` does not update clients already on `v0.2.1`.

## 5. Cutting a release

```bash
# 1. Bump versions in the two files above, commit.
git add frontend/src-tauri/tauri.conf.json frontend/src-tauri/Cargo.toml
git commit -m "release: v0.2.0"

# 2. Tag and push.
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

The `Desktop Release` workflow fires on tag push. It builds four targets in parallel on GitHub Actions runners:

| Target | Runner | Artifact |
|---|---|---|
| macOS Apple Silicon | macos-14 | `.dmg` + updater `.app.tar.gz` |
| macOS Intel | macos-13 | `.dmg` + updater `.app.tar.gz` |
| Windows x64 | windows-2022 | `.msi` + `.exe` + updater `.nsis.zip` |
| Linux x64 | ubuntu-22.04 | `.AppImage` + `.deb` + updater `.AppImage.tar.gz` |

Each runner signs the updater payload with the stored `TAURI_SIGNING_PRIVATE_KEY`, merges into a single `latest.json`, and attaches everything to the draft release.

Workflow runtime: **~20-40 minutes** (PyInstaller + four platform builds). Follow progress at:
`https://github.com/debpalash/OmniVoice-Studio/actions`

When it finishes, the draft release needs manual publishing — GitHub → Releases → **Edit** the draft → **Publish release**. Once published, existing clients detect the update on their next launch.

## 6. Expect-to-fail-first-time on Windows and Linux

mac-ARM is tested locally. The other three platforms will likely hit PyInstaller issues on their first CI run because neither dependency set nor platform quirks have been exercised. Common failures to expect:

- **Windows**: `mlx_whisper` is mac-only — need to conditional-guard the import in `backend.spec`. `demucs`'s CUDA autodetect may pull wheels we don't want. Long-path limits during the PyInstaller bundle.
- **Linux**: `libasound` / `libwebkit2gtk` dev headers vs runtime confusion. AppImage FUSE assumptions on the runner.
- **mac-Intel**: should work, but torch wheels for x86_64 differ — watch for `nvidia-*` wheels sneaking in via the default torch.

When a target fails, either fix the root cause in the spec / workflow, or comment that matrix row out temporarily and keep the working targets shipping. The `fail-fast: false` setting means one failure doesn't kill the others.

## 7. Testing the updater locally (before shipping a tag)

Two options:

**Option A — dry run the manifest:**
After a release is published, hit the updater URL manually:
```
curl -L https://github.com/debpalash/OmniVoice-Studio/releases/latest/download/latest.json | jq
```
You should see platform-keyed download URLs + minisign signatures. If that JSON looks right, clients will pick it up.

**Option B — full end-to-end:**
1. Install v0.1.0 on a fresh machine (or clean-installed Applications).
2. Cut v0.2.0 (bump, tag, push, wait for CI, publish draft).
3. Launch the installed v0.1.0. Within seconds, the dialog should appear.
4. Accept → app downloads, verifies, replaces, relaunches as v0.2.0.

If step 3 silently does nothing, DevTools console in the app webview has the `Updater check failed:` log.

## 8. Rolling back

There's no "revert update" flow for clients — they'll only see a *newer* version. To roll back:
1. Delete the broken release from GitHub Releases (or mark it as pre-release).
2. Re-tag the previous good commit with a higher version (e.g., if you shipped bad `v0.2.0`, tag `v0.2.1` on the old `v0.1.0` commit).
3. Clients auto-update to the "new" v0.2.1 which is actually the old code.

Ugly but it works. Better plan: test with Option B above before publishing the draft.
