import type { StateCreator } from 'zustand';

/**
 * Stories Editor state — a single persisted project (cast + tracks).
 * Pro-studio spec: docs/superpowers/specs/2026-05-30-stories-editor-studio-design.md
 *
 * A track references a cast member by id (`character`). Effective voice is
 * resolved in utils/storyCast.ts (track override → cast voice → default).
 * Transient runtime fields (generating, audioUrl) are NOT persisted — see the
 * partialize in store/index.ts.
 */
export interface StoryTrack {
  id: number;
  character: string;            // CastMember.id
  text: string;
  profileId: string | null;     // per-line voice override (else inherits cast)
  emotion: string | null;       // per-line tone/instruct (Phase 3)
  speed: number | null;         // per-line speed override (Phase 3)
}

export interface CastMember {
  id: string;
  name: string;
  color: string;
  profileId: string | null;     // the voice this character speaks in
}

export interface StoryProject {
  id: string;
  name: string;
  tracks: StoryTrack[];
  cast: CastMember[];
  updatedAt: number;
}

export interface StoriesSlice {
  storyTracks: StoryTrack[];
  cast: CastMember[];
  storyProjects: StoryProject[];
  currentProjectId: string | null;
  setStoryTracks: (tracks: StoryTrack[]) => void;
  setCast: (cast: CastMember[]) => void;
  upsertCastMember: (member: CastMember) => void;
  removeCastMember: (id: string) => void;
  setCharacterVoice: (castId: string, profileId: string | null) => void;
  saveProject: (name: string) => void;
  loadProject: (id: string) => void;
  newProject: () => void;
  deleteProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
}

export const DEFAULT_CAST: CastMember[] = [
  { id: 'narrator', name: 'Narrator', color: '#fabd2f', profileId: null },
];

function genProjectId(): string {
  return `p_${Math.random().toString(36).slice(2, 10)}`;
}

// Strip transient runtime fields before snapshotting into a saved project.
function snapshotTracks(tracks: StoryTrack[]): StoryTrack[] {
  return tracks.map(({ id, character, text, profileId, emotion, speed }) => ({ id, character, text, profileId, emotion, speed }));
}

export const createStoriesSlice: StateCreator<StoriesSlice, [], [], StoriesSlice> = (set, get) => ({
  storyTracks: [],
  cast: DEFAULT_CAST.map((c) => ({ ...c })),
  storyProjects: [],
  currentProjectId: null,
  setStoryTracks: (storyTracks) => set({ storyTracks }),
  setCast: (cast) => set({ cast }),
  upsertCastMember: (member) =>
    set((s) => {
      const i = s.cast.findIndex((c) => c.id === member.id);
      if (i === -1) return { cast: [...s.cast, member] };
      const next = s.cast.slice();
      next[i] = { ...next[i], ...member };
      return { cast: next };
    }),
  removeCastMember: (id) => set((s) => ({ cast: s.cast.filter((c) => c.id !== id) })),
  setCharacterVoice: (castId, profileId) =>
    set((s) => ({ cast: s.cast.map((c) => (c.id === castId ? { ...c, profileId } : c)) })),
  saveProject: (name) =>
    set((s) => {
      const id = s.currentProjectId || genProjectId();
      const ts = (() => { try { return Date.now(); } catch { return 0; } })();
      const proj: StoryProject = {
        id,
        name: name || 'Untitled',
        tracks: snapshotTracks(s.storyTracks),
        cast: s.cast.map((c) => ({ ...c })),
        updatedAt: ts,
      };
      const exists = s.storyProjects.some((p) => p.id === id);
      return {
        storyProjects: exists ? s.storyProjects.map((p) => (p.id === id ? proj : p)) : [...s.storyProjects, proj],
        currentProjectId: id,
      };
    }),
  loadProject: (id) => {
    const p = get().storyProjects.find((x) => x.id === id);
    if (!p) return;
    set({ storyTracks: p.tracks.map((t) => ({ ...t })), cast: p.cast.map((c) => ({ ...c })), currentProjectId: id });
  },
  newProject: () => set({ storyTracks: [], cast: DEFAULT_CAST.map((c) => ({ ...c })), currentProjectId: null }),
  deleteProject: (id) =>
    set((s) => ({
      storyProjects: s.storyProjects.filter((p) => p.id !== id),
      currentProjectId: s.currentProjectId === id ? null : s.currentProjectId,
    })),
  renameProject: (id, name) =>
    set((s) => ({ storyProjects: s.storyProjects.map((p) => (p.id === id ? { ...p, name } : p)) })),
});
