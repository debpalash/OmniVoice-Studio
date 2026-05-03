# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.2.x   | ✅ Current release |
| < 0.2   | ❌ No longer supported |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report them privately via one of these channels:

1. **GitHub Security Advisories** (preferred) — [Report a vulnerability](https://github.com/debpalash/OmniVoice-Studio/security/advisories/new)
2. **Email** — Send details to **security@palash.dev**

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

### Response timeline

| Step | Timeline |
|------|----------|
| Acknowledgment | Within **48 hours** |
| Initial assessment | Within **5 business days** |
| Fix or mitigation | Within **30 days** (critical), **90 days** (non-critical) |
| Public disclosure | After fix is released, coordinated with reporter |

### Scope

OmniVoice Studio runs **100% locally** by default. The primary attack surface is:

- **Network exposure** — if the user binds to `0.0.0.0` without a reverse proxy
- **Model downloads** — fetched from Hugging Face Hub over HTTPS
- **Dependency supply chain** — Python/npm packages
- **File handling** — audio/video uploads processed by FFmpeg, torchaudio, etc.

### Out of scope

- Vulnerabilities in upstream dependencies (PyTorch, FFmpeg, etc.) — report those upstream
- Issues requiring physical access to the machine
- Social engineering attacks

## Security Best Practices for Users

- **Do not expose OmniVoice to the internet without authentication.** The API has no built-in auth. Use a reverse proxy (Caddy, nginx, Tailscale) if you need remote access.
- **Keep your installation updated.** The desktop app auto-checks for updates via the built-in updater.
- **Review model sources.** Only download models from trusted Hugging Face repositories.
