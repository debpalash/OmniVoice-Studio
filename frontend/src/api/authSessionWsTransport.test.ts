import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_SESSION_STORAGE_KEY, AuthSessionError, authenticatedWsUrl } from './authSession';

const SESSION = `ovs_admin_session_${'A'.repeat(43)}`;
const TICKET = `ovs_ws_ticket_${'B'.repeat(43)}`;
const NOW_SECONDS = 1_800_000_000;

const response = () =>
  new Response(JSON.stringify({ ticket: TICKET, expires_at: NOW_SECONDS + 30 }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });

const storeSession = (apiBase: string) => {
  sessionStorage.setItem(
    ADMIN_SESSION_STORAGE_KEY,
    JSON.stringify({ token: SESSION, expiresAt: NOW_SECONDS + 3600, apiBase }),
  );
};

describe('ticketed WebSocket transport security', () => {
  beforeEach(() => sessionStorage.clear());

  it.each(['http://gpu.test:3900', 'http://127.evil.test:3900'])(
    'refuses a bearer-session ticket on non-loopback plaintext: %s',
    async (apiBase) => {
      storeSession(apiBase);
      const fetchImpl = vi.fn().mockResolvedValue(response());

      await expect(
        authenticatedWsUrl('/ws/tts', {
          apiBase,
          fetchImpl,
          now: () => NOW_SECONDS * 1000,
        }),
      ).rejects.toBeInstanceOf(AuthSessionError);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('permits bearer-session tickets on plaintext numeric loopback', async () => {
    const apiBase = 'http://127.0.0.2:3900';
    storeSession(apiBase);
    const fetchImpl = vi.fn().mockResolvedValue(response());

    await expect(
      authenticatedWsUrl('/ws/tts', {
        apiBase,
        fetchImpl,
        now: () => NOW_SECONDS * 1000,
      }),
    ).resolves.toBe(`ws://127.0.0.2:3900/ws/tts?ws_ticket=${TICKET}`);
  });
});
