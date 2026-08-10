import assert from "node:assert/strict";
import test from "node:test";

import { parseSsListeners, parseWindowsListeners } from "../../scripts/clear-dev-ports.mjs";

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
