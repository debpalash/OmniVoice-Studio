import { expect, test, type Page, type Request, type Route } from '@playwright/test';

const MASTER = 'root-master-never-retained';
const SESSION = `ovs_admin_session_${'S'.repeat(43)}`;

async function browserCredentialSnapshot(page: Page) {
  return page.evaluate(() => ({
    href: location.href,
    legacyMaster: localStorage.getItem('ov_api_key'),
    storedSession: sessionStorage.getItem('ov_admin_session'),
    localValues: Object.values(localStorage),
    sessionValues: Object.values(sessionStorage),
  }));
}

test('same-origin production bootstrap exchanges once into an HttpOnly cookie', async ({
  context,
  page,
}) => {
  const seen: Request[] = [];
  page.on('request', (request) => seen.push(request));
  await page.addInitScript((master) => localStorage.setItem('ov_api_key', master), MASTER);

  let exchange: Request | undefined;
  await page.route('**/api/auth/session', async (route) => {
    exchange = route.request();
    await route.fulfill({
      status: 204,
      headers: {
        'cache-control': 'no-store',
        'set-cookie': `ov_session=${SESSION}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
      },
    });
  });

  await page.goto(`/#api_key=${MASTER}&tab=voices`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => exchange?.headers().authorization).toBe(`Bearer ${MASTER}`);

  expect(exchange?.postDataJSON()).toEqual({ transport: 'cookie' });
  const snapshot = await browserCredentialSnapshot(page);
  expect(snapshot.href).toMatch(/#tab=voices$/);
  expect(snapshot.href).not.toContain(MASTER);
  expect(snapshot.legacyMaster).toBeNull();
  expect(snapshot.storedSession).toBeNull();
  expect([...snapshot.localValues, ...snapshot.sessionValues].join('\n')).not.toContain(MASTER);
  expect(seen.map((request) => request.url()).join('\n')).not.toContain(MASTER);

  const cookies = await context.cookies();
  const cookie = cookies.find(({ name }) => name === 'ov_session');
  expect(cookie).toMatchObject({ value: SESSION, httpOnly: true, sameSite: 'Strict', path: '/' });
  expect(cookies.some(({ name }) => name === 'ov_key')).toBe(false);
  expect(cookies.map(({ value }) => value).join('\n')).not.toContain(MASTER);
});

test('cross-origin production bootstrap stores only a backend-bound tab session', async ({
  page,
}) => {
  const remote = 'http://gpu.test:3900';
  const seen: Request[] = [];
  page.on('request', (request) => seen.push(request));
  await page.addInitScript(
    ({ backend, master }) => {
      localStorage.setItem('ov_backend_url', backend);
      localStorage.setItem('ov_api_key', master);
    },
    { backend: remote, master: MASTER },
  );

  let exchange: Request | undefined;
  await page.route(`${remote}/**`, async (route: Route) => {
    const request = route.request();
    const corsHeaders = {
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'authorization,content-type,x-voicestudio-csrf',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-origin': request.headers().origin ?? 'http://localhost:4173',
      'access-control-expose-headers': 'x-omnivoice-backend',
      'x-omnivoice-backend': 'e2e',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (new URL(request.url()).pathname === '/api/auth/session') {
      exchange = request;
      await route.fulfill({
        status: 201,
        headers: {
          ...corsHeaders,
          'cache-control': 'no-store',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token: SESSION, expires_at: 1, expires_in: 3600 }),
      });
      return;
    }
    if (new URL(request.url()).pathname === '/health') {
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ok', version: 'e2e', device: 'cpu' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders, 'content-type': 'application/json' },
      body: '{}',
    });
  });

  await page.goto(`/#api_key=${MASTER}`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => exchange?.headers().authorization).toBe(`Bearer ${MASTER}`);

  expect(exchange?.postDataJSON()).toEqual({ transport: 'bearer' });
  const snapshot = await browserCredentialSnapshot(page);
  expect(snapshot.href).not.toContain(MASTER);
  expect(snapshot.legacyMaster).toBeNull();
  expect(snapshot.storedSession).not.toBeNull();
  expect(JSON.parse(snapshot.storedSession ?? '{}')).toMatchObject({
    token: SESSION,
    apiBase: remote,
  });
  expect(snapshot.localValues.join('\n')).not.toContain(MASTER);
  expect(snapshot.sessionValues.join('\n')).not.toContain(MASTER);
  expect(seen.map((request) => request.url()).join('\n')).not.toContain(MASTER);
  expect(
    seen.filter((request) => request.headers().authorization === `Bearer ${MASTER}`),
  ).toHaveLength(1);
});
