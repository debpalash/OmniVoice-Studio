## Summary

<!-- Brief description of what this PR does. -->

## Changes

<!-- List the key changes made in this PR. -->

-

## Type

<!-- Check the one that applies. -->

- [ ] 🐛 Bug fix
- [ ] ✨ New feature
- [ ] ♻️ Refactor
- [ ] 📝 Documentation
- [ ] 🧪 Tests
- [ ] 🔧 CI / Build
- [ ] 🚀 Release prep

## Testing

<!-- How did you test these changes? -->

-

## Checklist

- [ ] I've tested this locally
- [ ] I've updated relevant documentation (if applicable)
- [ ] No local machine paths, logs, or personal env details in this PR
- [ ] Version files are in sync (if version bump): `pyproject.toml`, `package.json`, `tauri.conf.json`, `Cargo.toml`
- [ ] If this PR changes runtime behavior, the regression fixture at `tests/fixtures/omnivoice_data/` still loads green on the `smoke-matrix` CI job (macOS + Windows + Linux)

## Release cadence

OmniVoice ships **continuous-to-main** — no release candidates, no soak windows.
Every merged PR is immediately part of the rolling preview (`main`, Docker
`:latest`, the desktop Preview channel). Versioned releases are tagged from
`main` when it's ready; `main` then bumps to the next patch automatically.
Users who want stability pin a release tag / Docker `:stable` / the desktop
Stable channel.
