import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, BookOpen, Sparkles, Check, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Panel, Button, Input, Badge } from '../ui';
import {
  listGlossary, addGlossaryTerm, updateGlossaryTerm,
  deleteGlossaryTerm, clearGlossary, autoExtractGlossary,
} from '../api/glossary';
import './GlossaryPanel.css';

/**
 * GlossaryPanel — project-scoped term table.
 *
 * Props:
 *   projectId   current dub job / saved project id (shared ID space).
 *   sourceLang  e.g. "en" — for auto-extract.
 *   targetLang  e.g. "de" — for auto-extract.
 *   segments    source segments; used by auto-extract only, lazy.
 *   onChange    (terms[]) => void — fires whenever the list changes so the
 *               parent can include the current glossary in /dub/translate.
 */
export default function GlossaryPanel({
  projectId,
  sourceLang = 'en',
  targetLang,
  segments = [],
  onChange,
}) {
  const [terms, setTerms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [draft, setDraft] = useState({ source: '', target: '', note: '' });

  const pushChange = useCallback((next) => { onChange?.(next); }, [onChange]);

  const reload = useCallback(async () => {
    if (!projectId) { setTerms([]); pushChange([]); return; }
    setLoading(true);
    try {
      const rows = await listGlossary(projectId);
      setTerms(rows);
      pushChange(rows);
    } catch (e) {
      toast.error(`Failed to load glossary: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [projectId, pushChange]);

  useEffect(() => { reload(); }, [reload]);

  const onAdd = async () => {
    if (!projectId) { toast.error('Glossary needs a loaded project.'); return; }
    if (!draft.source.trim() || !draft.target.trim()) return;
    try {
      const row = await addGlossaryTerm(projectId, draft);
      const next = [...terms, row];
      setTerms(next); pushChange(next);
      setDraft({ source: '', target: '', note: '' });
    } catch (e) { toast.error(`Add failed: ${e.message}`); }
  };

  const onUpdate = async (id, patch) => {
    try {
      const row = await updateGlossaryTerm(projectId, id, patch);
      const next = terms.map(t => t.id === id ? row : t);
      setTerms(next); pushChange(next);
    } catch (e) { toast.error(`Update failed: ${e.message}`); }
  };

  const onDelete = async (id) => {
    try {
      await deleteGlossaryTerm(projectId, id);
      const next = terms.filter(t => t.id !== id);
      setTerms(next); pushChange(next);
    } catch (e) { toast.error(`Delete failed: ${e.message}`); }
  };

  const onClearAuto = async () => {
    if (!confirm('Remove all auto-extracted terms? Manual entries are kept.')) return;
    try {
      await clearGlossary(projectId, true);
      await reload();
    } catch (e) { toast.error(`Clear failed: ${e.message}`); }
  };

  const onAutoExtract = async () => {
    if (!targetLang) { toast.error('Pick a target language first.'); return; }
    if (!segments.length) { toast.error('No segments to scan.'); return; }
    setExtracting(true);
    try {
      const res = await autoExtractGlossary(projectId, {
        sourceLang, targetLang,
        segments: segments.map(s => ({ text: s.text_original || s.text })),
      });
      setTerms(res.terms); pushChange(res.terms);
      if (res.inserted === 0) {
        toast('Auto-extract found no new terms.', { icon: 'ℹ️' });
      } else {
        toast.success(`Added ${res.inserted} auto term${res.inserted === 1 ? '' : 's'}. Review and edit before translating.`);
      }
    } catch (e) {
      toast.error(`Auto-extract failed: ${e.message}`);
    } finally {
      setExtracting(false);
    }
  };

  const autoCount = terms.filter(t => t.auto).length;
  const manualCount = terms.length - autoCount;

  return (
    <Panel
      variant="flat"
      padding="sm"
      className="glossary-panel"
      title={
        <>
          <BookOpen size={13} /> Glossary
          <span className="glossary-panel__counts">
            {terms.length} {terms.length === 1 ? 'term' : 'terms'}
            {autoCount > 0 && <> · {autoCount} auto</>}
          </span>
        </>
      }
      actions={
        <>
          <Button
            variant="subtle" size="sm"
            leading={<Sparkles size={11} />}
            onClick={onAutoExtract}
            loading={extracting}
            disabled={!projectId || !targetLang || !segments.length}
            title="Ask the LLM to scan segments for proper nouns + recurring terms"
          >
            Auto
          </Button>
          {autoCount > 0 && (
            <Button
              variant="ghost" size="sm"
              onClick={onClearAuto}
              title="Remove all auto-extracted terms, keep manual ones"
            >
              Clear auto
            </Button>
          )}
        </>
      }
    >
      {!projectId ? (
        <div className="glossary-panel__empty">
          Save the dub as a project to start a glossary.
        </div>
      ) : (
        <>
          <table className="glossary-panel__table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Target</th>
                <th>Note</th>
                <th className="glossary-panel__col-kind" aria-label="auto / manual"></th>
                <th className="glossary-panel__col-action" aria-label="delete"></th>
              </tr>
            </thead>
            <tbody>
              {loading && !terms.length && (
                <tr><td colSpan={5} className="glossary-panel__muted">Loading…</td></tr>
              )}
              {!loading && !terms.length && (
                <tr><td colSpan={5} className="glossary-panel__muted">No terms yet. Add one below or click Auto.</td></tr>
              )}
              {terms.map(t => (
                <GlossaryRow
                  key={t.id}
                  term={t}
                  onUpdate={(patch) => onUpdate(t.id, patch)}
                  onDelete={() => onDelete(t.id)}
                />
              ))}
              <tr className="glossary-panel__row--new">
                <td>
                  <Input
                    size="sm" placeholder={`Source (${sourceLang})`}
                    value={draft.source}
                    onChange={e => setDraft({ ...draft, source: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') onAdd(); }}
                  />
                </td>
                <td>
                  <Input
                    size="sm" placeholder={`Target (${targetLang || '—'})`}
                    value={draft.target}
                    onChange={e => setDraft({ ...draft, target: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') onAdd(); }}
                  />
                </td>
                <td>
                  <Input
                    size="sm" placeholder="Note (optional)"
                    value={draft.note}
                    onChange={e => setDraft({ ...draft, note: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') onAdd(); }}
                  />
                </td>
                <td />
                <td>
                  <Button
                    variant="subtle" iconSize="sm"
                    disabled={!draft.source.trim() || !draft.target.trim()}
                    onClick={onAdd}
                    title="Add term"
                  >
                    <Plus size={10} />
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
          {manualCount > 0 && targetLang && (
            <div className="glossary-panel__hint">
              Glossary is injected into every Cinematic translate prompt. Manual entries take precedence.
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function GlossaryRow({ term, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState({ source: term.source, target: term.target, note: term.note || '' });

  useEffect(() => {
    setLocal({ source: term.source, target: term.target, note: term.note || '' });
  }, [term.source, term.target, term.note]);

  if (editing) {
    const save = () => {
      onUpdate(local);
      setEditing(false);
    };
    return (
      <tr>
        <td><Input size="sm" value={local.source} onChange={e => setLocal({ ...local, source: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} autoFocus /></td>
        <td><Input size="sm" value={local.target} onChange={e => setLocal({ ...local, target: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} /></td>
        <td><Input size="sm" value={local.note}   onChange={e => setLocal({ ...local, note: e.target.value })}   onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} /></td>
        <td />
        <td className="glossary-panel__row-actions">
          <Button variant="subtle" iconSize="sm" onClick={save} title="Save"><Check size={10} /></Button>
          <Button variant="ghost"   iconSize="sm" onClick={() => setEditing(false)} title="Cancel"><X size={10} /></Button>
        </td>
      </tr>
    );
  }

  return (
    <tr onDoubleClick={() => setEditing(true)}>
      <td className="glossary-panel__cell-src">{term.source}</td>
      <td className="glossary-panel__cell-tgt">{term.target}</td>
      <td className="glossary-panel__cell-note">{term.note}</td>
      <td>
        {term.auto
          ? <Badge tone="violet" size="xs">auto</Badge>
          : <Badge tone="success" size="xs">manual</Badge>}
      </td>
      <td className="glossary-panel__row-actions">
        <Button variant="danger" iconSize="sm" onClick={onDelete} title="Delete">
          <Trash2 size={10} />
        </Button>
      </td>
    </tr>
  );
}
