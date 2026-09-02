import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }));

import {
  createIngestTracker,
  entryKey,
  isVideoFile,
  openWatchSource,
  videoMimeFor,
} from './watchFolder';

const entry = (name, size = 100, mtime = 1000) => ({ name, size, mtime });

describe('isVideoFile', () => {
  it('accepts common video containers, case-insensitively', () => {
    for (const name of ['a.mp4', 'B.MOV', 'c.mkv', 'd.WebM', 'e.avi', 'f.m4v']) {
      expect(isVideoFile(name), name).toBe(true);
    }
  });

  it('rejects non-video and extension-less names', () => {
    for (const name of ['notes.txt', 'audio.wav', 'subs.srt', 'noext', '.mp4', '']) {
      expect(isVideoFile(name), name).toBe(false);
    }
  });
});

describe('entryKey — dedup identity is name+size+mtime', () => {
  it('is stable for identical entries and distinct when any part changes', () => {
    expect(entryKey(entry('a.mp4', 10, 1))).toBe(entryKey(entry('a.mp4', 10, 1)));
    const base = entryKey(entry('a.mp4', 10, 1));
    expect(entryKey(entry('b.mp4', 10, 1))).not.toBe(base);
    expect(entryKey(entry('a.mp4', 11, 1))).not.toBe(base);
    expect(entryKey(entry('a.mp4', 10, 2))).not.toBe(base);
  });
});

describe('createIngestTracker', () => {
  it('never re-ingests primed (pre-existing) files', () => {
    const tracker = createIngestTracker();
    tracker.prime([entry('old.mp4')]);
    expect(tracker.next([entry('old.mp4')])).toEqual([]);
    expect(tracker.next([entry('old.mp4')])).toEqual([]);
  });

  it('releases a new file only after two scans agree (copy-in-progress guard)', () => {
    const tracker = createIngestTracker();
    tracker.prime([]);
    expect(tracker.next([entry('new.mp4', 10, 1)])).toEqual([]); // first sighting
    expect(tracker.next([entry('new.mp4', 10, 1)])).toEqual([entry('new.mp4', 10, 1)]);
    // …and exactly once: later identical scans are deduped.
    expect(tracker.next([entry('new.mp4', 10, 1)])).toEqual([]);
    expect(tracker.next([entry('new.mp4', 10, 1)])).toEqual([]);
  });

  it('keeps waiting while a file is still growing', () => {
    const tracker = createIngestTracker();
    expect(tracker.next([entry('big.mp4', 10, 1)])).toEqual([]);
    expect(tracker.next([entry('big.mp4', 20, 2)])).toEqual([]); // changed → not stable
    expect(tracker.next([entry('big.mp4', 30, 3)])).toEqual([]);
    expect(tracker.next([entry('big.mp4', 30, 3)])).toEqual([entry('big.mp4', 30, 3)]);
  });

  it('ignores non-video files entirely', () => {
    const tracker = createIngestTracker();
    expect(tracker.next([entry('readme.txt')])).toEqual([]);
    expect(tracker.next([entry('readme.txt')])).toEqual([]);
  });

  it('a rewritten file (same name, new size/mtime) is ingested again', () => {
    const tracker = createIngestTracker();
    tracker.prime([entry('take.mp4', 10, 1)]);
    expect(tracker.next([entry('take.mp4', 99, 2)])).toEqual([]);
    expect(tracker.next([entry('take.mp4', 99, 2)])).toEqual([entry('take.mp4', 99, 2)]);
  });

  it('forgets a pending file that vanishes before settling', () => {
    const tracker = createIngestTracker();
    expect(tracker.next([entry('gone.mp4', 10, 1)])).toEqual([]);
    expect(tracker.next([])).toEqual([]); // vanished mid-copy
    // Reappears: must settle across two fresh scans again.
    expect(tracker.next([entry('gone.mp4', 10, 1)])).toEqual([]);
    expect(tracker.next([entry('gone.mp4', 10, 1)])).toEqual([entry('gone.mp4', 10, 1)]);
  });
});

describe('openWatchSource — Tauri backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
  });

  it('returns null when the native picker is cancelled', async () => {
    invoke.mockResolvedValueOnce(null);
    expect(await openWatchSource()).toBeNull();
    expect(invoke).toHaveBeenCalledWith('watch_folder_pick');
  });

  it('reads watched entries back as File objects and only ever sends the session token + bare name over IPC', async () => {
    const token = 'f'.repeat(64);
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'watch_folder_pick') return { token, path: '/Users/me/Watched Drop' };
      if (cmd === 'watch_folder_scan') return [{ name: 'clip.mp4', size: 4, mtime: 1234 }];
      if (cmd === 'watch_folder_read') return new TextEncoder().encode('vid!').buffer;
      return undefined;
    });

    const source = await openWatchSource();
    expect(source.label).toBe('Watched Drop');

    const entries = await source.listEntries();
    expect(entries).toEqual([{ name: 'clip.mp4', size: 4, mtime: 1234 }]);

    const file = await source.readFile(entries[0]);
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('clip.mp4');
    expect(file.size).toBe(4);
    expect(file.type).toBe('video/mp4');
    expect(await file.text()).toBe('vid!');

    source.close();
    expect(invoke).toHaveBeenCalledWith('watch_folder_forget', { token });

    // The scan/read/forget IPC calls carry the opaque token and a bare file
    // name — never a directory path (paths must not leave the pick reply).
    for (const [cmd, args] of invoke.mock.calls) {
      if (cmd === 'watch_folder_pick') continue;
      expect(JSON.stringify(args)).not.toContain('/Users/me');
      expect(JSON.stringify(args)).not.toContain('Watched Drop');
    }
    expect(invoke).toHaveBeenCalledWith('watch_folder_read', { token, name: 'clip.mp4' });
  });
});

describe('openWatchSource — unsupported web context', () => {
  it('throws an identifiable watch-unsupported error where no folder access exists', async () => {
    delete window.__TAURI_INTERNALS__;
    delete window.showDirectoryPicker;
    await expect(openWatchSource()).rejects.toMatchObject({ code: 'watch-unsupported' });
  });
});

describe('videoMimeFor', () => {
  it('maps known containers and falls back to octet-stream', () => {
    expect(videoMimeFor('a.mp4')).toBe('video/mp4');
    expect(videoMimeFor('a.mov')).toBe('video/quicktime');
    expect(videoMimeFor('a.unknown')).toBe('application/octet-stream');
  });
});
