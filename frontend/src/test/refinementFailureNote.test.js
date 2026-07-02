import { describe, it, expect } from 'vitest';
import { refineFailureNote } from '../components/settings/refineStatus';

// The honesty layer behind `llm_ready` (which only means "an endpoint is
// configured"): when the backend reports the last dictation refinement failed
// or timed out, the panel surfaces WHY and points at the LLM Providers Test
// button. A healthy/absent status shows nothing.
describe('refineFailureNote — RefinementPanel honesty hint', () => {
  it('is silent when there is no status', () => {
    expect(refineFailureNote(null)).toBeNull();
    expect(refineFailureNote(undefined)).toBeNull();
  });

  it('is silent when the last refinement succeeded', () => {
    expect(refineFailureNote({ ok: true, reason: null })).toBeNull();
  });

  it('flags a timeout as a slow/unreachable endpoint (dictation still works)', () => {
    const note = refineFailureNote({ ok: false, reason: 'timeout' });
    expect(note).toMatch(/timed out/i);
    expect(note).toMatch(/raw transcript is inserted/i);
    expect(note).toMatch(/LLM Providers/i);
  });

  it('flags a non-timeout failure as a rejected request', () => {
    const note = refineFailureNote({ ok: false, reason: 'RuntimeError' });
    expect(note).toMatch(/failed/i);
    expect(note).toMatch(/LLM Providers/i);
  });
});
