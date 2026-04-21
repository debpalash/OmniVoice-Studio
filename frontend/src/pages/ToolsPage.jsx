import React, { useState } from 'react';
import { Wrench, Sparkles, Activity, Target } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Panel, Button, Input, Field, Textarea, Badge } from '../ui';
import { apiPost } from '../api/client';
import './ToolsPage.css';

/**
 * ToolsPage — Phase 4.6 surface. Standalone utilities independent of the
 * dub pipeline. Today: directorial-AI parser, speech-rate fitter, probe.
 */
export default function ToolsPage({ onBack }) {
  return (
    <div className="tools-page">
      <div className="tools-page__bar">
        {onBack && <Button variant="ghost" size="sm" onClick={onBack}>← Back</Button>}
        <h1><Wrench size={15} /> Tools</h1>
      </div>

      <div className="tools-page__grid">
        <DirectorTool />
        <RateFitTool />
        <ProbeTool />
      </div>
    </div>
  );
}


function DirectorTool() {
  const [text, setText] = useState('make this feel urgent and surprised');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try { setResult(await apiPost('/tools/direction', { text })); }
    catch (e) { toast.error(`Parse failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <Panel variant="flat" padding="md" className="tools-card"
      title={<><Sparkles size={13} /> Directorial AI</>}
    >
      <p className="tools-card__desc">
        Type a natural-language direction — see the taxonomy tokens it maps to
        + the TTS instruct + translate hint + speech-rate bias.
      </p>
      <Field label="Direction">
        <Textarea rows={2} value={text} onChange={e => setText(e.target.value)} />
      </Field>
      <Button variant="primary" size="sm" loading={busy} onClick={run}>
        Parse
      </Button>
      {result && (
        <div className="tools-card__out">
          <div className="tools-card__out-row">
            <strong>method:</strong> <Badge tone={result.method === 'llm' ? 'violet' : 'neutral'}>{result.method}</Badge>
            {result.error && <Badge tone="warn" size="xs">{result.error}</Badge>}
          </div>
          <div className="tools-card__out-row"><strong>tts instruct:</strong> <code>{result.instruct_prompt || '—'}</code></div>
          <div className="tools-card__out-row"><strong>translate hint:</strong> <em>{result.translate_hint || '—'}</em></div>
          <div className="tools-card__out-row"><strong>rate bias:</strong> <code>{result.rate_bias?.toFixed?.(2)}</code></div>
          <details>
            <summary>tokens</summary>
            <pre>{JSON.stringify(result.tokens, null, 2)}</pre>
          </details>
          <details>
            <summary>taxonomy</summary>
            <pre>{JSON.stringify(result.taxonomy, null, 2)}</pre>
          </details>
        </div>
      )}
    </Panel>
  );
}


function RateFitTool() {
  const [text, setText] = useState('Tatsächlich das Spiel zu verändern.');
  const [slot, setSlot] = useState('2.0');
  const [lang, setLang] = useState('de');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      setResult(await apiPost('/tools/rate-fit', {
        text, slot_seconds: Number(slot), target_lang: lang,
      }));
    } catch (e) { toast.error(`Fit failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <Panel variant="flat" padding="md" className="tools-card"
      title={<><Target size={13} /> Speech-rate fit</>}
    >
      <p className="tools-card__desc">
        Check how a translated line compares to its time slot. With an LLM
        configured, the tool will trim or expand to fit.
      </p>
      <Field label="Translated line">
        <Textarea rows={2} value={text} onChange={e => setText(e.target.value)} />
      </Field>
      <div className="tools-card__row">
        <Field label="Slot (seconds)"><Input size="sm" value={slot} onChange={e => setSlot(e.target.value)} /></Field>
        <Field label="Target language"><Input size="sm" value={lang} onChange={e => setLang(e.target.value)} /></Field>
      </div>
      <Button variant="primary" size="sm" loading={busy} onClick={run}>
        Fit
      </Button>
      {result && (
        <div className="tools-card__out">
          <div className="tools-card__out-row"><strong>ratio:</strong> <code>{result.rate_ratio?.toFixed?.(2)}</code> {result.error && <Badge tone="warn" size="xs">{result.error}</Badge>}</div>
          <div className="tools-card__out-row"><strong>attempts:</strong> <code>{result.attempts}</code></div>
          <div className="tools-card__out-row"><strong>result:</strong></div>
          <div className="tools-card__result">{result.text}</div>
        </div>
      )}
    </Panel>
  );
}


function ProbeTool() {
  const [path, setPath] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try { setResult(await apiPost('/tools/probe', { path })); }
    catch (e) { toast.error(`Probe failed: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <Panel variant="flat" padding="md" className="tools-card"
      title={<><Activity size={13} /> Probe file</>}
    >
      <p className="tools-card__desc">
        ffprobe wrapper — inspect codec, streams, bit depth, duration of any
        local media file.
      </p>
      <Field label="Absolute path">
        <Input size="sm" value={path} onChange={e => setPath(e.target.value)} placeholder="/Users/you/Movies/sample.mp4" />
      </Field>
      <Button variant="primary" size="sm" loading={busy} onClick={run} disabled={!path.trim()}>
        Probe
      </Button>
      {result && (
        <details open className="tools-card__out">
          <summary>result</summary>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </details>
      )}
    </Panel>
  );
}
