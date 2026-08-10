import assert from "node:assert/strict";
import test from "node:test";

import {
  clearDevPortsWith,
  parseSsListeners,
  parseWindowsListeners,
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

test("refuses an unrelated listener without signalling it", async () => {
  const signals = [];
  const ops = {
    listeners: async () => [1234],
    inspect: async () => ({ identity: "start-a", owned: false }),
    stop: async (...args) => signals.push(args),
    sleep: async () => {},
  };
  await assert.rejects(
    clearDevPortsWith([3900], ops),
    /Refusing to stop unrelated process 1234/,
  );
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
