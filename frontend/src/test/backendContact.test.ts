/**
 * The mode-aware "can't reach the backend" copy.
 *
 * These messages are the only thing a user has when the backend stops
 * answering, so what they name as a likely cause matters: #1261 was told
 * "it most likely crashed or was killed mid-request" in dev mode, with the
 * backend having answered ten minutes earlier and three dub uploads in quick
 * succession. `bun run dev` runs uvicorn with --reload, where any file change
 * (including a save mid-request) restarts the process and drops the
 * connection — indistinguishable from a crash at the transport layer, and
 * fixed by simply retrying.
 */
import { describe, it, expect } from 'vitest';
describe('dev-mode unreachable copy names the reloader (#1261)', () => {
  // #1261: dev mode, "Failed to fetch", backend had answered 10 min earlier,
  // three dub uploads in quick succession. The message offered only "crashed or
  // was killed" — but `bun run dev` runs uvicorn with --reload, and a reload
  // mid-request produces exactly this with the backend healthy a second later.
  it('offers auto-reload as a cause and tells the user to retry first', async () => {
    const { unreachableBackendMessage } = await import('../utils/backendContact');
    const msg = unreachableBackendMessage('dev');
    expect(msg).toMatch(/auto-reload|reload/i);
    expect(msg).toMatch(/retry/i);
  });

  it('still points at the terminal and the log as the fallback', async () => {
    const { unreachableBackendMessage } = await import('../utils/backendContact');
    const msg = unreachableBackendMessage('dev');
    expect(msg).toContain('bun run dev');
    expect(msg).toContain('omnivoice.log');
  });

  it('leaves the server-mode copy alone', async () => {
    const { unreachableBackendMessage } = await import('../utils/backendContact');
    const msg = unreachableBackendMessage('server');
    expect(msg).not.toMatch(/auto-reload/i);
    expect(msg).toMatch(/docker logs|journalctl/i);
  });
});
