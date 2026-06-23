import { describe, it, expect } from 'vitest';
import { aggregate, fmtBytes, fmtRate } from '../components/WizardLibrary.jsx';

describe('aggregate — download telemetry from SSE file events', () => {
  it('sums bytes, computes pct, remaining, rate and ETA', () => {
    const files = {
      'a.bin': { downloaded: 500, total: 1000, rate: 100 },
      'b.bin': { downloaded: 250, total: 1000, rate: 150 },
    };
    const { pct, remaining, rate, etaSec } = aggregate(files);
    expect(pct).toBe(38);                 // 750 / 2000
    expect(remaining).toBe(1250);         // 2000 - 750
    expect(rate).toBe(250);               // both still downloading
    expect(etaSec).toBeCloseTo(5, 5);     // 1250 / 250
  });

  it('drops rate from already-complete files (no negative/idle ETA)', () => {
    const files = {
      done: { downloaded: 1000, total: 1000, rate: 999 },   // complete → rate ignored
      live: { downloaded: 0, total: 1000, rate: 200 },
    };
    const { rate, remaining, etaSec } = aggregate(files);
    expect(rate).toBe(200);
    expect(remaining).toBe(1000);
    expect(etaSec).toBeCloseTo(5, 5);
  });

  it('returns nulls before any totals arrive (degrades to "downloading…")', () => {
    expect(aggregate({}).pct).toBeNull();
    expect(aggregate({}).remaining).toBeNull();
    expect(aggregate(undefined).pct).toBeNull();
  });
});

describe('fmtBytes / fmtRate', () => {
  it('formats remaining size in MB/GB', () => {
    expect(fmtBytes(700 * 1024 * 1024)).toBe('700 MB');
    expect(fmtBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
    expect(fmtBytes(0)).toBe('');
    expect(fmtBytes(null)).toBe('');
  });

  it('formats rate in MB/s or KB/s, blank when idle', () => {
    expect(fmtRate(5.2 * 1024 * 1024)).toBe('5.2 MB/s');
    expect(fmtRate(512 * 1024)).toBe('512 KB/s');
    expect(fmtRate(0)).toBe('');
  });
});
