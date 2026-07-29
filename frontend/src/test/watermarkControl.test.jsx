/**
 * The app told users the watermark could be turned off in Settings → Privacy
 * long before anything there could do it. These pin the control's contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { getStatus, setSettings } = vi.hoisted(() => ({
  getStatus: vi.fn(),
  setSettings: vi.fn(),
}));

vi.mock('../api/watermark', () => ({
  getWatermarkStatus: (...a) => getStatus(...a),
  setWatermarkSettings: (...a) => setSettings(...a),
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, o) => o?.defaultValue ?? k }),
}));

import WatermarkControl from '../components/settings/WatermarkControl';

const AVAILABLE = {
  invisible_enabled: true,
  visible_audio_enabled: false,
  visible_video_enabled: true,
  audioseal_available: true,
};

describe('WatermarkControl', () => {
  beforeEach(() => {
    getStatus.mockReset();
    setSettings.mockReset();
  });

  it('reflects the backend state instead of assuming it', async () => {
    getStatus.mockResolvedValue({ ...AVAILABLE, invisible_enabled: false });
    render(<WatermarkControl />);
    const toggle = await screen.findByTestId('watermark-toggle');
    expect(toggle).not.toBeChecked();
  });

  it('turns the watermark off — the thing the FAQ promised', async () => {
    getStatus.mockResolvedValue(AVAILABLE);
    setSettings.mockResolvedValue({ ...AVAILABLE, invisible_enabled: false });
    render(<WatermarkControl />);

    const toggle = await screen.findByTestId('watermark-toggle');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    expect(setSettings).toHaveBeenCalledWith({ invisible_enabled: false });
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it('turns it back on', async () => {
    getStatus.mockResolvedValue({ ...AVAILABLE, invisible_enabled: false });
    setSettings.mockResolvedValue(AVAILABLE);
    render(<WatermarkControl />);

    const toggle = await screen.findByTestId('watermark-toggle');
    fireEvent.click(toggle);
    expect(setSettings).toHaveBeenCalledWith({ invisible_enabled: true });
    await waitFor(() => expect(toggle).toBeChecked());
  });

  // An inert switch over a mark that cannot be embedded is the same lie in the
  // other direction.
  it('renders nothing when AudioSeal is unavailable', async () => {
    getStatus.mockResolvedValue({ ...AVAILABLE, audioseal_available: false });
    const { container } = render(<WatermarkControl />);
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the backend cannot be reached', async () => {
    getStatus.mockRejectedValue(new Error('offline'));
    const { container } = render(<WatermarkControl />);
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the previous state when the update fails', async () => {
    getStatus.mockResolvedValue(AVAILABLE);
    setSettings.mockRejectedValue(new Error('boom'));
    render(<WatermarkControl />);

    const toggle = await screen.findByTestId('watermark-toggle');
    fireEvent.click(toggle);
    await waitFor(() => expect(setSettings).toHaveBeenCalled());
    expect(toggle).toBeChecked(); // not optimistically flipped
  });
});
