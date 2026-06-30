// ─────────────────────────────────────────────────────────────────
//  Visual-regression component registry.
//
//  Each entry renders a small, representative spread of a presentational
//  leaf component's variants/states. Keep these PURE — no backend hooks,
//  no i18n, no app context — so they render synchronously and snapshot
//  deterministically.
//
//  To add a component: add an entry here AND its name to ./manifest.ts
//  (the Playwright test reads the manifest). See ./README.md.
// ─────────────────────────────────────────────────────────────────

import React from 'react';
import { Download, Mic, Search, Sparkles, Trash2 } from 'lucide-react';

import Badge from '../../ui/Badge.jsx';
import Button from '../../ui/Button.jsx';
import { Field, Input, Select, Textarea } from '../../ui/Input.jsx';
import Panel from '../../ui/Panel.jsx';
import Progress from '../../ui/Progress.jsx';
import Segmented from '../../ui/Segmented.jsx';
import Slider from '../../ui/Slider.jsx';
import Table from '../../ui/Table.jsx';
import Tabs from '../../ui/Tabs.jsx';
import SettingRow from '../../components/settings/primitives/SettingRow.jsx';
import SettingsToggle from '../../components/settings/primitives/SettingsToggle.jsx';
// SettingRow / SettingsToggle styling lives in the primitives stylesheet,
// normally pulled in via the primitives barrel — import it directly here.
import '../../components/settings/primitives/primitives.css';
import './harness.css';

// ── PAGE / PANEL specs (opt-in providers) ─────────────────────────────────
// Unlike the pure leaf specs above, these render real Settings panels that
// depend on the Zustand store, react-i18next, react-query, and direct api/*
// fetches. Each declares a `providers` block (see ./providers.jsx) that seeds
// that infrastructure with representative data so the panel renders with NO
// backend. The `providers` key is what flips the harness into wrapped mode —
// leaf specs without it are byte-for-byte unaffected.
import AppearancePanel from '../../components/settings/AppearancePanel.jsx';
import GeneralTab from '../../components/settings/GeneralTab.jsx';
import StoragePanel from '../../components/settings/StoragePanel.jsx';
import { queryKeys } from '../../api/hooks.ts';

function Spec({ label, children }) {
  return (
    <div className="visual-spec">
      <span className="visual-spec__label">{label}</span>
      <div className="visual-spec__row">{children}</div>
    </div>
  );
}

const BADGE_TONES = ['neutral', 'brand', 'success', 'warn', 'danger', 'info', 'violet'];

const TAB_ITEMS = [
  { id: 'clone', label: 'Clone', icon: Mic },
  { id: 'design', label: 'Design', icon: Sparkles },
  { id: 'dub', label: 'Dub' },
];

const TABLE_COLS = [
  { key: 'name', label: 'Voice', flex: 2 },
  { key: 'lang', label: 'Lang', width: 80 },
  { key: 'dur', label: 'Length', width: 70, align: 'right' },
];

