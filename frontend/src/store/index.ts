/**
 * Zustand store root — Phase 2.2 (ROADMAP.md).
 *
 * Goal: peel state off the 1,803-line App.jsx monolith a slice at a time,
 * without big-bang disruption. Every slice lives in its own file, and the
 * root store composes them.
 *
 * Rule of thumb:
 *   - UI primitives own their local state (don't lift it).
 *   - App-level state (active project, user prefs, pipeline progress) lives
 *     here.
 *   - Selectors live at call sites (`useStore(s => s.foo)`).
 *
 * localStorage persistence uses zustand's own middleware so reloads keep
 * your quality/dual-subs/glossary-visibility choice.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import type { PrefsSlice, FontId } from './prefsSlice';
import { createPrefsSlice, FONT_OPTIONS, FONT_STACKS } from './prefsSlice';

// Re-export font preference tables so panels can import from the store root.
export type { FontId };
export { FONT_OPTIONS, FONT_STACKS };
import type { GlossarySlice } from './glossarySlice';
import { createGlossarySlice } from './glossarySlice';
import type { UiSlice } from './uiSlice';
import { createUiSlice } from './uiSlice';
import type { DubSlice } from './dubSlice';
import { createDubSlice } from './dubSlice';
import type { GenerateSlice } from './generateSlice';
import { createGenerateSlice } from './generateSlice';
import type { PillSlice } from './pillSlice';
import { createPillSlice } from './pillSlice';
import type { LongformSlice } from './longformSlice';
import { createLongformSlice, genProjectId } from './longformSlice';
import type { UpdaterSlice } from './updaterSlice';
import { createUpdaterSlice } from './updaterSlice';
import type { GallerySlice } from './gallerySlice';
import { createGallerySlice } from './gallerySlice';
import type { ReleasesSlice } from './releasesSlice';
import { createReleasesSlice } from './releasesSlice';
import type { DonationSlice } from './donationSlice';
import { createDonationSlice } from './donationSlice';

export type AppStore = PrefsSlice & GlossarySlice & UiSlice & DubSlice & GenerateSlice & PillSlice & LongformSlice & UpdaterSlice & GallerySlice & ReleasesSlice & DonationSlice;

/**
 * `useAppStore` — single root store. Don't create siblings. Slices compose here.
 *
 * Usage:
 *   const quality = useAppStore(s => s.translateQuality);
 *   const setQuality = useAppStore(s => s.setTranslateQuality);
 */
