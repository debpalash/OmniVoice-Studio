/**
 * Settings → System → LLM Providers (v0.3.8).
 *
 * One place to configure the high-quality LLM that powers Cinematic and
 * Autofit translation (fitting each line to its segment's time budget). Every
 * provider is OpenAI-compatible, so the same client drives all of them — pick
 * one, paste its key, mark it active. Keys are stored ENCRYPTED on the backend
 * and never returned to the UI.
 *
 * Endpoints (loopback-only):
 *   GET  /api/settings/llm-providers
 *     → {active, providers:[{id,display_name,local,needs_account,signup_url,
 *         notes,base_url,model,has_key,key_from_env,configured}]}
 *   PUT  /api/settings/llm-providers/{id}  {api_key?,base_url?,model?,account_id?,make_active?}
 *   POST /api/settings/llm-providers/active {provider}
 *   POST /api/settings/llm-providers/{id}/test → {ok, model?, reply?, detail?}
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, ExternalLink } from 'lucide-react';
import { apiJson, apiFetch, apiPost } from '../../api/client';
import { SettingsSection, SettingRow, SettingsInput } from './primitives';
import { Button, Badge, Select } from '../../ui';

export default function LLMProvidersPanel() {
  const [providers, setProviders] = useState([]);
  const [active, setActive] = useState(null);
  const [editing, setEditing] = useState('');
  const [fields, setFields] = useState({ base_url: '', model: '', api_key: '', account_id: '' });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const [error, setError] = useState(null);

  const current = useMemo(
    () => providers.find((p) => p.id === editing) || null,
    [providers, editing],
  );

  const populate = useCallback((list, id) => {
    const p = list.find((x) => x.id === id);
    if (!p) return;
    // base_url/model prefill with the resolved value so the user edits from a
    // sane default; api_key is never echoed (only the has_key flag comes back).
    setFields({ base_url: p.base_url || '', model: p.model || '', api_key: '', account_id: '' });
    setTest(null);
  }, []);

  const refresh = useCallback(
    async (keepEditing) => {
      setError(null);
      try {
        const data = await apiJson('/api/settings/llm-providers');
        setProviders(data.providers || []);
        setActive(data.active || null);
        const pick =
          keepEditing ||
          data.active ||
          data.providers?.find((p) => p.configured)?.id ||
          data.providers?.[0]?.id ||
          '';
        setEditing(pick);
        populate(data.providers || [], pick);
        return data;
      } catch (e) {
        setError(e?.message || 'Failed to load providers');
      }
    },
    [populate],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onSelect = (id) => {
    setEditing(id);
    populate(providers, id);
  };

  const save = async (makeActive) => {
    if (!current) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        base_url: fields.base_url.trim(),
        model: fields.model.trim(),
        make_active: !!makeActive,
      };
      if (fields.api_key) body.api_key = fields.api_key; // only when typed
      if (current.needs_account) body.account_id = fields.account_id.trim();
      await apiFetch(`/api/settings/llm-providers/${current.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await refresh(current.id);
    } catch (e) {
      setError(e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (!current) return;
    setTesting(true);
    setTest(null);
    setError(null);
    try {
      // Save first so the probe sees the just-typed key/URL.
      await save(false);
      const res = await apiPost(`/api/settings/llm-providers/${current.id}/test`);
      setTest(res);
    } catch (e) {
      setTest({ ok: false, detail: e?.message || 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  if (!providers.length) {
    return (
      <SettingsSection
        icon={Brain}
        title="LLM Providers"
        description="Configure a high-quality LLM for Cinematic & Autofit translation."
      >
        {error && (
          <div className="perfpanel__error" role="alert">
            {error}
          </div>
        )}
      </SettingsSection>
    );
  }

  const isActive = current && active === current.id;

  return (
    <SettingsSection
      icon={Brain}
      title="LLM Providers"
      description="Powers Cinematic & Autofit translation — the LLM rewrites each line to fit its segment's time budget so the video timing holds. Keys are stored encrypted; local providers (Ollama/LM Studio) stay fully offline."
    >
      <SettingRow
        title="Provider"
        hint="Pick a provider to configure. The active one is used for Cinematic/Autofit translation. Local providers need no key but require their server to be running."
        control={
          <Select
            value={editing}
            onChange={(e) => onSelect(e.target.value)}
            data-testid="llm-provider-select"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name}
                {p.local ? ' · local' : ''}
                {p.configured ? ' ✓' : ''}
                {active === p.id ? ' (active)' : ''}
              </option>
            ))}
          </Select>
        }
      />

      {current && (
        <>
          {(current.notes || current.signup_url) && (
            <SettingRow
              title="About"
              control={
                <div className="flex flex-col gap-[4px] min-w-0">
                  {current.notes && <span className="text-[12px] opacity-70">{current.notes}</span>}
                  {current.signup_url && (
                    <a
                      href={current.signup_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[12px] inline-flex items-center gap-[4px] opacity-80 hover:opacity-100"
                    >
                      Get an API key <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              }
            />
          )}

          {current.needs_account && (
            <SettingRow
              title="Account ID"
              control={
                <SettingsInput
                  mono
                  type="text"
                  value={fields.account_id}
                  onChange={(e) => setFields((f) => ({ ...f, account_id: e.target.value }))}
                  placeholder="Cloudflare account id"
                  data-testid="llm-account-id"
                />
              }
            />
          )}

          {!current.local && (
            <SettingRow
              title="API key"
              control={
                <SettingsInput
                  mono
                  type="password"
                  value={fields.api_key}
                  onChange={(e) => setFields((f) => ({ ...f, api_key: e.target.value }))}
                  placeholder={
                    current.key_from_env
                      ? 'set via environment (.env) — overrides this field'
                      : current.has_key
                        ? 'stored — type to replace'
                        : 'paste your API key'
                  }
                  disabled={current.key_from_env}
                  data-testid="llm-provider-key"
                />
              }
            />
          )}

          <SettingRow
            title="Base URL"
            control={
              <SettingsInput
                mono
                type="text"
                value={fields.base_url}
                onChange={(e) => setFields((f) => ({ ...f, base_url: e.target.value }))}
                placeholder="https://api.provider.com/v1"
                data-testid="llm-provider-base-url"
              />
            }
          />
          <SettingRow
            title="Model"
            control={
              <SettingsInput
                mono
                type="text"
                value={fields.model}
                onChange={(e) => setFields((f) => ({ ...f, model: e.target.value }))}
                placeholder="model name"
                data-testid="llm-provider-model"
              />
            }
          />

          {error && (
            <div className="perfpanel__error" role="alert">
              {error}
            </div>
          )}

          <SettingRow
            title="Status"
            control={
              <div className="flex flex-wrap items-center gap-[8px]">
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => save(false)}
                  loading={saving}
                  disabled={saving || testing}
                  data-testid="llm-provider-save"
                >
                  Save
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => save(true)}
                  loading={saving}
                  disabled={saving || testing}
                  data-testid="llm-provider-activate"
                >
                  {isActive ? 'Save & keep active' : 'Save & use for translation'}
                </Button>
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={runTest}
                  loading={testing}
                  disabled={saving || testing}
                  data-testid="llm-provider-test"
                >
                  Test
                </Button>
                {isActive && (
                  <Badge tone="success" dot role="status">
                    active
                  </Badge>
                )}
                {test && (
                  <Badge tone={test.ok ? 'success' : 'warn'} role="status">
                    {test.ok ? `ok — ${test.model || ''}` : test.detail || 'failed'}
                  </Badge>
                )}
              </div>
            }
          />
        </>
      )}
    </SettingsSection>
  );
}
