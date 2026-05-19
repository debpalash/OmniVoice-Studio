import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, RefreshCw, CheckCircle, AlertCircle, Square, Circle,
  Trash2, Download, XCircle, Film, Globe,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Panel, Button, Badge, Tabs } from '../ui';
import {
  listBatchJobs, cancelBatchJob, deleteBatchJob, enqueueBatchJob,
} from '../api/batch';
import { API } from '../api/client';
import BatchAddDialog from '../components/BatchAddDialog';
import toast from 'react-hot-toast';
import './BatchQueue.css';

export default function BatchQueue({ onBack }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState('active');
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const TABS = useMemo(() => [
    { id: 'active', label: t('batch.active'), icon: Activity },
    { id: 'done', label: t('batch.completed'), icon: CheckCircle },
    { id: 'failed', label: t('batch.failed'), icon: AlertCircle },
  ], [t]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const statusParam = tab === 'active' ? 'active' : tab;
      setJobs(await listBatchJobs(statusParam, 100));
    } catch (e) {
      console.warn('batch queue load failed', e);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { reload(); }, [reload]);

  // Poll active tab every 3s for live progress
  useEffect(() => {
    if (tab !== 'active') return;
    const iv = setInterval(reload, 3000);
    return () => clearInterval(iv);
  }, [tab, reload]);

  const handleEnqueue = useCallback(async (files, settings) => {
    const langCodes = settings.langs.map(l => l.code);
    let success = 0;
    for (const file of files) {
      try {
        await enqueueBatchJob(file, langCodes, settings.voiceId || undefined, settings.preserveBg);
        success++;
      } catch (e) {
        toast.error(t('batch.enqueue_failed', { name: file.name, msg: e.message }));
      }
    }
    if (success > 0) {
      toast.success(t('batch.enqueued', { n: success }));
      setTab('active');
      reload();
    }
  }, [reload, t]);

  const handleCancel = useCallback(async (id) => {
    try {
      await cancelBatchJob(id);
      toast.success(t('batch.job_cancelled'));
      reload();
    } catch (e) {
      toast.error(t('batch.cancel_failed') + e.message);
    }
  }, [reload, t]);

  const handleDelete = useCallback(async (id) => {
    try {
      await deleteBatchJob(id);
      toast.success(t('batch.job_deleted'));
      reload();
    } catch (e) {
      toast.error(t('batch.delete_failed') + e.message);
    }
  }, [reload, t]);

  return (
    <div className="batch-queue">
      <div className="batch-queue__bar">
        {onBack && <Button variant="ghost" size="sm" onClick={onBack}>← {t('common.back')}</Button>}
        <h1><Activity size={15} /> {t('batch.batch_dubbing')}</h1>
        <div className="batch-queue__bar-spacer" />
        <Button variant="subtle" size="sm" onClick={reload} loading={loading} leading={<RefreshCw size={11} />}>
          {t('common.refresh')}
        </Button>
        <Button variant="primary" size="sm" onClick={() => setAddOpen(true)} leading={<PlusIcon size={11} />}>
          {t('batch.add_videos')}
        </Button>
      </div>

      <Tabs
        items={TABS}
        value={tab}
        onChange={setTab}
        className="batch-queue__tabs"
      />

      {jobs.length === 0 && !loading && (
        <Panel variant="flat" padding="lg" className="batch-queue__empty">
          <div>
            <p>{t('batch.no_jobs', { tab })}</p>
            <p className="batch-queue__empty-sub">
              {tab === 'active' && t('batch.drop_hint')}
              {tab === 'done' && t('batch.nothing_completed')}
              {tab === 'failed' && t('batch.no_failed_jobs')}
            </p>
          </div>
        </Panel>
      )}

      <div className="batch-queue__list">
        {jobs.map(j => (
          <JobCard
            key={j.id}
            job={j}
            onCancel={handleCancel}
            onDelete={handleDelete}
          />
        ))}
      </div>

      <BatchAddDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onEnqueue={handleEnqueue}
      />
    </div>
  );
}

