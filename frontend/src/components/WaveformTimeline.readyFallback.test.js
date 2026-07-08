import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Regression guard: the dub editor's play button stayed permanently disabled
// (disabled={!ready}) whenever the initial WaveSurfer decode failed and the
// component fell back to a peaks-only ws.load(undefined, [peaks], duration)
// call — the waveform still rendered from those peaks (so nothing looked
// visibly broken), but `ready` was only ever set from the 'ready' event
// re-firing on that recovery load, which this component's own error-handling
// code never actually confirmed. Each fallback load must now explicitly
// confirm readiness once it settles, instead of assuming the event fires.
//
// Driving WaveSurfer + a real decode-failure/recovery sequence through jsdom
// is brittle (see WaveformTimeline.unlock.test.js), so this is a
// source-level contract guard, same house pattern: every `ws.load(undefined,
// ...)` recovery call inside the `ws.on('error', ...)` handler must be
// followed by an explicit setReady(true) confirmation.

const src = readFileSync(
  path.resolve(process.cwd(), 'src/components/WaveformTimeline.jsx'),
  'utf8',
);

describe('WaveformTimeline error-recovery ready confirmation', () => {
  it("confirms readiness explicitly after every fallback ws.load() call, not just via the 'ready' event", () => {
    const errorHandler = /ws\.on\('error', \(err\) => \{([\s\S]*?)\n    \}\);/.exec(src)?.[1];
    expect(errorHandler, "ws.on('error', ...) handler not found").toBeTruthy();

    // Every recovery load in this handler passes peaks explicitly
    // (`ws.load(undefined, [...], ...)`) — each occurrence must be
    // immediately confirmed ready via a .then()/.catch() pair (or an
    // unconditional setReady in a synchronous catch), not left to hope the
    // 'ready' event re-fires on its own.
    const loadCalls = [...errorHandler.matchAll(/ws\.load\(undefined, \[[^\]]*\][^)]*\)/g)];
    expect(loadCalls.length).toBeGreaterThanOrEqual(3);

    for (const match of loadCalls) {
      const tail = errorHandler.slice(match.index, match.index + 220);
      expect(tail, `no readiness confirmation after: ${match[0]}`).toMatch(/setReady\(true\)/);
    }
  });
});
