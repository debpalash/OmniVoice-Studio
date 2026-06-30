import { Play, Sparkles, FolderOpen } from 'lucide-react';
import { Panel, Button, Textarea, Field, Badge } from '../../ui';
import WaveformPlayer from '../WaveformPlayer';

/**
 * ProfileActivity — "Try it" preview panel + usage panel for the VoiceProfile
 * page. Pure presentation; state/handlers live in the parent VoiceProfile.
 */
export default function ProfileActivity({
  t,
  testText,
  setTestText,
  testGenerating,
  runTest,
  testAudioUrl,
  autoPlayPreview,
  usage,
  onOpenProject,
}) {
  return (
    <>
      {/* Try-it */}
      <Panel
        variant="flat"
        padding="md"
        title={
          <>
            <Play size={13} /> {t('voice_profile.try_voice')}
          </>
        }
      >
        <Field label={t('voice_profile.test_phrase')} hint={t('voice_profile.test_help')}>
          <Textarea
            rows={2}
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            placeholder={t('voice_profile.test_placeholder')}
          />
        </Field>
        <div className="mt-[var(--space-4)] flex flex-wrap items-center gap-[var(--space-4)]">
          <Button
            variant="primary"
            size="sm"
            loading={testGenerating}
            onClick={runTest}
            disabled={!testText.trim()}
            leading={!testGenerating && <Sparkles size={12} />}
          >
            {testGenerating ? t('voice_profile.generating') : t('voice_profile.gen_preview')}
          </Button>
          {testAudioUrl && (
            <WaveformPlayer
              src={testAudioUrl}
              source="profile-test"
              autoPlay={autoPlayPreview}
              className="min-w-[240px] max-w-[480px] flex-1"
            />
          )}
        </div>
      </Panel>

      {/* Usage */}
      <Panel variant="flat" padding="md" title={<>{t('voice_profile.used_title')}</>}>
        {!usage || (!usage.synth_total && !usage.projects?.length) ? (
          <div className="p-[var(--space-3)] italic text-fg-subtle">
            {t('voice_profile.used_empty')}
          </div>
        ) : (
          <>
            <div className="mb-[var(--space-4)] flex flex-wrap gap-[var(--space-3)]">
              <Badge tone="brand">
                {t('voice_profile.synth_clips', { count: usage.synth_total })}
              </Badge>
              <Badge tone="info">
                {t('voice_profile.projects_count', { count: usage.projects.length })}
              </Badge>
              <Badge tone="success">
                {t('voice_profile.dubbed_segments', { count: usage.project_total_segments })}
              </Badge>
            </div>
            {usage.projects.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-[var(--space-1)] p-0">
                {usage.projects.slice(0, 10).map((p) => (
                  <li key={p.project_id}>
                    <button
                      type="button"
                      onClick={() => onOpenProject?.(p.project_id)}
                      className="flex w-full cursor-pointer items-center gap-[var(--space-3)] rounded-[var(--radius-md)] border border-border bg-[rgba(255,255,255,0.02)] px-[var(--space-4)] py-[var(--space-3)] text-fg [font-size:var(--text-md)] transition-[background,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:border-[var(--color-border-strong)] hover:bg-[rgba(255,255,255,0.06)]"
                    >
                      <FolderOpen size={11} />
                      <span className="flex-1 text-left">{p.project_name}</span>
                      <span className="[font-size:var(--text-xs)] text-fg-subtle [font-variant-numeric:tabular-nums]">
                        {p.segment_count} segs
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Panel>
    </>
  );
}
