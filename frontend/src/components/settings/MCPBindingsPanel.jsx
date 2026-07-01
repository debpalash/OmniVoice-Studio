/**
 * Settings → Sharing → MCP voice bindings panel (parity program Wave 2.2).
 *
 * Bind an MCP client id (the X-OmniVoice-Client-Id an agent sends) to a voice
 * profile, so "Claude Code speaks in Morgan, Cursor in Scarlett". The MCP
 * server is mounted at /mcp on the backend; see docs/mcp.md.
 *
 * Endpoints (loopback-only):
 *   GET    /api/mcp/bindings
 *   PUT    /api/mcp/bindings   {client_id, label?, profile_id?, default_engine?}
 *   DELETE /api/mcp/bindings/{client_id}
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Bot, Trash2 } from 'lucide-react';
import { apiJson, apiFetch } from '../../api/client';
import { listProfiles } from '../../api/profiles';
import { SettingsSection, SettingRow, SettingsInput } from './primitives';
import { Button, Badge, Select } from '../../ui';

export default function MCPBindingsPanel() {
  const [bindings, setBindings] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [clientId, setClientId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [b, p] = await Promise.all([apiJson('/api/mcp/bindings'), listProfiles()]);
      setBindings(b);
      setProfiles(p);
    } catch (e) {
      setError(e?.message || 'Failed to load MCP bindings');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const profileName = (id) => profiles.find((p) => p.id === id)?.name || id || '—';

  const onAdd = async () => {
    if (!clientId.trim()) return;
    setError(null);
    try {
      await apiFetch('/api/mcp/bindings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId.trim(), profile_id: profileId || null }),
      });
      setClientId('');
      setProfileId('');
      refresh();
    } catch (e) {
      setError(e?.message || 'Failed to save binding');
    }
  };

  const onDelete = async (cid) => {
    try {
      await apiFetch(`/api/mcp/bindings/${encodeURIComponent(cid)}`, { method: 'DELETE' });
      refresh();
    } catch (e) {
      setError(e?.message || 'Failed to delete binding');
    }
  };

  return (
    <SettingsSection
      icon={Bot}
      title="MCP voice bindings"
      description="Bind an agent's client id to a voice profile."
    >
      {error && (
        <div className="perfpanel__error" role="alert">
          {error}
        </div>
      )}

      {bindings.map((b) => (
        <SettingRow
          key={b.client_id}
          title={b.label || b.client_id}
          hint={
            <>
              Agents reach OmniVoice at <code>/mcp</code>. Bind an agent's client id to a voice so
              it speaks in that profile. See <code>docs/mcp.md</code>.
            </>
          }
          control={
            <>
              <Badge tone="neutral">{profileName(b.profile_id)}</Badge>
              <Button
                variant="danger"
                size="sm"
                onClick={() => onDelete(b.client_id)}
                aria-label={`Remove ${b.client_id}`}
                data-testid={`mcp-del-${b.client_id}`}
              >
                <Trash2 size={12} />
              </Button>
            </>
          }
        />
      ))}

      <SettingRow
        title="Add binding"
        control={
          <>
            <SettingsInput
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="client id (e.g. claude-code)"
              data-testid="mcp-client-id"
            />
            <Select
              size="sm"
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              data-testid="mcp-profile"
            >
              <option value="">default voice</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Button variant="subtle" size="sm" onClick={onAdd} data-testid="mcp-add">
              Bind
            </Button>
          </>
        }
      />
    </SettingsSection>
  );
}
