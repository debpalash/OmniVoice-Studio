/**
 * Settings → Sharing → Remote backend panel (parity program Wave 2.3).
 *
 * Point this app at an OmniVoice backend running elsewhere (a GPU box over
 * Tailscale, a Docker deployment). Stores the URL + API key in localStorage
 * — they are CLIENT-side settings — and reloads the app so api/client.ts
 * re-resolves the base. "Test" hits {url}/health (with the key) and shows
 * the remote's version + device.
 *
 * Pairs with the backend's OMNIVOICE_API_KEY bearer gate; full recipe in
 * docs/remote-gpu.md.
 */
import React, { useState } from 'react';
import { Server } from 'lucide-react';
import { LS_BACKEND_URL, LS_API_KEY, API } from '../../api/client';
import { SettingsSection, SettingRow, InfoHint, SettingsInput } from './primitives';
import { Button, Badge } from '../../ui';
import RestartBadge from './RestartBadge';

const REMOTE_GPU_DOCS_URL =
  'https://github.com/debpalash/OmniVoice-Studio/blob/main/docs/remote-gpu.md';

export default function RemoteBackendPanel() {
  const [url, setUrl] = useState(() => localStorage.getItem(LS_BACKEND_URL) || '');
  const [key, setKey] = useState(() => localStorage.getItem(LS_API_KEY) || '');
  const [probe, setProbe] = useState(null); // {ok, detail}
  const [testing, setTesting] = useState(false);

  const normalized = url.trim().replace(/\/+$/, '');

  const onTest = async () => {
    setTesting(true);
    setProbe(null);
    try {
      const target = normalized || API;
      const res = await fetch(`${target}/health`, {
        headers: key.trim() ? { Authorization: `Bearer ${key.trim()}` } : {},
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`);
      setProbe({ ok: true, detail: `${body.version || '?'} on ${body.device || '?'}` });
    } catch (e) {
      setProbe({ ok: false, detail: e?.message || 'unreachable' });
    } finally {
      setTesting(false);
    }
  };

  const onSave = () => {
    if (normalized) localStorage.setItem(LS_BACKEND_URL, normalized);
    else localStorage.removeItem(LS_BACKEND_URL);
    if (key.trim()) localStorage.setItem(LS_API_KEY, key.trim());
    else localStorage.removeItem(LS_API_KEY);
    // api/client.ts resolves the base once at module load.
    window.location.reload();
  };

  return (
    <SettingsSection
      icon={Server}
      title="Remote backend"
      description="Run inference on another machine; leave the URL empty for the local backend."
      actions={
        <>
          <RestartBadge />
          <InfoHint learnMoreHref={REMOTE_GPU_DOCS_URL}>
            Start the backend on the other machine with <code>OMNIVOICE_API_KEY</code> set, reach it
            over your tailnet, and point this app at it.
          </InfoHint>
        </>
      }
    >
      <SettingRow
        stack
        title="Backend URL"
        control={
          <SettingsInput
            mono
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://gpu-box.tailnet.ts.net:3900"
            data-testid="remote-backend-url"
          />
        }
      />
      <SettingRow
        stack
        title="API key"
        control={
          <SettingsInput
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="value of OMNIVOICE_API_KEY on the server"
            data-testid="remote-backend-key"
          />
        }
      />

      <div className="flex flex-wrap items-center gap-[var(--space-3)] min-w-0 max-w-full">
        <Button
          variant="subtle"
          size="sm"
          onClick={onTest}
          loading={testing}
          disabled={testing}
          data-testid="remote-backend-test"
        >
          Test connection
        </Button>
        <Button variant="subtle" size="sm" onClick={onSave} data-testid="remote-backend-save">
          Save &amp; reload
        </Button>
        {probe && (
          <Badge tone={probe.ok ? 'success' : 'danger'} dot role="status">
            {probe.ok ? `OK — ${probe.detail}` : `Failed — ${probe.detail}`}
          </Badge>
        )}
      </div>
    </SettingsSection>
  );
}
