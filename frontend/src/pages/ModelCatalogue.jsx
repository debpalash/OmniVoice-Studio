/**
 * ModelCatalogue — the workspace where engines and model weights are browsed
 * and the app's defaults are chosen.
 *
 * Engine picking and the model store used to be two Settings categories, which
 * buried the single most consequential decision in the app (which TTS/ASR/LLM
 * engine runs, and which weights are on disk) three clicks deep, split across
 * two panes that constantly cross-reference each other. This promotes both to a
 * first-class workspace with one pane switch between them; Settings keeps only
 * the genuinely settings-shaped remainder (models directory, HF mirror) and
 * points here for the rest.
 *
 * Deliberately a COMPOSITION, not a rewrite: the panes mount the existing
 * `EnginesTab` (engine matrix + the OpenAI-compatible ASR config) and
 * `ModelStoreTab` unchanged, so their data contracts, tests and behaviour carry
 * over untouched — the shared engine cache, the same install/delete flows, and
 * the same env-var-wins semantics.
 *
 * `pendingCatalogueTab` is the one-shot deep-link hand-off (mirrors Settings'
 * `pendingSettingsTab`): a caller sets the pane and navigates here, this page
 * consumes it once and clears it so a later plain visit reopens the last pane.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, CheckCircle, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { useModelStatus, useSystemInfo } from '../api/hooks';
import { Badge, Tabs } from '../ui';
import EnginesTab from '../components/settings/EnginesTab';
import ModelStoreTab from '../components/settings/ModelStoreTab';

/** Persisted across visits so the workspace reopens where you left it. */
const PANE_KEY = 'omnivoice.catalogue.pane';
const FAMILY_KEY = 'omnivoice.catalogue.engine-family';
const PANES = ['engines', 'models'];
const FAMILIES = ['tts', 'asr', 'llm'];

function readStoredPane() {
  try {
    const stored = localStorage.getItem(PANE_KEY);
    return PANES.includes(stored) ? stored : 'engines';
  } catch {
    return 'engines';
  }
}

function readStoredFamily() {
  try {
    const stored = localStorage.getItem(FAMILY_KEY);
    return FAMILIES.includes(stored) ? stored : 'tts';
  } catch {
    return 'tts';
  }
}

