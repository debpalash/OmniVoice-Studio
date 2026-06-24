/**
 * Settings → General → Pronunciation dictionary panel (Expressive-TTS Spec 01).
 *
 * A table of user pronunciation entries (term → respelling), scoped Global or to
 * a language. Entries are applied as pure text substitution before synthesis, so
 * a saved entry changes the audio on every engine. Plus a model-free "test"
 * field that previews the substitution via POST /pronunciation/test.
 *
 * Endpoints (loopback-only):
 *   GET    /pronunciation
 *   POST   /pronunciation              {term, replacement, type, language, enabled}
 *   PUT    /pronunciation/{id}         (partial)
 *   DELETE /pronunciation/{id}
 *   POST   /pronunciation/test         {text, language} → {substituted, changed}
 *
 * Cross-platform: identical on macOS / Windows / Linux — it's a pure form over
 * a text transform, no OS-specific behavior. All strings via i18n.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { BookA, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiJson, apiFetch } from '../../api/client';
import './PerformancePanel.css';

const TYPES = ['respelling', 'ipa', 'cmu'];

export default function PronunciationPanel() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState([]);
  const [term, setTerm] = useState('');
  const [replacement, setReplacement] = useState('');
  const [language, setLanguage] = useState('');
  const [type, setType] = useState('respelling');
  const [error, setError] = useState(null);
  const [testText, setTestText] = useState('');
  const [testOut, setTestOut] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setEntries(await apiJson('/pronunciation'));
    } catch (e) {
      setError(e?.message || t('pronunciation.load_error'));
    }
  }, [t]);

  useEffect(() => { refresh(); }, [refresh]);

  const onAdd = async () => {
    if (!term.trim()) return;
    setError(null);
    try {
      await apiFetch('/pronunciation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          term: term.trim(),
          replacement,
          type,
          language: language.trim() || '*',
          enabled: true,
        }),
      });
      setTerm(''); setReplacement(''); setLanguage(''); setType('respelling');
      refresh();
    } catch (e) {
      setError(e?.message || t('pronunciation.save_error'));
    }
  };

  const onToggle = async (entry) => {
    try {
      await apiFetch(`/pronunciation/${encodeURIComponent(entry.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !entry.enabled }),
      });
      refresh();
    } catch (e) {
      setError(e?.message || t('pronunciation.save_error'));
    }
  };

  const onDelete = async (id) => {
    try {
      await apiFetch(`/pronunciation/${encodeURIComponent(id)}`, { method: 'DELETE' });
      refresh();
    } catch (e) {
      setError(e?.message || t('pronunciation.save_error'));
    }
  };

  const onTest = async (value) => {
    setTestText(value);
    if (!value.trim()) { setTestOut(null); return; }
    try {
      const r = await apiJson('/pronunciation/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: value }),
      });
      setTestOut(r);
    } catch {
      setTestOut(null);
    }
  };

  const scopeLabel = (s) => (!s || s === '*' ? t('pronunciation.global') : s);
  const typeLabel = (ty) => t(`pronunciation.type_${ty}`, ty);

  return (
    <section className="perfpanel" aria-labelledby="pron-heading">
      <h3 id="pron-heading" className="perfpanel__title">
        <BookA size={14} /> {t('pronunciation.title')}
      </h3>
      <p className="perfpanel__help">{t('pronunciation.help')}</p>

      {error && <div className="perfpanel__error" role="alert">{error}</div>}

      {entries.length === 0 && (
        <p className="perfpanel__help" data-testid="pron-empty">{t('pronunciation.empty')}</p>
      )}

      {entries.map((e) => (
        <div className="perfpanel__row" key={e.id}>
          <input
            type="checkbox"
            checked={!!e.enabled}
            onChange={() => onToggle(e)}
            aria-label={t('pronunciation.enabled')}
            data-testid={`pron-toggle-${e.id}`}
          />
          <span className="perfpanel__label" style={{ flex: 1 }}>
            <strong>{e.term}</strong> → {e.replacement || '—'}
          </span>
          <span className="perfpanel__badge">{typeLabel(e.type)}</span>
          <span className="perfpanel__badge">{scopeLabel(e.scope || e.language)}</span>
          <button
            type="button"
            onClick={() => onDelete(e.id)}
            aria-label={t('pronunciation.remove', { term: e.term })}
            data-testid={`pron-del-${e.id}`}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}

      <div className="perfpanel__row">
        <input
          type="text"
          value={term}
          onChange={(ev) => setTerm(ev.target.value)}
          placeholder={t('pronunciation.term_placeholder')}
          style={{ flex: 1 }}
          data-testid="pron-term"
        />
        <input
          type="text"
          value={replacement}
          onChange={(ev) => setReplacement(ev.target.value)}
          placeholder={t('pronunciation.replacement_placeholder')}
          style={{ flex: 1 }}
          data-testid="pron-replacement"
        />
        <select value={type} onChange={(ev) => setType(ev.target.value)} data-testid="pron-type">
          {TYPES.map((ty) => <option key={ty} value={ty}>{typeLabel(ty)}</option>)}
        </select>
        <input
          type="text"
          value={language}
          onChange={(ev) => setLanguage(ev.target.value)}
          placeholder={t('pronunciation.lang_label')}
          style={{ width: 90 }}
          data-testid="pron-language"
        />
        <button type="button" onClick={onAdd} data-testid="pron-add">{t('pronunciation.add')}</button>
      </div>

      <div className="perfpanel__row">
        <input
          type="text"
          value={testText}
          onChange={(ev) => onTest(ev.target.value)}
          placeholder={t('pronunciation.test_placeholder')}
          style={{ flex: 1 }}
          data-testid="pron-test-input"
        />
      </div>
      {testOut && (
        <p className="perfpanel__help" data-testid="pron-test-out">
          {testOut.changed
            ? <>{t('pronunciation.test_result')} <strong>{testOut.substituted}</strong></>
            : t('pronunciation.test_nochange')}
        </p>
      )}
    </section>
  );
}
