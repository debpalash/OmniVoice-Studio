import React, { useCallback } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { addBreadcrumb } from '../../utils/breadcrumbs';
import { selectEngine } from '../../api/engines';
import { notifyEngineSelected } from '../../utils/engineSelectToast';
import EngineCompatibilityMatrix from '../EngineCompatibilityMatrix';
import { SETTINGS_SECTION_SURFACE } from './primitives';

/** Settings → Engines: ONE section, one matrix, a TTS / ASR / LLM tab strip.
 *
 *  The page used to stack three pinned per-family matrices; with every row
 *  free to grow (wrapping names, stacked badges, inline failure prose) a
 *  single engine could fill a viewport and the ASR/LLM pickers lived below
 *  the fold. The matrix's family tab strip (Radix Segmented — roving
 *  tabindex + arrow keys, active engine named in each tab caption) now
 *  presents one family at a time instead, over compact fixed-height rows.
 *
 *  Data contract is unchanged: the single mounted matrix issues exactly one
 *  GET /engines + one GET /model/loaded per Settings open (switching tabs
 *  re-slices the same payload — no refetch), `openSettingsTab('engines')`
 *  still lands here, and `OMNIVOICE_*_BACKEND` env vars still win over any
 *  pick made in the UI. */
export default function EnginesTab() {
  const { t } = useTranslation();

  // Plan 02-04 / ENGINE-06 — engine selection is wired through the
  // matrix component's optional onSelect callback so the matrix doubles
  // as a picker. Keeps a single source of truth for the engine list +
  // its install / GPU / isolation state.
  //
  // Review mode (the staged-checkpoint nudges) moved to Settings → General.
  const onSelect = useCallback(
    // modelId is only ever set by mlx-audio's curated-model picker (#981) —
    // every other call site (the "Use" button) omits it.
    async (family, backendId, modelId) => {
      try {
        addBreadcrumb(`engine:${family}=${backendId}`);
        const r = await selectEngine(family, backendId, modelId);
        // Consume the routing echo: warn (not a bare success) when the pick
        // lands on a CPU fallback on this host. See notifyEngineSelected.
        notifyEngineSelected(r, t, family);
      } catch (e) {
        toast.error(e.message || t('engines.switch_failed'));
      }
    },
    [t],
  );

  return (
    <section className={SETTINGS_SECTION_SURFACE} data-slot="settings-section">
      <EngineCompatibilityMatrix family="tts" onSelect={onSelect} />
    </section>
  );
}
