// MIRROR OF backend/core/error_docs_map.py — keep in sync.
// The Python test_keys_match_python_map / test_keys_match_taxonomy guards
// the 4-class taxonomy on the backend; the `_KEYS` array below is the
// TS-side anchor (the keys-sync test imports it and asserts equality).
//
// This `BASE` constant is the SECOND hardcoded URL drift site: the
// canonical Python-side resolver is `backend/core/links.py`
// (`PROJECT_REPO_BLOB_MAIN`). The TS half runs in the browser and can't
// read `pyproject.toml`, so it gets a hand-maintained mirror. Centralising
// the URL on the TS side is a v0.4 concern — the milestone accepts the
// drift risk and relies on the keys-sync test + threat-model T-02-01
// to bound the blast radius.

import { openExternal } from '../api/external';

const BASE = 'https://github.com/debpalash/OmniVoice-Studio/blob/main';

export const ERROR_DOCS: Record<string, string> = {
  GATEKEEPER_QUARANTINE: `${BASE}/docs/install/macos.md#gatekeeper-quarantine`,
  APPIMAGE_WEBKIT_WHITESCREEN: `${BASE}/docs/install/linux.md#appimage-white-screen-on-fedora-44--ubuntu-2404`,
  PKG_RESOURCES_MISSING: `${BASE}/docs/install/troubleshooting.md#pkg_resources-missing`,
  HF_AUTH_FAILED: `${BASE}/docs/setup/huggingface-token.md`,
  // Issue #78 — pyannote gated-model license not accepted on HF.
  // Distinct from HF_AUTH_FAILED (which is a missing/invalid token).
  PYANNOTE_LICENSE_REQUIRED: `${BASE}/docs/features/diarization.md#license-acceptance-flow`,
};

export const DEFAULT_DOCS = `${BASE}/docs/install/troubleshooting.md`;

// Locked taxonomy keys — Phase 5 bug reporter consumes this exact set.
// Adding a 6th class is a contract change; update the Python map at the
// same time (`backend/core/error_docs_map.py`).
export const ERROR_CLASS_KEYS = [
  'GATEKEEPER_QUARANTINE',
  'APPIMAGE_WEBKIT_WHITESCREEN',
  'PKG_RESOURCES_MISSING',
  'HF_AUTH_FAILED',
  'PYANNOTE_LICENSE_REQUIRED',
] as const;

export type ErrorClass = (typeof ERROR_CLASS_KEYS)[number];

/**
 * Heuristic error message → ErrorClass classifier. ErrorBoundary uses this
 * when the thrown Error doesn't carry an explicit `errorClass` property.
 */
export function classifyError(error: unknown): ErrorClass | null {
  const message =
    (error as { message?: string } | null | undefined)?.message ?? String(error ?? '');
  const lower = message.toLowerCase();
  if (/pkg_resources/.test(lower)) return 'PKG_RESOURCES_MISSING';
  // Issue #78 — pyannote license + diarization are diagnosed separately
  // from generic HF auth, since the fix instructions are different (click
  // "Agree" on the model page vs. set/refresh the token). Check this BEFORE
  // the HF_AUTH_FAILED branch so a message mentioning both "pyannote" and
  // "401" routes to the more specific deeplink.
  if (
    /pyannote/.test(lower) ||
    /\bgated\b/.test(lower) ||
    /speaker[- ]?diariz/.test(lower) ||
    /accept.*(license|terms|conditions)/.test(lower)
  ) {
    return 'PYANNOTE_LICENSE_REQUIRED';
  }
  if (/\b401\b/.test(lower) || /hfhub|hfhubhttp/.test(lower) || /unauthorized/.test(lower)) {
    return 'HF_AUTH_FAILED';
  }
  if (/webkit/.test(lower) || /white\s*screen/.test(lower)) {
    return 'APPIMAGE_WEBKIT_WHITESCREEN';
  }
  if (/quarantine/.test(lower) || /gatekeeper/.test(lower)) return 'GATEKEEPER_QUARANTINE';
  return null;
}

export function urlFor(errorClass: ErrorClass | null | undefined): string {
  if (!errorClass) return DEFAULT_DOCS;
  return ERROR_DOCS[errorClass] ?? DEFAULT_DOCS;
}

/** Open the docs URL for `errorClass` in the user's default browser. */
export async function openDocsFor(
  errorClass: ErrorClass | string | null | undefined,
): Promise<void> {
  const url = ERROR_DOCS[errorClass as string] ?? DEFAULT_DOCS;
  await openExternal(url);
}
