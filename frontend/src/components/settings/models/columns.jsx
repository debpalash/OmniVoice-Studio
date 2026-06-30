import React from 'react';
import { RefreshCw, Trash2, ExternalLink, Download } from 'lucide-react';
import { openExternal } from '../../../api/external';
import { Button, Badge, Progress } from '../../../ui';
import { fmtBytes, orgColor } from './format';

/**
 * Build the TanStack column definitions for the model store table.
 *
 * The column cells close over runtime values, so this is a factory rather than
 * a static array: pass in the live callbacks/refs from the host component and
 * memoize the result with the same dependency array the inline definition used.
 */
export function makeModelColumns({
  t,
  getRowRuntime,
  speedRef,
  MODEL_ROLE_LABEL,
  onInstall,
  onDelete,
  onReinstall,
}) {
  return [
    {
      id: 'name',
      accessorFn: (m) => `${m.label || ''} ${m.repo_id || ''}`,
      header: t('models.column_model'),
      size: 260,
      meta: { className: 'models-row__name' },
      cell: ({ row }) => {
        const m = row.original;
        const rt = getRowRuntime(m);
        return (
          <>
            <span className="models-row__title">
              <span
                className="models-row__avatar"
                style={{ background: orgColor(m.repo_id) }}
                title={m.repo_id.split('/')[0]}
              >
                {m.repo_id.split('/')[0].slice(0, 2).toUpperCase()}
              </span>
              {m.label}
              {m.required && <span className="models-row__tag">{t('models.required_tag')}</span>}
            </span>
            <span className="models-row__repo">
              <code>{m.repo_id}</code>
              {m.note && <span className="models-row__note"> · {m.note}</span>}
            </span>
            {rt.showBar && (
              <div className="models-row__progressline">
                <Progress value={rt.aggPct} tone={rt.isDeleting ? 'warn' : 'brand'} size="xs" />
                <span className="models-row__progresstext">
                  {(() => {
                    if (rt.isDeleting) return t('models.removing_cached');
                    const hasAgg = !!rt.agg;
                    if (!rt.hasFiles && !hasAgg) {
                      if (rt.phase === 'resolving') {
                        const dots = '.'.repeat((rt.rs?.resolvingStep || 0) % 4);
                        // Once the preflight plan lands we can show the real size
                        // even before the first byte (FDL-05).
                        const planBytes = rt.plan?.to_download_bytes;
                        const planStr = planBytes
                          ? ` · ${fmtBytes(planBytes)} ${t('models.to_download') || 'to download'}`
                          : '';
                        return `${t('models.resolving_metadata')}${dots}${planStr}`;
                      }
                      if (rt.phase === 'install_retry') {
                        return t('models.retry_attempt', {
                          attempt: rt.rs?.retryAttempt || '?',
                          error: rt.rs?.error || 'reconnecting',
                        });
                      }
                      return t('models.connecting_hf');
                    }

                    // Prefer the backend aggregate's windowed rate (FDL-06).
                    // Fall back to the frontend sampler only until it arrives.
                    let speed = rt.aggRate ?? 0;
                    if (!(speed > 0)) {
                      const sp = speedRef.current[m.repo_id];
                      const now = Date.now();
                      if (sp && rt.dispDownloaded > 0) {
                        const dt = (now - sp.lastTime) / 1000;
                        if (dt >= 1) {
                          sp.speed = Math.max(0, (rt.dispDownloaded - sp.lastBytes) / dt);
                          sp.lastBytes = rt.dispDownloaded;
                          sp.lastTime = now;
                        }
                      } else {
                        speedRef.current[m.repo_id] = {
                          lastBytes: rt.dispDownloaded,
                          lastTime: now,
                          speed: 0,
                        };
                      }
                      speed = rt.backendRate > 0 ? rt.backendRate : sp?.speed || 0;
                    }

                    // Total unknown and nothing downloaded yet → still resolving
                    if (rt.dispTotal === 0 && rt.dispDownloaded === 0) {
                      const activeFile = rt.activeFilename?.split('/').pop();
                      return activeFile
                        ? t('models.resolving_files_active', {
                            count: rt.fileList.length,
                            file: activeFile,
                          })
                        : t('models.resolving_files', { count: rt.fileList.length });
                    }

                    // ETA: prefer the backend's, else derive from remaining/speed.
                    const remaining = Math.max(0, rt.dispTotal - rt.dispDownloaded);
                    const etaSec =
                      rt.aggEtaSec != null
                        ? rt.aggEtaSec
                        : speed > 0 && rt.dispTotal > 0
                          ? remaining / speed
                          : 0;
                    const etaStr =
                      etaSec > 0
                        ? etaSec < 60
                          ? `~${Math.ceil(etaSec)}s`
                          : etaSec < 3600
                            ? `~${Math.ceil(etaSec / 60)}m`
                            : `~${(etaSec / 3600).toFixed(1)}h`
                        : '';
                    const dlStr = fmtBytes(rt.dispDownloaded) || '0 B';
                    const totalStr = rt.dispTotal > 0 ? fmtBytes(rt.dispTotal) : '…';
                    const pctStr =
                      rt.aggPct != null && rt.aggPct > 0 ? `${Math.round(rt.aggPct)}%` : '';
                    const speedStr = speed > 0 ? `${fmtBytes(speed)}/s` : '';

                    const parts = [
                      `${dlStr} / ${totalStr}`,
                      pctStr,
                      speedStr || (rt.dispDownloaded > 0 ? t('models.measuring') : ''),
                      etaStr,
                    ].filter(Boolean);

                    const extra = [];
                    if (rt.cachedBytes > 0)
                      extra.push(`${fmtBytes(rt.cachedBytes)} ${t('models.cached') || 'cached'}`);
                    if (rt.filesTotal > 1)
                      extra.push(
                        t('models.files_progress', { done: rt.filesDone, total: rt.filesTotal }),
                      );
                    if (rt.activeFilename) extra.push(rt.activeFilename.split('/').pop());

                    return extra.length
                      ? `${parts.join(' · ')}  ⸱  ${extra.join(' · ')}`
                      : parts.join(' · ');
                  })()}
                </span>
              </div>
            )}
            {rt.phase === 'install_error' && rt.rs?.error && (
              <span className="models-row__error">
                {t('models.install_error', { error: rt.rs.error })}
              </span>
            )}
          </>
        );
      },
    },
    {
      id: 'role',
      accessorFn: (m) => (m.role || 'other').toLowerCase(),
      header: t('models.column_role'),
      size: 58,
      filterFn: (row, id, value) => !value || row.getValue(id) === value,
      cell: ({ row }) => (
        <span className="models-row__role">
          {MODEL_ROLE_LABEL[row.getValue('role')] || row.original.role || 'Other'}
        </span>
      ),
    },
    {
      id: 'size',
      accessorFn: (m) => (m.installed ? m.size_on_disk_bytes || 0 : (m.size_gb || 0) * 1024 ** 3),
      header: t('models.column_size'),
      size: 68,
      meta: { align: 'right', className: 'models-row__size' },
      cell: ({ row }) => {
        const m = row.original;
        const rt = getRowRuntime(m);
        // During active download, show live downloaded / total
        if (rt.showBar && rt.hasFiles && rt.totals.total > 0) {
          return (
            <span className="models-row__size-live">
              {fmtBytes(rt.totals.downloaded)}
              <span className="models-row__size-sep">/</span>
              {fmtBytes(rt.totals.total)}
            </span>
          );
        }
        return m.installed ? fmtBytes(m.size_on_disk_bytes) : `${m.size_gb} GB`;
      },
    },
    {
      id: 'status',
      accessorFn: (m) => (m.installed ? 2 : m.supported === false ? 0 : 1),
      header: t('models.column_status'),
      size: 96,
      meta: { align: 'center', className: 'models-row__status' },
      cell: ({ row }) => {
        const m = row.original;
        const rt = getRowRuntime(m);
        return rt.isInstalling ? (
          <Badge tone="warn" size="xs">
            <Download size={10} />{' '}
            {rt.aggPct != null ? `${Math.round(rt.aggPct)}%` : t('models.downloading')}
          </Badge>
        ) : rt.isDeleting ? (
          <Badge tone="warn" size="xs">
            <Trash2 size={10} /> {t('models.deleting')}
          </Badge>
        ) : rt.rowBusy ? (
          <Badge tone="warn" size="xs">
            <RefreshCw size={10} className="spinner" /> {t('models.working')}
          </Badge>
        ) : m.installed ? (
          <Badge tone="success" size="xs">
            {t('models.installed')}
          </Badge>
        ) : rt.unsupported ? (
          <Badge tone="neutral" size="xs">
            {(m.platforms || []).join(', ')}
          </Badge>
        ) : (
          <Badge tone="neutral" size="xs">
            {t('models.not_installed')}
          </Badge>
        );
      },
    },
    {
      id: 'actions',
      header: '',
      size: 90,
      enableSorting: false,
      meta: { align: 'right', className: 'models-row__actions' },
      cell: ({ row }) => {
        const m = row.original;
        const rt = getRowRuntime(m);
        return (
          <>
            <Button
              variant="icon"
              iconSize="sm"
              onClick={() => openExternal(`https://huggingface.co/${m.repo_id}`)}
              title={t('models.view_on_hf')}
              aria-label={t('models.view_on_hf')}
            >
              <ExternalLink size={11} />
            </Button>
            {!m.installed && !rt.rowBusy && !rt.isInstalling && !rt.unsupported && (
              <Button
                variant="subtle"
                size="sm"
                onClick={() => onInstall(m.repo_id)}
                leading={<Download size={11} />}
              >
                {t('models.install_btn')}
              </Button>
            )}
            {m.installed && !rt.rowBusy && !rt.isDeleting && (
              <>
                <Button
                  variant="icon"
                  iconSize="sm"
                  onClick={() => onReinstall(m.repo_id)}
                  title={t('models.reinstall_btn')}
                  aria-label={t('models.reinstall_btn')}
                >
                  <RefreshCw size={11} />
                </Button>
                <Button
                  variant="icon"
                  iconSize="sm"
                  onClick={() => onDelete(m.repo_id)}
                  title={t('models.delete_btn')}
                  aria-label={t('models.delete_btn')}
                >
                  <Trash2 size={11} />
                </Button>
              </>
            )}
          </>
        );
      },
    },
  ];
}
