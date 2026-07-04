import {
  FileText,
  Save,
  RotateCcw,
  Loader,
  Square,
  Play,
  Download,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '../../ui';
import FooterBtn from './FooterBtn';
import DubPipelineStepper from './DubPipelineStepper';
import { formatTime } from '../../utils/format';

export default function DubHeader({
  t,
  dubFilename,
  dubDuration,
  dubSegments,
  activeProjectName,
  saveProject,
  resetDub,
  dubStep,
  handleDubStop,
  dubProgress,
  onGenerateClick,
  multiLangMode,
  multiLangs,
  incrementalPlan,
  handleDubGenerate,
  qcRunning,
  handleDubQc,
  setExportOpen,
}) {
  return (
    <div className="flex flex-col gap-[2px] min-w-0 px-[10px] py-[4px] shrink-0 bg-[var(--color-bg-elev-1)] rounded-md mb-[2px]">
      {/* Row 1: project title (left) + actions (right). Row 2: the pipeline
          spine (Upload → … → Export) sits directly under the title with a
          tight 2px gap — title-first, owner-requested order. */}
      <div className="flex flex-wrap justify-between items-center gap-x-[var(--space-2)] gap-y-[4px] min-w-0">
        <div className="label-row dub-head__title !gap-[6px]">
          <FileText className="label-icon" size={11} />
          <span className="font-medium text-[0.78rem] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-fg normal-case">
            {dubFilename}
          </span>
          <span className="text-fg-muted font-normal whitespace-nowrap text-[0.68rem] normal-case shrink-0">
            · {formatTime(dubDuration)} · {dubSegments.length} {t('dub.segs')}
          </span>
          {activeProjectName && activeProjectName !== dubFilename && (
            <span className="text-[#b8bb26] ml-[var(--space-2)] whitespace-nowrap text-[0.68rem] normal-case overflow-hidden text-ellipsis min-w-0">
              — {activeProjectName}
            </span>
          )}
        </div>
        <div className="flex gap-[6px] items-center shrink-0">
          {/* Icon-only secondary actions (tooltips carry the labels);
                  Generate Dub keeps its label as the primary verb. */}
          <Button
            variant="subtle"
            size="sm"
            onClick={saveProject}
            title={t('dub.save')}
            aria-label={t('dub.save')}
          >
            <Save size={12} />
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={resetDub}
            title={t('dub.reset')}
            aria-label={t('dub.reset')}
          >
            <RotateCcw size={12} />
          </Button>
          {/* Primary actions live on the header bar (compact) — moved up from the footer. */}
          <div className="flex gap-[6px] items-center pl-[var(--space-2)] ml-[2px]">
            {dubStep === 'stopping' ? (
              <FooterBtn
                sm
                tone="stopping"
                disabled
                icon={<Loader className="spinner" size={9} />}
                label={t('dub.stopping')}
              />
            ) : dubStep === 'generating' ? (
              <FooterBtn
                sm
                tone="danger"
                onClick={handleDubStop}
                icon={<Square size={9} />}
                label={t('dub.stop_progress', {
                  current: dubProgress.current,
                  total: dubProgress.total,
                })}
              />
            ) : (
              <>
                <FooterBtn
                  sm
                  tone={dubSegments.length ? 'pink' : 'idle'}
                  onClick={onGenerateClick}
                  disabled={!dubSegments.length}
                  icon={<Play size={11} />}
                  label={
                    multiLangMode && multiLangs.length > 1
                      ? t('dub.generate_dub_multi', {
                          count: multiLangs.length,
                          defaultValue: 'Generate {{count}} dubs',
                        })
                      : t('dub.generate_dub')
                  }
                />
                {dubStep === 'done' && incrementalPlan && incrementalPlan.stale?.length > 0 && (
                  <FooterBtn
                    sm
                    tone="pink"
                    onClick={() =>
                      handleDubGenerate({ regenOnly: incrementalPlan.stale, preview: true })
                    }
                    icon={<Play size={11} />}
                    label={t('dub.regen_changed', { count: incrementalPlan.stale.length })}
                  />
                )}
              </>
            )}
            {dubStep === 'done' && (
              <FooterBtn
                sm
                tone="idle"
                disabled={qcRunning || !dubSegments.length}
                onClick={handleDubQc}
                icon={
                  qcRunning ? <Loader className="spinner" size={11} /> : <ShieldCheck size={11} />
                }
                title={t('dub.qc_btn', { defaultValue: 'Verify dub timing (second-pass check)' })}
                aria-label={t('dub.qc_btn', {
                  defaultValue: 'Verify dub timing (second-pass check)',
                })}
              />
            )}
            <FooterBtn
              sm
              tone={dubStep === 'done' ? 'green' : 'idle'}
              disabled={dubStep !== 'done' && !dubSegments.length}
              onClick={() => setExportOpen(true)}
              icon={<Download size={12} />}
              title={t('dub.export_btn')}
              aria-label={t('dub.export_btn')}
            />
          </div>
        </div>
      </div>
      <DubPipelineStepper dubStep={dubStep} inline />
    </div>
  );
}
