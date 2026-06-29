// Shared archetype facet helpers — used by ArchetypesZone + ArchetypeCard.
export const titleCase = (s) => (s ? String(s).replace(/\b\w/g, (c) => c.toUpperCase()) : s);
export const facetLabel = (v) => titleCase(String(v).replace(' pitch', '').replace(' accent', ''));
