/**
 * UI / navigation slice — Phase 2.2 (App.jsx monolith reduction).
 *
 * Holds the always-on "where am I in the app?" state that used to live as a
 * fan of `useState` calls at the top of App.jsx. Moving this out makes the
 * top of App.jsx readable again and lets deep children (Sidebar, NavRail,
 * VoiceProfile) read current mode / active project without prop-drilling
 * through the whole tree.
 *
 * Persisted: mode (the tab you were on), isSidebarCollapsed, uiScale. The
 * active-project / active-voice ids are transient — on reload we snap back
 * to the launchpad rather than half-load a stale project state.
 */
import type { StateCreator } from 'zustand';

export type AppMode =
  | 'launchpad'
  | 'generate'
  | 'dub'
  | 'clone'
  | 'design'
  | 'voice'
  | 'tools'
  | 'batch'
  | 'settings';

export type SidebarTab = 'projects' | 'history' | 'downloads';

export interface UiSlice {
  mode: AppMode;
  activeProjectId: string | null;
  activeProjectName: string;
  activeVoiceId: string | null;
  /** The mode the user was on before opening a voice profile. "Back" restores it. */
  modeBeforeVoice: AppMode | null;
  isSidebarCollapsed: boolean;
  isSidebarProjectsCollapsed: boolean;
  sidebarTab: SidebarTab;
  showCheatsheet: boolean;
  uiScale: number;

  setMode: (mode: AppMode) => void;
  setActiveProject: (id: string | null, name?: string) => void;
  setActiveVoiceId: (id: string | null) => void;
  setModeBeforeVoice: (mode: AppMode | null) => void;
  setIsSidebarCollapsed: (collapsed: boolean) => void;
  setIsSidebarProjectsCollapsed: (collapsed: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setShowCheatsheet: (open: boolean | ((prev: boolean) => boolean)) => void;
  setUiScale: (scale: number) => void;

  /** Jump to the voice-profile page, remembering what mode you were on. */
  openVoiceProfile: (id: string) => void;
  /** Close the voice-profile page, restoring the previous mode. */
  closeVoiceProfile: () => void;
}

export const createUiSlice: StateCreator<UiSlice, [], [], UiSlice> = (set, get) => ({
  mode: 'launchpad',
  activeProjectId: null,
  activeProjectName: '',
  activeVoiceId: null,
  modeBeforeVoice: null,
  isSidebarCollapsed: false,
  isSidebarProjectsCollapsed: false,
  sidebarTab: 'projects',
  showCheatsheet: false,
  uiScale: 1.3,

  setMode: (mode) => set({ mode }),
  setActiveProject: (id, name = '') => set({ activeProjectId: id, activeProjectName: name }),
  setActiveVoiceId: (id) => set({ activeVoiceId: id }),
  setModeBeforeVoice: (mode) => set({ modeBeforeVoice: mode }),
  setIsSidebarCollapsed: (collapsed) => set({ isSidebarCollapsed: collapsed }),
  setIsSidebarProjectsCollapsed: (collapsed) => set({ isSidebarProjectsCollapsed: collapsed }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setShowCheatsheet: (open) => set((s) => ({
    showCheatsheet: typeof open === 'function' ? (open as (p: boolean) => boolean)(s.showCheatsheet) : open,
  })),
  setUiScale: (scale) => set({ uiScale: scale }),

  openVoiceProfile: (id) => {
    const prev = get().mode;
    set({
      mode: 'voice',
      activeVoiceId: id,
      modeBeforeVoice: prev !== 'voice' ? prev : get().modeBeforeVoice,
    });
  },
  closeVoiceProfile: () => {
    const prev = get().modeBeforeVoice;
    set({
      mode: prev ?? 'launchpad',
      activeVoiceId: null,
      modeBeforeVoice: null,
    });
  },
});
