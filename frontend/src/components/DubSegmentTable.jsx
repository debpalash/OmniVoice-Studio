import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { List } from 'react-window';
import DubSegmentRow from './DubSegmentRow';
import { Table, Select } from '../ui';
import { useAppStore } from '../store';
import './DubSegmentTable.css';

const BASE_ROW_HEIGHT = 26;
const ROW_HEIGHT_WITH_ORIG = 40;

const COLUMNS = [
  { key: 'time',  width: 50 },
  { key: 'spkr',  width: 45 },
  { key: 'text',  flex: 1 },
  { key: 'lang',  width: 42 },
  { key: 'voice', width: 60 },
  { key: 'vol',   width: 40 },
  { key: 'act',   width: 42 },
];

export default function DubSegmentTable({
  segments, profiles, speakerClones, dubStep, dubProgress, previewLoadingId,
  selectedIds, onSelect, onSelectAll, onClearSelection,
  onEditField, onDelete, onRestore, onPreview, onSplit, onMerge, onDirect, onSeek,
  timelineSelectedId = null,
}) {
  const { t } = useTranslation();
  const disabled = dubStep === 'generating' || dubStep === 'stopping';
  const [query, setQuery] = useState('');
  const [speakerFilter, setSpeakerFilter] = useState('');
  // ID of the segment under the playhead. Subscribed via selector so the
  // table re-renders only when the playing segment changes, not on every
  // timeupdate tick.
  const currentSegId = useAppStore(s => s.dubCurrentSegId);

  // Imperative handle for react-window v2 so we can auto-scroll the row
  // containing the playhead into view. (The scroll effect itself lives
  // below the `filtered` memo so it can depend on it without TDZ.)
  const listRef = useRef(null);

  const columns = COLUMNS.map(c => {
    if (c.key === 'vol') return { ...c, label: t('segment.vol'), title: t('segment.vol_title') };
    if (c.key === 'act') return { ...c, label: '' };
    return { ...c, label: t(`segment.${c.key}`) };
  });

  const bodyRef = useRef(null);
  const [bodyHeight, setBodyHeight] = useState(0);
  useLayoutEffect(() => {
    if (!bodyRef.current) return;
    const measure = () => {
      const h = bodyRef.current?.clientHeight || 0;
      setBodyHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bodyRef.current);
    return () => ro.disconnect();
  }, []);

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

  // Auto-scroll the playing row into view as the playhead advances. Uses
  // align='smart' so an already-visible row doesn't trigger a jump.
  // Placed after `filtered` so it can depend on it without TDZ.
  useEffect(() => {
    if (!currentSegId || !listRef.current) return;
    const filteredIdx = filtered.findIndex(s => s.id === currentSegId);
    if (filteredIdx < 0) return;
    try {
      listRef.current.scrollToRow({
        index: filteredIdx, align: 'smart', behavior: 'smooth',
      });
    } catch (_) { /* react-window may not be ready yet */ }
  }, [currentSegId, filtered]);

  // Timeline → table sync (#280, item 3): clicking a segment box on the
  // waveform timeline scrolls its row into view and highlights it.
  useEffect(() => {
    if (timelineSelectedId == null || !listRef.current) return;
    const filteredIdx = filtered.findIndex(s => String(s.id) === String(timelineSelectedId));
    if (filteredIdx < 0) return;
    try {
      listRef.current.scrollToRow({
        index: filteredIdx, align: 'smart', behavior: 'smooth',
      });
    } catch (_) { /* react-window may not be ready yet */ }
  }, [timelineSelectedId, filtered]);

  const rowHeight = useCallback((index) => {
    const s = filtered[index];
    if (!s) return BASE_ROW_HEIGHT;
    return (s.text_original && s.text_original !== s.text) ? ROW_HEIGHT_WITH_ORIG : BASE_ROW_HEIGHT;
  }, [filtered]);

  const rowProps = useMemo(() => ({
    filtered, profiles, speakerClones, disabled, dubStep, dubProgress, previewLoadingId,
    selectedIds, onSelect, onEditField, onDelete, onRestore, onPreview, onSplit, onMerge, onDirect, onSeek,
    segments, currentSegId, timelineSelectedId,
  }), [filtered, profiles, speakerClones, disabled, dubStep, dubProgress, previewLoadingId,
      selectedIds, onSelect, onEditField, onDelete, onRestore, onPreview, onSplit, onMerge, onDirect, onSeek, segments, currentSegId, timelineSelectedId]);

  const Row = useCallback(({ index, style, filtered: fl, profiles: profs, speakerClones: clones, disabled: dis, dubProgress: prog, dubStep: step, previewLoadingId: previewId, selectedIds: sel, onSelect: pick, onEditField: edit, onDelete: del, onRestore: rest, onPreview: prev, onSplit: split, onMerge: merge, onDirect: direct, onSeek: seek, segments: segs, currentSegId: curId, timelineSelectedId: tlSel }) => {
    const seg = fl[index];
    if (!seg) return null;
    const absoluteIndex = segs.indexOf(seg);
    const isActive = (step === 'generating' || step === 'stopping') && prog.current === absoluteIndex + 1;
    const isDone = (step === 'generating' || step === 'stopping') && prog.current > absoluteIndex + 1;
    const isPlaying = curId === seg.id;
    const timelineSelected = tlSel != null && String(tlSel) === String(seg.id);
    const canMerge = index < fl.length - 1;
    return (
      <DubSegmentRow
        seg={seg} idx={index} style={style}
        disabled={dis} isActive={isActive} isDone={isDone}
        isPlaying={isPlaying}
        timelineSelected={timelineSelected}
        previewLoading={previewId === seg.id}
        selected={sel && sel.has(seg.id)}
        canMerge={canMerge}
        profiles={profs}
        speakerClones={clones}
        onEditField={edit} onDelete={del} onRestore={rest} onPreview={prev}
        onSelect={pick} onSplit={split} onMerge={merge} onDirect={direct} onSeek={seek}
      />
    );
  }, []);

  const allFilteredSelected = filtered.length > 0 && filtered.every(s => selectedIds && selectedIds.has(s.id));
  const selCount = selectedIds?.size ?? 0;
  const meta = (
    <>
      {filtered.length}/{segments.length}
      {selCount > 0 && <span className="dub-segment-table__sel-count"> · {t('segment.sel_count', { count: selCount })}</span>}
    </>
  );

  return (
    <Table className="segment-table">
      <Table.Toolbar
        search={query}
        onSearch={setQuery}
        searchPlaceholder={t('segment.search_placeholder')}
        meta={meta}
      >
        {speakers.length > 1 && (
          <Select
            size="sm"
            value={speakerFilter}
            onChange={(e) => setSpeakerFilter(e.target.value)}
            className="dub-segment-table__spk-filter"
          >
            <option value="">{t('segment.all_speakers')}</option>
            {speakers.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
        )}
      </Table.Toolbar>

      <Table.Header
        className="dub-segment-table__header"
        columns={columns}
        leading={
          <span className="dub-segment-table__select-all">
            <input
              type="checkbox"
              checked={allFilteredSelected}
              onChange={(e) => e.target.checked ? onSelectAll(filtered) : onClearSelection()}
              title={t('segment.select_all_title')}
            />
          </span>
        }
      />

      <div className="dub-segment-table__body" ref={bodyRef}>
        {bodyHeight > 0 && (
          <List
            listRef={listRef}
            rowCount={filtered.length}
            rowHeight={rowHeight}
            rowComponent={Row}
            rowProps={rowProps}
            overscanCount={6}
            style={{ height: bodyHeight, width: '100%' }}
          />
        )}
      </div>
    </Table>
  );
}
