import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, BookOpen, Sparkles, Check, ChevronDown, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Panel, Button, Input, Badge } from '../ui';
import {
  listGlossary,
  addGlossaryTerm,
  updateGlossaryTerm,
  deleteGlossaryTerm,
  clearGlossary,
  autoExtractGlossary,
} from '../api/glossary';
import './GlossaryPanel.css';

export default function GlossaryPanel({
  projectId,
  sourceLang = 'en',
  targetLang,
  segments = [],
  onChange,
  onClose,
}) {
  const { t } = useTranslation();
  const [terms, setTerms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [draft, setDraft] = useState({ source: '', target: '', note: '' });

  const pushChange = useCallback(
    (next) => {
      onChange?.(next);
    },
    [onChange],
  );

  const reload = useCallback(async () => {
    if (!projectId) {
      setTerms([]);
      pushChange([]);
      return;
    }
    setLoading(true);
    try {
      const rows = await listGlossary(projectId);
      setTerms(rows);
      pushChange(rows);
    } catch (e) {
      toast.error(t('glossary.load_error', { message: e.message }));
    } finally {
      setLoading(false);
    }
  }, [projectId, pushChange, t]);

  useEffect(() => {
    reload();
  }, [reload]);

  const onAdd = async () => {
    if (!projectId) {
      toast.error(t('glossary.needs_project'));
      return;
    }
    if (!draft.source.trim() || !draft.target.trim()) return;
    try {
      const row = await addGlossaryTerm(projectId, draft);
      const next = [...terms, row];
      setTerms(next);
      pushChange(next);
      setDraft({ source: '', target: '', note: '' });
    } catch (e) {
      toast.error(t('glossary.add_error', { message: e.message }));
    }
  };

  const onUpdate = async (id, patch) => {
    try {
      const row = await updateGlossaryTerm(projectId, id, patch);
      const next = terms.map((t) => (t.id === id ? row : t));
      setTerms(next);
      pushChange(next);
    } catch (e) {
      toast.error(t('glossary.update_error', { message: e.message }));
    }
  };

  const onDelete = async (id) => {
    try {
      await deleteGlossaryTerm(projectId, id);
      const next = terms.filter((t) => t.id !== id);
      setTerms(next);
      pushChange(next);
    } catch (e) {
      toast.error(t('glossary.delete_error', { message: e.message }));
    }
  };

  const onClearAuto = async () => {
    if (!confirm(t('glossary.clear_auto_confirm'))) return;
    try {
      await clearGlossary(projectId, true);
      await reload();
    } catch (e) {
      toast.error(t('glossary.clear_error', { message: e.message }));
    }
  };

  const onAutoExtract = async () => {
    if (!targetLang) {
      toast.error(t('glossary.pick_target'));
      return;
    }
    if (!segments.length) {
      toast.error(t('glossary.no_segments'));
      return;
    }
    setExtracting(true);
    try {
      const res = await autoExtractGlossary(projectId, {
        sourceLang,
        targetLang,
        segments: segments.map((s) => ({ text: s.text_original || s.text })),
      });
      setTerms(res.terms);
      pushChange(res.terms);
      if (res.inserted === 0) {
        toast(t('glossary.auto_empty'), { icon: 'ℹ️' });
      } else {
        toast.success(t('glossary.auto_added', { count: res.inserted }));
      }
    } catch (e) {
      toast.error(t('glossary.auto_error', { message: e.message }));
    } finally {
      setExtracting(false);
    }
  };

  const autoCount = terms.filter((t) => t.auto).length;
  const manualCount = terms.length - autoCount;

  return (
    <Panel
      variant="flat"
      padding="sm"
      className="glossary-panel"
      title={
        <>
          <BookOpen size={13} /> {t('glossary.title')}
          <span className="glossary-panel__counts">
            {t('glossary.count', { count: terms.length })}
            {autoCount > 0 && <> · {t('glossary.auto_count', { count: autoCount })}</>}
          </span>
        </>
      }
      actions={
        <>
          <Button
            variant="subtle"
            size="sm"
            leading={<Sparkles size={11} />}
            onClick={onAutoExtract}
            loading={extracting}
            disabled={!projectId || !targetLang || !segments.length}
            title={t('glossary.auto_title')}
          >
            {t('glossary.auto_btn')}
          </Button>
          {autoCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearAuto}
              title={t('glossary.clear_auto_title')}
            >
              {t('glossary.clear_auto_btn')}
            </Button>
          )}
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose} title={t('glossary.close')}>
              <ChevronDown size={11} />
            </Button>
          )}
        </>
      }
    >
      {!projectId ? (
        <div className="glossary-panel__empty">{t('glossary.empty_save')}</div>
      ) : (
        <>
          <table className="glossary-panel__table">
            <thead>
              <tr>
                <th>{t('glossary.source')}</th>
                <th>{t('glossary.target')}</th>
                <th>{t('glossary.note')}</th>
                <th className="glossary-panel__col-kind" aria-label="auto / manual"></th>
                <th className="glossary-panel__col-action" aria-label="delete"></th>
              </tr>
            </thead>
            <tbody>
              {loading && !terms.length && (
                <tr>
                  <td colSpan={5} className="glossary-panel__muted">
                    {t('common.loading')}
                  </td>
                </tr>
              )}
              {!loading && !terms.length && (
                <tr>
                  <td colSpan={5} className="glossary-panel__muted">
                    {t('glossary.no_terms')}
                  </td>
                </tr>
              )}
              {terms.map((t) => (
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
                    size="sm"
                    placeholder={t('glossary.source_placeholder', { lang: sourceLang })}
                    value={draft.source}
                    onChange={(e) => setDraft({ ...draft, source: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onAdd();
                    }}
                  />
                </td>
                <td>
                  <Input
                    size="sm"
                    placeholder={t('glossary.target_placeholder', { lang: targetLang || '—' })}
                    value={draft.target}
                    onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onAdd();
                    }}
                  />
                </td>
                <td>
                  <Input
                    size="sm"
                    placeholder={t('glossary.note_placeholder')}
                    value={draft.note}
                    onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onAdd();
                    }}
                  />
                </td>
                <td />
                <td>
                  <Button
                    variant="subtle"
                    iconSize="sm"
                    disabled={!draft.source.trim() || !draft.target.trim()}
                    onClick={onAdd}
                    title={t('glossary.add_term')}
                  >
                    <Plus size={10} />
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
          {manualCount > 0 && targetLang && (
            <div className="glossary-panel__hint">{t('glossary.hint')}</div>
          )}
        </>
      )}
    </Panel>
  );
}

