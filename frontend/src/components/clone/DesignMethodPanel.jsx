import { ChevronUp, ChevronDown, Save } from 'lucide-react';
import { Button, Input } from '../../ui';
import { PRESETS, CATEGORIES } from '../../utils/constants';
import {
  PRESET_ICONS,
  PERSONALITY_ICONS,
  FALLBACK_VOICE_ICON,
  FALLBACK_PERSONALITY_ICON,
  stripVoiceEmoji,
} from '../../utils/voiceIcons';
import { buildDesignInstruct } from '../../utils/voiceInstruct';

// Chip / personality-chip class families migrated from index.css to Tailwind
// utilities (shadcn P4). The token utilities reference the same --chrome-* vars
// the old `.personality-chip` / `.chip-group .chip` rules used, so the look is
// unchanged and still recolors with every [data-theme]. Active = chrome accent
// (pink), matching the rest of the app's selection accent.
// `focus-visible` ring matches the studio's shared 10x a11y rule (index.css):
// an opaque accent outline at 1px offset, on top of the app's global ring.
const CHIP_FOCUS =
  'focus-visible:[outline:2px_solid_var(--chrome-accent)] focus-visible:[outline-offset:1px]';
const PCHIP_BASE = `inline-flex items-center gap-[5px] px-[12px] py-[5px] font-[var(--font-sans)] text-[0.72rem] font-medium rounded-[var(--chrome-radius-pill)] border bg-transparent flex-none cursor-pointer transition-colors duration-[120ms] ${CHIP_FOCUS}`;
const PCHIP_INACTIVE =
  'border-transparent text-[var(--chrome-fg-muted)] hover:bg-[var(--chrome-hover-bg)] hover:border-transparent hover:text-[var(--chrome-fg)]';
const PCHIP_ACTIVE =
  'bg-[var(--chrome-accent-bg)] border-[var(--chrome-accent-border)] text-[var(--chrome-accent)]';
const CHIP_BASE = `font-[var(--font-sans)] font-medium text-[0.68rem] px-[10px] py-[3px] rounded-[var(--chrome-radius-pill)] border bg-transparent whitespace-nowrap cursor-pointer transition-colors duration-[120ms] ${CHIP_FOCUS}`;
const CHIP_INACTIVE =
  'border-transparent text-[var(--chrome-fg-muted)] hover:text-[var(--chrome-fg)] hover:bg-[var(--chrome-hover-bg)] hover:border-transparent';
const CHIP_ACTIVE =
  'bg-[var(--chrome-accent-bg)] border-[var(--chrome-accent-border)] text-[var(--chrome-accent)]';

