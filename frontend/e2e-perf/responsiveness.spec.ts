import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const APP_STORE_KEY = 'omnivoice.app';
const OMNI_UI_KEY = 'omni_ui';
const TARGET_KEYS = [APP_STORE_KEY, OMNI_UI_KEY] as const;
const UPDATE_COUNT = 20;
const UPDATE_INTERVAL_MS = 25;
const TRAILING_FLUSH_SETTLE_MS = 1_250;

type TargetKey = (typeof TARGET_KEYS)[number];

interface PhysicalWrite {
  phase: string;
  key: TargetKey;
  atMs: number;
  bytes: number;
  durationMs: number;
}

interface LongTaskSample {
  phase: string;
  atMs: number;
  durationMs: number;
}

interface InputFrameSample {
  phase: string;
  target: 'ui-scale' | 'studio-text';
  atMs: number;
  durationMs: number;
}

interface BrowserMetrics {
  phase: string;
  writes: PhysicalWrite[];
  longTasks: LongTaskSample[];
  inputToNextRaf: InputFrameSample[];
}

declare global {
  interface Window {
    __OV_WINDOW__?: string;
    __OMNIVOICE_API_BASE__?: string;
    __ovResponsivenessMetrics?: BrowserMetrics;
    __ovSetResponsivenessPhase?: (phase: string) => void;
  }
}

function makeStoryTracks() {
  return Array.from({ length: 400 }, (_, index) => ({
    id: index + 1,
    character: index % 2 === 0 ? 'narrator' : 'guest',
    text: `Story track ${index.toString().padStart(3, '0')} ${'narration '.repeat(8)}`,
    profileId: null,
    emotion: index % 3 === 0 ? 'warm' : null,
    speed: 1,
  }));
}

function makeDubSegments() {
  return Array.from({ length: 1_800 }, (_, index) => ({
    id: `segment-${index.toString().padStart(4, '0')}`,
    start: index * 2.5,
    end: index * 2.5 + 2.25,
    speaker: index % 2 === 0 ? 'SPEAKER_00' : 'SPEAKER_01',
    text_original: `Original line ${index} ${'source '.repeat(7)}`,
    text: `Translated line ${index} ${'target '.repeat(7)}`,
    profile_id: null,
    direction: '',
  }));
}

function persistedFixtures() {
  return {
    app: {
      state: {
        mode: 'settings',
        defineMethod: 'audio',
        uiScale: 1,
        uiScaleConfigured: true,
        navStyle: 'rail',
        locale: 'en',
        localeChosen: true,
        langPromptSeen: true,
        storyTracks: makeStoryTracks(),
      },
      version: 7,
    },
    omniUi: {
      uiScale: 1,
      text: 'Seeded studio text',
      mode: 'settings',
      defineMethod: 'audio',
      vdStates: {
        Gender: 'Auto',
        Age: 'Auto',
        Pitch: 'Auto',
        Style: 'Auto',
        EnglishAccent: 'Auto',
        ChineseDialect: 'Auto',
      },
      language: 'Auto',
      isSidebarCollapsed: false,
      sidebarTab: 'projects',
      dubJobId: 'responsiveness-fixture',
      dubFilename: 'responsiveness-fixture.mp4',
      dubDuration: 4_500,
      dubSegments: makeDubSegments(),
      dubLang: 'English',
      dubLangCode: 'en',
      dubTracks: [],
      dubStep: 'editing',
      dubTranscript: '',
      exportTracks: {},
      preserveBg: true,
      defaultTrack: 'dialogue',
      exportHistory: [],
      speed: 1,
      steps: 16,
      cfg: 2,
      denoise: true,
      showOverrides: false,
    },
  };
}

