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
import './i18n';   // ← initialise i18next before any component renders
import './ui';
import './index.css';
import App from './App.jsx';
import { installConsoleCapture } from './utils/consoleBuffer.js';

installConsoleCapture();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

import { Suspense, lazy } from 'react';
const CaptureWidget = lazy(() => import('./components/CaptureWidget.jsx'));

// Detect which Tauri window we're rendering in.
// Tauri 2's WebviewUrl::App(PathBuf) variant doesn't support query strings —
// declaring `"url": "/?window=widget"` in tauri.conf.json silently failed to
// create the widget window. So both windows load the same index.html and we
// differentiate by window label via the Tauri JS API.
async function detectIsWidget() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().label === 'widget';
  } catch {
    // Non-Tauri context (browser dev, Docker) — fall back to URL query for
    // legacy `bun dev:frontend` workflows that may still rely on it.
    return window.location.search.includes('window=widget');
  }
}

export async function bootstrapApp() {
  const isWidget = await detectIsWidget();

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        {isWidget ? (
          <Suspense
            fallback={
              <div
                style={{
                  position: 'fixed',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(18, 18, 22, 0.88)',
                  backdropFilter: 'blur(24px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(24px) saturate(180%)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '100px',
                  color: 'rgba(255, 255, 255, 0.9)',
                  fontFamily: '"Inter Variable", "Inter", -apple-system, sans-serif',
                  fontSize: 13,
                  userSelect: 'none',
                }}
              >
                Loading dictation…
              </div>
            }
          >
            <CaptureWidget />
          </Suspense>
        ) : (
          <App />
        )}
      </QueryClientProvider>
    </StrictMode>,
  );
}
