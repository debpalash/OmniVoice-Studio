import { describe, it, expect, vi, beforeEach } from 'vitest';

import { scrubText, buildBugReportUrl, ISSUES_URL, REDACTED } from './bugReport';

describe('scrubText — frontend twin of backend/core/scrub.py', () => {
  it.each([
    ['/Users/alice/Library/Logs/app.log', '~/Library/Logs/app.log'],
    ['/home/bob/.omnivoice/omnivoice.log', '~/.omnivoice/omnivoice.log'],
    ['C:\\Users\\carol\\AppData\\Roaming\\OmniVoice', '~\\AppData\\Roaming\\OmniVoice'],
    // Windows paths normalized to forward slashes (webview stacks, file URLs)
    ['C:/Users/dave/AppData/Local/OmniVoice/app.log', '~/AppData/Local/OmniVoice/app.log'],
    ['file:///C:/Users/erin/project/index.js', '~/project/index.js'],
  ])('redacts home path %s', (raw, expected) => {
    expect(scrubText(raw)).toBe(expected);
  });

  it.each([
    [`hf_${'A'.repeat(34)}`],
    [`ghp_${'B'.repeat(36)}`],
    [`github_pat_${'C'.repeat(22)}`],
    [`sk-${'d'.repeat(40)}`],
  ])('redacts credential-shaped %s', (secret) => {
    const out = scrubText(`auth failed: token=${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it.each([['hf_hub'], ['sk-learn'], ['ghp_x']])(
    'leaves short identifier %s alone',
    (benign) => {
      expect(scrubText(`import error in ${benign}`)).toContain(benign);
    },
  );

  it('handles null/undefined', () => {
    expect(scrubText(null)).toBe('');
    expect(scrubText(undefined)).toBe('');
  });
});

describe('buildBugReportUrl', () => {
  beforeEach(() => {
    // Backend down — the builder must still produce a usable URL.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
  });

  it('targets the issues/new endpoint with bug label', async () => {
    const url = await buildBugReportUrl();
    expect(url.startsWith(`${ISSUES_URL}?`)).toBe(true);
    expect(url).toContain(`labels=${encodeURIComponent('bug')}`);
  });

  it('embeds the scrubbed error message and stack', async () => {
    const err = new Error('cannot open /Users/alice/voice.wav');
    const url = await buildBugReportUrl({ error: err });
    const body = decodeURIComponent(url);
    expect(body).toContain('## Error');
    expect(body).toContain('cannot open ~/voice.wav');
    expect(body).not.toContain('/Users/alice');
  });

  it('seeds the title with the error message', async () => {
    const url = await buildBugReportUrl({ error: new Error('synthesis exploded') });
    expect(decodeURIComponent(url)).toContain('[Bug] synthesis exploded');
  });

  it('stays under the prefill URL ceiling on huge stacks', async () => {
    const err = new Error('boom');
    err.stack = 'at frame\n'.repeat(5000);
    const url = await buildBugReportUrl({ error: err });
    expect(url.length).toBeLessThan(8000);
  });
});

describe('buildIssueSearchUrl', () => {
  it('builds a scrubbed, noise-free search query', async () => {
    const { buildIssueSearchUrl } = await import('./bugReport');
    const url = buildIssueSearchUrl(new Error('CUDA error 700 at /home/eve/cache: illegal memory access'));
    const q = decodeURIComponent(url.split('q=')[1]);
    expect(url).toContain('github.com/debpalash/OmniVoice-Studio/issues?q=');
    expect(q).toContain('CUDA error');
    expect(q).not.toContain('700');       // machine-specific noise stripped
    expect(q).not.toContain('/home/eve'); // scrubbed + punctuation-stripped
  });

  it('survives an empty error', async () => {
    const { buildIssueSearchUrl } = await import('./bugReport');
    expect(buildIssueSearchUrl(null)).toContain('issues?q=');
  });
});
