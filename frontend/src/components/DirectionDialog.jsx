import React, { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { Dialog, Button, Textarea, Field, Badge } from '../ui';
import { apiPost } from '../api/client';
import './Misc.css';

/**
 * DirectionDialog — Phase 4.2 per-segment direction editor.
 *
 * The user types a natural-language note ("urgent and surprised"). We call
 * /tools/direction to preview the parsed taxonomy tokens + instruct prompt +
 * rate bias — useful for seeing what the LLM/heuristic actually took away.
 *
 * On Save, the parent receives the raw direction string and persists it on
 * the segment. The dub pipeline re-parses at send time so the saved text is
 * always the canonical input.
 */
export default function DirectionDialog({ open, seg, onSave, onClose }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setText(seg?.direction || '');
      setPreview(null);
    }
  }, [open, seg?.id, seg?.direction]);

  const runPreview = async () => {
    if (!text.trim()) { setPreview(null); return; }
    setParsing(true);
    try {
      setPreview(await apiPost('/tools/direction', { text }));
    } catch (e) {
      toast.error(`Preview failed: ${e.message}`);
    } finally {
      setParsing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave?.(text.trim());
      onClose?.();
    } finally { setSaving(false); }
  };

  if (!open) return null;

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={<><Sparkles size={14} /> {t('dub.direction_dialog_title', { id: seg?.id?.slice?.(0, 6) || '' })}</>}
      footer={
        <>
          {seg?.direction && (
            <Button
              variant="ghost" size="sm"
              onClick={() => { setText(''); }}
              leading={<X size={11} />}
              className="dir-clear-btn"
            >
              {t('common.clear')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} loading={saving}>{t('dub.save_direction')}</Button>
        </>
      }
    >
      <p className="direction-dialog__desc">
        {t('dub.direction_description')}
      </p>

      <Field label={t('dub.direction_label')} hint={
        seg?.text ? t('dub.direction_line_hint', { text: seg.text.slice(0, 80) + (seg.text.length > 80 ? '…' : '') }) : null
      }>
        <Textarea
          rows={3}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={t('dub.direction_placeholder')}
          autoFocus
        />
      </Field>

      <div className="dir-preview-actions">
        <Button
          variant="subtle" size="sm"
          onClick={runPreview}
          loading={parsing}
          disabled={!text.trim()}
        >
          {t('dub.preview_parse')}
        </Button>
        {preview && (
          <Badge tone={preview.method === 'llm' ? 'violet' : 'neutral'} size="xs">
            {preview.method}
          </Badge>
        )}
      </div>

      {preview && (
        <div className="direction-dialog__preview">
          <div>
            <strong>{t('dub.tts_instruct')}</strong> <code>{preview.instruct_prompt || t('dub.nothing_parsed')}</code>
          </div>
          <div>
            <strong>{t('dub.translate_hint')}</strong> <em>{preview.translate_hint || '—'}</em>
          </div>
          <div>
            <strong>{t('dub.rate_bias')}</strong> <code>{preview.rate_bias?.toFixed?.(2)}</code>
            {preview.rate_bias > 1.05 && <> · <span className="dir-rate-up">{t('dub.speeds_up')}</span></>}
            {preview.rate_bias < 0.95 && <> · <span className="dir-rate-down">{t('dub.slows_down')}</span></>}
          </div>
          {Object.keys(preview.tokens || {}).length > 0 && (
            <details>
              <summary>{t('dub.taxonomy_tokens')}</summary>
              <pre>{JSON.stringify(preview.tokens, null, 2)}</pre>
            </details>
          )}
          {preview.error && (
            <div className="dir-error">
              {preview.error}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
