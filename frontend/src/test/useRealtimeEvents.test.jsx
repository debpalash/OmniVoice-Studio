import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// The cold-start probe in useRealtimeEvents uses a RAW fetch() that does not
// carry the LAN PIN / remote API-key headers apiFetch would attach. It must
// therefore poll the auth-exempt /health endpoint — never a gated path like
// /model/status, which 401s in LAN-share/remote mode and would wedge the
// reconnect loop so the WebSocket never opens. This test pins that contract.
import useRealtimeEvents from '../hooks/useRealtimeEvents';

// Minimal WebSocket stub: records construction and lets us drive onopen.
class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.readyState = 3; // CLOSED
  }
}

function Harness() {
  useRealtimeEvents({});
  return null;
}

describe('useRealtimeEvents cold-start health probe', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    if (!AbortSignal.timeout) {
      AbortSignal.timeout = () => new AbortController().signal;
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('probes the auth-exempt /health endpoint, not a gated path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const probedUrl = String(fetchMock.mock.calls[0][0]);
    expect(probedUrl).toMatch(/\/health$/);
    // Guard against the #439 regression: the gated path drops auth → 401.
    expect(probedUrl).not.toContain('/model/status');
  });

  it('opens the WebSocket once the health probe succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness />);

    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    expect(FakeWebSocket.instances[0].url).toContain('/ws/events');
  });

  it('does NOT open the WebSocket while the backend is unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    render(<Harness />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(FakeWebSocket.instances.length).toBe(0);
  });
});
