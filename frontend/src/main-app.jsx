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

export function bootstrapApp() {
  const isWidget = window.location.search.includes('window=widget');
  
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        {isWidget ? (
          <Suspense fallback={null}>
            <CaptureWidget />
          </Suspense>
        ) : (
          <App />
        )}
      </QueryClientProvider>
    </StrictMode>,
  );
}
