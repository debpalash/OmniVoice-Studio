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
import { SettingsSection, SettingRow, InfoHint } from './primitives';
import './PerformancePanel.css';

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
        <InfoHint learnMoreHref={REMOTE_GPU_DOCS_URL}>
          Start the backend on the other machine with <code>OMNIVOICE_API_KEY</code> set, reach it
          over your tailnet, and point this app at it.
        </InfoHint>
      }
    >
      <SettingRow
        className="st-row--stack"
        title="Backend URL"
        control={
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://gpu-box.tailnet.ts.net:3900"
            className="st-input st-input--mono"
            data-testid="remote-backend-url"
          />
        }
      />
      <SettingRow
        className="st-row--stack"
        title="API key"
        control={
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="value of OMNIVOICE_API_KEY on the server"
            className="st-input"
            data-testid="remote-backend-key"
          />
        }
      />

      <div className="perfpanel__row">
        <button type="button" onClick={onTest} disabled={testing} data-testid="remote-backend-test">
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" onClick={onSave} data-testid="remote-backend-save">
          Save &amp; reload
        </button>
        {probe && (
          <span className="perfpanel__badge" role="status">
            {probe.ok ? `OK — ${probe.detail}` : `Failed — ${probe.detail}`}
          </span>
        )}
      </div>
    </SettingsSection>
  );
}
