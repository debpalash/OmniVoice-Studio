import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Pause, Play, Square } from 'lucide-react';
import { Badge, Button } from '../ui';
import toast from 'react-hot-toast';
import { createIngestTracker, openWatchSource, WATCH_POLL_MS } from '../utils/watchFolder';

/**
 * WatchFolderBar — opt-in "watch a folder" controls for the batch queue
 * (extracted from BatchQueue so the page stays focused on the job list).
 *
 * Pick a directory once; every ~5s the source is rescanned and new, settled
 * video files are handed to `onIngest(files)` as File objects — the exact
 * same shape the Add-to-queue dialog produces. Dedup (name+size+mtime),
 * pause/resume, and stop-on-unmount live here; the actual enqueue (and its
 * language/voice settings) stays with the parent.
 */
export default function WatchFolderBar({ onIngest }) {
  const { t } = useTranslation();
  const [source, setSource] = useState(null);
  const [paused, setPaused] = useState(false);
  const [added, setAdded] = useState(0);
  const [starting, setStarting] = useState(false);

  const sourceRef = useRef(null);
  const trackerRef = useRef(null);
  const pausedRef = useRef(false);
  const tickingRef = useRef(false);
  const mountedRef = useRef(true);
  const startingRef = useRef(false);
  const startSequenceRef = useRef(0);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const stop = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    trackerRef.current = null;
    setSource(null);
    setPaused(false);
    setAdded(0);
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    const sequence = ++startSequenceRef.current;
    let next = null;
    try {
      next = await openWatchSource();
      if (!next) return; // picker cancelled
      const tracker = createIngestTracker();
      // Files already sitting in the folder are not "new" — only arrivals
      // after this point get enqueued.
      tracker.prime(await next.listEntries());
      if (!mountedRef.current || startSequenceRef.current !== sequence) {
        next.close();
        return;
      }
      sourceRef.current = next;
      trackerRef.current = tracker;
      setAdded(0);
      setPaused(false);
      setSource(next);
      toast.success(t('batch.watch_started', { folder: next.label }));
    } catch (e) {
      next?.close();
      if (mountedRef.current && startSequenceRef.current === sequence) {
        if (e?.code === 'watch-unsupported') {
          toast.error(t('batch.watch_unsupported'));
        } else {
          toast.error(t('batch.watch_failed', { message: e?.message || String(e) }));
        }
      }
    } finally {
      if (startSequenceRef.current === sequence) startingRef.current = false;
      if (mountedRef.current && startSequenceRef.current === sequence) setStarting(false);
    }
  }, [t]);

  const tick = useCallback(async () => {
    const src = sourceRef.current;
    const tracker = trackerRef.current;
    if (!src || !tracker || pausedRef.current || tickingRef.current) return;
    tickingRef.current = true;
    try {
      const fresh = tracker.next(await src.listEntries());
      const candidates = [];
      for (const entry of fresh) {
        try {
          const file = await src.readFile(entry);
          candidates.push({ entry, file });
        } catch {
          // A transient read/upload failure must not permanently consume the
          // entry. If it vanished, later scans simply clear it from pending.
          tracker.retry(entry);
        }
      }
      if (!candidates.length || sourceRef.current !== src) return;

      let accepted;
      try {
        accepted = await onIngest(candidates.map(({ file }) => file));
      } catch {
        for (const { entry } of candidates) tracker.retry(entry);
        return;
      }
      if (sourceRef.current !== src) return;

      let addedNow = 0;
      for (const { entry, file } of candidates) {
        // BatchQueue returns the exact File objects it accepted. Keep
        // undefined/true/positive-count compatible with simpler consumers.
        const wasAccepted =
          accepted instanceof Set ? accepted.has(file) : accepted !== false && accepted !== 0;
        if (wasAccepted) addedNow += 1;
        else tracker.retry(entry);
      }
      if (addedNow) setAdded((n) => n + addedNow);
    } catch (e) {
      // The folder itself became unreadable (unmounted, deleted, permission
      // revoked) — stop loudly rather than failing silently every 5s.
      if (sourceRef.current === src) {
        stop();
        toast.error(t('batch.watch_failed', { message: e?.message || String(e) }));
      }
    } finally {
      tickingRef.current = false;
    }
  }, [onIngest, stop, t]);

  useEffect(() => {
    if (!source) return undefined;
    const iv = setInterval(tick, WATCH_POLL_MS);
    return () => clearInterval(iv);
  }, [source, tick]);

  // Stop on unmount: release the native authorization and the poll timer.
  useEffect(
    () => () => {
      mountedRef.current = false;
      startSequenceRef.current += 1;
      sourceRef.current?.close();
    },
    [],
  );

  if (!source) {
    return (
      <Button
        variant="subtle"
        size="sm"
        onClick={start}
        disabled={starting}
        loading={starting}
        leading={!starting && <FolderOpen size={11} />}
      >
        {t('batch.watch_folder')}
      </Button>
    );
  }

  return (
    <div
      className="flex items-center gap-[var(--space-2)]"
      title={source.path}
      data-testid="watch-folder-active"
    >
      <Badge tone={paused ? 'warn' : 'brand'} dot>
        <FolderOpen size={10} />
        {paused
          ? t('batch.watch_paused', { folder: source.label })
          : t('batch.watching', { folder: source.label })}
      </Badge>
      <span className="text-[var(--text-xs)] text-fg-subtle [font-variant-numeric:tabular-nums]">
        {t('batch.watch_added', { count: added })}
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setPaused((p) => !p)}
        leading={paused ? <Play size={10} /> : <Pause size={10} />}
      >
        {paused ? t('batch.watch_resume') : t('batch.watch_pause')}
      </Button>
      <Button variant="ghost" size="xs" onClick={stop} leading={<Square size={10} />}>
        {t('batch.watch_stop')}
      </Button>
    </div>
  );
}
