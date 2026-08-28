import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Regression guard: the dub editor's play button stayed permanently disabled
// (disabled={!ready}) whenever the initial WaveSurfer decode failed and the
// component fell back to a peaks-only ws.load(undefined, peaks, duration)
// call. WaveSurfer 7 clears the attached media element's src for that call,
// so the waveform rendered while the transport became silent (#1692).
// Recovery must retain a concrete source, switch a failed video transport to
// companion audio, and explicitly confirm readiness once loading settles.
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

describe('WaveformTimeline audible error recovery', () => {
  it('never clears the media src while loading recovered peaks', () => {
    expect(src).not.toContain('ws.load(undefined');
    expect(src).toMatch(/ws\.load\(fallbackSource, peaks, fallbackDuration\)/);
  });

  it('moves playback to companion audio and synchronizes the visual video', () => {
    expect(src).toContain('ws.setMediaElement(fallbackAudioEl)');
    expect(src).toContain('mediaElRef.current = fallbackAudioEl');
    expect(src).toContain("fallbackAudioEl.addEventListener('play', playVideo)");
    expect(src).toContain("fallbackAudioEl.addEventListener('seeking', seekVideo)");
    expect(src).toContain("fallbackAudioEl.addEventListener('timeupdate', trackVideo)");
  });

  it("confirms readiness explicitly after every fallback ws.load() call, not just via the 'ready' event", () => {
    const errorHandler = /ws\.on\('error', \(err\) => \{([\s\S]*?)\n    \}\);/.exec(src)?.[1];
    expect(errorHandler, "ws.on('error', ...) handler not found").toBeTruthy();

    const loadCalls = [...errorHandler.matchAll(/loadRecoveredPeaks\([^;]+/g)];
    expect(loadCalls.length).toBeGreaterThanOrEqual(3);

    for (const match of loadCalls) {
      const tail = errorHandler.slice(match.index, match.index + 220);
      expect(tail, `no readiness confirmation after: ${match[0]}`).toMatch(/setReady\(true\)/);
    }
  });
});