function PlusIcon({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function JobCard({ job, onCancel, onDelete }) {
  const { t } = useTranslation();

  const STATUS_TONE = {
    queued:    { tone: 'neutral', icon: Circle,      label: t('batch.queued') },
    running:   { tone: 'brand',   icon: Activity,    label: t('batch.running') },
    done:      { tone: 'success', icon: CheckCircle, label: t('common.done') },
    failed:    { tone: 'danger',  icon: AlertCircle, label: t('batch.failed') },
    cancelled: { tone: 'warn',    icon: Square,      label: t('batch.cancelled') },
  };

  const STAGE_LABELS = {
    extract:    '🎬 ' + t('batch.step_extract'),
    transcribe: '📝 ' + t('batch.step_transcribe'),
    translate:  '🌐 ' + t('batch.step_translate'),
    generate:   '🗣️ ' + t('batch.step_generate'),
    mix:        '🎛️ ' + t('batch.step_mix'),
    done:       '✅ ' + t('batch.step_complete'),
  };

  const st = STATUS_TONE[job.status] || STATUS_TONE.queued;
  const StIcon = st.icon;

  const ageLabel = formatAge((Date.now() / 1000 - (job.created_at || 0)) * 1000, t);

  const duration = job.finished_at && job.started_at
    ? Math.max(0, job.finished_at - job.started_at)
    : null;

  const progress = job.progress;
  const stageLabel = progress ? (STAGE_LABELS[progress.stage] || progress.stage) : null;
  const pct = progress?.percent ?? 0;

  return (
    <Panel variant="flat" padding="md" className={`batch-queue__card batch-queue__card--${job.status}`}>
      <div className="batch-queue__card-head">
        <Badge tone={st.tone} dot>
          <StIcon size={10} /> {st.label}
        </Badge>
        <span className="batch-queue__card-filename">
          <Film size={10} /> {job.filename}
        </span>
        <span className="batch-queue__card-spacer" />
        <span className="batch-queue__card-age" title={new Date((job.created_at || 0) * 1000).toLocaleString()}>
          {ageLabel}
        </span>
      </div>

      {/* Languages */}
      <div className="batch-queue__card-langs">
        <Globe size={9} />
        {job.langs.map(l => (
          <span key={l} className="batch-queue__card-lang">{l}</span>
        ))}
      </div>

      {/* Progress bar for running jobs */}
      {job.status === 'running' && progress && (
        <div className="batch-queue__progress">
          <div className="batch-queue__progress-bar">
            <div
              className="batch-queue__progress-fill"
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <div className="batch-queue__progress-info">
            <span className="batch-queue__progress-stage">{stageLabel}</span>
            {progress.current_lang && (
              <span className="batch-queue__progress-lang">{progress.current_lang}</span>
            )}
            {progress.current_segment != null && progress.total_segments && (
              <span className="batch-queue__progress-segs">
                {t('batch.seg_progress', { current: progress.current_segment, total: progress.total_segments })}
              </span>
            )}
            <span className="batch-queue__progress-pct">{pct}%</span>
          </div>
        </div>
      )}

      {/* Duration for completed jobs */}
      {duration != null && (
        <div className="batch-queue__card-meta">
          {t('batch.completed_in', { duration: formatDuration(duration, t) })}
        </div>
      )}

      {/* Error display */}
      {job.error && (
        <div className="batch-queue__card-error">
          <AlertCircle size={11} /> {job.error}
        </div>
      )}

      {/* Output downloads for done jobs */}
      {job.status === 'done' && job.outputs && Object.keys(job.outputs).length > 0 && (
        <div className="batch-queue__card-outputs">
          {Object.entries(job.outputs).map(([lang, path]) => (
            <a
              key={lang}
              className="batch-queue__card-dl"
              href={`${API}/batch/download/${job.id}/${lang}`}
              download
            >
              <Download size={10} /> {lang}
            </a>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="batch-queue__card-actions">
        {(job.status === 'queued' || job.status === 'running') && (
          <Button variant="ghost" size="xs" onClick={() => onCancel(job.id)} leading={<XCircle size={10} />}>
            {t('common.cancel')}
          </Button>
        )}
        {(job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') && (
          <Button variant="ghost" size="xs" onClick={() => onDelete(job.id)} leading={<Trash2 size={10} />}>
            {t('common.delete')}
          </Button>
        )}
      </div>
    </Panel>
  );
}

function formatAge(ms, t) {
  if (!isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return t('common.seconds_ago', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('common.minutes_ago', { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('common.hours_ago', { h });
  const d = Math.floor(h / 24);
  return t('common.days_ago', { d });
}

function formatDuration(secs, t) {
  if (secs < 60) return t('batch.duration_seconds', { s: secs.toFixed(1) });
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  if (m < 60) return t('batch.duration_min_sec', { m, s });
  const h = Math.floor(m / 60);
  return t('batch.duration_hr_min', { h, m: m % 60 });
}
