import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, RefreshCw, CheckCircle, AlertCircle, Square, Pause, Circle,
} from 'lucide-react';
import { Panel, Button, Badge, Tabs } from '../ui';
import { listJobs } from '../api/engines';
import BatchAddDialog from '../components/BatchAddDialog';
import './BatchQueue.css';

/**
 * BatchQueue — Phase 4 UI surface on top of /jobs (Phase 2.1 backend).
 *
 * Tabs: Active · Done · Failed. Polls /jobs every 3s for active tabs so
 * ingest/dub progress stays live without needing an SSE hookup yet.
 */
const TABS = [
  { id: 'active',   label: 'Active',   icon: Activity     },
  { id: 'done',     label: 'Completed', icon: CheckCircle },
  { id: 'failed',   label: 'Failed',   icon: AlertCircle  },
];

const STATUS_TONE = {
  pending:   { tone: 'neutral', icon: Circle,      label: 'queued'    },
  running:   { tone: 'brand',   icon: Activity,    label: 'running'   },
  done:      { tone: 'success', icon: CheckCircle, label: 'done'      },
  failed:    { tone: 'danger',  icon: AlertCircle, label: 'failed'    },
  cancelled: { tone: 'warn',    icon: Square,      label: 'cancelled' },
};

export default function BatchQueue({ onBack }) {
  const [tab, setTab] = useState('active');
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const statusParam = tab === 'active' ? 'active' : tab;
      setJobs(await listJobs({ status: statusParam, limit: 100 }));
    } catch (e) {
      console.warn('batch queue load failed', e);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { reload(); }, [reload]);

  // Poll active tab so running jobs advance without user refresh.
  useEffect(() => {
    if (tab !== 'active') return;
    const iv = setInterval(reload, 3000);
    return () => clearInterval(iv);
  }, [tab, reload]);

  return (
    <div className="batch-queue">
      <div className="batch-queue__bar">
        {onBack && <Button variant="ghost" size="sm" onClick={onBack}>← Back</Button>}
        <h1><Activity size={15} /> Batch queue</h1>
        <div className="batch-queue__bar-spacer" />
        <Button variant="subtle" size="sm" onClick={reload} loading={loading} leading={<RefreshCw size={11} />}>
          Refresh
        </Button>
        <Button variant="primary" size="sm" onClick={() => setAddOpen(true)} leading={<Plus size={11} />}>
          Add Videos
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
            <p>No {tab} jobs.</p>
            <p className="batch-queue__empty-sub">
              {tab === 'active' && 'Upload a video or queue a translation to see it here.'}
              {tab === 'done' && 'Nothing has completed recently.'}
              {tab === 'failed' && 'No failed jobs — enjoy the silence.'}
            </p>
          </div>
        </Panel>
      )}

      <div className="batch-queue__list">
        {jobs.map(j => <JobCard key={j.id} job={j} />)}
      </div>
    </div>
  );
}

function Plus({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function JobCard({ job }) {
  const meta = useMemo(() => {
    try { return JSON.parse(job.meta_json || '{}'); } catch { return {}; }
  }, [job.meta_json]);

  const st = STATUS_TONE[job.status] || STATUS_TONE.pending;
  const StIcon = st.icon;

  const ageMs = (Date.now() / 1000 - (job.created_at || 0)) * 1000;
  const ageLabel = formatAge(ageMs);

  const duration = job.finished_at && job.created_at
    ? Math.max(0, job.finished_at - job.created_at)
    : null;

  return (
    <Panel variant="flat" padding="md" className={`batch-queue__card batch-queue__card--${job.status}`}>
      <div className="batch-queue__card-head">
        <Badge tone={st.tone} dot>
          <StIcon size={10} /> {st.label}
        </Badge>
        <span className="batch-queue__card-type">{job.type}</span>
        {job.project_id && <code className="batch-queue__card-proj">{job.project_id}</code>}
        <span className="batch-queue__card-spacer" />
        <span className="batch-queue__card-age" title={new Date((job.created_at || 0) * 1000).toLocaleString()}>
          {ageLabel}
        </span>
      </div>
      <div className="batch-queue__card-id"><code>{job.id}</code></div>
      {duration != null && (
        <div className="batch-queue__card-meta">
          ran for {duration.toFixed(1)}s
        </div>
      )}
      {job.error && (
        <div className="batch-queue__card-error">
          <AlertCircle size={11} /> {job.error}
        </div>
      )}
      {Object.keys(meta).length > 0 && (
        <details className="batch-queue__card-meta-wrap">
          <summary>meta</summary>
          <pre>{JSON.stringify(meta, null, 2)}</pre>
        </details>
      )}
    </Panel>
  );
}

function formatAge(ms) {
  if (!isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(Date.now() - ms).toLocaleDateString();
}
