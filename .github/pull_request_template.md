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
- [ ] 🚀 Release prep (RC or final)

## Testing

<!-- How did you test these changes? -->

-

## Checklist

- [ ] I've tested this locally
- [ ] I've updated relevant documentation (if applicable)
- [ ] No local machine paths, logs, or personal env details in this PR
- [ ] Version files are in sync (if version bump): `pyproject.toml`, `package.json`, `tauri.conf.json`, `Cargo.toml`
- [ ] If this PR changes runtime behavior, the regression fixture at `tests/fixtures/omnivoice_data/` still loads green on the `smoke-matrix` CI job (macOS + Windows + Linux)
- [ ] If this is part of a release, I've read the "Release cadence" section below and confirmed this PR targets the right RC

## Release cadence (read once per RC)

OmniVoice ships every minor on a **two-RC cadence**:
- `vX.Y.0-rc1` — cut from `main` once all GATE-* requirements pass; clean-VM exercise on 4 OSes (per `REL-01`)
- 48-hour soak (no new commits to release branch except fix-forward)
- `vX.Y.0` — promotion if rc1 is clean

If your PR touches install / bootstrap / CI, it MUST land before rc1 cut, not between rc1 and the promotion. During a soak, any merge needs explicit OK from the release captain.

## Screenshots

<!-- If applicable, add screenshots or recordings. -->
