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
import { Download, Sparkles, Trash2 } from 'lucide-react';

import Badge from '../../ui/Badge.jsx';
import Button from '../../ui/Button.jsx';
import Panel from '../../ui/Panel.jsx';
import Progress from '../../ui/Progress.jsx';
import Segmented from '../../ui/Segmented.jsx';
import SettingRow from '../../components/settings/primitives/SettingRow.jsx';
import SettingsToggle from '../../components/settings/primitives/SettingsToggle.jsx';
// SettingRow / SettingsToggle styling lives in the primitives stylesheet,
// normally pulled in via the primitives barrel — import it directly here.
import '../../components/settings/primitives/primitives.css';
import './harness.css';

function Spec({ label, children }) {
  return (
    <div className="visual-spec">
      <span className="visual-spec__label">{label}</span>
      <div className="visual-spec__row">{children}</div>
    </div>
  );
}

const BADGE_TONES = ['neutral', 'brand', 'success', 'warn', 'danger', 'info', 'violet'];

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
};