function GlossaryRow({ term, onUpdate, onDelete }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState({
    source: term.source,
    target: term.target,
    note: term.note || '',
  });

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
        <td>
          <Input
            size="sm"
            value={local.source}
            onChange={(e) => setLocal({ ...local, source: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(false);
            }}
            autoFocus
          />
        </td>
        <td>
          <Input
            size="sm"
            value={local.target}
            onChange={(e) => setLocal({ ...local, target: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        </td>
        <td>
          <Input
            size="sm"
            value={local.note}
            onChange={(e) => setLocal({ ...local, note: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        </td>
        <td />
        <td className="glossary-panel__row-actions">
          <Button variant="subtle" iconSize="sm" onClick={save} title={t('common.save')}>
            <Check size={10} />
          </Button>
          <Button
            variant="ghost"
            iconSize="sm"
            onClick={() => setEditing(false)}
            title={t('common.cancel')}
          >
            <X size={10} />
          </Button>
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
        {term.auto ? (
          <Badge tone="violet" size="xs">
            {t('glossary.auto_badge')}
          </Badge>
        ) : (
          <Badge tone="success" size="xs">
            {t('glossary.manual_badge')}
          </Badge>
        )}
      </td>
      <td className="glossary-panel__row-actions">
        <Button variant="danger" iconSize="sm" onClick={onDelete} title={t('common.delete')}>
          <Trash2 size={10} />
        </Button>
      </td>
    </tr>
  );
}
