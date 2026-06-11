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
 * `scrubText` is the frontend twin of backend/core/scrub.py and must stay
 * at least as strict for the shapes a webview can see (home paths +
 * credential-shaped substrings; env vars aren't reachable from JS).
 */
/* global __APP_VERSION__ -- injected by Vite at build time (vite.config define) */
import { API } from '../api/client';
import { formatBreadcrumbs } from './breadcrumbs';

export const ISSUES_URL = 'https://github.com/debpalash/OmniVoice-Studio/issues/new';

const APP_VERSION = (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) || 'unknown';

export const REDACTED = '***REDACTED***';

// Thresholds mirror backend/core/scrub.py: long enough that identifiers
// like `hf_hub` or `sk-learn` survive, short enough that real tokens don't.
const TOKEN_PATTERNS = [
  /hf_[A-Za-z0-9]{30,}/g,            // HuggingFace
  /github_pat_[A-Za-z0-9_]{20,}/g,   // GitHub fine-grained PAT
  /gh[pousr]_[A-Za-z0-9]{30,}/g,     // GitHub classic tokens
  /sk-[A-Za-z0-9_-]{20,}/g,          // OpenAI-style API keys
];

const HOME_PATTERNS = [
  // Windows-with-forward-slashes must run BEFORE the bare macOS shape, or
  // `/Users/<name>` inside `C:/Users/<name>` gets eaten first, leaving `C:~`.
  /(?:file:\/\/\/)?[A-Za-z]:\/Users\/[^/\s"']+/g, // Windows, forward slashes (webview stacks, file:/// URLs)
  /\/Users\/[^/\s"']+/g,                       // macOS
  /\/home\/[^/\s"']+/g,                        // Linux
  /[A-Za-z]:\\Users\\[^\\\s"']+/g,             // Windows, backslashes
];

/** Redact credential-shaped substrings and home directories. */
export function scrubText(text) {
  if (text == null) return '';
  let s = String(text);
  for (const pat of TOKEN_PATTERNS) s = s.replace(pat, REDACTED);
  for (const pat of HOME_PATTERNS) s = s.replace(pat, '~');
  return s;
}

// GitHub truncates very long prefill URLs; keep the encoded result well
// under the ~8k practical ceiling so the user never loses the form.
const MAX_STACK_CHARS = 1800;
const MAX_BODY_CHARS = 6000;

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
export async function captureContext() {
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
  } catch { /* backend down, stalled, or timed out — partial context is fine */ }

  try {
    const j = await fetchJsonWithTimeout(`${API}/engines`);
    const active = j?.tts?.active;
    if (active) lines.push(`**Active TTS engine:** \`${active}\``);
  } catch { /* noop */ }

  return lines.join('\n');
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

  const errorSection = [];
  if (error) {
    const msg = scrubText(error?.message || String(error));
    // Seed the title with the failure so the issue list stays scannable;
    // the user can still edit it on github.com before submitting.
    if (title === '[Bug] ' && msg) title = `[Bug] ${msg.slice(0, 80)}`;
    let stack = error?.stack ? scrubText(error.stack) : '';
    if (stack.length > MAX_STACK_CHARS) stack = `${stack.slice(0, MAX_STACK_CHARS)}\n… (truncated)`;
    errorSection.push(
      '## Error',
      '',
      '```',
      msg,
      ...(stack && stack !== msg ? [stack] : []),
      '```',
      '',
    );
  }

  // Action names only (see utils/breadcrumbs.js privacy rules) — still
  // scrubbed as belt-and-braces, and the user reviews it all on github.com.
  const crumbs = scrubText(formatBreadcrumbs());
  const crumbSection = crumbs
    ? ['## Recent actions', '', '```', crumbs, '```', '']
    : [];

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
    ...crumbSection,
    '## What I was doing',
    '',
    '<!-- step-by-step would help us reproduce -->',
    '',
  ].join('\n');
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n… (truncated)`;

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
    .replace(/[^a-zA-Z\s]/g, ' ')      // drop numbers/punctuation — machine-specific
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 6)
    .join(' ');
  const q = `is:issue ${terms}`.trim();
  return `https://github.com/debpalash/OmniVoice-Studio/issues?q=${encodeURIComponent(q)}`;
}
