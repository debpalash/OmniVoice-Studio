import React, { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Dialog, Button, Textarea, Field, Badge } from '../ui';
import { apiPost } from '../api/client';

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
      title={<><Sparkles size={14} /> Direction for segment #{seg?.id?.slice?.(0, 6) || ''}</>}
      footer={
        <>
          {seg?.direction && (
            <Button
              variant="ghost" size="sm"
              onClick={() => { setText(''); }}
              leading={<X size={11} />}
              style={{ marginRight: 'auto' }}
            >
              Clear
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving}>Save direction</Button>
        </>
      }
    >
      <p className="direction-dialog__desc">
        Tell the pipeline how this line should feel. Plain English works — the system
        maps your words onto a stable taxonomy (energy / emotion / pace / intimacy / formality),
        then threads the taxonomy through Cinematic translation, TTS, and slot-fit.
      </p>

      <Field label="Direction" hint={
        seg?.text ? <>Line: <em>"{seg.text.slice(0, 80)}{seg.text.length > 80 ? '…' : ''}"</em></> : null
      }>
        <Textarea
          rows={3}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="e.g. urgent and surprised  /  warm, hopeful  /  whispered, intimate"
          autoFocus
        />
      </Field>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <Button
          variant="subtle" size="sm"
          onClick={runPreview}
          loading={parsing}
          disabled={!text.trim()}
        >
          Preview parse
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
            <strong>TTS instruct:</strong> <code>{preview.instruct_prompt || '— (nothing parsed)'}</code>
          </div>
          <div>
            <strong>Translate hint:</strong> <em>{preview.translate_hint || '—'}</em>
          </div>
          <div>
            <strong>Rate bias:</strong> <code>{preview.rate_bias?.toFixed?.(2)}</code>
            {preview.rate_bias > 1.05 && <> · <span style={{ color: 'var(--color-brand)' }}>speeds up</span></>}
            {preview.rate_bias < 0.95 && <> · <span style={{ color: 'var(--color-info)' }}>slows down</span></>}
          </div>
          {Object.keys(preview.tokens || {}).length > 0 && (
            <details>
              <summary>taxonomy tokens</summary>
              <pre>{JSON.stringify(preview.tokens, null, 2)}</pre>
            </details>
          )}
          {preview.error && (
            <div style={{ color: 'var(--color-warn)', fontSize: '0.7rem' }}>
              {preview.error}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
