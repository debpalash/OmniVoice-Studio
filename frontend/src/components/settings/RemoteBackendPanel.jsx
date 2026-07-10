/**
 * Settings → Sharing → Remote backend panel (parity program Wave 2.3).
 *
 * Point this app at an OmniVoice backend running elsewhere (a GPU box over
 * Tailscale, a Docker deployment). Stores the URL + API key in localStorage
 * — they are CLIENT-side settings — and reloads the app so api/client.ts
 * re-resolves the base. "Test" hits {url}/health (with the key) and shows
 * the remote's version + device.
 *
 * Saving is guarded: the URL must be a parseable http(s):// URL (a typo'd
 * base would brick every API call after the reload), and saving a URL that
 * hasn't passed a connection test asks for confirmation first.
 *
 * Pairs with the backend's OMNIVOICE_API_KEY bearer gate; full recipe in
 * docs/remote-gpu.md.
 */
import React, { useState } from 'react';
import { Server } from 'lucide-react';
import toast from 'react-hot-toast';
import { Trans, useTranslation } from 'react-i18next';
import { LS_BACKEND_URL, LS_API_KEY, API } from '../../api/client';
import { askConfirm } from '../../utils/dialog';
import { SettingsSection, SettingRow, InfoHint, SettingsInput } from './primitives';
import { Button, Badge } from '../../ui';

const REMOTE_GPU_DOCS_URL =
  'https://github.com/debpalash/OmniVoice-Studio/blob/main/docs/remote-gpu.md';

/** A saved backend base must be a parseable absolute http(s) URL. */
export function isValidBackendUrl(value) {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function RemoteBackendPanel({ reload = () => window.location.reload() }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(() => localStorage.getItem(LS_BACKEND_URL) || '');
  const [key, setKey] = useState(() => localStorage.getItem(LS_API_KEY) || '');
  const [probe, setProbe] = useState(null); // {ok, detail, target}
  const [testing, setTesting] = useState(false);

  const normalized = url.trim().replace(/\/+$/, '');

  const onTest = async () => {
    setTesting(true);
    setProbe(null);
    const target = normalized || API;
    try {
      const res = await fetch(`${target}/health`, {
        headers: key.trim() ? { Authorization: `Bearer ${key.trim()}` } : {},
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.detail || `HTTP ${res.status}`);
      setProbe({
        ok: true,
        detail: `${body.version || '?'} on ${body.device || '?'}`,
        target,
      });
    } catch (e) {
      setProbe({
        ok: false,
        detail:
          e?.message || t('settings.remote_backend_unreachable', { defaultValue: 'unreachable' }),
        target,
      });
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    if (normalized) {
      if (!isValidBackendUrl(normalized)) {
        toast.error(
          t('settings.remote_backend_invalid_url', {
            defaultValue:
              'Enter a valid URL starting with http:// or https:// (e.g. http://gpu-box:3900).',
          }),
        );
        return;
      }
      // A wrong base bricks every API call after the reload — if this exact
      // URL hasn't passed a connection test, make the user confirm.
      const verified = probe?.ok && probe.target === normalized;
      if (!verified) {
        const go = await askConfirm(
          t('settings.remote_backend_confirm_unverified', {
            defaultValue:
              "This backend URL hasn't passed a connection test. Save it and reload anyway? " +
              "If it's wrong, the app can't reach any backend until you change it back here.",
          }),
          t('settings.remote_backend_confirm_title', { defaultValue: 'Use unverified backend?' }),
        );
        if (!go) return;
      }
      localStorage.setItem(LS_BACKEND_URL, normalized);
    } else {
      localStorage.removeItem(LS_BACKEND_URL);
    }
    if (key.trim()) localStorage.setItem(LS_API_KEY, key.trim());
    else localStorage.removeItem(LS_API_KEY);
    // api/client.ts resolves the base once at module load.
    reload();
  };

  return (
    <SettingsSection
      icon={Server}
      title={t('settings.remote_backend_title', { defaultValue: 'Remote backend' })}
      description={t('settings.remote_backend_desc', {
        defaultValue:
          'Run inference on another machine; leave the URL empty for the local backend. ' +
          'Saving reloads the app to apply.',
      })}
      actions={
        <InfoHint learnMoreHref={REMOTE_GPU_DOCS_URL}>
          <Trans
            i18nKey="settings.remote_backend_hint"
            defaults="Start the backend on the other machine with <1>OMNIVOICE_API_KEY</1> set, reach it over your tailnet, and point this app at it."
            components={{ 1: <code /> }}
          />
        </InfoHint>
      }
    >
      <SettingRow
        stack
        title={t('settings.remote_backend_url', { defaultValue: 'Backend URL' })}
        control={
          <SettingsInput
            mono
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://gpu-box.tailnet.ts.net:3900"
            aria-label={t('settings.remote_backend_url', { defaultValue: 'Backend URL' })}
            data-testid="remote-backend-url"
          />
        }
      />
      <SettingRow
        stack
        title={t('settings.remote_backend_key', { defaultValue: 'API key' })}
        control={
          <SettingsInput
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t('settings.remote_backend_key_placeholder', {
              defaultValue: 'value of OMNIVOICE_API_KEY on the server',
            })}
            aria-label={t('settings.remote_backend_key', { defaultValue: 'API key' })}
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
          {t('settings.remote_backend_test', { defaultValue: 'Test connection' })}
        </Button>
        <Button variant="subtle" size="sm" onClick={onSave} data-testid="remote-backend-save">
          {t('settings.remote_backend_save', { defaultValue: 'Save & reload' })}
        </Button>
        {probe && (
          <Badge tone={probe.ok ? 'success' : 'danger'} dot role="status">
            {probe.ok
              ? t('settings.remote_backend_probe_ok', {
                  detail: probe.detail,
                  defaultValue: 'OK — {{detail}}',
                })
              : t('settings.remote_backend_probe_fail', {
                  detail: probe.detail,
                  defaultValue: 'Failed — {{detail}}',
                })}
          </Badge>
        )}
      </div>
    </SettingsSection>
  );
}
