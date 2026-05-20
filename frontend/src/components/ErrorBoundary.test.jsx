import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('../utils/errorDocsMap', async () => {
  const actual = await vi.importActual('../utils/errorDocsMap');
  return {
    ...actual,
    openDocsFor: vi.fn(async (_cls) => {}),
  };
});

import ErrorBoundary from './ErrorBoundary';
import { openDocsFor } from '../utils/errorDocsMap';

function Boom({ message = 'pkg_resources missing' }) {
  throw new Error(message);
  // eslint-disable-next-line no-unreachable
  return null;
}

function Boom401() {
  const e = new Error('HfHubHTTPError: 401 Unauthorized');
  throw e;
}

describe('ErrorBoundary deeplink button', () => {
  beforeEach(() => {
    vi.mocked(openDocsFor).mockClear();
    // Suppress the noisy React error log that fires on a thrown render.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders the "Open docs for this error" button on failure', () => {
    render(
      <ErrorBoundary name="test">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/open docs for this error/i)).toBeInTheDocument();
  });

  it('clicking the docs button calls openDocsFor with the classified class', async () => {
    render(
      <ErrorBoundary name="test">
        <Boom message="ModuleNotFoundError: pkg_resources" />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText(/open docs for this error/i));
    expect(openDocsFor).toHaveBeenCalledTimes(1);
    expect(openDocsFor).toHaveBeenCalledWith('PKG_RESOURCES_MISSING');
  });

  it('maps a 401 HF error to HF_AUTH_FAILED', async () => {
    render(
      <ErrorBoundary name="test">
        <Boom401 />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText(/open docs for this error/i));
    expect(openDocsFor).toHaveBeenCalledWith('HF_AUTH_FAILED');
  });

  it('still renders a docs button for unknown errors (default fallback)', () => {
    render(
      <ErrorBoundary name="test">
        <Boom message="something totally unrelated" />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText(/open docs for this error/i));
    // classifyError returns null → openDocsFor still called → wrapper picks default
    expect(openDocsFor).toHaveBeenCalledWith(null);
  });
});
