import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';

const bootstrapProbe = vi.hoisted(() => ({ order: [], captureRenders: 0 }));

// The whole point of this test: a throw in the top-level app tree (App itself,
// or anything RemoteAuthGate/the providers render) must NOT blank #root. Before
// the root <ErrorBoundary> in main-app.jsx, such a throw escaped every one of
// App's per-tab boundaries and left #root with zero children — the exact
// `#root children = 0` the shell's blank_guard logged before painting its
// dead-end failure page (#1178-class white screen). We simulate that by making
// the App module throw on render, then assert the window is a recoverable error
// card, not an empty shell.
vi.mock('./App.jsx', () => ({
  default: function BoomApp() {
    bootstrapProbe.order.push('render:app');
    throw new Error('simulated top-level render crash');
  },
}));

vi.mock('./components/CaptureWidget.jsx', () => ({
  default: function CaptureWidgetProbe() {
    bootstrapProbe.order.push('render:widget');
    bootstrapProbe.captureRenders += 1;
    return <div data-testid="capture-widget-probe" />;
  },
}));

vi.mock('./utils/coalescedJsonStorage', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    configurePersistenceRole(role) {
      bootstrapProbe.order.push(`configure:${role}`);
      return actual.configurePersistenceRole(role);
    },
    installPersistenceLifecycleFlush() {
      bootstrapProbe.order.push('install:lifecycle');
      return actual.installPersistenceLifecycleFlush();
    },
  };
});

vi.mock('./utils/persistenceLifecycle', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    installDesktopPersistenceExitHandshake() {
      bootstrapProbe.order.push('install:exit-handshake');
      // A damaged Tauri bridge can leave event registration pending forever.
      // bootstrapApp must render without awaiting this non-critical promise.
      return new Promise(() => {});
    },
  };
});

// detectIsWidget() awaits a dynamic import of the Tauri window API; in jsdom
// that import never settles and would hang bootstrapApp(). Stub it to a plain
// main window so the mount path is deterministic and fast.
const getCurrentWindowMock = vi.hoisted(() => vi.fn(() => ({ label: 'main' })));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: getCurrentWindowMock }));

// RemoteAuthGate is real (we want the true mount chain), but it must render its
// children straight through in the default no-auth case; nothing to mock.

describe('bootstrapApp root error boundary', () => {
  beforeEach(() => {
    window.__OV_WINDOW__ = 'main';
    getCurrentWindowMock.mockReset().mockReturnValue({ label: 'main' });
    bootstrapProbe.order.length = 0;
    bootstrapProbe.captureRenders = 0;
    // A thrown render logs loudly via React; silence it so the suite output
    // stays readable (the throw is the point of the test, not a failure).
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
  });

  afterEach(() => {
    document.getElementById('root')?.remove();
    vi.restoreAllMocks();
  });

  // Generous timeout: this test is the only one that imports the full app entry
  // module (main-app.jsx), so it pays the one-time cold-transform cost of the
  // whole ui/i18n/client import graph before it can run.
  it('renders a recoverable error card instead of blanking #root when the app tree throws', async () => {
    const { bootstrapApp } = await import('./main-app.jsx');
    const appRoot = await bootstrapApp();

    const root = document.getElementById('root');
    await waitFor(() => {
      // The invariant the blank_guard probe checks: #root must have mounted
      // content. 0 children is the blank window this fix exists to prevent.
      expect(root.childElementCount).toBeGreaterThan(0);
    });

    // And it must be the actual recovery UI showing the real error, not just
    // any stray node — so the user has a way forward without restarting the app.
    expect(root.textContent).toMatch(/simulated top-level render crash/);
    expect(bootstrapProbe.order.slice(0, 4)).toEqual([
      'configure:main',
      'install:lifecycle',
      'install:exit-handshake',
      'render:app',
    ]);
    expect(getCurrentWindowMock).not.toHaveBeenCalled();
    appRoot.unmount();
  }, 20000);
});

describe('detectIsWidget', () => {
  beforeEach(() => {
    delete window.__OV_WINDOW__;
    getCurrentWindowMock.mockReset().mockReturnValue({ label: 'main' });
  });

  afterEach(() => {
    delete window.__OV_WINDOW__;
  });

  it('uses the initialization marker before consulting the Tauri API', async () => {
    window.__OV_WINDOW__ = 'widget';
    const { detectIsWidget } = await import('./main-app.jsx');

    await expect(detectIsWidget()).resolves.toBe(true);
    expect(getCurrentWindowMock).not.toHaveBeenCalled();
  });

  it('recognizes a label-only Tauri widget', async () => {
    getCurrentWindowMock.mockReturnValue({ label: 'widget' });
    const { detectIsWidget } = await import('./main-app.jsx');

    await expect(detectIsWidget()).resolves.toBe(true);
  });

  it('keeps the legacy URL fallback for browser development', async () => {
    getCurrentWindowMock.mockImplementation(() => {
      throw new Error('not running in Tauri');
    });
    const { detectIsWidget } = await import('./main-app.jsx');

    expect(() => getCurrentWindowMock()).toThrow('not running in Tauri');
    await expect(detectIsWidget('?window=widget')).resolves.toBe(true);
  });
});

describe('bootstrapApp persistence ownership', () => {
  beforeEach(() => {
    window.__OV_WINDOW__ = 'widget';
    bootstrapProbe.order.length = 0;
    bootstrapProbe.captureRenders = 0;
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
  });

  afterEach(() => {
    delete window.__OV_WINDOW__;
    document.getElementById('root')?.remove();
  });

  it('resolves a widget readonly before rendering and never installs a writer lifecycle', async () => {
    const persistence = await import('./utils/coalescedJsonStorage');
    persistence.resetCoalescedJsonStorageForTests();
    localStorage.setItem('omnivoice.app', '{"state":{"durable":true},"version":7}');
    persistence.queueJsonWrite('omnivoice.app', () => ({
      state: { staleWidget: true },
      version: 7,
    }));
    const { bootstrapApp } = await import('./main-app.jsx');

    const root = await bootstrapApp();
    await waitFor(() => expect(bootstrapProbe.captureRenders).toBeGreaterThan(0));
    persistence.flushPendingWrites();

    expect(bootstrapProbe.order.slice(0, 2)).toEqual(['configure:readonly', 'render:widget']);
    expect(bootstrapProbe.order).not.toContain('install:lifecycle');
    expect(localStorage.getItem('omnivoice.app')).toBe('{"state":{"durable":true},"version":7}');
    root.unmount();
  });
});
