import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/** Create Tauri's required dev resource before starting the compiler. */
export function launchTauriDev({
  cwd = process.cwd(),
  args = process.argv.slice(2),
  env = process.env,
  mkdir = mkdirSync,
  spawn = spawnSync,
} = {}) {
  mkdir(join(cwd, "dist"), { recursive: true });
  return spawn("bun", ["run", "tauri", "dev", ...args], {
    stdio: "inherit",
    env,
  });
}
