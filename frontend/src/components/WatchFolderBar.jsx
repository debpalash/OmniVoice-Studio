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

  const sourceRef = useRef(null);
  const trackerRef = useRef(null);
  const pausedRef = useRef(false);
  const tickingRef = useRef(false);
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
    try {
      const next = await openWatchSource();
      if (!next) return; // picker cancelled
      const tracker = createIngestTracker();
      // Files already sitting in the folder are not "new" — only arrivals
      // after this point get enqueued.
      tracker.prime(await next.listEntries());
      sourceRef.current = next;
      trackerRef.current = tracker;
      setAdded(0);
      setPaused(false);
      setSource(next);
      toast.success(t('batch.watch_started', { folder: next.label }));
    } catch (e) {
      if (e?.code === 'watch-unsupported') {
        toast.error(t('batch.watch_unsupported'));
      } else {
        // Actionable message for the user; raw detail to the console only.
        console.warn('watch folder start failed', e);
        toast.error(t('batch.watch_start_failed'));
      }
    }
  }, [t]);

  const tick = useCallback(async () => {
    const src = sourceRef.current;
    const tracker = trackerRef.current;
    if (!src || !tracker || pausedRef.current || tickingRef.current) return;
    tickingRef.current = true;
    try {
      const fresh = tracker.next(await src.listEntries());
      const files = [];
      for (const entry of fresh) {
        try {
          files.push(await src.readFile(entry));
        } catch {
          // Vanished or changed between scan and read — skip; a changed file
          // re-settles under its new name+size+mtime key on later scans.
        }
      }
      // The user may have paused (or stopped) while the awaits above were in
      // flight — nothing may enter the queue after the UI says paused. Hand
      // the released entries back so they ingest on the next unpaused poll.
      if (pausedRef.current || sourceRef.current !== src) {
        for (const entry of fresh) tracker.unsee(entry);
        return;
      }
      if (files.length) {
        await onIngest(files);
        setAdded((n) => n + files.length);
      }
    } catch (e) {
      // The folder itself became unreadable (unmounted, deleted, permission
      // revoked) — stop loudly rather than failing silently every 5s.
      if (sourceRef.current === src) {
        console.warn('watch folder scan failed', e);
        stop();
        toast.error(t('batch.watch_failed'));
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
  useEffect(() => () => sourceRef.current?.close(), []);

  if (!source) {
    return (
      <Button variant="subtle" size="sm" onClick={start} leading={<FolderOpen size={11} />}>
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
