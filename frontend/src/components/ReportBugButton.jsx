/**
 * ReportBugButton — opt-in bug reporter via prefilled GitHub Issues URL.
 *
 * Capability 2 from CLAUDE.md. The user clicks → we build a URL like:
 *   https://github.com/{owner}/{repo}/issues/new?title=…&body=…&labels=bug
 * and open it in their browser. They review what we captured and click
 * Submit on github.com if they're happy. We never hold an auth token,
 * never POST to GitHub directly, and never bypass the user's review —
 * opt-in by construction, no separate consent dialog needed.
 *
 * What gets captured (no secrets):
 *   - OS + arch
 *   - OmniVoice version (Vite injects __APP_VERSION__ at build time)
 *   - Browser/webview UA
 *   - Active TTS engine (best-effort fetch)
 *   - Optional user-typed description
 *
 * What gets stripped:
 *   - $HOME path → ~/
 *   - Anything matching /TOKEN|KEY|SECRET/i in env vars
 *   - Audio file contents (we don't include them)
 */
import { useState } from 'react';
import { Bug } from 'lucide-react';
import { Button } from '../ui';
import { openExternal } from '../api/external';
import { API } from '../api/client';

const APP_VERSION = (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) || 'unknown';

const ISSUES_URL = 'https://github.com/debpalash/OmniVoice-Studio/issues/new';

function stripHome(s) {
  if (!s) return s;
  // Best-effort home redaction — works for the most common /Users/<name>/
  // and /home/<name>/ paths. We don't know the actual $HOME from JS, so
  // pattern-match the prefix.
  return String(s)
    .replace(/\/Users\/[^/]+/g, '~')
    .replace(/\/home\/[^/]+/g, '~')
    .replace(/[A-Z]:\\Users\\[^\\]+/g, '~');
}

async function captureContext() {
  const lines = [
    `**Version:** \`${APP_VERSION}\``,
    `**Platform:** \`${navigator?.userAgent || 'unknown'}\``,
  ];

  // Best-effort backend system info — silently skip if backend is down.
  try {
    const r = await fetch(`${API}/system/info`);
    if (r.ok) {
      const j = await r.json();
      // /system/info exposes `platform` (sys.platform) + `device` (best
      // compute device). Map to those — older field names (os/torch_device/
      // gpu) never existed on this endpoint, so they silently dropped.
      if (j?.platform) lines.push(`**OS:** \`${j.platform}\``);
      if (j?.python) lines.push(`**Python:** \`${j.python}\``);
      if (j?.device) lines.push(`**Compute device:** \`${stripHome(j.device)}\``);
    }
  } catch { /* backend probably not up yet */ }

  try {
    const r = await fetch(`${API}/engines`);
    if (r.ok) {
      const j = await r.json();
      const active = j?.tts?.active;
      if (active) lines.push(`**Active TTS engine:** \`${active}\``);
    }
  } catch { /* noop */ }

  return lines.join('\n');
}

export default function ReportBugButton({ size = 'sm', variant = 'subtle', label = 'Report a bug' }) {
  const [building, setBuilding] = useState(false);

  const handleClick = async () => {
    setBuilding(true);
    try {
      const ctx = await captureContext();
      const body = [
        '<!-- Click Submit at the bottom of this page to file the issue.',
        '     Review the auto-captured environment info below and add anything',
        '     about what you were doing when the bug happened. -->',
        '',
        '## Describe the bug',
        '',
        '<!-- e.g. "Synthesize failed in Design mode after picking Narrator personality" -->',
        '',
        '## Environment',
        '',
        ctx,
        '',
        '## What I was doing',
        '',
        '<!-- step-by-step would help us reproduce -->',
        '',
      ].join('\n');
      const url = `${ISSUES_URL}?title=${encodeURIComponent('[Bug] ')}&labels=${encodeURIComponent('bug')}&body=${encodeURIComponent(body)}`;
      await openExternal(url);
    } finally {
      setBuilding(false);
    }
  };

  return (
    <Button
      size={size}
      variant={variant}
      onClick={handleClick}
      loading={building}
      leading={!building && <Bug size={12} />}
      title="Opens a prefilled GitHub Issues page in your browser. Nothing is sent until you click Submit."
    >
      {label}
    </Button>
  );
}
