import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BackendCrashNotice from './BackendCrashNotice';
import { acknowledgeBackendCrash, getUnacknowledgedBackendCrash } from '../utils/backendCrash';

// #941: the crash-notice branch — a recorded backend death must surface the
// honest message (exit code + age) with a "View crash details" affordance,
// and viewing/dismissing must acknowledge the marker.
vi.mock('../utils/backendCrash', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getUnacknowledgedBackendCrash: vi.fn().mockResolvedValue(null),
    acknowledgeBackendCrash: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../utils/bugReport', () => ({
  buildBugReportUrl: vi.fn().mockResolvedValue('https://example.test/issues/new'),
}));
vi.mock('../api/external', () => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
}));

const MARKER = {
  ts: Math.floor(Date.now() / 1000) - 12,
  exit_code: 134,
  signal: null,
  exit_desc: 'exit status: 134',
  backend_version: '0.3.10',
  uptime_s: 87,
  last_stderr: 'CUDA error: an illegal memory access was encountered',
  acknowledged: false,
};

describe('BackendCrashNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUnacknowledgedBackendCrash.mockResolvedValue(null);
  });

  it('renders nothing when the shell reports no crash', async () => {
    const { container } = render(<BackendCrashNotice />);
    await waitFor(() => expect(getUnacknowledgedBackendCrash).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the honest message and the details affordance for a fresh marker', async () => {
    getUnacknowledgedBackendCrash.mockResolvedValue(MARKER);
    render(<BackendCrashNotice />);
    const alert = await screen.findByRole('alert');
    // Honest: names the exit code instead of a vague "can't reach".
    expect(alert.textContent).toContain('crashed');
    expect(alert.textContent).toContain('exit code 134');
    expect(screen.getByRole('button', { name: /view crash details/i })).toBeInTheDocument();
  });

  it('surfaces a crash pushed via the ov:backend-crashed event', async () => {
    render(<BackendCrashNotice />);
    await waitFor(() => expect(getUnacknowledgedBackendCrash).toHaveBeenCalled());
    window.dispatchEvent(new CustomEvent('ov:backend-crashed', { detail: MARKER }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('exit code 134');
  });

  it('acks on view and shows the stderr tail in the details dialog', async () => {
    getUnacknowledgedBackendCrash.mockResolvedValue(MARKER);
    render(<BackendCrashNotice />);
    fireEvent.click(await screen.findByRole('button', { name: /view crash details/i }));
    expect(acknowledgeBackendCrash).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/illegal memory access/)).toBeInTheDocument();
    expect(screen.getByText('Backend crash details')).toBeInTheDocument();
  });

  it('ack + clear on dismiss', async () => {
    getUnacknowledgedBackendCrash.mockResolvedValue(MARKER);
    render(<BackendCrashNotice />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(acknowledgeBackendCrash).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
