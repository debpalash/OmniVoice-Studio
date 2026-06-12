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
import type { StoriesSlice } from './storiesSlice';
import { createStoriesSlice } from './storiesSlice';
import type { UpdaterSlice } from './updaterSlice';
import { createUpdaterSlice } from './updaterSlice';
import type { GallerySlice } from './gallerySlice';
import { createGallerySlice } from './gallerySlice';
import type { ReleasesSlice } from './releasesSlice';
import { createReleasesSlice } from './releasesSlice';

export type AppStore = PrefsSlice & GlossarySlice & UiSlice & DubSlice & GenerateSlice & PillSlice & StoriesSlice & UpdaterSlice & GallerySlice & ReleasesSlice;

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
      ...createStoriesSlice(set, get, api),
      ...createUpdaterSlice(set, get, api),  // transient — not in partialize
      ...createGallerySlice(set, get, api),
      ...createReleasesSlice(set, get, api),  // transient — not in partialize
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
      }),
      version: 4,
      // Drop old persisted shapes rather than crashing the app. Every field
      // has a safe default in its slice, so v1/v2/v3 users pick up v4 defaults
      // for new fields (timingStrategy etc.) and keep any keys we still write
      // today. Upgrade > crash.
      migrate: (persisted, version) => {
        if (!persisted || typeof persisted !== 'object') return {} as Partial<AppStore>;
        if (version < 4) {
          // v1 → v2 added reviewMode; v2 → v3 added mode/sidebar/generate knobs;
          // v3 → v4 added timingStrategy. All of those have slice defaults,
          // so passing through the old keys is sufficient — anything missing
          // falls through to the slice init.
          return persisted as Partial<AppStore>;
        }
        return persisted as Partial<AppStore>;
      },
    },
  ),
);