async function installDeterministicBrowserState(page: Page): Promise<Set<string>> {
  const fixtures = persistedFixtures();
  const unexpectedRequests = new Set<string>();
  await page.addInitScript(
    ({ appKey, omniUiKey, app, omniUi }) => {
      // Fix window identity and API routing before any application module runs.
      window.__OV_WINDOW__ = 'main';
      window.__OMNIVOICE_API_BASE__ = window.location.origin;

      // Seed through the native method so fixture setup is not counted as an
      // application write. Both payloads intentionally match production schema.
      const nativeSetItem = Storage.prototype.setItem;
      nativeSetItem.call(localStorage, appKey, JSON.stringify(app));
      nativeSetItem.call(localStorage, omniUiKey, JSON.stringify(omniUi));
      nativeSetItem.call(localStorage, 'omnivoice.settings.category', 'appearance');

      const targetKeys = new Set([appKey, omniUiKey]);
      const metrics: BrowserMetrics = {
        phase: 'startup',
        writes: [],
        longTasks: [],
        inputToNextRaf: [],
      };
      window.__ovResponsivenessMetrics = metrics;
      window.__ovSetResponsivenessPhase = (phase) => {
        metrics.phase = phase;
      };

      Storage.prototype.setItem = function setItem(key: string, value: string): void {
        const startedAt = performance.now();
        try {
          nativeSetItem.call(this, key, value);
        } finally {
          if (targetKeys.has(key)) {
            const durationMs = performance.now() - startedAt;
            metrics.writes.push({
              phase: metrics.phase,
              key: key as TargetKey,
              atMs: startedAt,
              // Encode after the native call so byte accounting is excluded
              // from the measured physical-storage duration.
              bytes: new TextEncoder().encode(value).byteLength,
              durationMs,
            });
          }
        }
      };

      document.addEventListener(
        'input',
        (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const sampleTarget = target.matches('.appearance-panel input[type="range"]')
            ? 'ui-scale'
            : target.matches('textarea.studio-script-input')
              ? 'studio-text'
              : null;
          if (!sampleTarget) return;
          const startedAt = performance.now();
          requestAnimationFrame(() => {
            metrics.inputToNextRaf.push({
              phase: metrics.phase,
              target: sampleTarget,
              atMs: startedAt,
              durationMs: performance.now() - startedAt,
            });
          });
        },
        true,
      );

      if (
        'PerformanceObserver' in window &&
        PerformanceObserver.supportedEntryTypes?.includes('longtask')
      ) {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            metrics.longTasks.push({
              phase: metrics.phase,
              atMs: entry.startTime,
              durationMs: entry.duration,
            });
          }
        });
        observer.observe({ type: 'longtask', buffered: true });
      }

      // Keep the realtime hook deterministic and fully local while preserving
      // the handler and EventTarget surfaces used by capture/realtime clients.
      class DeterministicWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;

        readonly url: string;
        readyState = DeterministicWebSocket.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;

        constructor(url: string | URL) {
          super();
          this.url = String(url);
          queueMicrotask(() => {
            if (this.readyState !== DeterministicWebSocket.CONNECTING) return;
            this.readyState = DeterministicWebSocket.OPEN;
            const event = new Event('open');
            this.dispatchEvent(event);
            this.onopen?.(event);
          });
        }

        send(): void {}

        close(): void {
          if (this.readyState === DeterministicWebSocket.CLOSED) return;
          this.readyState = DeterministicWebSocket.CLOSED;
          const event = new CloseEvent('close', { code: 1000, wasClean: true });
          this.dispatchEvent(event);
          this.onclose?.(event);
        }
      }

      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        writable: true,
        value: DeterministicWebSocket,
      });
    },
    {
      appKey: APP_STORE_KEY,
      omniUiKey: OMNI_UI_KEY,
      app: fixtures.app,
      omniUi: fixtures.omniUi,
    },
  );

  // Production resolves API calls to the preview origin. Fulfil every
  // fetch/XHR deterministically, while allowing HTML, chunks, fonts and CSS to
  // come from the real production bundle under test.
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!['fetch', 'xhr'].includes(request.resourceType())) {
      await route.continue();
      return;
    }

    const path = new URL(request.url()).pathname;
    const responseByPath: Record<string, unknown> = {
      '/health': { status: 'ok' },
      '/setup/status': {
        models_ready: true,
        missing: [],
        hf_cache_dir: '/deterministic/models',
        disk_free_gb: 100,
        min_free_gb: 1,
        enough_disk: true,
      },
      '/model/status': { status: 'idle', sub_stage: null, detail: '', error: null, progress: null },
      '/profiles': [],
      '/personalities': [],
      '/history': [],
      '/dub/history': [],
      '/projects': [],
      '/export/history': [],
      '/engines': {
        tts: { active: null, backends: [] },
        asr: { active: null, backends: [] },
        llm: { active: null, backends: [] },
      },
      '/sysinfo': { cpu: 0, ram: 0, total_ram: 32, vram: 0, gpu_active: false },
      '/system/info': { platform: 'benchmark', device: 'deterministic' },
      '/system/notifications': { notifications: [] },
      '/system/last-run-crash': { record: null, acknowledged: false },
      '/system/logs': { path: '', exists: false, lines: [] },
      '/system/logs/tauri': { path: '', exists: false, lines: [] },
      '/system/network/state': { enabled: false },
      '/dictation/prefs': {
        enabled: false,
        mode: 'toggle',
        model_id: 'sherpa-parakeet-tdt-v3',
      },
      '/workers': { enabled: false, running: false, workers: [] },
      '/workers/target': {
        target: 'local',
        active: { remote: false },
        targets: [
          { id: 'local', label: 'Local', is_local: true, status: 'ready', available: true },
        ],
      },
      '/api/settings/analytics': { available: false, prompted: true, opted_in: false },
      '/donation_progress.json': {
        raised: 10,
        goal: 200,
        currency: 'USD',
        sponsorCount: 1,
        updated: '2026-06-17',
      },
    };

    const responseBody = responseByPath[path];
    if (responseBody === undefined) {
      unexpectedRequests.add(`${request.method()} ${path}`);
      await route.fulfill({
        status: 501,
        contentType: 'application/json',
        headers: { 'x-omnivoice-backend': '1' },
        body: JSON.stringify({ detail: 'Unhandled deterministic benchmark route' }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'x-omnivoice-backend': '1' },
      body: JSON.stringify(responseBody),
    });
  });
  return unexpectedRequests;
}