export const SPECS = {
  Badge: {
    render: () => (
      <>
        <Spec label="tones">
          {BADGE_TONES.map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
        </Spec>
        <Spec label="dot / size">
          <Badge tone="success" dot>
            online
          </Badge>
          <Badge tone="brand" size="xs">
            xs
          </Badge>
          <Badge tone="warn" size="sm">
            sm
          </Badge>
        </Spec>
      </>
    ),
  },

  Segmented: {
    render: () => (
      <>
        <Spec label="sm — middle active">
          <Segmented
            size="sm"
            value="b"
            onChange={() => {}}
            items={[
              { value: 'a', label: 'One' },
              { value: 'b', label: 'Two' },
              { value: 'c', label: 'Three' },
            ]}
          />
        </Spec>
        <Spec label="xs — first active">
          <Segmented
            size="xs"
            value="a"
            onChange={() => {}}
            items={[
              { value: 'a', label: 'Alpha' },
              { value: 'b', label: 'Beta' },
            ]}
          />
        </Spec>
      </>
    ),
  },

  Progress: {
    render: () => (
      <>
        <Spec label="tones @ 65%">
          {['brand', 'success', 'warn', 'danger'].map((tone) => (
            <div key={tone} style={{ width: '200px' }}>
              <Progress tone={tone} value={65} />
            </div>
          ))}
        </Spec>
        <Spec label="sizes @ 40%">
          {['xs', 'sm', 'md'].map((size) => (
            <div key={size} style={{ width: '200px' }}>
              <Progress size={size} value={40} />
            </div>
          ))}
        </Spec>
        <Spec label="indeterminate / no-shimmer">
          <div style={{ width: '200px' }}>
            <Progress />
          </div>
          <div style={{ width: '200px' }}>
            <Progress value={50} shimmer={false} />
          </div>
        </Spec>
      </>
    ),
  },

  Button: {
    render: () => (
      <>
        <Spec label="variants">
          <Button variant="primary">Primary</Button>
          <Button variant="subtle">Subtle</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
        </Spec>
        <Spec label="chip / preset / icon">
          <Button variant="chip">Chip</Button>
          <Button variant="chip" active>
            Active chip
          </Button>
          <Button variant="preset">Preset</Button>
          <Button variant="icon" aria-label="Delete">
            <Trash2 size={16} />
          </Button>
        </Spec>
        <Spec label="states">
          <Button variant="primary" leading={<Download size={14} />}>
            Leading
          </Button>
          <Button variant="primary" loading>
            Loading
          </Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
        </Spec>
      </>
    ),
  },

  Panel: {
    render: () => (
      <>
        <Spec label="glass + title + actions">
          <Panel
            variant="glass"
            title="Voice settings"
            actions={
              <Button variant="ghost" size="sm" leading={<Sparkles size={14} />}>
                Tune
              </Button>
            }
          >
            Body content sits on the panel surface.
          </Panel>
        </Spec>
        <Spec label="solid / flat">
          <Panel variant="solid" title="Solid">
            Solid surface body.
          </Panel>
          <Panel variant="flat" title="Flat">
            Flat surface body.
          </Panel>
        </Spec>
      </>
    ),
  },

  Input: {
    render: () => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 300 }}>
        <Spec label="sizes">
          <Input size="sm" placeholder="Small" />
          <Input size="md" placeholder="Medium" />
          <Input size="lg" placeholder="Large" />
        </Spec>
        <Spec label="states">
          <Input placeholder="Default" />
          <Input defaultValue="Disabled" disabled />
          <Input defaultValue="Invalid" aria-invalid="true" />
        </Spec>
        <Spec label="textarea / select">
          <Textarea placeholder="Textarea" rows={2} />
          <Select defaultValue="b">
            <option value="a">Option A</option>
            <option value="b">Option B</option>
          </Select>
        </Spec>
        <Spec label="field">
          <Field label="Name" hint="Your full name">
            <Input placeholder="Jane Doe" />
          </Field>
          <Field label="Email" error="Required field">
            <Input placeholder="you@example.com" />
          </Field>
          <Field label="Search" icon={<Search size={13} />}>
            <Input placeholder="Search…" />
          </Field>
        </Spec>
      </div>
    ),
  },

  SettingRow: {
    render: () => (
      <Panel variant="flat" padding="md">
        <SettingRow
          title="Auto-update models"
          subtitle="Download new engine weights in the background."
          control={<SettingsToggle checked onChange={() => {}} aria-label="Auto-update" />}
        />
        <SettingRow
          icon={Sparkles}
          title="Cinematic dubbing"
          subtitle="Use the LLM rewrite pass for natural phrasing."
          control={<SettingsToggle checked={false} onChange={() => {}} aria-label="Cinematic" />}
        />
        <SettingRow title="App version" control="0.3.8" mono />
      </Panel>
    ),
  },

  SettingsToggle: {
    render: () => (
      <>
        <Spec label="on / off">
          <SettingsToggle checked onChange={() => {}} aria-label="On" />
          <SettingsToggle checked={false} onChange={() => {}} aria-label="Off" />
        </Spec>
        <Spec label="disabled">
          <SettingsToggle checked disabled onChange={() => {}} aria-label="Disabled on" />
          <SettingsToggle checked={false} disabled onChange={() => {}} aria-label="Disabled off" />
        </Spec>
      </>
    ),
  },

  Slider: {
    render: () => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
        <Spec label="md + label">
          <Slider value={42} onChange={() => {}} label="Stability" />
        </Spec>
        <Spec label="sm">
          <Slider value={70} onChange={() => {}} size="sm" />
        </Spec>
        <Spec label="no value bubble">
          <Slider value={30} onChange={() => {}} showValue={false} />
        </Spec>
      </div>
    ),
  },

  Table: {
    render: () => (
      <div style={{ display: 'flex', width: '100%', height: 160 }}>
        <Table>
          <Table.Toolbar search="voice" onSearch={() => {}} meta="42/42 · 3 sel" />
          <Table.Header columns={TABLE_COLS} />
          <div style={{ flex: 1 }} />
        </Table>
      </div>
    ),
  },

  Tabs: {
    render: () => (
      <>
        <Spec label="pill (md)">
          <Tabs items={TAB_ITEMS} value="clone" onChange={() => {}} />
        </Spec>
        <Spec label="pill (sm)">
          <Tabs items={TAB_ITEMS} value="design" onChange={() => {}} size="sm" />
        </Spec>
        <Spec label="underline">
          <Tabs items={TAB_ITEMS} value="dub" onChange={() => {}} variant="underline" />
        </Spec>
      </>
    ),
  },

  // ── Panels (provider-wrapped) ────────────────────────────────────────────

  // Store + i18n only — the simplest page-level target. Aligns the store's
  // active `theme` with the rendered data-theme variant so the highlighted
  // theme dot matches the snapshot's palette.
  AppearancePanel: {
    width: 640,
    providers: {
      store: ({ theme }) => ({
        theme: theme === 'default' ? 'gruvbox' : theme,
        uiScale: 1,
        font: 'inter',
        autoPlayPreview: true,
      }),
    },
    render: () => <AppearancePanel />,
  },

  // Store + i18n + a seeded react-query cache. `useSystemInfo()` would
  // otherwise spin forever with no backend; we pre-fill its cache entry with
  // a representative payload so the ffmpeg badge + advanced rows render real.
  GeneralTab: {
    width: 640,
    providers: {
      store: ({ theme }) => ({
        locale: 'en',
        theme: theme === 'default' ? 'gruvbox' : theme,
      }),
      query: (qc) => {
        qc.setQueryData(queryKeys.systemInfo, {
          app_version: '0.3.6',
          python: '3.12.4',
          platform: 'macOS-15.0-arm64',
          device: 'mps',
          ffmpeg_ok: true,
          ffmpeg_path: '/opt/homebrew/bin/ffmpeg',
          proxy_url: '',
          has_hf_token: true,
        });
      },
    },
    render: () => <GeneralTab />,
  },

  // Direct api/* fetch on mount (no react-query) — exercises the fetch stub.
  // StoragePanel GETs /api/settings/storage/models-dir as it mounts; the stub
  // returns a representative payload so it renders its loaded state, not the
  // error fallback a missing backend would otherwise produce.
  StoragePanel: {
    width: 640,
    providers: {
      fetch: (url) => {
        if (url.includes('/api/settings/storage/models-dir')) {
          return {
            configured: '',
            effective: '/Users/~/Library/Caches/huggingface',
            default: '/Users/~/Library/Caches/huggingface',
            restart_required: false,
          };
        }
        return undefined;
      },
    },
    render: () => <StoragePanel />,
  },
};
