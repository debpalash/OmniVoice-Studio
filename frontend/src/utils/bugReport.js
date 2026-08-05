/**
 * bugReport — shared builder for the prefilled GitHub Issues URL.
 *
 * Single source of truth for everything that can leave the machine as a
 * bug report: ReportBugButton (Settings → About), the ErrorBoundary's
 * "Report this bug" action, and error toasts all funnel through
 * `buildBugReportUrl()`. The user always reviews the prefilled form on
 * github.com before anything is submitted — we never POST, never hold a
 * token (CLAUDE.md Capability 2).
 *
 * Everything assembled here is scrubbed with `scrubText` (utils/scrub.js —
 * the frontend twin of backend/core/scrub.py), which must stay at least as
 * strict for the shapes a webview can see (home paths + credential-shaped
 * substrings; env vars aren't reachable from JS).
 */
/* global __APP_VERSION__ -- injected by Vite at build time (vite.config define) */
import { API } from '../api/client';
import { formatBreadcrumbs } from './breadcrumbs';
import { crashAge, describeCrashExit, getLastBackendCrash } from './backendCrash';
import { contactAge, lastBackendContact } from './backendContact';
import { deploymentMode } from './deploymentMode';

/** Canonical project repository — every GitHub link in the app derives from
 * this single constant so a fork/rename can never leave stale links behind. */
export const REPO_URL = 'https://github.com/debpalash/OmniVoice-Studio';

export const ISSUES_URL = `${REPO_URL}/issues/new`;

const APP_VERSION = (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) || 'unknown';

// The scrub primitives live in utils/scrub.js (#1177) so transport-layer code
// (api/client.ts) can scrub without importing this module — bugReport imports
// client for `API`, so the reverse static import would be a cycle. Re-exported
// here because every existing caller (and bugReport.test.js) imports them from
// this module.
export { REDACTED, scrubText } from './scrub';
import { scrubText } from './scrub';

// GitHub truncates very long prefill URLs; keep the encoded result well
// under the ~8k practical ceiling so the user never loses the form.
const MAX_STACK_CHARS = 1800;
const MAX_MSG_CHARS = 1200;
// Crash-marker stderr tail budget (#941) — keep the newest end (the actual
// traceback/abort), the head is uvicorn boot noise.
const MAX_CRASH_TAIL_CHARS = 1200;
// The real ceiling is on the URL-ENCODED body, not the raw string: markdown
// encodes ~1.3–1.6× larger (newlines→%0A, spaces→%20, backticks/#//), so a
// 6000-char raw body can be ~9k encoded and blow past GitHub's limit. Bound
// the encoded length directly.
const MAX_ENCODED_BODY = 7000;

/** Trim `text` so its URL-encoded length is ≤ maxEncoded (binary search on
 *  the raw cut point — exact, and cheap for report-sized strings). */
function fitEncoded(text, maxEncoded) {
  if (encodeURIComponent(text).length <= maxEncoded) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encodeURIComponent(text.slice(0, mid)).length <= maxEncoded) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}\n… (truncated)`;
}

/** Bound every context fetch: a backend that accepts the socket and then
 * stalls must not pin the report button / error-toast / boundary flow on the
 * browser's full network timeout — partial context beats a hung report. */
async function fetchJsonWithTimeout(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    return r.ok ? await r.json() : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Environment lines for the report body. Best-effort — every fetch is
 * optional so a dead backend still yields a usable report. */
async function captureContext() {
  const lines = [
    `**Version:** \`${APP_VERSION}\``,
    `**Platform:** \`${navigator?.userAgent || 'unknown'}\``,
  ];

  try {
    const j = await fetchJsonWithTimeout(`${API}/system/info`);
    if (j) {
      if (j?.os_version) lines.push(`**OS:** \`${scrubText(j.os_version)}\``);
      else if (j?.platform) lines.push(`**OS:** \`${j.platform}\``);
      if (j?.python) lines.push(`**Python:** \`${j.python}\``);
      if (j?.device) lines.push(`**Compute device:** \`${scrubText(j.device)}\``);
      if (j?.gpu_name) {
        const vram = j?.vram_total_gb ? ` (${j.vram_total_gb} GB VRAM)` : '';
        lines.push(`**GPU:** \`${scrubText(j.gpu_name)}${vram}\``);
      }
      if (j?.cpu_model) lines.push(`**CPU:** \`${scrubText(j.cpu_model)}\``);
      if (j?.ram_total_gb) lines.push(`**RAM:** \`${j.ram_total_gb} GB\``);
      if (j?.disk_free_gb) lines.push(`**Disk free:** \`${j.disk_free_gb} GB\``);
    }
  } catch {
    /* backend down, stalled, or timed out — partial context is fine */
  }

  try {
    const j = await fetchJsonWithTimeout(`${API}/engines`);
    const active = j?.tts?.active;
    if (active) lines.push(`**Active TTS engine:** \`${active}\``);
  } catch {
    /* noop */
  }

  return lines.join('\n');
}

