/**
 * TranscriptionsPage — history of dictation transcriptions.
 *
 * Stores transcriptions in localStorage and displays them in a searchable,
 * timestamped list. Each entry can be copied, deleted, or re-used.
 *
 * Reactivity: addTranscription() dispatches a custom window event so the
 * page updates in realtime without requiring a shared store.
 */
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { Mic, Copy, Trash2, Search, Clock, Languages, FileText, Download } from 'lucide-react';
import { Button } from '../ui';
import { toast } from 'react-hot-toast';
import './Transcriptions.css';

const STORAGE_KEY = 'omni_transcriptions';
const TXN_EVENT = 'omni:transcription-added';

function loadTranscriptions() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function saveTranscriptions(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function addTranscription(entry) {
  const list = loadTranscriptions();
  const newEntry = {
    id: Date.now(),
    text: entry.text || '',
    language: entry.language || 'unknown',
    duration_s: entry.duration_s || 0,
    segments: entry.segments || [],
    timestamp: new Date().toISOString(),
  };
  list.unshift(newEntry);
  // Keep last 200
  if (list.length > 200) list.length = 200;
  saveTranscriptions(list);
  // Fire custom event for reactive updates
  window.dispatchEvent(new CustomEvent(TXN_EVENT, { detail: newEntry }));
}

export default function TranscriptionsPage() {
  const [transcriptions, setTranscriptions] = useState(loadTranscriptions);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  // Listen for new transcriptions added from CaptureButton
  useEffect(() => {
    const handler = () => {
      setTranscriptions(loadTranscriptions());
    };
    window.addEventListener(TXN_EVENT, handler);
    return () => window.removeEventListener(TXN_EVENT, handler);
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return transcriptions;
    const q = search.toLowerCase();
    return transcriptions.filter(t =>
      t.text.toLowerCase().includes(q) ||
      (t.language || '').toLowerCase().includes(q)
    );
  }, [transcriptions, search]);

  const selected = useMemo(
    () => transcriptions.find(t => t.id === selectedId),
    [transcriptions, selectedId]
  );

  const copyText = useCallback((text) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success('Copied to clipboard'),
      () => toast.error('Copy failed')
    );
  }, []);

  const deleteEntry = useCallback((id) => {
    const next = transcriptions.filter(t => t.id !== id);
    setTranscriptions(next);
    saveTranscriptions(next);
    if (selectedId === id) setSelectedId(null);
  }, [transcriptions, selectedId]);

  const clearAll = useCallback(() => {
    setTranscriptions([]);
    saveTranscriptions([]);
    setSelectedId(null);
  }, []);

  const exportAll = useCallback(() => {
    const text = transcriptions
      .map(t => `[${new Date(t.timestamp).toLocaleString()}] (${t.language})\n${t.text}\n`)
      .join('\n---\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcriptions_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Exported transcriptions');
  }, [transcriptions]);

  const formatTime = (iso) => {
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="txn-page" role="region" aria-label="Transcriptions">
      {/* Header */}
      <div className="txn-header">
        <div className="txn-header__left">
          <h1 className="txn-header__title">
            <FileText size={20} />
            Transcriptions
          </h1>
          <span className="txn-header__count">{transcriptions.length} entries</span>
        </div>
        <div className="txn-header__right">
          <div className="txn-search">
            <Search size={13} className="txn-search__icon" />
            <input
              className="txn-search__input"
              placeholder="Search transcriptions…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Search transcriptions"
            />
          </div>
          {transcriptions.length > 0 && (
            <>
              <Button size="sm" variant="ghost" onClick={exportAll} title="Export all">
                <Download size={13} /> Export
              </Button>
              <Button size="sm" variant="ghost" onClick={clearAll} title="Clear all">
                <Trash2 size={13} /> Clear
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="txn-content">
        {/* List */}
        <div className="txn-list" role="list">
          {filtered.length === 0 ? (
            <div className="txn-empty">
              <Mic size={32} className="txn-empty__icon" />
              <p className="txn-empty__title">
                {search ? 'No matching transcriptions' : 'No transcriptions yet'}
              </p>
              <p className="txn-empty__desc">
                {search
                  ? 'Try a different search term.'
                  : 'Use the capture button (⌘+⇧+Space) to record and transcribe audio.'
                }
              </p>
            </div>
          ) : (
            filtered.map(t => (
              <div
                key={t.id}
                role="listitem"
                className={`txn-item ${selectedId === t.id ? 'txn-item--active' : ''}`}
                onClick={() => setSelectedId(t.id)}
              >
                <div className="txn-item__text">
                  {t.text.length > 120 ? t.text.slice(0, 120) + '…' : t.text}
                </div>
                <div className="txn-item__meta">
                  <span className="txn-item__time">
                    <Clock size={10} /> {formatTime(t.timestamp)}
                  </span>
                  {t.language && t.language !== 'unknown' && (
                    <span className="txn-item__lang">
                      <Languages size={10} /> {t.language}
                    </span>
                  )}
                  {t.duration_s > 0 && (
                    <span className="txn-item__dur">{t.duration_s.toFixed(1)}s</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="txn-detail">
            <div className="txn-detail__header">
              <span className="txn-detail__time">
                {new Date(selected.timestamp).toLocaleString()}
              </span>
              <div className="txn-detail__actions">
                <Button size="sm" variant="ghost" onClick={() => copyText(selected.text)}>
                  <Copy size={12} /> Copy
                </Button>
                <Button size="sm" variant="ghost" onClick={() => deleteEntry(selected.id)}>
                  <Trash2 size={12} /> Delete
                </Button>
              </div>
            </div>
            <div className="txn-detail__body">
              <p className="txn-detail__text">{selected.text}</p>
            </div>
            {selected.segments && selected.segments.length > 0 && (
              <div className="txn-detail__segments">
                <h4 className="txn-detail__seg-title">Segments</h4>
                {selected.segments.map((seg, i) => (
                  <div key={i} className="txn-detail__seg">
                    <span className="txn-detail__seg-time">
                      {seg.start.toFixed(1)}s – {seg.end.toFixed(1)}s
                    </span>
                    <span className="txn-detail__seg-text">{seg.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
