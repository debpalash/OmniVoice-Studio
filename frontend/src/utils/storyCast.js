/**
 * Cast helpers for the Stories Editor.
 *
 * Effective voice for a track resolves: per-line override → the character's
 * cast voice → null (the /generate default). Pure + testable.
 */

// Gruvbox-ish palette cycled when adding new cast members.
export const CAST_COLORS = [
  '#fabd2f', '#d3869b', '#83a598', '#b8bb26',
  '#fe8019', '#8ec07c', '#fb4934', '#458588',
];

/** Pick the first unused palette color (wraps by count when all are used). */
export function nextCastColor(cast) {
  const used = new Set((cast || []).map((c) => c.color));
  return CAST_COLORS.find((c) => !used.has(c)) || CAST_COLORS[(cast?.length || 0) % CAST_COLORS.length];
}

/** Resolve the profile id a track should speak in. */
export function effectiveProfile(track, cast) {
  if (track && track.profileId) return track.profileId;
  const member = (cast || []).find((c) => c.id === (track && track.character));
  return (member && member.profileId) || null;
}

/** Find a cast member by id (falls back to the first member). */
export function castMember(cast, id) {
  return (cast || []).find((c) => c.id === id) || (cast || [])[0] || null;
}
