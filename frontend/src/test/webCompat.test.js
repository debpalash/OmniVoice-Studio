/**
 * #1245: the app was dead on arrival on macOS 12 (Monterey).
 *
 * The reporter's whole session was one line — `view:launchpad` — and
 * "Last backend response: none this session — it may never have started".
 * The stack is a React render throwing:
 *
 *     AbortSignal.timeout is not a function.
 *     (In 'AbortSignal.timeout(2e3)', 'AbortSignal.timeout' is undefined)
 *
 * `useRealtimeEvents` polls backend health with `AbortSignal.timeout(2000)`
 * on mount. That method arrived in Safari 16.0; `tauri.conf.json` declares
 * `minimumSystemVersion: "12.0"` and `docs/install/macos.md` promises macOS 12,
 * which ships WKWebView **15.6**. So this was not an exotic environment — it
 * was the floor we advertise.
 *
 * Two halves are pinned:
 *  1. the polyfill behaves like the real thing (aborts, and with TimeoutError);
 *  2. no app module reaches for a post-floor API that nothing fills in — the
 *     whole class, not just the one method that got reported.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { installAbortSignalTimeout } from '../utils/webCompat.js';

const SRC = path.resolve(__dirname, '..');

describe('AbortSignal.timeout polyfill', () => {
  let original;

  beforeEach(() => {
    vi.useFakeTimers();
    original = AbortSignal.timeout;
  });

  afterEach(() => {
    vi.useRealTimers();
    AbortSignal.timeout = original;
  });

  it('fills the method in when the WebView lacks it', () => {
    // Reproduce Monterey: the method is simply absent.
    delete AbortSignal.timeout;
    expect(AbortSignal.timeout).toBeUndefined();

    installAbortSignalTimeout();
    expect(typeof AbortSignal.timeout).toBe('function');
  });

  it('aborts after the delay, with a TimeoutError reason', () => {
    delete AbortSignal.timeout;
    installAbortSignalTimeout();

    const signal = AbortSignal.timeout(2000);
    expect(signal.aborted).toBe(false);

    vi.advanceTimersByTime(1999);
    expect(signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    // `reason` is how a caller tells a timeout apart from a user cancel.
    expect(signal.reason?.name).toBe('TimeoutError');
  });

  it('does not clobber a native implementation', () => {
    const native = vi.fn(() => new AbortController().signal);
    AbortSignal.timeout = native;

    installAbortSignalTimeout();

    expect(AbortSignal.timeout).toBe(native);
  });

  it('is installed before the app boots', () => {
    // The gap fill is worthless if it loads after the chunk that throws.
    const main = fs.readFileSync(path.join(SRC, 'main.jsx'), 'utf8');
    const compat = main.indexOf('utils/webCompat');
    const app = main.indexOf('main-app.jsx');
    expect(compat).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(-1);
    expect(compat).toBeLessThan(app);
  });
});

/**
 * The recurrence guard. `AbortSignal.timeout` was not special — it was
 * whichever post-floor API we happened to reach for first. Each entry is an
 * API that does NOT exist in Safari 15.6 (our declared macOS floor) and that
 * `webCompat.js` does not fill in, so using one would break Monterey exactly
 * the way #1245 did.
 *
 * To use one of these: either fill it in inside `webCompat.js` and delete the
 * entry, or guard the call site with a runtime check and a fallback.
 */
const POST_FLOOR_APIS = [
  // Safari 17.4
  { pattern: /\bAbortSignal\s*\.\s*any\b/, name: 'AbortSignal.any', since: 'Safari 17.4' },
  { pattern: /\bObject\s*\.\s*groupBy\b/, name: 'Object.groupBy', since: 'Safari 17.4' },
  { pattern: /\bMap\s*\.\s*groupBy\b/, name: 'Map.groupBy', since: 'Safari 17.4' },
  {
    pattern: /\bPromise\s*\.\s*withResolvers\b/,
    name: 'Promise.withResolvers',
    since: 'Safari 17.4',
  },
  // Safari 17.0
  { pattern: /\bURL\s*\.\s*canParse\b/, name: 'URL.canParse', since: 'Safari 17.0' },
  { pattern: /\.isWellFormed\s*\(/, name: 'String#isWellFormed', since: 'Safari 17.0' },
  // Safari 16.4
  { pattern: /\.toSorted\s*\(/, name: 'Array#toSorted', since: 'Safari 16.4' },
  { pattern: /\.toReversed\s*\(/, name: 'Array#toReversed', since: 'Safari 16.4' },
  { pattern: /\.toSpliced\s*\(/, name: 'Array#toSpliced', since: 'Safari 16.4' },
  // Safari 16.0 — the one that actually bit us; listed so removing the
  // polyfill without removing the call sites fails here too.
  { pattern: /\bAbortSignal\s*\.\s*timeout\b/, name: 'AbortSignal.timeout', since: 'Safari 16.0' },
];

/** Entries `webCompat.js` fills in, so app code may use them freely. */
const POLYFILLED = new Set(['AbortSignal.timeout']);

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

describe('no app code depends on an API newer than the macOS floor', () => {
  it('matches the floor tauri.conf.json and the install docs promise', () => {
    const conf = JSON.parse(
      fs.readFileSync(path.resolve(SRC, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'),
    );
    // If the floor is ever raised, this list should be re-derived — the test
    // is only as correct as the version it is written against.
    expect(conf.bundle?.macOS?.minimumSystemVersion).toBe('12.0');
  });

  it('uses no unfilled post-Safari-15.6 API', () => {
    const offenders = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(path.join('utils', 'webCompat.js'))) continue;
      const src = fs.readFileSync(file, 'utf8');
      for (const api of POST_FLOOR_APIS) {
        if (POLYFILLED.has(api.name)) continue;
        if (api.pattern.test(src)) {
          offenders.push(`${path.relative(SRC, file)} uses ${api.name} (${api.since})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still guards the API that broke Monterey', () => {
    // Sanity: AbortSignal.timeout IS used by app code, so the exemption above
    // is load-bearing — if the polyfill is deleted the exemption must go too.
    const users = walk(SRC).filter(
      (f) =>
        !f.endsWith(path.join('utils', 'webCompat.js')) &&
        /\bAbortSignal\s*\.\s*timeout\b/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(users.length).toBeGreaterThan(0);

    const compat = fs.readFileSync(path.join(SRC, 'utils', 'webCompat.js'), 'utf8');
    expect(compat).toMatch(/AbortSignal\.timeout\s*=/);
  });
});
