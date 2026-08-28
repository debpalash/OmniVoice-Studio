import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import Tabs from './Tabs';

describe('Tabs', () => {
  it('preserves Radix trigger associations when no ID prefix is supplied', () => {
    render(<Tabs items={[{ id: 'first', label: 'First' }]} value="first" onChange={vi.fn()} />);

    const trigger = screen.getByRole('tab', { name: 'First' });
    expect(trigger.id).toBeTruthy();
    expect(trigger.getAttribute('aria-controls')).toBeTruthy();
  });
});
