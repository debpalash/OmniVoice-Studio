import React, { memo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle,
  AlertCircle,
  Circle,
  Trash2,
  Loader,
  Headphones,
  Scissors,
  Merge,
  MoreHorizontal,
  Sparkles,
} from 'lucide-react';
import { formatTime } from '../utils/format';
import { LANG_CODES } from '../utils/languages';
import { PRESETS } from '../utils/constants';
import { Menu, Button, Badge } from '../ui';

const CHAR_BUDGET_RATIO = 1.3;
const SENTENCE_END = /[.!?。！？]/;

function rowClass(isActive, isDone, selected, isPlaying, timelineSelected) {
  return `segment-row${isActive ? ' segment-active' : ''}${isDone ? ' segment-done' : ''}${selected ? ' segment-selected' : ''}${isPlaying ? ' segment-playing' : ''}${timelineSelected ? ' segment-timeline-selected' : ''}`;
}

// Best split point for the Scissors menu when the user hasn't placed a cursor —
// prefer the sentence boundary nearest the middle, then a whitespace boundary,
// then the literal midpoint as a last resort.
function bestSplitPoint(text) {
  const mid = Math.floor(text.length / 2);
  let best = -1,
    bestDist = Infinity;
  for (let i = 0; i < text.length; i++) {
    if (SENTENCE_END.test(text[i])) {
      const d = Math.abs(i + 1 - mid);
      if (d < bestDist) {
        best = i + 1;
        bestDist = d;
      }
    }
  }
  if (best > 0 && best < text.length) return best;
  for (let r = 0; r < text.length; r++) {
    for (const i of [mid - r, mid + r]) {
      if (i > 0 && i < text.length && /\s/.test(text[i])) return i;
    }
  }
  return mid;
}