async function setPhase(page: Page, phase: string): Promise<void> {
  await page.evaluate((nextPhase) => window.__ovSetResponsivenessPhase?.(nextPhase), phase);
}

async function driveNativeInputBurst(
  page: Page,
  selector: string,
  values: string[],
): Promise<void> {
  await page.locator(selector).evaluate(
    async (node, burst) => {
      const element = node as HTMLInputElement | HTMLTextAreaElement;
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const nativeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!nativeValueSetter) throw new Error(`No native value setter for ${element.tagName}`);

      await new Promise<void>((resolve) => {
        // Schedule against one common origin. Measuring UI work must not add
        // another 25 ms after every handler and accidentally turn a 475 ms
        // burst into a >1 s stream that rightfully crosses the max-flush gate.
        burst.values.forEach((value, index) => {
          setTimeout(() => {
            nativeValueSetter.call(element, value);
            element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            if (index === burst.values.length - 1) resolve();
          }, index * burst.intervalMs);
        });
      });
    },
    { values, intervalMs: UPDATE_INTERVAL_MS },
  );
}

async function readDurableValues(page: Page) {
  return page.evaluate(
    ({ appKey, omniUiKey }) => ({
      app: JSON.parse(localStorage.getItem(appKey) || 'null'),
      omniUi: JSON.parse(localStorage.getItem(omniUiKey) || 'null'),
    }),
    { appKey: APP_STORE_KEY, omniUiKey: OMNI_UI_KEY },
  );
}

function writesFor(metrics: BrowserMetrics, phase: string, key: TargetKey): PhysicalWrite[] {
  return metrics.writes.filter((write) => write.phase === phase && write.key === key);
}

async function writeReport(testInfo: TestInfo, report: unknown): Promise<void> {
  const artifactPath = testInfo.outputPath('responsiveness.json');
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await testInfo.attach('responsiveness.json', {
    path: artifactPath,
    contentType: 'application/json',
  });
}