/** "## Last backend crash" section from the desktop shell's crash marker
 * (#941): exit code/signal + scrubbed stderr tail, so a "backend became
 * unreachable" report arrives WITH the evidence instead of needing a
 * logs-please round-trip. Empty outside Tauri or when nothing ever crashed.
 * The marker's age is stated so a stale (possibly unrelated) crash can't
 * masquerade as fresh evidence. */
async function captureCrashSection() {
  let marker = null;
  try {
    marker = await getLastBackendCrash();
  } catch {
    /* shell forensics unavailable */
  }
  if (!marker) return [];
  let tail = scrubText(marker.last_stderr || '').trim();
  if (tail.length > MAX_CRASH_TAIL_CHARS) {
    tail = `… (truncated)\n${tail.slice(-MAX_CRASH_TAIL_CHARS)}`;
  }
  return [
    '## Last backend crash (auto-captured — may predate this bug)',
    '',
    `**When:** ${new Date(marker.ts * 1000).toISOString()} (${crashAge(marker)} ago)`,
    `**Exit:** \`${describeCrashExit(marker)}\``,
    `**Uptime before crash:** ${marker.uptime_s} s`,
    `**Backend version:** \`${marker.backend_version}\``,
    '',
    '```',
    // An empty code block reads as "there was nothing to report" and produces
    // an issue nobody can answer (#1375). Say what is missing and where the
    // reporter can get it, so the report asks for the right thing up front.
    tail ||
      '(no output was captured for this crash — please paste the last ~100 ' +
        'lines of Settings → Logs → Backend here)',
    '```',
    '',
  ];
}

/** "## Backend reachability" section (#1164): which deployment this is, and
 * whether/when the backend last answered — the two facts that split every
 * "can't reach the backend" report into diagnosable halves (crashed
 * mid-session vs never started). When the report is built from a transport
 * ApiError, its structured detail (mode at failure time, first failure,
 * retry attempts) rides along too. All values are mode ids, timestamps, and
 * counts — nothing user-generated — but scrubbed anyway as belt-and-braces. */
function captureReachabilitySection(error) {
  const lines = ['## Backend reachability', ''];
  try {
    lines.push(`**Deployment mode:** \`${deploymentMode()}\``);
    const last = lastBackendContact();
    lines.push(
      last != null
        ? `**Last backend response:** ${contactAge(last)} before this report`
        : '**Last backend response:** none this session — it may never have started',
    );
    const d = error?.detail;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      if (typeof d.firstFailureTs === 'number' && d.firstFailureTs > 0) {
        lines.push(`**First failure:** ${new Date(d.firstFailureTs).toISOString()}`);
      }
      if (typeof d.attempts === 'number') {
        lines.push(`**Attempts before giving up:** ${d.attempts}`);
      }
      if (typeof d.mode === 'string' && d.mode) {
        lines.push(`**Mode at failure time:** \`${scrubText(d.mode)}\``);
      }
      if (typeof d.transport === 'string' && d.transport) {
        lines.push(`**Transport error:** \`${scrubText(d.transport).slice(0, 200)}\``);
      }
    }
  } catch {
    /* reachability context is best-effort — never block the report */
  }
  lines.push('');
  return lines;
}

