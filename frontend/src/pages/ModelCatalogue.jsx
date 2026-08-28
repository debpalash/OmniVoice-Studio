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
import { Boxes, CheckCircle, Cpu, HardDriveDownload, RefreshCw } from 'lucide-react';
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
      { id: 'engines', label: t('catalogue.tab_engines'), icon: Cpu },
      { id: 'models', label: t('catalogue.tab_models'), icon: HardDriveDownload },
    ],
    [t],
  );

  return (
    // Same container-query shell as Settings: the app is zoom-scaled, so
    // viewport media queries fire at the wrong logical width under Tauri.
    <div
      className="h-full min-h-0 w-full overflow-y-auto overscroll-contain bg-[var(--chrome-bg)] [container-type:inline-size] [container-name:catalogue-shell]"
      data-testid="model-catalogue"
    >
      <div className="mx-auto box-border w-full max-w-[1500px] px-[34px] pb-[56px] pt-[34px] font-sans @max-[900px]/catalogue-shell:px-[24px] @max-[900px]/catalogue-shell:pb-[36px] @max-[900px]/catalogue-shell:pt-[26px] @max-[560px]/catalogue-shell:px-[14px]">
        {/* Treat this as a workspace, not a Settings card: one editorial title,
            one quiet navigation line, then the data surface. */}
        <header className="mb-[24px] flex flex-wrap items-end justify-between gap-x-[32px] gap-y-[18px] border-b border-[color-mix(in_srgb,var(--chrome-fg)_9%,transparent)] pb-[18px] @max-[560px]/catalogue-shell:flex-col @max-[560px]/catalogue-shell:items-start">
          <div className="flex items-center gap-[12px]">
            <span
              className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[12px] bg-[color-mix(in_srgb,var(--chrome-accent)_11%,transparent)] text-[color:var(--chrome-accent)]"
              aria-hidden="true"
            >
              <Boxes size={17} strokeWidth={1.6} />
            </span>
            <h1 className="m-0 min-w-0 [font-family:var(--font-serif)] text-[2rem] font-normal leading-none tracking-[-0.025em] text-[color:var(--chrome-fg)] @max-[560px]/catalogue-shell:text-[1.55rem]">
              {t('catalogue.title')}
            </h1>
          </div>
          <Tabs
            items={paneItems}
            value={pane}
            onChange={setPane}
            variant="underline"
            idPrefix="catalogue-pane"
            aria-label={t('catalogue.title')}
            data-testid="catalogue-pane-switch"
          />
        </header>

        {/* Full-bleed: engine rows and the model table are wide, data-dense
            surfaces — a reading-width column would only add horizontal
            scrolling inside them. */}
        <div
          key={pane}
          id={`catalogue-pane-panel-${pane}`}
          data-testid={`catalogue-pane-${pane}`}
          role="tabpanel"
          aria-labelledby={`catalogue-pane-tab-${pane}`}
          className="min-w-0 [&>*:first-child]:mt-0"
        >
          {pane === 'engines' ? (
            <EnginesTab initialFamily={family} onFamilyChange={setFamily} catalogueLayout />
          ) : (
            <ModelStoreTab info={info} modelBadge={modelBadge} catalogueLayout />
          )}
        </div>
      </div>
    </div>
  );
}
