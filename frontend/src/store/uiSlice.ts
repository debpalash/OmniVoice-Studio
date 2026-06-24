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
  | 'studio'
  // Legacy navigation ids — consolidated into 'studio' (voice-studio-unification
  // P4). Kept in the union so persisted UI state / history items that still say
  // 'clone'/'design' type-check while the restore shims map them to 'studio'.
  | 'clone'
  | 'design'
  | 'stories'
  | 'voice'
  | 'tools'
  | 'batch'
  | 'contact'
  | 'settings';

/**
 * The Voice workspace's "Define voice" method (was the Clone/Design tab
 * split): 'audio' = define from reference audio (old Clone tab), 'design' =
 * define by described attributes (old Design tab).
 */
export type DefineMethod = 'audio' | 'design';

export type SidebarTab = 'projects' | 'history' | 'downloads';

export interface UiSlice {
  mode: AppMode;
  /** Active definition method inside the Voice ('studio') workspace. */
  defineMethod: DefineMethod;
  activeProjectId: string | null;
  activeProjectName: string;
  activeVoiceId: string | null;
  /** The mode the user was on before opening a voice profile. "Back" restores it. */
  modeBeforeVoice: AppMode | null;
  /**
   * One-shot hand-off for "use this voice in the synthesis view": the Gallery
   * (or any view) sets a profile id and navigates to `studio`; App.jsx selects
   * that profile once it appears in the loaded profiles list, then clears this.
   */
  pendingProfileId: string | null;
  /**
   * One-shot hand-off for "open Settings on a specific tab": a caller (e.g. the
   * footer version badge) sets the tab id and navigates to `settings`; the
   * Settings page consumes it as its initial/active tab, then clears it. Mirrors
   * `pendingProfileId`.
   */
  pendingSettingsTab: string | null;
  isSidebarCollapsed: boolean;
  isSidebarProjectsCollapsed: boolean;
  sidebarTab: SidebarTab;
  showCheatsheet: boolean;
  uiScale: number;

  setMode: (mode: AppMode) => void;
  setDefineMethod: (method: DefineMethod) => void;
  setActiveProject: (id: string | null, name?: string) => void;
  setActiveVoiceId: (id: string | null) => void;
  setModeBeforeVoice: (mode: AppMode | null) => void;
  setPendingProfileId: (id: string | null) => void;
  setPendingSettingsTab: (tab: string | null) => void;
  /** Navigate to Settings on a specific tab in one call. */
  openSettingsTab: (tab: string) => void;
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
  defineMethod: 'audio',
  activeProjectId: null,
  activeProjectName: '',
  activeVoiceId: null,
  modeBeforeVoice: null,
  pendingProfileId: null,
  pendingSettingsTab: null,
  isSidebarCollapsed: false,
  isSidebarProjectsCollapsed: false,
  sidebarTab: 'projects',
  showCheatsheet: false,
  uiScale: 1.3,

  setMode: (mode) => set({ mode }),
  setDefineMethod: (method) => set({ defineMethod: method }),
  setActiveProject: (id, name = '') => set({ activeProjectId: id, activeProjectName: name }),
  setActiveVoiceId: (id) => set({ activeVoiceId: id }),
  setModeBeforeVoice: (mode) => set({ modeBeforeVoice: mode }),
  setPendingProfileId: (id) => set({ pendingProfileId: id }),
  setPendingSettingsTab: (tab) => set({ pendingSettingsTab: tab }),
  openSettingsTab: (tab) => set({ pendingSettingsTab: tab, mode: 'settings' }),
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
