import { Command, Plus, ChevronDown } from 'lucide-react';
import DemoPresetGrid from '../DemoPresetGrid';
import { TAGS } from '../../utils/constants';

// `.tag-btn` (special-token chips in the Insert menu) migrated from index.css to
// Tailwind utilities (shadcn P4). Flat chrome pill, mono face — token utilities
// reference the same --chrome-* vars the old rule used, so the look is unchanged.
const TAG_BTN =
  'border border-[var(--chrome-border)] bg-transparent text-[var(--chrome-fg-muted)] px-[9px] py-[3px] rounded-[var(--chrome-radius-pill)] font-[var(--chrome-font-mono)] font-medium text-[0.66rem] whitespace-nowrap cursor-pointer transition-colors duration-[120ms] hover:bg-[var(--chrome-hover-bg)] hover:text-[var(--chrome-fg)] hover:border-[var(--chrome-border-strong)]';

export default function ScriptPanel({
  t,
  defineMethod,
  text,
  setText,
  activePersonality,
  demoPresets,
  applyDemoPreset,
  showDemoCoachmark,
  setShowDemoCoachmark,
  selectedProfile,
  DEMO_PROFILE_ID,
  textAreaRef,
  insertOpen,
  setInsertOpen,
  insertTag,
}) {
  return (
    <div className="studio-column">
      {/* overflow-visible: the ⊕ Insert popover opens above the textarea and
            must escape the panel's `overflow:auto` box instead of being clipped
            into its scroll region (#481). */}
      <div className="studio-panel clone-panel--overflow-visible">
        <div className="label-row label-row--center">
          <Command className="label-icon" size={14} />{' '}
          {t('clone.script', { defaultValue: 'Script' })}
        </div>
        {/* Design-tab empty state: 7-card demo grid until the user
              interacts; then it steps aside for the standard form. */}
        {defineMethod === 'design' && !text && !activePersonality && demoPresets.length > 0 && (
          <DemoPresetGrid presets={demoPresets} onUse={applyDemoPreset} />
        )}
        {showDemoCoachmark && defineMethod === 'audio' && selectedProfile === DEMO_PROFILE_ID && (
          <div
            className="flex items-center gap-[8px] px-[10px] py-[6px] mb-[8px] rounded-[8px] bg-[rgba(243,165,182,0.08)] [border:1px_solid_rgba(243,165,182,0.25)] text-[11px] text-fg"
            role="note"
          >
            <span className="text-[14px] leading-none">💡</span>
            <span className="flex-1">{t('demo.clone_coachmark')}</span>
            <button
              type="button"
              className="clone-coachmark__close"
              onClick={() => setShowDemoCoachmark(false)}
              aria-label="Dismiss coach mark"
            >
              ×
            </button>
          </div>
        )}
        <div className="relative flex-1 flex flex-col min-h-0">
          <textarea
            ref={textAreaRef}
            className="input-base clone-text-area"
            placeholder={
              defineMethod === 'audio'
                ? t('clone.prompt_placeholder')
                : t('clone.design_placeholder')
            }
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (showDemoCoachmark) setShowDemoCoachmark(false);
            }}
          />
          {/* Expression tokens live behind a popover — fourteen permanent
                chips were renting the page's best pixels for an occasional
                power feature (10x spec §1.4). */}
          <button
            type="button"
            className={`clone-insert-btn ${insertOpen ? 'is-open' : ''}`}
            onClick={() => setInsertOpen((o) => !o)}
            aria-expanded={insertOpen}
            aria-label={t('clone.insert_token', { defaultValue: 'Insert expression token' })}
          >
            <Plus size={11} /> {t('clone.insert', { defaultValue: 'Insert' })}{' '}
            <ChevronDown size={10} />
          </button>
          {insertOpen && (
            <div className="fixed inset-0 z-[19]" onClick={() => setInsertOpen(false)} />
          )}
          {insertOpen && (
            <div className="clone-insert-pop" role="menu">
              {TAGS.map((tag) => (
                <button
                  key={tag}
                  className={TAG_BTN}
                  role="menuitem"
                  onClick={() => {
                    insertTag(tag);
                    setInsertOpen(false);
                  }}
                >
                  {tag}
                </button>
              ))}
              <button
                className={`${TAG_BTN} clone-auto-extract-btn`}
                role="menuitem"
                onClick={() => {
                  insertTag('[B EY1 S]');
                  setInsertOpen(false);
                }}
              >
                [CMU]
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
