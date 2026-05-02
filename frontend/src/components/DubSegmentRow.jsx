import React, { memo } from 'react';
import {
  CheckCircle, AlertCircle, Circle, Trash2, Loader, Headphones, Scissors, Merge,
  MoreHorizontal, Sparkles,
} from 'lucide-react';
import { formatTime } from '../utils/format';
import { LANG_CODES } from '../utils/languages';
import { PRESETS } from '../utils/constants';
import { Menu, Button, Badge } from '../ui';
import './DubSegmentRow.css';

const CHAR_BUDGET_RATIO = 1.3;

function rowClass(isActive, isDone, selected) {
  return `segment-row${isActive ? ' segment-active' : ''}${isDone ? ' segment-done' : ''}${selected ? ' segment-selected' : ''}`;
}

function DubSegmentRow({
  seg, idx, style, disabled, isActive, isDone, previewLoading, selected,
  profiles, onEditField, onDelete, onRestore, onPreview, onSelect, onSplit, onMerge, canMerge,
  onDirect,
}) {
  const syncColor = seg.sync_ratio === undefined ? null
    : (seg.sync_ratio >= 0.95 && seg.sync_ratio <= 1.05) ? '#b8bb26'
    : seg.sync_ratio > 1.25 ? '#fb4934'
    : '#fabd2f';
  const SyncIcon = seg.sync_ratio === undefined ? null
    : (seg.sync_ratio >= 0.95 && seg.sync_ratio <= 1.05) ? CheckCircle
    : seg.sync_ratio > 1.25 ? AlertCircle
    : Circle;

  const overBudget = seg.text_original
    && seg.text.length > Math.ceil(seg.text_original.length * CHAR_BUDGET_RATIO);

  const handleTextKeyDown = (e) => {
    // Ctrl/Cmd+D → split at cursor, Ctrl/Cmd+M → merge with next
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      const pos = e.target.selectionStart ?? seg.text.length;
      onSplit(seg.id, pos);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      if (canMerge) onMerge(seg.id);
    }
  };

  return (
    <div style={style} className={rowClass(isActive, isDone, selected)}>
      <input
        type="checkbox"
        checked={!!selected}
        onChange={(e) => onSelect(seg.id, idx, e.nativeEvent.shiftKey)}
        onClick={(e) => onSelect(seg.id, idx, e.shiftKey)}
        disabled={disabled}
        style={{ accentColor: '#d3869b' }}
        className="seg-check"
        title="Select segment (shift+click for range)"
      />
      <span className="segment-time seg-time">
        <span>
          {formatTime(seg.start)}–{formatTime(seg.end)}
          {seg.speed && seg.speed !== 1.0 && (
            <span className="seg-speed-badge" style={{ color: seg.speed > 1 ? '#d3869b' : '#8ec07c' }}>
              {seg.speed.toFixed(2)}x
            </span>
          )}
        </span>
        {SyncIcon && (
          <span
            className="seg-sync-badge"
            style={{ color: syncColor }}
            title={`Generated audio is ${Math.round(seg.sync_ratio * 100)}% the duration of original`}
          >
            <SyncIcon size={8} /> Sync: {Math.round(seg.sync_ratio * 100)}%
          </span>
        )}
        {seg.rate_ratio != null && Math.abs(seg.rate_ratio - 1.0) > 0.03 && (
          <span
            className="seg-rate-badge"
            style={{ color: seg.rate_ratio > 1.15 ? '#fb4934' : seg.rate_ratio < 0.85 ? '#83a598' : '#a89984' }}
            title={`Speech-rate fit: ${seg.rate_ratio.toFixed(2)}× relative to slot${seg.rate_error ? ` (${seg.rate_error})` : ''}`}
          >
            📖 {seg.rate_ratio.toFixed(2)}×
          </span>
        )}
      </span>

      <input
        className="input-base seg-speaker-input"
        value={seg.speaker_id || ''}
        onChange={(e) => onEditField(seg.id, 'speaker_id', e.target.value)}
        disabled={disabled}
        title="Speaker ID"
      />

      <span className="seg-text-col">
        <input
          className="input-base segment-input"
          value={seg.text}
          onChange={(e) => onEditField(seg.id, 'text', e.target.value)}
          onKeyDown={handleTextKeyDown}
          disabled={disabled}
          title={seg.translate_error
            ? `Translation error: ${seg.translate_error}`
            : overBudget
              ? `Text is ${Math.round((seg.text.length / seg.text_original.length) * 100)}% of original — consider higher speed or shorter phrasing`
              : 'Ctrl+D to split at cursor · Ctrl+M to merge with next'}
          style={
            overBudget ? { borderColor: 'rgba(250,189,47,0.6)', background: 'rgba(250,189,47,0.06)' }
            : seg.translate_error ? { borderColor: 'rgba(251,73,52,0.5)' }
            : undefined
          }
        />
        {seg.text_original && seg.text_original !== seg.text && (
          <span className="seg-orig-row">
            <span className="seg-orig-label">orig</span>
            <span className="seg-orig-text" title={seg.text_original}>
              {seg.text_original}
            </span>
            {overBudget && (
              <span className="seg-budget-warn">
                {Math.round((seg.text.length / seg.text_original.length) * 100)}%
              </span>
            )}
            <button
              onClick={() => onRestore(seg.id)}
              disabled={disabled}
              title="Restore original text"
              className="seg-restore-btn"
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
        <option value="">(Def)</option>
        {LANG_CODES.map(lc => (
          <option key={lc.code} value={lc.code}>{lc.code.toUpperCase()}</option>
        ))}
      </select>

      <select
        className="input-base seg-profile-select"
        value={seg.profile_id || ''}
        disabled={disabled}
        onChange={(e) => onEditField(seg.id, 'profile_id', e.target.value)}
      >
        <option value="">Default</option>
        {profiles.length > 0 && (
          <optgroup label="Clone Profiles">
            {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </optgroup>
        )}
        {PRESETS.length > 0 && (
          <optgroup label="Design Presets">
            {PRESETS.map(p => <option key={p.id} value={`preset:${p.id}`}>{p.name}</option>)}
          </optgroup>
        )}
      </select>

      <input
        type="range"
        min="0" max="200"
        value={Math.round((seg.gain ?? 1.0) * 100)}
        title={`${Math.round((seg.gain ?? 1.0) * 100)}%`}
        disabled={disabled}
        onChange={(e) => onEditField(seg.id, 'gain', Number(e.target.value) / 100)}
        className="seg-gain-slider"
        style={{ accentColor: (seg.gain ?? 1.0) > 1.2 ? '#fb4934' : (seg.gain ?? 1.0) < 0.5 ? '#83a598' : '#a89984' }}
      />

      <div className="seg-actions">
        <button
          className="segment-play"
          disabled={disabled}
          title="Live Preview"
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
              label: seg.direction ? 'Edit direction…' : 'Set direction…',
              icon: Sparkles,
              onSelect: () => onDirect?.(seg),
            },
            'separator',
            {
              id: 'split',
              label: 'Split at cursor',
              icon: Scissors,
              shortcut: '⌘D',
              onSelect: () => onSplit(seg.id, Math.floor(seg.text.length / 2)),
            },
            {
              id: 'merge',
              label: 'Merge with next',
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
            title={seg.direction ? `Direction: ${seg.direction}` : 'More actions'}
          >
            {seg.direction ? <Sparkles size={9} /> : <MoreHorizontal size={9} />}
          </button>
        </Menu>
        <button
          className="segment-del"
          disabled={disabled}
          onClick={() => onDelete(seg.id)}
        >
          <Trash2 size={9} />
        </button>
      </div>
    </div>
  );
}

export default memo(DubSegmentRow, (prev, next) => (
  prev.seg === next.seg &&
  prev.disabled === next.disabled &&
  prev.isActive === next.isActive &&
  prev.isDone === next.isDone &&
  prev.previewLoading === next.previewLoading &&
  prev.onDirect === next.onDirect &&
  prev.selected === next.selected &&
  prev.canMerge === next.canMerge &&
  prev.profiles === next.profiles &&
  prev.idx === next.idx
));
