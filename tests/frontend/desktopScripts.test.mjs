// Unit tests for scripts/desktop-common.mjs — the pure helpers behind the
// local desktop launcher scripts (desktop-fresh.mjs / desktop-prod.sh).
//
// The load-bearing guarantees:
//   * every path the fresh script may delete is app-scoped (contains
//     "omnivoice" or "com.debpalash") and lives under the given home dir —
//     a typo can never widen a rm -rf beyond OmniVoice's own traces;
//   * the PATH sanitizer strips exactly the intended dev-tool prefixes and
//     preserves order otherwise;
//   * the env sanitizer removes exactly the HF/OMNIVOICE keys, nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_ID,
  STRIPPED_PATH_ENTRIES,
  STRIPPED_ENV_VARS,
  UPDATER_ARTIFACTS_OFF,
  hiddenFrom,
  isAppScoped,
  macosFreshTraces,
  sanitizedEnv,
  sanitizedPath,
  tauriBuildArgs,
} from '../../scripts/desktop-common.mjs';

const HOME = '/Users/testuser';

test('every fresh-trace path is app-scoped and under home', () => {
  const traces = macosFreshTraces(HOME);
  assert.ok(traces.length >= 8, 'expected the full trace list');
  for (const { path } of traces) {
    assert.ok(path.startsWith(`${HOME}/`), `not under home: ${path}`);
    // The scoping must come from the path BELOW home, not from home itself.
    const rel = path.slice(HOME.length);
    assert.ok(isAppScoped(rel), `not app-scoped below home: ${path}`);
  }
});

test('fresh traces cover every macOS install remnant', () => {
  const paths = macosFreshTraces(HOME).map((t) => t.path);
  const mustCover = [
    `${HOME}/Library/Application Support/${APP_ID}`, // Tauri app data
    `${HOME}/Library/Application Support/OmniVoice`, // backend data
    `${HOME}/Library/Logs/${APP_ID}`,
    `${HOME}/Library/WebKit/${APP_ID}`, // webview localStorage
    `${HOME}/Library/Caches/${APP_ID}`,
    `${HOME}/Library/HTTPStorages/${APP_ID}`,
    `${HOME}/Library/Preferences/${APP_ID}.plist`,
    `${HOME}/Library/Saved Application State/${APP_ID}.savedState`,
  ];
  for (const p of mustCover) {
    assert.ok(paths.includes(p), `missing trace: ${p}`);
  }
  // HTTPStorages must be prefix-matched (dir AND .binarycookies file).
  const http = macosFreshTraces(HOME).find((t) => t.path.includes('HTTPStorages'));
  assert.equal(http.kind, 'prefix');
});

test('isAppScoped accepts app dirs, rejects shared paths', () => {
  assert.ok(isAppScoped(`/x/Library/Caches/${APP_ID}`));
  assert.ok(isAppScoped('/x/Library/Application Support/OmniVoice'));
  assert.ok(isAppScoped('C:/Users/u/AppData/Local/OmniVoice/hf_cache'));
  assert.ok(!isAppScoped(`${HOME}/.cache/huggingface`)); // shared global HF cache
  assert.ok(!isAppScoped(`${HOME}/Library`));
  assert.ok(!isAppScoped(''));
});

test('sanitizedPath strips exactly the dev-tool entries, keeps order', () => {
  const input = [
    '/opt/homebrew/bin',
    '/usr/bin',
    '/opt/homebrew/sbin',
    '/bin',
    '/usr/local/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
  assert.equal(sanitizedPath(input), '/usr/bin:/bin:/usr/sbin:/sbin');
});

test('sanitizedPath normalises trailing slashes but not look-alikes', () => {
  assert.equal(
    sanitizedPath('/usr/local/bin/:/usr/bin:/opt/homebrew/bin//'),
    '/usr/bin',
  );
  // Prefix look-alikes and subdirectories must survive.
  assert.equal(
    sanitizedPath('/usr/local/bin-extra:/usr/local/bin/sub:/opt/homebrew/binx'),
    '/usr/local/bin-extra:/usr/local/bin/sub:/opt/homebrew/binx',
  );
  assert.equal(sanitizedPath(''), '');
});

test('sanitizedEnv removes exactly the HF and OMNIVOICE_* keys', () => {
  const input = {
    HOME: '/Users/testuser',
    USER: 'testuser',
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    HF_TOKEN: 'x',
    HUGGING_FACE_HUB_TOKEN: 'x',
    HF_HOME: '/tmp/hf',
    HF_HUB_CACHE: '/tmp/hf/hub',
    HF_ENDPOINT: 'https://example.invalid',
    OMNIVOICE_DATA_DIR: '/tmp/ov',
    OMNIVOICE_CACHE_DIR: '/tmp/ovc',
    // Look-alikes that must survive:
    HF_TOKENX: 'keep',
    MY_HF_TOKEN: 'keep',
    OMNIVOICEX: 'keep', // no underscore → not the OMNIVOICE_ prefix
  };
  const out = sanitizedEnv(input);
  for (const key of STRIPPED_ENV_VARS) assert.ok(!(key in out), `should strip ${key}`);
  assert.ok(!('OMNIVOICE_DATA_DIR' in out));
  assert.ok(!('OMNIVOICE_CACHE_DIR' in out));
  assert.equal(out.HOME, '/Users/testuser');
  assert.equal(out.USER, 'testuser');
  assert.equal(out.HF_TOKENX, 'keep');
  assert.equal(out.MY_HF_TOKEN, 'keep');
  assert.equal(out.OMNIVOICEX, 'keep');
  assert.equal(out.PATH, '/usr/bin:/bin'); // PATH sanitized too
  // Input must not be mutated.
  assert.equal(input.HF_TOKEN, 'x');
  assert.equal(input.PATH, '/opt/homebrew/bin:/usr/bin:/bin');
});

test('hiddenFrom reports only what is actually present', () => {
  const { vars, pathEntries } = hiddenFrom({
    PATH: '/usr/bin:/opt/homebrew/bin',
    HF_TOKEN: 'x',
    OMNIVOICE_DATA_DIR: '/tmp',
    HOME: '/Users/testuser',
  });
  assert.deepEqual(vars.sort(), ['HF_TOKEN', 'OMNIVOICE_DATA_DIR']);
  assert.deepEqual(pathEntries, ['/opt/homebrew/bin']);
  const empty = hiddenFrom({ HOME: '/Users/testuser' });
  assert.deepEqual(empty.vars, []);
  assert.deepEqual(empty.pathEntries, []);
});

test('tauriBuildArgs builds only the launched bundle, updater artifacts off', () => {
  const macos = tauriBuildArgs('darwin');
  assert.deepEqual(macos.slice(0, 3), ['tauri', 'build', '--debug']);
  assert.ok(macos.join(' ').includes('--bundles app'));
  assert.deepEqual(tauriBuildArgs('linux').join(' ').includes('--bundles appimage'), true);
  assert.ok(tauriBuildArgs('win32').includes('--no-bundle'));

  for (const platform of ['darwin', 'linux', 'win32']) {
    const args = tauriBuildArgs(platform);
    const config = args[args.indexOf('--config') + 1];
    // The override must parse and target the exact tauri.conf.json key.
    assert.deepEqual(JSON.parse(config), { bundle: { createUpdaterArtifacts: false } });
    assert.equal(config, UPDATER_ARTIFACTS_OFF);
  }
});

test('STRIPPED_PATH_ENTRIES are exactly the intended dev prefixes', () => {
  assert.deepEqual(STRIPPED_PATH_ENTRIES, [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
  ]);
});
