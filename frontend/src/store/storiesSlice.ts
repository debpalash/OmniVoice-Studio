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

export interface StoriesSlice {
  storyTracks: StoryTrack[];
  cast: CastMember[];
  setStoryTracks: (tracks: StoryTrack[]) => void;
  setCast: (cast: CastMember[]) => void;
  upsertCastMember: (member: CastMember) => void;
  removeCastMember: (id: string) => void;
  setCharacterVoice: (castId: string, profileId: string | null) => void;
}

export const DEFAULT_CAST: CastMember[] = [
  { id: 'narrator', name: 'Narrator', color: '#fabd2f', profileId: null },
];

export const createStoriesSlice: StateCreator<StoriesSlice, [], [], StoriesSlice> = (set) => ({
  storyTracks: [],
  cast: DEFAULT_CAST.map((c) => ({ ...c })),
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
});
