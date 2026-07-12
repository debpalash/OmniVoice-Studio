/**
 * Frontend analytics (posthog-js) — consent-gated, autocapture OFF.
 *
 * The usual integration is one line at module load:
 *
 *     posthog.init(TOKEN, { api_host, defaults: '2026-05-30' })
 *
 * That is wrong for this app, twice over, and the reasons are not theoretical:
 *
 * 1. **It would track everyone immediately, before consent.** OmniVoice's whole
 *    promise is that a default install sends nothing (Settings → Privacy is OFF
 *    until you turn it on; see backend/core/analytics.py). Initialising at load
 *    would make the app's own README a lie. So init happens ONLY after the user
 *    has opted in, and never before.
 *
 * 2. **posthog-js autocaptures DOM interactions by default** — clicks, form
 *    interactions, and the *text content* of the elements involved. In this app
 *    the DOM holds the script the user is about to synthesise, their voice names,
 *    and their file names. Autocapture would exfiltrate precisely the content we
 *    promise never leaves the machine. It is explicitly disabled, along with
 *    session recording (which would record the screen) and pageview capture.
 *
 * What we send instead is a small set of deliberate events with metadata-only
 * properties, filtered through the same allowlist the backend uses — so no
 * future caller can leak content by adding a field.
 *
 * The project token is a *publishable* key (PostHog's client tokens are designed
 * to ship in client code); it grants write-only event ingestion, not data access.
 */
import type { PostHog } from 'posthog-js';

/**
 * Supplied at BUILD time, not committed. PostHog client tokens are publishable
 * (write-only event ingestion), but a token-shaped literal in the repo trips the
 * secret scanner and is a bad habit regardless — so the release build injects it,
 * exactly as the backend takes POSTHOG_PROJECT_TOKEN from the environment.
 *
 * No token => no destination => the Privacy toggle isn't even offered and nothing
 * can ever be sent. That is the correct default for a source build.
 */
const POSTHOG_TOKEN: string = (import.meta.env?.VITE_POSTHOG_KEY as string) || '';
const POSTHOG_HOST: string =
  (import.meta.env?.VITE_POSTHOG_HOST as string) || 'https://eu.i.posthog.com';

/** Whether this build has an analytics destination at all. */
export function analyticsAvailable(): boolean {
  return Boolean(POSTHOG_TOKEN);
}

/** The ONLY property keys allowed to leave. Mirrors backend `_ALLOWED_PROPS`.
 *  A key not on this list is dropped — not trusted. */
const ALLOWED_PROPS = new Set([
  'engine_id',
  'language',
  'mode',
  'kind',
  'source',
  'input_type',
  'effect_preset',
  'error_type',
  'duration_seconds',
  'gen_time_seconds',
  'text_length',
  'has_profile',
  'stream',
  'app_version',
  'platform',
]);

/** A string longer than this is refused outright, so free text can't ride in on
 *  an allowlisted key. */
const MAX_STR_LEN = 64;

let client: PostHog | null = null;

/** Drop anything that isn't explicitly allowed. Pure + exported for tests: this
 *  is what stops a take's text, a file path, or a voice name from ever going out. */
export function sanitizeProps(props?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (!ALLOWED_PROPS.has(k)) continue;
    if (typeof v === 'string' && v.length > MAX_STR_LEN) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

/** Config that makes the promises above true rather than aspirational. */
export function hardenedConfig() {
  return {
    api_host: POSTHOG_HOST,
    // The DOM of this app contains the user's script text, voice names and file
    // names. Autocapture would send them. Never enable.
    autocapture: false,
    // Would record the screen. Never enable.
    disable_session_recording: true,
    // We send deliberate events; we don't need URL/pageview streams.
    capture_pageview: false,
    capture_pageleave: false,
    // Defence in depth: even if a recording were somehow switched on upstream,
    // don't ship text or element attributes.
    mask_all_text: true,
    mask_all_element_attributes: true,
    // Consent is the gate — never start capturing on init.
    opt_out_capturing_by_default: true,
    persistence: 'localStorage' as const,
  };
}

/** Start analytics. Call ONLY when the user has opted in. Idempotent. */
export async function enableAnalytics(): Promise<void> {
  try {
    if (!POSTHOG_TOKEN) return; // no destination in this build — nothing to start
    if (!client) {
      const { default: posthog } = await import('posthog-js');
      posthog.init(POSTHOG_TOKEN, hardenedConfig());
      client = posthog;
    }
    client.opt_in_capturing();
  } catch (e) {
    console.warn('[analytics] init failed (non-fatal)', e);
  }
}

/** Stop analytics and forget the local id. Safe to call when never started. */
export function disableAnalytics(): void {
  try {
    client?.opt_out_capturing();
    client?.reset();
  } catch {
    /* nothing to stop */
  }
}

/** Record one event. A no-op unless the user opted in. Never throws. */
export function capture(event: string, props?: Record<string, unknown>): void {
  try {
    if (!client || client.has_opted_out_capturing()) return;
    client.capture(event, sanitizeProps(props));
  } catch (e) {
    console.warn('[analytics] capture failed (non-fatal)', e);
  }
}

/** On app start: turn analytics on ONLY if the backend says the user opted in.
 *  Anything else — backend down, no consent, source build — leaves it off. */
export async function initAnalyticsFromConsent(
  fetchState: () => Promise<{ opted_in?: boolean; available?: boolean }>,
): Promise<boolean> {
  try {
    const s = await fetchState();
    if (s?.available && s?.opted_in) {
      await enableAnalytics();
      return true;
    }
  } catch {
    /* backend unreachable → stay off. Silence is not consent. */
  }
  return false;
}
