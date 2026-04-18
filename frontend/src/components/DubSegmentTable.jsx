import React, { useCallback, useMemo, useState } from 'react';
import { List } from 'react-window';
import { Search, X } from 'lucide-react';
import DubSegmentRow from './DubSegmentRow';

const BASE_ROW_HEIGHT = 28;
const ROW_HEIGHT_WITH_ORIG = 44;

export default function DubSegmentTable({
  segments, profiles, dubStep, dubProgress, previewLoadingId,
  selectedIds, onSelect, onSelectAll, onClearSelection,
  onEditField, onDelete, onRestore, onPreview, onSplit, onMerge,
}) {
  const disabled = dubStep === 'generating' || dubStep === 'stopping';
  const [query, setQuery] = useState('');
  const [speakerFilter, setSpeakerFilter] = useState('');

  const speakers = useMemo(() => {
    const s = new Set(segments.map(x => x.speaker_id).filter(Boolean));
    return Array.from(s).sort();
  }, [segments]);

  const filtered = useMemo(() => {
    if (!query && !speakerFilter) return segments;
    const q = query.trim().toLowerCase();
    return segments.filter(s => {
      if (speakerFilter && s.speaker_id !== speakerFilter) return false;
      if (!q) return true;
      return (s.text && s.text.toLowerCase().includes(q))
        || (s.text_original && s.text_original.toLowerCase().includes(q));
    });
  }, [segments, query, speakerFilter]);

  const rowHeight = useCallback((index) => {
    const s = filtered[index];
    if (!s) return BASE_ROW_HEIGHT;
    return (s.text_original && s.text_original !== s.text) ? ROW_HEIGHT_WITH_ORIG : BASE_ROW_HEIGHT;
  }, [filtered]);

  const rowProps = useMemo(() => ({
    filtered, profiles, disabled, dubStep, dubProgress, previewLoadingId,
    selectedIds, onSelect, onEditField, onDelete, onRestore, onPreview, onSplit, onMerge,
    segments,
  }), [filtered, profiles, disabled, dubStep, dubProgress, previewLoadingId,
      selectedIds, onSelect, onEditField, onDelete, onRestore, onPreview, onSplit, onMerge, segments]);

  const Row = useCallback(({ index, style, filtered: fl, profiles: profs, disabled: dis, dubProgress: prog, dubStep: step, previewLoadingId: previewId, selectedIds: sel, onSelect: pick, onEditField: edit, onDelete: del, onRestore: rest, onPreview: prev, onSplit: split, onMerge: merge, segments: segs }) => {
    const seg = fl[index];
    if (!seg) return null;
    const absoluteIndex = segs.indexOf(seg);
    const isActive = (step === 'generating' || step === 'stopping') && prog.current === absoluteIndex + 1;
    const isDone = (step === 'generating' || step === 'stopping') && prog.current > absoluteIndex + 1;
    const canMerge = index < fl.length - 1;
    return (
      <DubSegmentRow
        seg={seg} idx={index} style={style}
        disabled={dis} isActive={isActive} isDone={isDone}
        previewLoading={previewId === seg.id}
        selected={sel && sel.has(seg.id)}
        canMerge={canMerge}
        profiles={profs}
        onEditField={edit} onDelete={del} onRestore={rest} onPreview={prev}
        onSelect={pick} onSplit={split} onMerge={merge}
      />
    );
  }, []);

  const allFilteredSelected = filtered.length > 0 && filtered.every(s => selectedIds && selectedIds.has(s.id));

  return (
    <div className="segment-table" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Search / filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.15)' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 120 }}>
          <Search size={10} style={{ position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)', color: '#6b6657' }} />
          <input
            className="input-base"
            placeholder="Search text…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: '100%', fontSize: '0.64rem', padding: '3px 6px 3px 20px' }}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              style={{ position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#6b6657', cursor: 'pointer' }}
            >
              <X size={10} />
            </button>
          )}
        </div>
        {speakers.length > 1 && (
          <select
            className="input-base"
            value={speakerFilter}
            onChange={(e) => setSpeakerFilter(e.target.value)}
            style={{ fontSize: '0.62rem', padding: '3px 4px', minWidth: 80 }}
          >
            <option value="">All speakers</option>
            {speakers.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <span style={{ fontSize: '0.62rem', color: '#6b6657', whiteSpace: 'nowrap' }}>
          {filtered.length}/{segments.length}
          {selectedIds && selectedIds.size > 0 && (
            <span style={{ color: '#d3869b', marginLeft: 4 }}>· {selectedIds.size} sel</span>
          )}
        </span>
      </div>

      <div className="segment-header">
        <span style={{ width: 18 }}>
          <input
            type="checkbox"
            checked={allFilteredSelected}
            onChange={(e) => e.target.checked ? onSelectAll(filtered) : onClearSelection()}
            style={{ accentColor: '#d3869b', cursor: 'pointer' }}
            title="Select all filtered"
          />
        </span>
        <span style={{ width: 55 }}>Time</span>
        <span style={{ width: 50 }}>Spkr</span>
        <span style={{ flex: 1 }}>Text</span>
        <span style={{ width: 45 }}>Lang</span>
        <span style={{ width: 90 }}>Voice</span>
        <span style={{ width: 30 }} title="Volume (0-200%)">Vol</span>
        <span style={{ width: 62 }}></span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <List
          rowCount={filtered.length}
          rowHeight={rowHeight}
          rowComponent={Row}
          rowProps={rowProps}
          overscanCount={6}
          style={{ height: '100%', width: '100%' }}
        />
      </div>
    </div>
  );
}
