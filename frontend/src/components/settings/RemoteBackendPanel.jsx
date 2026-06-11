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
import './PerformancePanel.css';

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
    <section className="perfpanel" aria-labelledby="remotebackend-heading">
      <h3 id="remotebackend-heading" className="perfpanel__title">
        <Server size={14} /> Remote backend
      </h3>
      <p className="perfpanel__help">
        Run inference on another machine: start the backend there with{' '}
        <code>OMNIVOICE_API_KEY</code> set, reach it over your tailnet, and
        point this app at it. Leave the URL empty to use the local backend.
        See <code>docs/remote-gpu.md</code> for the full recipe.
      </p>

      <label className="perfpanel__row">
        <span className="perfpanel__label">Backend URL</span>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://gpu-box.tailnet.ts.net:3900"
          style={{ flex: 1 }}
          data-testid="remote-backend-url"
        />
      </label>
      <label className="perfpanel__row">
        <span className="perfpanel__label">API key</span>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="value of OMNIVOICE_API_KEY on the server"
          style={{ flex: 1 }}
          data-testid="remote-backend-key"
        />
      </label>

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
    </section>
  );
}
