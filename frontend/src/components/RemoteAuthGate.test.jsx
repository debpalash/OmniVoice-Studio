import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RemoteAuthGate from './RemoteAuthGate';

describe('RemoteAuthGate', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  it('renders children when not gated', () => {
    render(
      <RemoteAuthGate>
        <div>app-content</div>
      </RemoteAuthGate>,
    );
    expect(screen.getByText('app-content')).toBeInTheDocument();
  });

  it('stores the entered PIN', () => {
    render(
      <RemoteAuthGate forceGate>
        <div>app-content</div>
      </RemoteAuthGate>,
    );
    fireEvent.change(screen.getByLabelText(/access pin/i), { target: { value: '999111' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(sessionStorage.getItem('ov_pin')).toBe('999111');
  });
});
