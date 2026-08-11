import assert from "node:assert/strict";
import test from "node:test";

import {
  belongsToCheckout,
  clearDevPortsWith,
  isUninspectableProcessError,
  parseSsListeners,
  parseWindowsListeners,
  stopUnixProcess,
} from "../../scripts/clear-dev-ports.mjs";

test("parses only requested Windows TCP listeners", () => {
  const output = [
    "  TCP    0.0.0.0:3900    0.0.0.0:0    LISTENING    1234",
    "  TCP    [::]:3901       [::]:0       LISTENING    5678",
    "  TCP    0.0.0.0:5173    0.0.0.0:0    LISTENING    9999",
  ].join("\r\n");
  assert.deepEqual(parseWindowsListeners(output, [3900, 3901]), [1234, 5678]);
});

test("parses only requested Linux listeners and deduplicates pids", () => {
  const output = [
    'LISTEN 0 512 *:3900 *:* users:(("bun",pid=1234,fd=11))',
    'LISTEN 0 512 127.0.0.1:3901 0.0.0.0:* users:(("bun",pid=1234,fd=12))',
    'LISTEN 0 512 *:5173 *:* users:(("bun",pid=9999,fd=8))',
  ].join("\n");
  assert.deepEqual(parseSsListeners(output, [3900, 3901]), [1234]);
});

test("command ownership requires a checkout path boundary", () => {
  const root = "/work/VoiceStudio";
  assert.equal(belongsToCheckout("", `bun ${root}/scripts/dev.mjs`, "", false, root), true);
  assert.equal(belongsToCheckout("", `bun '${root}'`, "", false, root), true);
  assert.equal(belongsToCheckout("", `bun --cwd=${root}/frontend`, "", false, root), true);
  assert.equal(belongsToCheckout("", `bun ${root}-old/scripts/dev.mjs`, "", false, root), false);
  assert.equal(belongsToCheckout("", `bun ${root}2/scripts/dev.mjs`, "", false, root), false);
  assert.equal(belongsToCheckout("", `bun /tmp${root}/scripts/dev.mjs`, "", false, root), false);
  assert.equal(belongsToCheckout("", "bun C:/repo/scripts/dev.mjs", "", true, "C:\\repo"), true);
});

test("permission and exit races make a process uninspectable", () => {
  for (const code of ["ENOENT", "ESRCH", "EACCES", "EPERM"]) {
    assert.equal(isUninspectableProcessError({ code }), true);
  }
  assert.equal(isUninspectableProcessError({ code: "EIO" }), false);
});

test("an already-exited Unix process counts as stopped", () => {
  const missing = Object.assign(new Error("gone"), { code: "ESRCH" });
  assert.doesNotThrow(() =>
    stopUnixProcess(1234, false, () => {
      throw missing;
    }),
  );
  assert.throws(
    () =>
      stopUnixProcess(1234, true, () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      }),
    /denied/,
  );
});

test("refuses an unrelated listener without signalling it", async () => {
  const signals = [];
  const ops = {
    listeners: async () => [1234],
    inspect: async () => ({ identity: "start-a", owned: false }),
    stop: async (...args) => signals.push(args),
    sleep: async () => {},
  };
  await assert.rejects(clearDevPortsWith([3900], ops), /Refusing to stop unrelated process 1234/);
  assert.deepEqual(signals, []);
});

test("refuses Windows auto-stop when termination cannot bind to the inspected process", async () => {
  const signals = [];
  const ops = {
    canStop: false,
    listeners: async () => [1234],
    inspect: async () => ({ identity: "windows:start-a", owned: true }),
    stop: async (...args) => signals.push(args),
    sleep: async () => {},
  };
  await assert.rejects(clearDevPortsWith([3900], ops), /stop it in Task Manager and retry/);
  assert.deepEqual(signals, []);
});

test("never force-kills a recycled pid", async () => {
  const signals = [];
  let inspections = 0;
  let discovery = 0;
  const ops = {
    listeners: async () => (discovery++ === 0 ? [1234] : []),
    inspect: async () => {
      inspections += 1;
      if (inspections <= 3) return { identity: "start-a", owned: true };
      return { identity: "start-b", owned: false };
    },
    stop: async (pid, force) => signals.push([pid, force]),
    sleep: async () => {},
  };
  await clearDevPortsWith([3900], ops);
  assert.deepEqual(signals, [[1234, false]]);
});

test("escalates only while ownership and identity remain stable", async () => {
  const signals = [];
  let discovery = 0;
  const ops = {
    listeners: async () => (discovery++ === 0 ? [1234] : []),
    inspect: async () => ({ identity: "start-a", owned: true }),
    stop: async (pid, force) => signals.push([pid, force]),
    sleep: async () => {},
  };
  await clearDevPortsWith([3900], ops);
  assert.deepEqual(signals, [
    [1234, false],
    [1234, true],
  ]);
});

test("does not force-kill when the platform cannot prove process identity precisely", async () => {
  const signals = [];
  let discovery = 0;
  const ops = {
    canForce: false,
    listeners: async () => (discovery++ === 0 ? [1234] : []),
    inspect: async () => ({ identity: "mac:start-second", owned: true }),
    stop: async (pid, force) => signals.push([pid, force]),
    sleep: async () => {},
  };
  await clearDevPortsWith([3900], ops);
  assert.deepEqual(signals, [[1234, false]]);
});

test("waits for the listener to disappear after force stop", async () => {
  const signals = [];
  let discovery = 0;
  let sleeps = 0;
  const ops = {
    listeners: async () => (++discovery < 4 ? [1234] : []),
    inspect: async () => ({ identity: "start-a", owned: true }),
    stop: async (pid, force) => signals.push([pid, force]),
    sleep: async () => {
      sleeps += 1;
    },
  };
  await clearDevPortsWith([3900], ops);
  assert.deepEqual(signals, [
    [1234, false],
    [1234, true],
  ]);
  assert.equal(sleeps, 12);
});
