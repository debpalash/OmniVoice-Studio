import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import i18n from '../i18n';
import { useAppStore } from '../store';
import LongformPersistenceGate from './LongformPersistenceGate';

describe('LongformPersistenceGate', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    useAppStore.setState({ longformPersistenceError: true });
  });

  afterEach(() => {
    useAppStore.setState({ longformPersistenceError: false });
    vi.restoreAllMocks();
  });

  it('keeps project UI unmounted until a retry rehydrates durable storage', async () => {
    const rehydrate = vi.spyOn(useAppStore.persist, 'rehydrate').mockImplementation(async () => {
      useAppStore.setState({ longformPersistenceError: false });
    });
    render(
      <LongformPersistenceGate>
        <div data-testid="project-ui">Project UI</div>
      </LongformPersistenceGate>,
    );

    expect(screen.queryByTestId('project-ui')).not.toBeInTheDocument();
    expect(screen.getByText("Projects couldn't be loaded")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(rehydrate).toHaveBeenCalledOnce());
    expect(await screen.findByTestId('project-ui')).toBeInTheDocument();
  });
});
