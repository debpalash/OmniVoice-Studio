import { FileText, Save, RotateCcw, Loader, Square, Play, Download, ShieldCheck } from 'lucide-react';
import { Button } from '../../ui';
import FooterBtn from './FooterBtn';
import { formatTime } from '../../utils/format';

export default function DubHeader({ t, dubFilename, dubDuration, dubSegments, activeProjectName, saveProject, resetDub, dubStep, handleDubStop, dubProgress, onGenerateClick, multiLangMode, multiLangs, incrementalPlan, handleDubGenerate, qcRunning, handleDubQc, setExportOpen }) {
  return (
          <div className="dub-head">
            <div className="label-row dub-head__title">
              <FileText className="label-icon" size={11} />
              <span className="dub-head__filename">{dubFilename}</span>
              <span className="dub-head__meta">· {formatTime(dubDuration)} · {dubSegments.length} {t('dub.segs')}</span>
              {activeProjectName && activeProjectName !== dubFilename && (
                <span className="dub-head__project">— {activeProjectName}</span>
              )}
            </div>
            <div className="dub-head__actions">
              {/* Icon-only secondary actions (tooltips carry the labels);
                  Generate Dub keeps its label as the primary verb. */}
              <Button variant="subtle" size="sm" onClick={saveProject}
                title={t('dub.save')} aria-label={t('dub.save')}><Save size={12} /></Button>
              <Button variant="danger" size="sm" onClick={resetDub}
                title={t('dub.reset')} aria-label={t('dub.reset')}><RotateCcw size={12} /></Button>
              {/* Primary actions live on the header bar (compact) — moved up from the footer. */}
              <div className="dub-head__primary">
                {dubStep === 'stopping' ? (
                  <FooterBtn sm tone="stopping" disabled icon={<Loader className="spinner" size={9} />} label={t('dub.stopping')} />
                ) : dubStep === 'generating' ? (
                  <FooterBtn sm tone="danger" onClick={handleDubStop} icon={<Square size={9} />}
                    label={t('dub.stop_progress', { current: dubProgress.current, total: dubProgress.total })} />
                ) : (
                  <>
                    <FooterBtn sm tone={dubSegments.length ? 'pink' : 'idle'} onClick={onGenerateClick}
                      disabled={!dubSegments.length} icon={<Play size={11} />}
                      label={multiLangMode && multiLangs.length > 1
                        ? t('dub.generate_dub_multi', { count: multiLangs.length, defaultValue: 'Generate {{count}} dubs' })
                        : t('dub.generate_dub')} />
                    {dubStep === 'done' && incrementalPlan && incrementalPlan.stale?.length > 0 && (
                      <FooterBtn sm tone="pink"
                        onClick={() => handleDubGenerate({ regenOnly: incrementalPlan.stale, preview: true })}
                        icon={<Play size={11} />}
                        label={t('dub.regen_changed', { count: incrementalPlan.stale.length })} />
                    )}
                  </>
                )}
                {dubStep === 'done' && (
                  <FooterBtn sm tone="idle"
                    disabled={qcRunning || !dubSegments.length}
                    onClick={handleDubQc}
                    icon={qcRunning ? <Loader className="spinner" size={11} /> : <ShieldCheck size={11} />}
                    title={t('dub.qc_btn', { defaultValue: 'Verify dub timing (second-pass check)' })}
                    aria-label={t('dub.qc_btn', { defaultValue: 'Verify dub timing (second-pass check)' })} />
                )}
                <FooterBtn sm tone={dubStep === 'done' ? 'green' : 'idle'}
                  disabled={dubStep !== 'done' && !dubSegments.length}
                  onClick={() => setExportOpen(true)}
                  icon={<Download size={12} />}
                  title={t('dub.export_btn')} aria-label={t('dub.export_btn')} />
              </div>
            </div>
          </div>
  );
}
