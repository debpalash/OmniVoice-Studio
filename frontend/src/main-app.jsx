import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// Fonts load before tokens so --font-* can resolve immediately (no FOUT).
// Inter ships as a single variable file; Source Serif 4 too. Plex Mono has
// no variable build so we pull the three weights we use (400/500/600).
import '@fontsource-variable/inter';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource-variable/source-serif-4';
import './i18n'; // ← initialise i18next before any component renders
import './ui';
// Single stylesheet: index.css now carries the Tailwind foundation, the token
// scale + themes, and every former per-component .css (residual + all component
// styles) consolidated in, so this one import pulls in the whole app's CSS.
import './index.css';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary';
import RemoteAuthGate from './components/RemoteAuthGate';
import DesktopCaptureShortcutBridge from './components/DesktopCaptureShortcutBridge';
import CaptureWidget from './components/CaptureWidget.jsx';
import LongformPersistenceGate from './components/LongformPersistenceGate.jsx';
import { useAppStore } from './store';
import { installConsoleCapture } from './utils/consoleBuffer.js';
import { installGlobalErrorHandlers } from './utils/globalErrorHandlers.js';
import {
  configurePersistenceRole,
  installPersistenceLifecycleFlush,
} from './utils/coalescedJsonStorage';
import { installLongformPersistenceLifecycleFlush } from './utils/longformPersistence';
import { installDesktopPersistenceExitHandshake } from './utils/persistenceLifecycle';

installConsoleCapture();
// After console capture so the underlying console.error of each uncaught
// failure is already in the ring buffer when the toast appears.
installGlobalErrorHandlers();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Detect which Tauri window we're rendering in.
// Tauri 2's WebviewUrl::App(PathBuf) variant doesn't support query strings —
// declaring `"url": "/?window=widget"` in tauri.conf.json silently failed to
// create the widget window. So both windows load the same index.html and we
// differentiate by window label via the Tauri JS API.
export async function detectIsWidget(locationSearch = window.location.search) {
  // The widget window stamps this from an initialization_script (lib.rs)
  // before any page script runs, so it is always here and never races.
  //
  // It has to be first. Asking `getCurrentWindow()` throws when Tauri's
  // internals aren't injected yet, and the catch below can only guess — the
  // URL query it looks for is one Tauri 2 cannot set. A widget window that
  // guessed "main" rendered <App/>: opaque background, no pill, and no
  // CaptureWidget to run the hide reconcile, leaving a dark rectangle on the
  // desktop that nothing but quitting the app could remove.
  if (typeof window !== 'undefined' && window.__OV_WINDOW__) {
    return window.__OV_WINDOW__ === 'widget';
  }
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().label === 'widget';
  } catch {
    // Non-Tauri context (browser dev, Docker) — fall back to URL query for
    // legacy `bun dev:frontend` workflows that may still rely on it.
    return locationSearch.includes('window=widget');
  }
}

export async function bootstrapApp() {
  const isWidget = await detectIsWidget();
  configurePersistenceRole(isWidget ? 'readonly' : 'main');
  await useAppStore.persist.rehydrate();
  if (!isWidget) {
    installPersistenceLifecycleFlush();
    installLongformPersistenceLifecycleFlush();
    // Listener registration is non-critical startup work. A damaged Tauri IPC
    // bridge can leave `listen()` pending forever; native exit still has its
    // bounded timeout, so never hold the first React render behind this promise.
    void installDesktopPersistenceExitHandshake();
  }
  const isDesktopShell = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  // The widget window is `transparent: true` (tauri.conf.json), but it loads
  // the SAME index.html as the main window — so `body { background-color:
  // var(--chrome-bg) }` painted an opaque rectangle across all 300x64 of it,
  // defeating the transparency and showing a hard-edged dark square wherever
  // the pill happened to sit. Mark the document so index.css can scope the
  // chrome background away for this window only. Set before the first render;
  // the window is created hidden and only shown on a dictation trigger, so
  // there is no window in which an unstyled frame can be seen.
  if (isWidget) document.documentElement.dataset.window = 'widget';

  const root = createRoot(document.getElementById('root'));
  root.render(
    <StrictMode>
      {/* Root error boundary — the missing layer between App's own render and
          the shell's blank_guard (frontend/src-tauri/src/blank_guard.rs). App
          and RemoteAuthGate render a large tree of hooks/store access BEFORE any
          of App's per-tab <ErrorBoundary> wraps take effect; a throw up there
          used to escape every boundary and leave #root empty (children === 0),
          which the shell could only react to by reloading three times and then
          painting a dead-end failure page (#1178-class blank window). Catching it
          here turns "blank window, restart the app" into an in-app, recoverable
          error card with Reload / Report — data untouched. The shell guard stays
          as the last resort for the rarer case where even this can't render. */}
      <ErrorBoundary name="app-root">
        <QueryClientProvider client={queryClient}>
          {/* RemoteAuthGate is the TRUE outermost wrap so a remote device that
            loads a bare URL (no ?pin=) during first-run setup states —
            setup-status check, SetupWizard, BootstrapSplash — still gets the
            PIN dialog instead of a silent 401. Loopback / QR users are
            unaffected (the gate only shows on an ov:auth-required event). */}
          <RemoteAuthGate>
            {isWidget ? (
              <CaptureWidget />
            ) : (
              <LongformPersistenceGate>
                <>
                  <App />
                  {isDesktopShell && <DesktopCaptureShortcutBridge />}
                  {/* The desktop shell owns a separate global-hotkey widget
                    window. Browser/Docker builds do not, so mount the same
                    capture engine here to provide the documented focused-page
                    Ctrl+Shift+Space fallback. */}
                  {!isDesktopShell && (
                    <div className="capture-pill-host">
                      <CaptureWidget />
                    </div>
                  )}
                </>
              </LongformPersistenceGate>
            )}
          </RemoteAuthGate>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
  return root;
}
