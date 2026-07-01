import '@testing-library/jest-dom/vitest';
// Initialize the real i18n instance so components that call the global
// i18next.t() singleton (e.g. class components like ErrorBoundary) render
// actual strings in tests instead of bare keys. fallbackLng: 'en' keeps
// assertions on English text stable regardless of detected locale.
import '../i18n';

const localStorageMock = (function () {
  let store = {};
  return {
    getItem(key) {
      return store[key] || null;
    },
    setItem(key, value) {
      store[key] = value.toString();
    },
    clear() {
      store = {};
    },
    removeItem(key) {
      delete store[key];
    },
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});