test('coalesces large-state persistence during rapid UI input', async ({ page }, testInfo) => {
  const unexpectedRequests = await installDeterministicBrowserState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const listenerProbe = await page.evaluate(async () => {
    const socket = new WebSocket('ws://benchmark.invalid');
    let onceCalls = 0;
    let removedCalls = 0;
    const removedListener = () => {
      removedCalls += 1;
    };
    socket.addEventListener(
      'open',
      () => {
        onceCalls += 1;
      },
      { once: true },
    );
    socket.addEventListener('open', removedListener);
    socket.removeEventListener('open', removedListener);
    await Promise.resolve();
    socket.dispatchEvent(new Event('open'));
    socket.close();
    return { onceCalls, removedCalls };
  });
  expect(listenerProbe).toEqual({ onceCalls: 1, removedCalls: 0 });

  const scaleSelector = '.appearance-panel input[type="range"]';
  await expect(page.locator(scaleSelector)).toBeVisible();

  // Let startup restoration and its trailing persistence window fully settle;
  // subsequent records are phase-labelled and attributable to one burst.
  await page.waitForTimeout(TRAILING_FLUSH_SETTLE_MS);

  const scaleValues = Array.from({ length: UPDATE_COUNT }, (_, index) =>
    (0.65 + index * 0.05).toFixed(2),
  );
  const finalScale = Number(scaleValues.at(-1));
  await setPhase(page, 'ui-scale');
  await driveNativeInputBurst(page, scaleSelector, scaleValues);
  await page.waitForTimeout(TRAILING_FLUSH_SETTLE_MS);

  const afterScale = await readDurableValues(page);
  expect(afterScale.app?.state?.uiScale).toBe(finalScale);
  expect(afterScale.omniUi?.uiScale).toBe(finalScale);

  // Navigate through the real production UI. Waiting before phase assignment
  // prevents the navigation write from being counted as a text-input write.
  await setPhase(page, 'navigation');
  await page.locator('.nav-rail button[aria-label="Voice"]').click();
  const textSelector = 'textarea.studio-script-input';
  await expect(page.locator(textSelector)).toBeVisible();
  await page.waitForTimeout(TRAILING_FLUSH_SETTLE_MS);

  const textValues = Array.from(
    { length: UPDATE_COUNT },
    (_, index) => `responsiveness-${index.toString().padStart(2, '0')}-${'voice '.repeat(8)}`,
  );
  const finalText = textValues.at(-1);
  await setPhase(page, 'studio-text');
  await driveNativeInputBurst(page, textSelector, textValues);
  await page.waitForTimeout(TRAILING_FLUSH_SETTLE_MS);

  const durable = await readDurableValues(page);
  const metrics = await page.evaluate(() => window.__ovResponsivenessMetrics as BrowserMetrics);

  const report = {
    schemaVersion: 1,
    fixture: { appStoreVersion: 7, storyTracks: 400, dubSegments: 1_800 },
    burst: { updates: UPDATE_COUNT, requestedIntervalMs: UPDATE_INTERVAL_MS },
    durable: {
      appUiScale: durable.app?.state?.uiScale,
      omniUiScale: durable.omniUi?.uiScale,
      omniUiText: durable.omniUi?.text,
    },
    phases: {
      uiScale: {
        writes: Object.fromEntries(
          TARGET_KEYS.map((key) => [key, writesFor(metrics, 'ui-scale', key)]),
        ),
        inputToNextRaf: metrics.inputToNextRaf.filter((sample) => sample.phase === 'ui-scale'),
        longTasks: metrics.longTasks.filter((sample) => sample.phase === 'ui-scale'),
      },
      studioText: {
        writes: Object.fromEntries(
          TARGET_KEYS.map((key) => [key, writesFor(metrics, 'studio-text', key)]),
        ),
        inputToNextRaf: metrics.inputToNextRaf.filter((sample) => sample.phase === 'studio-text'),
        longTasks: metrics.longTasks.filter((sample) => sample.phase === 'studio-text'),
      },
    },
    startup: {
      writes: metrics.writes.filter((write) => write.phase === 'startup'),
      longTasks: metrics.longTasks.filter((sample) => sample.phase === 'startup'),
    },
    network: { unexpectedRequests: [...unexpectedRequests].sort() },
  };
  await writeReport(testInfo, report);

  expect(durable.omniUi?.text).toBe(finalText);
  expect([...unexpectedRequests].sort(), 'every fetch/XHR must have an explicit fixture').toEqual(
    [],
  );
  expect(metrics.inputToNextRaf.filter((sample) => sample.phase === 'ui-scale')).toHaveLength(
    UPDATE_COUNT,
  );
  expect(metrics.inputToNextRaf.filter((sample) => sample.phase === 'studio-text')).toHaveLength(
    UPDATE_COUNT,
  );
  for (const phase of ['ui-scale', 'studio-text']) {
    for (const key of TARGET_KEYS) {
      expect(
        writesFor(metrics, phase, key).length,
        `${phase} should physically write ${key} no more than once`,
      ).toBeLessThanOrEqual(1);
    }
  }
});