export default function DesignMethodPanel({
  t,
  describeText,
  onDescribeChange,
  describeMatchedAny,
  describeUnmatched,
  chipPersonalities,
  activePersonality,
  applyPersonality,
  applyPreset,
  identityOpen,
  setIdentityOpen,
  identityRecipe,
  vdStates,
  setVdStates,
  onChipKeyDown,
  showSaveProfile,
  setShowSaveProfile,
  profileName,
  setProfileName,
  handleSaveDesignProfile,
  instruct,
  language,
}) {
  return (
    <div>
      {/* ── Describe your voice (#317) — free text drives the controls.
                The placeholder explains itself; no extra header (10x §1.2). ── */}
      <div className="mb-[8px]">
        <textarea
          className="input-base w-full resize-y min-h-[44px] mb-1"
          rows={2}
          placeholder={t('clone.describe_placeholder')}
          value={describeText}
          onChange={onDescribeChange}
        />
        {describeText.trim() && !describeMatchedAny && (
          <div className="text-[0.65rem] text-[#d79921] mb-[2px]" role="status">
            {t('clone.describe_no_match')}
          </div>
        )}
        {describeMatchedAny && describeUnmatched.length > 0 && (
          <div className="text-[0.65rem] text-[#d79921] mb-[2px]" role="status">
            {t('clone.describe_unmatched', { items: describeUnmatched.join(', ') })}
          </div>
        )}
        <div className="text-[0.62rem] text-[var(--chrome-fg-muted)]">
          {t('clone.describe_hint')}
        </div>
      </div>

      {/* ONE preset system (10x §1.3): personalities + the old PROMPT
                presets share a single scrollable "Starting points" lane —
                both set vdStates + instruct; two widgets for one slot was
                the confusion. */}
      <div className="mt-[8px] mr-0 mb-[12px] ml-0">
        <div className="font-[var(--chrome-font-mono)] text-[0.62rem] uppercase tracking-[0.06em] text-[var(--chrome-fg-muted)] mb-[6px]">
          {t('clone.starting_points', { defaultValue: 'Starting points' })}
        </div>
        <div className="flex flex-nowrap gap-[6px] mb-[10px] overflow-x-auto pb-[2px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [-webkit-mask-image:linear-gradient(90deg,transparent,#000_12px,#000_calc(100%-18px),transparent)] [mask-image:linear-gradient(90deg,transparent,#000_12px,#000_calc(100%-18px),transparent)]">
          {chipPersonalities.map((p) => {
            const Icon = PERSONALITY_ICONS[p.id] || FALLBACK_PERSONALITY_ICON;
            return (
              <button
                key={p.id}
                type="button"
                className={`${PCHIP_BASE} ${activePersonality === p.id ? PCHIP_ACTIVE : PCHIP_INACTIVE}`}
                onClick={() => applyPersonality(p)}
              >
                <span className="inline-flex items-center">
                  <Icon size={13} />
                </span>
                {stripVoiceEmoji(t(`clone.personality_${p.id}`, { defaultValue: p.name }))}
              </button>
            );
          })}
          {PRESETS.map((p) => {
            const Icon = PRESET_ICONS[p.id] || FALLBACK_VOICE_ICON;
            return (
              <button
                key={p.id}
                type="button"
                className={`${PCHIP_BASE} ${PCHIP_INACTIVE}`}
                onClick={() => applyPreset(p)}
              >
                <span className="inline-flex items-center">
                  <Icon size={13} />
                </span>
                {stripVoiceEmoji(t(`clone.preset_${p.id}`, { defaultValue: p.name }))}
              </button>
            );
          })}
        </div>
      </div>
      {/* Identity recipe (10x §1.5): once any category is set, the
                chip groups collapse to one quiet line — the current voice
                recipe — and the describe box rewrites it live. All-Auto
                (first run) starts expanded. */}
      <button
        type="button"
        className="flex items-center gap-[8px] w-full mt-[4px] mb-[8px] px-[10px] py-[6px] bg-[var(--chrome-hover-bg)] border border-transparent rounded-[8px] cursor-pointer text-left transition-[border-color] duration-[var(--dur-fast)] hover:border-transparent focus-visible:[outline:2px_solid_var(--chrome-accent)] focus-visible:[outline-offset:1px]"
        onClick={() => setIdentityOpen((o) => !o)}
        aria-expanded={identityOpen}
      >
        <span className="font-[var(--chrome-font-mono)] text-[0.62rem] uppercase tracking-[0.06em] text-[var(--chrome-fg-muted)] flex-none">
          {t('clone.identity', { defaultValue: 'Identity' })}
        </span>
        <span className="flex-1 min-w-0 text-[0.74rem] text-[var(--chrome-fg)] truncate">
          {identityRecipe}
        </span>
        {identityOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {identityOpen && (
        <div className="grid grid-cols-[1fr_1fr] gap-x-[12px] gap-y-[8px]">
          {Object.entries(CATEGORIES).map(([key, options]) => {
            const many = options.length > 6;
            const optLabel = (val) => {
              const tKey = `clone.opt_${val.replace(/[ -]/g, '_')}`;
              const tl = t(tKey);
              return tl !== tKey ? tl : val;
            };
            return (
              <div key={key} className={many ? 'min-w-0 max-[1100px]:col-[1/-1]' : 'col-[1/-1]'}>
                <div className="label-row text-[0.7rem]">
                  {t(`clone.cat_${key}`)}
                  <span className="ml-[6px] text-[0.58rem] text-[var(--chrome-fg-muted)] font-medium">
                    {vdStates[key] === 'Auto'
                      ? t('clone.auto_kicker')
                      : `· ${optLabel(vdStates[key])}`}
                  </span>
                </div>
                {many ? (
                  <select
                    className="input-base"
                    value={vdStates[key]}
                    onChange={(e) => setVdStates({ ...vdStates, [key]: e.target.value })}
                  >
                    {options.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div
                    className="chip-group flex flex-wrap gap-1"
                    role="radiogroup"
                    aria-label={t(`clone.cat_${key}`)}
                  >
                    {options.map((opt, i) => {
                      const optTKey = `clone.opt_${opt.replace(/[ -]/g, '_')}`;
                      const optTl = t(optTKey);
                      const optLabel = optTl !== optTKey ? optTl : opt;
                      const checked = vdStates[key] === opt;
                      // Roving tabindex: the checked chip is the group's
                      // single tab stop (first chip if nothing matches).
                      const roving = checked || (!options.includes(vdStates[key]) && i === 0);
                      return (
                        <button
                          key={opt}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          tabIndex={roving ? 0 : -1}
                          className={`${CHIP_BASE} ${checked ? CHIP_ACTIVE : CHIP_INACTIVE}`}
                          onClick={() => setVdStates({ ...vdStates, [key]: opt })}
                          onKeyDown={(e) => onChipKeyDown(e, key, options)}
                        >
                          {opt === 'Auto' ? (
                            <span className="chip-auto">
                              <FALLBACK_VOICE_ICON size={11} />{' '}
                              {stripVoiceEmoji(t('clone.opt_Auto'))}
                            </span>
                          ) : (
                            optLabel
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Save the current design as a reusable profile (0005): the
                backend renders a deterministic identity sample (seed 42)
                and stores the slider picks for later re-editing. */}
      <div className="mt-[var(--space-4)]">
        {!showSaveProfile ? (
          <Button
            variant="subtle"
            size="sm"
            onClick={() => setShowSaveProfile(true)}
            leading={<Save size={12} />}
          >
            {t('clone.save_design_as_profile', { defaultValue: 'Save design as profile' })}
          </Button>
        ) : (
          <div className="flex gap-[var(--space-3)] items-center [&>:first-child]:flex-1">
            <Input
              size="sm"
              placeholder={t('clone.profile_name')}
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
            />
            <Button
              variant="subtle"
              size="sm"
              onClick={() =>
                handleSaveDesignProfile(
                  vdStates,
                  buildDesignInstruct(vdStates, instruct).instruct,
                  language,
                )
              }
            >
              {t('clone.save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowSaveProfile(false)}>
              {t('clone.cancel')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
