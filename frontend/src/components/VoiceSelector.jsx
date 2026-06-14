import React, { useMemo } from 'react';
import { Play, Loader, ExternalLink, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SearchableSelect from './SearchableSelect';
import { PRESETS } from '../utils/constants';
import './VoiceSelector.css';

/**
 * Shared voice picker (#22) — one searchable, grouped control used everywhere a
 * voice is chosen (Stories cast, Audiobook default, Dub segments). A thin,
 * controlled wrapper over {@link SearchableSelect}: it builds a group-ordered
 * options array and surfaces optional preview / gallery-jump / create
 * adornments. It owns NO audio and makes NO API calls — it only emits the
 * selected value string and hands click events to the parent's callbacks.
 *
 * Value contract (identical to what every existing call site already sends to
 * the backend, so project data stays byte-compatible):
 *   '' (engine default) | '<profileId>' | 'preset:<id>' | 'auto:<slug>'
 *
 * Group order is fixed: default → fromVideo (dub only) → clone → designed →
 * preset. Clone-vs-designed splits on the runtime `.instruct` string (matching
 * VoicePreview/DubSegmentRow), NOT `profile.kind`.
 *
 * @param {string}   value            controlled value (see contract above)
 * @param {(v:string)=>void} onChange commits a new value
 * @param {Array}    [profiles=[]]    voice profiles ({id,name,instruct?})
 * @param {boolean}  [presets=false]  include the PRESETS character group
 * @param {Object}   [speakerClones=null] dub from-video speakers ({name: ...})
 * @param {boolean}  [engineDefault=true] include the '' engine-default row
 * @param {string}   [defaultLabel]   overrides the '' row label (Stories "↳ Aria")
 * @param {(v:string)=>void} [onPreview]   render a preview button → calls this
 * @param {boolean}  [previewLoading=false] show a spinner + disable preview
 * @param {()=>void} [onJumpToGallery] render a gallery-jump button → calls this
 * @param {()=>void} [onCreateVoice]  render an inline "create voice" button
 * @param {string}   [recentsKey='']  persist recents under this key (real ids only)
 * @param {string}   [placeholder]    trigger placeholder when nothing resolves
 */
export default function VoiceSelector({
  value = '',
  onChange,
  profiles = [],
  presets = false,
  speakerClones = null,
  engineDefault = true,
  defaultLabel,
  onPreview,
  previewLoading = false,
  onJumpToGallery,
  onCreateVoice,
  recentsKey = '',
  placeholder,
  disabled = false,
  size = 'md',
  buttonClassName,
}) {
  const { t } = useTranslation();

  const options = useMemo(() => {
    const list = [];

    // 1. engine-default sentinel — FIRST, no group header (groupLabel '').
    if (engineDefault) {
      list.push({
        value: '',
        label: defaultLabel || t('voiceSelector.engineDefault'),
        group: 'default',
        groupLabel: '',
      });
    }

    // 2. fromVideo (dub only) — slug rule byte-identical to DubSegmentRow.
    const speakers = speakerClones ? Object.keys(speakerClones) : [];
    for (const spk of speakers) {
      const slug = (spk || '').toLowerCase().replace(/\s+/g, '_');
      list.push({
        value: `auto:${slug}`,
        label: `🎤 ${spk}`,
        group: 'fromVideo',
        groupLabel: t('voiceSelector.fromVideo'),
      });
    }

    // 3 & 4. clone vs designed — split on runtime `.instruct` (not .kind).
    const clones = profiles.filter((p) => !p.instruct);
    const designed = profiles.filter((p) => !!p.instruct);
    for (const p of clones) {
      list.push({
        value: p.id,
        label: p.name?.trim() || p.id,
        group: 'clone',
        groupLabel: t('voiceSelector.clone'),
      });
    }
    for (const p of designed) {
      list.push({
        value: p.id,
        label: p.name?.trim() || p.id,
        group: 'designed',
        groupLabel: t('voiceSelector.designed'),
      });
    }

    // 5. presets.
    if (presets) {
      for (const p of PRESETS) {
        list.push({
          value: `preset:${p.id}`,
          label: p.name,
          group: 'preset',
          groupLabel: t('voiceSelector.presets'),
        });
      }
    }

    // Ghost: a real profile id is selected but the profile is gone (deleted but
    // still referenced by a track/segment/default). Render a human label so the
    // trigger isn't the raw id — but DON'T auto-clear (that mutates user data).
    const isSentinel = !value || value.startsWith('preset:') || value.startsWith('auto:');
    if (!isSentinel && !list.some((o) => o.value === value)) {
      list.push({
        value,
        label: t('voiceSelector.missingVoice'),
        group: 'clone',
        groupLabel: t('voiceSelector.clone'),
      });
    }

    return list;
  }, [profiles, presets, speakerClones, engineDefault, defaultLabel, value, t]);

  // Only real profile ids are worth recording as recents.
  const isRecentable = (v) => !!v && !v.startsWith('preset:') && !v.startsWith('auto:');

  return (
    <div className="voice-selector">
      <SearchableSelect
        value={value}
        onChange={onChange}
        options={options}
        renderGroupHeaders
        isRecentable={isRecentable}
        recentsKey={recentsKey}
        placeholder={placeholder || t('voiceSelector.engineDefault')}
        disabled={disabled}
        size={size}
        buttonClassName={buttonClassName}
      />
      {(onPreview || onJumpToGallery || onCreateVoice) && (
        <div className="voice-selector__adornments">
          {onPreview && (
            <button
              type="button"
              className="voice-selector__btn"
              onClick={() => onPreview(value)}
              disabled={previewLoading}
              aria-label={t('voiceSelector.preview')}
              title={t('voiceSelector.preview')}
            >
              {previewLoading
                ? <Loader size={13} className="voice-selector__spin" />
                : <Play size={13} />}
            </button>
          )}
          {onJumpToGallery && (
            <button
              type="button"
              className="voice-selector__btn"
              onClick={() => onJumpToGallery()}
              aria-label={t('voiceSelector.openGallery')}
              title={t('voiceSelector.openGallery')}
            >
              <ExternalLink size={13} />
            </button>
          )}
          {onCreateVoice && (
            <button
              type="button"
              className="voice-selector__btn"
              onClick={() => onCreateVoice()}
              aria-label={t('voiceSelector.createVoice')}
              title={t('voiceSelector.createVoice')}
            >
              <Plus size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
