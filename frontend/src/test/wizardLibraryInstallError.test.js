import { describe, it, expect } from 'vitest';
import { reduceWizardDownloadEvent } from '../components/WizardLibrary.jsx';

const REPO = 'org/model';

// P1-A: the first-run wizard used to DELETE a row on install_error (never even
// reading ev.error), so a failed download vanished with no reason. It must now
// keep the row and its mirror-aware message so the row can render a Retry.
describe('reduceWizardDownloadEvent — install_error persists (P1-A)', () => {
  it('KEEPS the row + its error message on install_error (does not delete)', () => {
    let s = reduceWizardDownloadEvent({}, { repo_id: REPO, phase: 'install_start' });
    s = reduceWizardDownloadEvent(s, {
      repo_id: REPO,
      phase: 'install_error',
      error: 'We couldn’t connect to hf-mirror.com',
    });
    expect(s[REPO]).toBeDefined();
    expect(s[REPO].phase).toBe('install_error');
    expect(s[REPO].error).toBe('We couldn’t connect to hf-mirror.com');
  });

  it('install_done still drops the transient row (reverts to installed flag)', () => {
    let s = reduceWizardDownloadEvent({}, { repo_id: REPO, phase: 'install_start' });
    s = reduceWizardDownloadEvent(s, { repo_id: REPO, phase: 'install_done' });
    expect(s[REPO]).toBeUndefined();
  });

  it('aggregate + per-file events accumulate without clearing the row', () => {
    let s = reduceWizardDownloadEvent(
      {},
      { repo_id: REPO, phase: 'aggregate', bytes_done: 10, total_bytes: 100, rate: 5 },
    );
    s = reduceWizardDownloadEvent(s, {
      repo_id: REPO,
      phase: 'progress',
      filename: 'a.bin',
      downloaded: 10,
      total: 100,
    });
    expect(s[REPO].agg.totalBytes).toBe(100);
    expect(s[REPO].files['a.bin'].total).toBe(100);
  });

  it('ignores keepalive events without a repo_id', () => {
    const prev = { [REPO]: { phase: 'install_error', error: 'x' } };
    expect(reduceWizardDownloadEvent(prev, {})).toBe(prev);
  });
});