export const useAppStore = create<AppStore>()(
  persist(
    (set, get, api) => ({
      ...createPrefsSlice(set, get, api),
      ...createGlossarySlice(set, get, api),
      ...createUiSlice(set, get, api),
      ...createDubSlice(set, get, api),
      ...createGenerateSlice(set, get, api),
      ...createPillSlice(set, get, api),
      ...createLongformSlice(set, get, api),
      ...createUpdaterSlice(set, get, api),  // transient — not in partialize
      ...createGallerySlice(set, get, api),
      ...createReleasesSlice(set, get, api),  // transient — not in partialize
      ...createDonationSlice(set, get, api),
    }),
    {
      name: 'omnivoice.app',
      storage: createJSONStorage(() => localStorage),
      // Only persist user prefs + glossary. Pipeline / transient state is opt-out.
      partialize: (s) => ({
        translateQuality:           s.translateQuality,
        dualSubs:                   s.dualSubs,
        burnSubs:                   s.burnSubs,
        glossaryVisible:            s.glossaryVisible,
        reviewMode:                 s.reviewMode,
        showHeaderLiveStats:        s.showHeaderLiveStats,
        timingStrategy:             s.timingStrategy,
        fitOptions:                 s.fitOptions,
        autoPlayPreview:            s.autoPlayPreview,
        mode:                       s.mode,
        defineMethod:               s.defineMethod,
        isSidebarCollapsed:         s.isSidebarCollapsed,
        isSidebarProjectsCollapsed: s.isSidebarProjectsCollapsed,
        sidebarTab:                 s.sidebarTab,
        uiScale:                    s.uiScale,
        locale:                     s.locale,
        theme:                      s.theme,
        font:                       s.font,
        // Generate-tab prefs — users expect their synthesis knobs to stick.
        language:      s.language,
        speed:         s.speed,
        steps:         s.steps,
        cfg:           s.cfg,
        tShift:        s.tShift,
        posTemp:       s.posTemp,
        classTemp:     s.classTemp,
        layerPenalty:  s.layerPenalty,
        denoise:       s.denoise,
        postprocess:   s.postprocess,
        vdStates:      s.vdStates,
        // Voice gallery — favorites + view/zone/filter preferences stick.
        favoriteArchetypeIds: s.favoriteArchetypeIds,
        galleryViewMode:      s.galleryViewMode,
        galleryZone:          s.galleryZone,
        archetypeFilters:     s.archetypeFilters,
        // Stories Editor — persist the project; strip transient runtime fields
        // (generating, audioUrl) so a dead blob: URL / stuck spinner never rehydrates.
        storyTracks:   s.storyTracks.map(({ id, character, text, profileId, emotion, speed }) =>
                          ({ id, character, text, profileId, emotion, speed })),
        cast:          s.cast,
        storyProjects: s.storyProjects,
        currentProjectId: s.currentProjectId,
        // Long-form shared working fields (#31) — persist so Audiobook
        // metadata/script/prefs survive a tab switch or reload once bound (#31b).
        script:        s.script,
        meta:          s.meta,
        lexicon:       s.lexicon,
        coverRef:      s.coverRef,
        outputFormat:  s.outputFormat,
        loudness:      s.loudness,
        defaultVoice:  s.defaultVoice,
        projectMode:   s.projectMode,
        // Donation prompt state (#007) — persist everything EXCEPT
        // `shownThisSession` so the ≤1/session cap resets on every launch.
        successCount:    s.successCount,
        dubCount:        s.dubCount,
        firstSuccessAt:  s.firstSuccessAt,
        lastShownAt:     s.lastShownAt,
        shownCount:      s.shownCount,
        firedMilestones: s.firedMilestones,
        optedOut:        s.optedOut,
      }),
      version: 6,
      // Drop old persisted shapes rather than crashing the app. Every field
      // has a safe default in its slice, so v1/v2/v3 users pick up v4 defaults
      // for new fields (timingStrategy etc.) and keep any keys we still write
      // today. Upgrade > crash.
      migrate: (persisted, version) => {
        if (!persisted || typeof persisted !== 'object') return {} as Partial<AppStore>; // D1
        const p = persisted as any;
        if (version < 4) {
          // v1 → v2 added reviewMode; v2 → v3 added mode/sidebar/generate knobs;
          // v3 → v4 added timingStrategy. All of those have slice defaults, so
          // passing through is sufficient — then fall through to the < 5 branch.
        }
        if (version < 5) {
          // #31: each saved Stories project becomes a LongformProject. Defaults
          // FIRST, real fields LAST (spread wins), so id/name/cast/tracks/
          // updatedAt always survive; new book-identity fields seed to defaults.
          // The field name stays `storyProjects` (every consumer reads it), so
          // no key rename — only the per-project shape is enriched. Never throws;
          // malformed entries are dropped (D2/D3).
          const raw = Array.isArray(p.storyProjects) ? p.storyProjects : [];        // D2
          p.storyProjects = raw
            .filter((sp: any) => sp && typeof sp === 'object')                       // D3
            .map((sp: any) => ({
              id: genProjectId(), name: 'Untitled', mode: 'stories',
              cast: [], tracks: [], script: '', meta: {}, lexicon: {},
              coverRef: null, outputFormat: 'm4b', loudness: 'off',
              defaultVoice: null, updatedAt: 0,
              ...sp,
            }));
          // Loose working fields seed to defaults; absent ones fall through to
          // slice init. A dangling currentProjectId is harmless (loadProject
          // no-ops). NB: set `projectMode` (the long-form field), NOT `mode`
          // (that's the app navigation mode owned by uiSlice).
          p.projectMode = 'stories';
          // fall through to the < 6 branch
        }
        if (version < 6) {
          // #007: donation-prompt fields are new. Every field has a safe slice
          // default (INITIAL_DONATION), so a v5→v6 user simply picks those up —
          // pass through untouched. Never throws.
        }
        return p as Partial<AppStore>; // also covers version > 6 (downgrade→upgrade)
      },
    },
  ),
);
