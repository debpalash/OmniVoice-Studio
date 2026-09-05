import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readFileSync, existsSync } from 'fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

const dialogEsm = [
  path.resolve(__dirname, 'node_modules/@tauri-apps/plugin-dialog/dist-js/index.js'),
  path.resolve(__dirname, '../node_modules/@tauri-apps/plugin-dialog/dist-js/index.js'),
].find(existsSync);

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  resolve: {
    preserveSymlinks: false,
    alias: {
      // shadcn/ui convention: `@/…` resolves to `src/…` (mirrored in
      // tsconfig.json `paths` so the type-checker agrees). Lets shadcn
      // primitives import `@/lib/utils` and `npx shadcn add` work unmodified.
      '@': path.resolve(__dirname, 'src'),
      // Package managers may install this nested (frontend/node_modules) or
      // hoisted to the workspace root; a hardcoded path breaks whichever
      // layout it did not guess. Probe both, and fall through to Vite's own
      // resolution when neither exists rather than crashing the optimizer.
      ...(dialogEsm ? { '@tauri-apps/plugin-dialog': dialogEsm } : {}),
    },
  },
  server: {
    port: Number(process.env.OMNIVOICE_UI_PORT) || 3901,
    strictPort: true,
    host: false,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx,ts,tsx}'],
    css: false,
  },
});
