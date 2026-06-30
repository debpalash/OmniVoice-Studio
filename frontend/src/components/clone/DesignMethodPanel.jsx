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
      <div className="describe-voice-block">
        <textarea
          className="input-base describe-voice-area"
          rows={2}
          placeholder={t('clone.describe_placeholder')}
          value={describeText}
          onChange={onDescribeChange}
        />
        {describeText.trim() && !describeMatchedAny && (
          <div className="describe-voice-feedback" role="status">
            {t('clone.describe_no_match')}
          </div>
        )}
        {describeMatchedAny && describeUnmatched.length > 0 && (
          <div className="describe-voice-feedback" role="status">
            {t('clone.describe_unmatched', { items: describeUnmatched.join(', ') })}
          </div>
        )}
        <div className="describe-voice-hint">{t('clone.describe_hint')}</div>
      </div>

      {/* ONE preset system (10x §1.3): personalities + the old PROMPT
                presets share a single scrollable "Starting points" lane —
                both set vdStates + instruct; two widgets for one slot was
                the confusion. */}
      <div className="starting-points">
        <div className="starting-points__label">
          {t('clone.starting_points', { defaultValue: 'Starting points' })}
        </div>
        <div className="personality-strip starting-points__strip">
          {chipPersonalities.map((p) => {
            const Icon = PERSONALITY_ICONS[p.id] || FALLBACK_PERSONALITY_ICON;
            return (
              <button
                key={p.id}
                type="button"
                className={`personality-chip ${activePersonality === p.id ? 'active' : ''}`}
                onClick={() => applyPersonality(p)}
              >
                <span className="personality-chip__icon">
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
                className="personality-chip"
                onClick={() => applyPreset(p)}
              >
                <span className="personality-chip__icon">
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
        className="identity-line"
        onClick={() => setIdentityOpen((o) => !o)}
        aria-expanded={identityOpen}
      >
        <span className="identity-line__kicker">
          {t('clone.identity', { defaultValue: 'Identity' })}
        </span>
        <span className="identity-line__recipe">{identityRecipe}</span>
        {identityOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {identityOpen && (
        <div className="clone-sliders-col">
          {Object.entries(CATEGORIES).map(([key, options]) => {
            const many = options.length > 6;
            const optLabel = (val) => {
              const tKey = `clone.opt_${val.replace(/[ -]/g, '_')}`;
              const tl = t(tKey);
              return tl !== tKey ? tl : val;
            };
            return (
              <div
                key={key}
                className={`clone-cat ${many ? 'clone-cat--select' : 'clone-cat--chips'}`}
              >
                <div className="label-row label-row--sm">
                  {t(`clone.cat_${key}`)}
                  <span className="clone-slider-kicker">
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
                  <div className="chip-group" role="radiogroup" aria-label={t(`clone.cat_${key}`)}>
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
                          className={`chip ${checked ? 'active' : ''}`}
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
      <div className="clone-save-profile">
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
          <div className="clone-save-profile__row">
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
