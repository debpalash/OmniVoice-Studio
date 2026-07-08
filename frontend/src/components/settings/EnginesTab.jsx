import React, { useCallback, useRef } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { addBreadcrumb } from '../../utils/breadcrumbs';
import { listEngines, selectEngine } from '../../api/engines';
import { notifyEngineSelected } from '../../utils/engineSelectToast';
import EngineCompatibilityMatrix from '../EngineCompatibilityMatrix';
import { SETTINGS_SECTION_SURFACE } from './primitives';

/** One pinned matrix per family, stacked in this order. ASR used to be
 *  reachable only through the matrix's family tabs, which read as a
 *  TTS-only table — README even promised a Settings ASR picker that
 *  didn't exist (UX gap found during #877). Every family now gets a
 *  visible picker; `OMNIVOICE_*_BACKEND` env vars still win over any pick. */
const FAMILIES = ['tts', 'asr', 'llm'];

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

  // The stacked matrices all consume the same GET /engines payload — share
  // one in-flight request so opening the tab probes every engine once, not
  // once per family. A per-matrix Refresh after the shared promise settles
  // still triggers a fresh fetch.
  const inflightList = useRef(null);
  const listEnginesShared = useCallback(() => {
    if (!inflightList.current) {
      inflightList.current = listEngines().finally(() => {
        inflightList.current = null;
      });
    }
    return inflightList.current;
  }, []);

  return (
    <>
      {FAMILIES.map((family) => (
        <section key={family} className={SETTINGS_SECTION_SURFACE} data-slot="settings-section">
          <EngineCompatibilityMatrix
            family={family}
            showFamilyTabs={false}
            onSelect={onSelect}
            apiListEngines={listEnginesShared}
          />
        </section>
      ))}
    </>
  );
}
