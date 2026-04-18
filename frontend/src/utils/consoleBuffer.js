// Ring buffer for frontend console messages. Settings "Logs > Frontend" tab
// reads from here. Installed once in main.jsx so every console.* is captured
// without breaking the DevTools output.

const MAX = 500;
const buf = [];

function push(level, args) {
  const msg = Array.from(args).map((a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? '\n' + a.stack : ''}`;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
  buf.push({ t: Date.now(), level, msg });
  if (buf.length > MAX) buf.shift();
}

let installed = false;
export function installConsoleCapture() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    const orig = console[level].bind(console);
    console[level] = (...args) => { try { push(level, args); } catch {} orig(...args); };
  });
  window.addEventListener('error', (e) => {
    push('error', [`[uncaught] ${e.message}`, e.filename ? `at ${e.filename}:${e.lineno}:${e.colno}` : '']);
  });
  window.addEventListener('unhandledrejection', (e) => {
    push('error', ['[unhandledrejection]', e.reason]);
  });
}

export function getFrontendLogs() {
  return buf.slice();
}

export function clearFrontendLogs() {
  buf.length = 0;
}