// Accept "m:ss[.s]" or raw seconds; return null on garbage so the field can revert.
function parseTime(s) {
  const m = /^\s*(\d+):([0-5]?\d(?:\.\d+)?)\s*$/.exec(s);
  if (m) return parseInt(m[1], 10) * 60 + parseFloat(m[2]);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function DubSegmentRow({
  seg,
  idx,
  style,
  disabled,
  isActive,
  isDone,
  isPlaying,
  previewLoading,
  selected,
  profiles,
  speakerClones,
  onEditField,
  onDelete,
  onRestore,
  onPreview,
  onSelect,
  onSplit,
  onMerge,
  canMerge,
  onDirect,
  onSeek,
  timelineSelected,
}) {
  const { t } = useTranslation();
  const textInputRef = useRef(null);
  // Remember where the caret was inside the text field even after it loses
  // focus — Radix's menu trigger steals focus, so by the time the Scissors
  // item fires, selectionStart on the input would otherwise read as null.
  const lastCursorRef = useRef(null);
  const speakerOptions = speakerClones ? Object.keys(speakerClones) : [];
  const speakerListId = `seg-speakers-${seg.id}`;

  // Truthful per-segment fit badge. The backend's new fit_status object is
  // the source of truth — describes exactly what the mix loop did:
  //   "fits"            → audio fit cleanly inside the slot (or its gap).
  //   "overflows"       → concise mode hard-trimmed +Ns past slot; user
  //                       should shorten the text for a cleaner result.
  //   "video_stretched" → stretch_video mode lengthened the source clip by
  //                       the stretch ratio to fit natural-rate audio.
  // We fall back to the legacy sync_ratio bucketing only when fit_status is
  // missing (older jobs / partial-regen with no done event yet) — and even
  // then we now display the *raw* ratio so it stops claiming 100% when the
  // audio was actually compressed at synthesis time.
  const fitStatus = seg.fit_status && typeof seg.fit_status === 'object' ? seg.fit_status : null;
  let fitBadge = null;
  if (fitStatus) {
    if (fitStatus.status === 'fits') {
      fitBadge = {
        color: '#b8bb26',
        Icon: CheckCircle,
        label: t('segment.fit_fits'),
        title: t('segment.fit_fits_title'),
      };
    } else if (fitStatus.status === 'overflows') {
      const over = fitStatus.overflow_s || 0;
      fitBadge = {
        color: over > 0.5 ? '#fb4934' : '#fabd2f',
        Icon: AlertCircle,
        label: t('segment.fit_overflows', { seconds: over.toFixed(2) }),
        title: t('segment.fit_overflows_title', { seconds: over.toFixed(2) }),
      };
    } else if (fitStatus.status === 'video_stretched') {
      const r = fitStatus.stretch_ratio || 1.0;
      fitBadge = {
        color: r > 1.18 ? '#fb4934' : r > 1.05 ? '#fabd2f' : '#83a598',
        Icon: Circle,
        label: t('segment.fit_stretched', { ratio: r.toFixed(2) }),
        title: t('segment.fit_stretched_title', { ratio: r.toFixed(2) }),
      };
    }
  } else if (seg.sync_ratio !== undefined) {
    const r = seg.sync_ratio;
    if (r > 1.25) {
      fitBadge = {
        color: '#fb4934',
        Icon: AlertCircle,
        label: `${Math.round(r * 100)}%`,
        title: t('segment.fit_compressed_title', { pct: Math.round(r * 100) }),
      };
    } else if (r >= 0.95 && r <= 1.05) {
      fitBadge = {
        color: '#b8bb26',
        Icon: CheckCircle,
        label: t('segment.fit_fits'),
        title: t('segment.fit_audio_title'),
      };
    } else {
      fitBadge = {
        color: '#fabd2f',
        Icon: Circle,
        label: `${Math.round(r * 100)}%`,
        title: t('segment.fit_ratio_title', { pct: Math.round(r * 100) }),
      };
    }
  }

  const overBudget =
    seg.text_original && seg.text.length > Math.ceil(seg.text_original.length * CHAR_BUDGET_RATIO);

  const handleTextKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      const pos = e.target.selectionStart ?? seg.text.length;
      onSplit(seg.id, pos);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      if (canMerge) onMerge(seg.id);
    }
  };

  const captureCursor = (e) => {
    const pos = e.target.selectionStart;
    if (pos != null) lastCursorRef.current = pos;
  };

  // Row click → seek the player to this segment. We don't fire when the click
  // originates in an interactive element (input, button, the actions cluster)
  // so per-field editing keeps working.
  const handleRowClick = (e) => {
    if (!onSeek) return;
    if (e.target.closest('input, button, select, textarea, label, [data-noseek]')) return;
    onSeek(seg.start);
  };

  return (
    <div
      style={style}
      className={rowClass(isActive, isDone, selected, isPlaying, timelineSelected)}
      onClick={handleRowClick}
    >
      <input
        type="checkbox"
        checked={!!selected}
        onChange={(e) => onSelect(seg.id, idx, e.nativeEvent.shiftKey)}
        onClick={(e) => onSelect(seg.id, idx, e.shiftKey)}
        disabled={disabled}
        className="cursor-pointer justify-self-center"
        title={t('segment.select_title')}
      />
      <span className="segment-time flex flex-col min-w-0 overflow-hidden tabular-nums">
        <span className="flex items-baseline gap-[2px] min-w-0">
          <input
            type="text"
            className="seg-time-input"
            defaultValue={formatTime(seg.start)}
            key={`start-${seg.id}-${seg.start}`}
            disabled={disabled}
            title={t('segment.time_edit_title')}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.target.blur();
              if (e.key === 'Escape') {
                e.target.value = formatTime(seg.start);
                e.target.blur();
              }
            }}
            onBlur={(e) => {
              const v = parseTime(e.target.value);
              if (v == null || v < 0 || v >= seg.end) {
                e.target.value = formatTime(seg.start);
                return;
              }
              if (Math.abs(v - seg.start) > 1e-3) {
                onEditField(seg.id, 'start', +v.toFixed(3));
              } else {
                e.target.value = formatTime(seg.start);
              }
            }}
          />
          <span className="text-[var(--chrome-fg-muted)]">–</span>
          <span className="text-[var(--chrome-fg-muted)] text-[0.62rem]">
            {formatTime(seg.end)}
          </span>
          {seg.speed && seg.speed !== 1.0 && (
            <span
              className="text-[0.52rem] ml-[1px]"
              style={{ color: seg.speed > 1 ? '#d3869b' : '#8ec07c' }}
            >
              {seg.speed.toFixed(2)}x
            </span>
          )}
        </span>
        {fitBadge && (
          <span
            className="text-[0.48rem] mt-[1px] inline-flex items-center gap-[1px]"
            style={{ color: fitBadge.color }}
            title={fitBadge.title}
          >
            <fitBadge.Icon size={8} /> {fitBadge.label}
          </span>
        )}
        {seg.qc_flagged && (
          // Wave 3.3: second-pass ASR heard something different from the
          // target text for this line — worth a re-listen / re-dub.
          <span
            className="text-[0.48rem] mt-[1px] inline-flex items-center gap-[1px]"
            style={{ color: '#fb4934' }}
            title={t('segment.qc_verify_title', { heard: seg.qc_recognized || '' })}
          >
            <AlertCircle size={8} /> {t('segment.qc_verify')}
          </span>
        )}
        {seg.rate_ratio != null && Math.abs(seg.rate_ratio - 1.0) > 0.03 && (
          <span
            className="text-[0.48rem] mt-[1px] tabular-nums"
            style={{
              color:
                seg.rate_ratio > 1.15 ? '#fb4934' : seg.rate_ratio < 0.85 ? '#83a598' : '#a89984',
            }}
            title={t('segment.rate_title', {
              ratio: seg.rate_ratio.toFixed(2),
              error: seg.rate_error || '',
            })}
          >
            📖 {seg.rate_ratio.toFixed(2)}×
          </span>
        )}
        {/* Pre-synthesis duration plan (backend duration_planner): warn about
            tight/impossible segments BEFORE GPU time is spent. Informational
            only — generation is never blocked. */}
        {seg.plan && (seg.plan.status === 'tight' || seg.plan.status === 'impossible') && (
          <span
            className="text-[0.48rem] mt-[1px] inline-flex items-center gap-[1px]"
            style={{ color: seg.plan.status === 'impossible' ? '#fb4934' : '#fabd2f' }}
            title={t(
              seg.plan.status === 'impossible'
                ? 'segment.plan_impossible_title'
                : 'segment.plan_tight_title',
              {
                est: (seg.plan.est_dur_s || 0).toFixed(1),
                avail: (seg.plan.available_s || 0).toFixed(1),
                seconds: (seg.plan.est_overrun_s || 0).toFixed(1),
              },
            )}
          >
            <AlertCircle size={8} />{' '}
            {seg.plan.status === 'impossible'
              ? t('segment.plan_impossible', {
                  seconds: (seg.plan.est_overrun_s || 0).toFixed(1),
                })
              : t('segment.plan_tight')}
          </span>
        )}
        {seg.plan && seg.plan.suggested_text && seg.plan.suggested_text !== seg.text && (
          <button
            onClick={() => onEditField(seg.id, 'text', seg.plan.suggested_text)}
            disabled={disabled}
            title={t('segment.plan_apply_title', { text: seg.plan.suggested_text })}
            className="bg-transparent border-none text-[#83a598] cursor-pointer p-0 mt-[1px] text-[0.48rem] text-left"
          >
            ✂ {t('segment.plan_apply')}
          </button>
        )}
      </span>

      <input
        className="seg-speaker-input"
        value={seg.speaker_id || ''}
        onChange={(e) => onEditField(seg.id, 'speaker_id', e.target.value)}
        onClick={(e) => e.stopPropagation()}
        disabled={disabled}
        list={speakerOptions.length ? speakerListId : undefined}
        placeholder={speakerOptions.length ? t('segment.speaker_pick') : ''}
        title={
          speakerOptions.length
            ? t('segment.speaker_title_detected')
            : t('segment.speaker_title_custom')
        }
      />
      {speakerOptions.length > 0 && (
        <datalist id={speakerListId}>
          {speakerOptions.map((spk) => (
            <option key={spk} value={spk} />
          ))}
        </datalist>
      )}

      <span className="seg-text-col">
        <input
          ref={textInputRef}
          className="input-base segment-input"
          value={seg.text}
          onChange={(e) => onEditField(seg.id, 'text', e.target.value)}
          onKeyDown={handleTextKeyDown}
          onKeyUp={captureCursor}
          onSelect={captureCursor}
          onClick={(e) => {
            e.stopPropagation();
            captureCursor(e);
          }}
          disabled={disabled}
          title={
            seg.translate_error
              ? t('segment.translate_error_title', { error: seg.translate_error })
              : overBudget
                ? t('segment.budget_title', {
                    pct: Math.round((seg.text.length / seg.text_original.length) * 100),
                  })
                : t('segment.text_title')
          }
          style={
            overBudget
              ? { background: 'rgba(250,189,47,0.10)' }
              : seg.translate_error
                ? { background: 'rgba(251,73,52,0.10)' }
                : undefined
          }
        />
        {seg.text_original && seg.text_original !== seg.text && (
          <span className="text-[0.52rem] text-[#6b6657] flex items-center gap-[3px] px-[2px] overflow-hidden">
            <span className="opacity-80 uppercase font-semibold text-[0.48rem] text-[#7c6f64]">
              {t('segment.orig_label')}
            </span>
            <span
              className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis"
              title={seg.text_original}
            >
              {seg.text_original}
            </span>
            {overBudget && (
              <span className="text-[#fabd2f] text-[0.48rem]">
                {Math.round((seg.text.length / seg.text_original.length) * 100)}%
              </span>
            )}
            <button
              onClick={() => onRestore(seg.id)}
              disabled={disabled}
              title={t('segment.restore_title')}
              className="bg-transparent border-none text-[#83a598] cursor-pointer p-0 text-[0.52rem]"
            >
              ↺
            </button>
          </span>
        )}
      </span>

      <select
        className="input-base seg-lang-select"
        value={seg.target_lang || ''}
        disabled={disabled}
        onChange={(e) => onEditField(seg.id, 'target_lang', e.target.value)}
      >
        <option value="">{t('segment.lang_default')}</option>
        {LANG_CODES.map((lc) => (
          <option key={lc.code} value={lc.code}>
            {lc.code.toUpperCase()}
          </option>
        ))}
      </select>

      <select
        className="input-base seg-profile-select"
        value={seg.profile_id || ''}
        disabled={disabled}
        onChange={(e) => onEditField(seg.id, 'profile_id', e.target.value)}
      >
        <option value="">{t('segment.voice_default')}</option>
        {speakerClones && Object.keys(speakerClones).length > 0 && (
          <optgroup label={t('segment.from_video')}>
            {Object.keys(speakerClones).map((spk) => {
              const autoId = `auto:${(spk || '').toLowerCase().replace(/\s+/g, '_')}`;
              return (
                <option key={autoId} value={autoId}>
                  🎤 {spk}
                </option>
              );
            })}
          </optgroup>
        )}
        {profiles.length > 0 && (
          <optgroup label={t('segment.clone_profiles')}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        )}
        {PRESETS.length > 0 && (
          <optgroup label={t('segment.design_presets')}>
            {PRESETS.map((p) => (
              <option key={p.id} value={`preset:${p.id}`}>
                {p.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>

      <input
        type="range"
        min="0"
        max="200"
        value={Math.round((seg.gain ?? 1.0) * 100)}
        title={`${Math.round((seg.gain ?? 1.0) * 100)}%`}
        disabled={disabled}
        onChange={(e) => onEditField(seg.id, 'gain', Number(e.target.value) / 100)}
        className="seg-gain-slider"
        style={{
          accentColor:
            (seg.gain ?? 1.0) > 1.2
              ? 'var(--color-danger)'
              : (seg.gain ?? 1.0) < 0.5
                ? 'var(--color-info)'
                : 'var(--color-fg-muted)',
        }}
      />

      <div className="seg-actions">
        <button
          className="segment-play"
          disabled={disabled}
          title={t('segment.preview_title')}
          onClick={(e) => onPreview(seg, e)}
        >
          {previewLoading ? <Loader className="spinner" size={9} /> : <Headphones size={9} />}
        </button>
        <Menu
          placement="bottom-end"
          disabled={disabled}
          items={[
            {
              id: 'direct',
              label: seg.direction ? t('segment.edit_direction') : t('segment.set_direction'),
              icon: Sparkles,
              onSelect: () => onDirect?.(seg),
            },
            'separator',
            {
              id: 'split',
              label: t('segment.split_label'),
              icon: Scissors,
              shortcut: '⌘D',
              onSelect: () => {
                // Prefer the live cursor if the text input still has focus,
                // otherwise fall back to the last remembered position, then
                // to a sentence-boundary heuristic. Splitting at the literal
                // midpoint (the old behaviour) felt random to users.
                let pos = textInputRef.current?.selectionStart;
                if (pos == null || pos <= 0 || pos >= seg.text.length) {
                  pos = lastCursorRef.current;
                }
                if (pos == null || pos <= 0 || pos >= seg.text.length) {
                  pos = bestSplitPoint(seg.text);
                }
                onSplit(seg.id, pos);
              },
            },
            {
              id: 'merge',
              label: t('segment.merge_label'),
              icon: Merge,
              shortcut: '⌘M',
              disabled: !canMerge,
              onSelect: () => onMerge(seg.id),
            },
          ]}
        >
          <button
            className={`segment-play ${seg.direction ? 'has-direction' : ''}`}
            disabled={disabled}
            title={
              seg.direction
                ? t('segment.direction_title', { dir: seg.direction })
                : t('segment.more_actions_title')
            }
          >
            {seg.direction ? <Sparkles size={9} /> : <MoreHorizontal size={9} />}
          </button>
        </Menu>
        <button className="segment-del" disabled={disabled} onClick={() => onDelete(seg.id)}>
          <Trash2 size={9} />
        </button>
      </div>
    </div>
  );
}

export default memo(
  DubSegmentRow,
  (prev, next) =>
    prev.seg === next.seg &&
    prev.disabled === next.disabled &&
    prev.isActive === next.isActive &&
    prev.isDone === next.isDone &&
    prev.isPlaying === next.isPlaying &&
    prev.timelineSelected === next.timelineSelected &&
    prev.previewLoading === next.previewLoading &&
    prev.onDirect === next.onDirect &&
    prev.onSeek === next.onSeek &&
    prev.selected === next.selected &&
    prev.canMerge === next.canMerge &&
    prev.profiles === next.profiles &&
    prev.speakerClones === next.speakerClones &&
    prev.idx === next.idx,
);