/**
 * Build the prefilled GitHub Issues URL.
 *
 * @param {object} [opts]
 * @param {string} [opts.title]  Issue title prefill (defaults to '[Bug] ').
 * @param {Error|string} [opts.error]  Error to embed — message + stack are
 *   scrubbed and truncated into an "## Error" section so the report opens
 *   with the actual failure attached.
 */
export async function buildBugReportUrl({ title = '[Bug] ', error } = {}) {
  const ctx = await captureContext();
  // getLastBackendCrash inside captureCrashSection covers every deployment:
  // the desktop shell's marker, or (browser/dev/Docker) the backend's
  // run-sentinel record via its HTTP fallback — usually unfetchable while
  // the backend is still down, which is why the reachability section below
  // reports the CACHED last-contact data regardless.
  const crashSection = await captureCrashSection();
  const reachabilitySection = captureReachabilitySection(error);

  const errorSection = [];
  if (error) {
    const msg = scrubText(error?.message || String(error));
    // Seed the title with the failure so the issue list stays scannable;
    // the user can still edit it on github.com before submitting.
    if (title === '[Bug] ' && msg) title = `[Bug] ${msg.slice(0, 80)}`;
    // Cap the message in the body too — a large payload (validation dump,
    // HTML/JSON response body) would otherwise inflate the report past the
    // encoded URL ceiling.
    const msgForBody =
      msg.length > MAX_MSG_CHARS ? `${msg.slice(0, MAX_MSG_CHARS)}\n… (truncated)` : msg;
    let stack = error?.stack ? scrubText(error.stack) : '';
    if (stack.length > MAX_STACK_CHARS) stack = `${stack.slice(0, MAX_STACK_CHARS)}\n… (truncated)`;
    errorSection.push(
      '## Error',
      '',
      '```',
      msgForBody,
      ...(stack && stack !== msgForBody ? [stack] : []),
      '```',
      '',
    );
  }

  // Action names only (see utils/breadcrumbs.js privacy rules) — still
  // scrubbed as belt-and-braces, and the user reviews it all on github.com.
  const crumbs = scrubText(formatBreadcrumbs());
  const crumbSection = crumbs ? ['## Recent actions', '', '```', crumbs, '```', ''] : [];

  let body = [
    '<!-- Click Submit at the bottom of this page to file the issue.',
    '     Review the auto-captured environment info below and add anything',
    '     about what you were doing when the bug happened. -->',
    '',
    '## Describe the bug',
    '',
    '<!-- e.g. "Synthesize failed in Design mode after picking Narrator personality" -->',
    '',
    ...errorSection,
    '## Environment',
    '',
    ctx,
    '',
    ...reachabilitySection,
    ...crashSection,
    ...crumbSection,
    '## What I was doing',
    '',
    '<!-- step-by-step would help us reproduce -->',
    '',
  ].join('\n');
  body = fitEncoded(body, MAX_ENCODED_BODY);

  return `${ISSUES_URL}?title=${encodeURIComponent(title)}&labels=${encodeURIComponent('bug')}&body=${encodeURIComponent(body)}`;
}

/**
 * GitHub issue-search URL for "has someone already hit this?" — opened in
 * the user's browser before they file a duplicate. Search terms come from
 * the scrubbed error message with noise (numbers, paths, quotes) stripped
 * so the query matches across machines.
 */
export function buildIssueSearchUrl(error) {
  const msg = scrubText(error?.message || String(error || ''));
  const terms = msg
    .replace(/[^a-zA-Z\s]/g, ' ') // drop numbers/punctuation — machine-specific
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 6)
    .join(' ');
  const q = `is:issue ${terms}`.trim();
  return `${REPO_URL}/issues?q=${encodeURIComponent(q)}`;
}
