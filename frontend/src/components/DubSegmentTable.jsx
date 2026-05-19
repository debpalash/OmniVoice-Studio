import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { List } from 'react-window';
import DubSegmentRow from './DubSegmentRow';
import { Table, Select } from '../ui';
import './DubSegmentTable.css';

const BASE_ROW_HEIGHT = 26;
const ROW_HEIGHT_WITH_ORIG = 40;

export default function DubSegmentTable({
  segments, profiles, speakerClones, dubStep, dubProgress, previewLoadingId,
  selectedIds, onSelect, onSelectAll, onClearSelection,
  onEditField, onDelete, onRestore, onPreview, onSplit, onMerge, onDirect, onSeek,
}) {
  const { t } = useTranslation();
  const disabled = dubStep === 'generating' || dubStep === 'stopping';
  const columns = useMemo(() => [
    { key: 'time',  label: t('dub.time_column'),  width: 46 },
    { key: 'spkr',  label: t('dub.spkr_column'),  width: 40 },
    { key: 'text',  label: t('dub.text_column'),  flex: 1 },
    { key: 'lang',  label: t('dub.lang_column'),  width: 38 },
    { key: 'voice', label: t('dub.voice_column'), width: 56 },
    { key: 'vol',   label: t('dub.vol_column'),   width: 36, title: t('dub.volume_title') },
    { key: 'act',   label: '',      width: 38 },
  ], [t]);
  const [query, setQuery] = useState('');
  const [speakerFilter, setSpeakerFilter] = useState('');

  // react-window v2 needs a concrete height prop — CSS 100 % doesn't cut it.
  // Measure the body container and pass its height explicitly so the list
  // renders every row that fits, not just a default-sized window.
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

  const rowHeight = useCallback((index) => {
    const s = filtered[index];
    if (!s) return BASE_ROW_HEIGHT;
    return (s.text_original && s.text_original !== s.text) ? ROW_HEIGHT_WITH_ORIG : BASE_ROW_HEIGHT;
  }, [filtered]);

  const rowProps = useMemo(() => ({
    filtered, profiles, speakerClones, disabled, dubStep, dubProgress, previewLoadingId,
    selectedIds, onSelect, onEditField, onDelete, onRestore, onPreview, onSplit, onMerge, onDirect, onSeek,
    segments,
  }), [filtered, profiles, speakerClones, disabled, dubStep, dubProgress, previewLoadingId,
      selectedIds, onSelect, onEditField, onDelete, onRestore, onPreview, onSplit, onMerge, onDirect, onSeek, segments]);

  const Row = useCallback(({ index, style, filtered: fl, profiles: profs, speakerClones: clones, disabled: dis, dubProgress: prog, dubStep: step, previewLoadingId: previewId, selectedIds: sel, onSelect: pick, onEditField: edit, onDelete: del, onRestore: rest, onPreview: prev, onSplit: split, onMerge: merge, onDirect: direct, onSeek: seek, segments: segs }) => {
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
      {selCount > 0 && <span className="dub-segment-table__sel-count"> · {t('dub.selected_count', { n: selCount })}</span>}
    </>
  );

  return (
    <Table className="segment-table">
      <Table.Toolbar
        search={query}
        onSearch={setQuery}
        searchPlaceholder={t('dub.search_text')}
        meta={meta}
      >
        {speakers.length > 1 && (
          <Select
            size="sm"
            value={speakerFilter}
            onChange={(e) => setSpeakerFilter(e.target.value)}
            className="dub-segment-table__spk-filter"
          >
            <option value="">{t('dub.all_speakers')}</option>
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
              title={t('dub.select_all_filtered')}
            />
          </span>
        }
      />

      <div className="dub-segment-table__body" ref={bodyRef}>
        {bodyHeight > 0 && (
          <List
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