export default function ModelCatalogue() {
  const { t } = useTranslation();
  const pendingCatalogueTab = useAppStore((s) => s.pendingCatalogueTab);
  const pendingCatalogueFamily = useAppStore((s) => s.pendingCatalogueFamily);
  const setPendingCatalogueTab = useAppStore((s) => s.setPendingCatalogueTab);
  const setPendingCatalogueFamily = useAppStore((s) => s.setPendingCatalogueFamily);
  // Seed from the deep-link so the first paint is already the requested pane —
  // seeding from storage and correcting in an effect would flash the wrong one.
  const [pane, setPaneRaw] = useState(() =>
    PANES.includes(pendingCatalogueTab) ? pendingCatalogueTab : readStoredPane(),
  );
  const [family, setFamilyRaw] = useState(() =>
    FAMILIES.includes(pendingCatalogueFamily) ? pendingCatalogueFamily : readStoredFamily(),
  );

  const setPane = useCallback((next) => {
    setPaneRaw(next);
    try {
      localStorage.setItem(PANE_KEY, next);
    } catch {
      /* private mode / quota — the pane still switches, it just won't persist */
    }
  }, []);
  const setFamily = useCallback((next) => {
    setFamilyRaw(next);
    try {
      localStorage.setItem(FAMILY_KEY, next);
    } catch {
      /* private mode / quota — the family still switches */
    }
  }, []);

  // Consume the one-shot deep-link (including a repeat request for the pane
  // we're already on, which must still clear).
  useEffect(() => {
    if (!pendingCatalogueTab) return;
    if (PANES.includes(pendingCatalogueTab)) setPane(pendingCatalogueTab);
    if (FAMILIES.includes(pendingCatalogueFamily)) setFamily(pendingCatalogueFamily);
    setPendingCatalogueTab(null);
    setPendingCatalogueFamily(null);
  }, [
    pendingCatalogueTab,
    pendingCatalogueFamily,
    setPendingCatalogueFamily,
    setPendingCatalogueTab,
    setFamily,
    setPane,
  ]);

  const { data: info } = useSystemInfo();
  const { data: status } = useModelStatus();

  // The loaded-model pill ModelStoreTab renders in its header. Lives here now
  // that this page — not Settings — hosts the model store.
  const modelBadge =
    status?.status === 'ready' ? (
      <Badge tone="success">
        <CheckCircle size={11} /> {t('models.ready_badge')}
      </Badge>
    ) : status?.status === 'loading' ? (
      <Badge tone="warn">
        <RefreshCw size={11} className="spinner" /> {t('models.loading_badge')}
      </Badge>
    ) : (
      <Badge tone="warn">{t('models.idle_badge')}</Badge>
    );

  // Tabs, not a two-state Segmented: these are two workspaces of a catalogue,
  // not one setting with an on/off reading, and the room to add a third pane
  // later is free. Tabs also carry roving tabindex + role="tab" from the
  // primitive, which the switch had to describe with an aria-label.
  const paneItems = useMemo(
    () => [
      { id: 'engines', label: t('catalogue.tab_engines') },
      { id: 'models', label: t('catalogue.tab_models') },
    ],
    [t],
  );

  return (
    // Same container-query shell as Settings: the app is zoom-scaled, so
    // viewport media queries fire at the wrong logical width under Tauri.
    <div
      className="h-full min-h-0 w-full [container-type:inline-size] [container-name:catalogue-shell]"
      data-testid="model-catalogue"
    >
      <div className="flex h-full min-h-0 w-full box-border flex-col overflow-y-auto bg-[var(--chrome-bg)] p-[var(--space-4)_var(--space-5)_var(--space-5)] font-sans @min-[760px]/catalogue-shell:overflow-hidden">
        {/* One line of chrome: what this is, and which half of it you're on.
            Both panes already headline themselves (the matrix names the active
            engine, the model store carries disk/cache status), so a subtitle
            here would only repeat what the content says better. */}
        <header className="z-10 mb-[var(--space-4)] flex shrink-0 flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-2)] border-b border-[color-mix(in_srgb,var(--chrome-fg)_7%,transparent)] bg-[var(--chrome-bg)] pb-[var(--space-3)]">
          <span
            className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[var(--chrome-radius-pill)] bg-[color-mix(in_srgb,var(--chrome-accent)_12%,var(--chrome-bg))] text-[color:var(--chrome-accent)]"
            aria-hidden="true"
          >
            <Boxes size={14} />
          </span>
          <h1 className="m-0 min-w-0 flex-auto truncate [font-family:var(--font-sans)] text-[length:var(--text-lg)] font-semibold tracking-[-0.015em] text-[color:var(--chrome-fg)]">
            {t('catalogue.title')}
          </h1>
          <Tabs
            items={paneItems}
            value={pane}
            onChange={setPane}
            size="sm"
            aria-label={t('catalogue.title')}
            data-testid="catalogue-pane-switch"
          />
        </header>

        {/* Full-bleed: engine rows and the model table are wide, data-dense
            surfaces — a reading-width column would only add horizontal
            scrolling inside them. */}
        <div
          key={pane}
          data-testid={`catalogue-pane-${pane}`}
          aria-label={t(pane === 'models' ? 'catalogue.tab_models' : 'catalogue.tab_engines')}
          className="min-w-0 [&>*:first-child]:mt-0 @min-[760px]/catalogue-shell:min-h-0 @min-[760px]/catalogue-shell:flex-1 @min-[760px]/catalogue-shell:overflow-y-auto @min-[760px]/catalogue-shell:overscroll-contain"
        >
          {pane === 'engines' ? (
            <EnginesTab initialFamily={family} onFamilyChange={setFamily} />
          ) : (
            <ModelStoreTab info={info} modelBadge={modelBadge} />
          )}
        </div>
      </div>
    </div>
  );
}
