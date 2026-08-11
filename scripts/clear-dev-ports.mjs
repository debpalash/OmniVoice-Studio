#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORTS = [3900, 3901];
const CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseWindowsListeners(output, ports) {
  const wanted = new Set(ports);
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (match && wanted.has(Number(match[1]))) pids.add(Number(match[2]));
  }
  return [...pids];
}

export function parseSsListeners(output, ports) {
  const wanted = new Set(ports);
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    const portMatch = line.match(/\]?:([0-9]+)\s/);
    if (!portMatch || !wanted.has(Number(portMatch[1]))) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
  }
  return [...pids];
}

function validPid(pid) {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

function unixListeners(ports) {
  const pids = new Set();
  for (const port of ports) {
    const result = spawnSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    });
    if (!result.error) {
      for (const value of result.stdout.split(/\s+/)) {
        const pid = Number(value);
        if (validPid(pid)) pids.add(pid);
      }
      continue;
    }

    if (result.error.code !== "ENOENT") throw result.error;
    const fallback = spawnSync("ss", ["-ltnp"], { encoding: "utf8" });
    if (fallback.error) throw fallback.error;
    for (const pid of parseSsListeners(fallback.stdout, ports)) {
      if (validPid(pid)) pids.add(pid);
    }
    break;
  }
  return [...pids];
}

function windowsListeners(ports) {
  const result = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
  if (result.error) throw result.error;
  return parseWindowsListeners(result.stdout, ports).filter(validPid);
}

function normalized(value, windows = process.platform === "win32") {
  if (windows)
    return String(value || "")
      .replaceAll("/", "\\")
      .toLowerCase();
  return resolve(String(value || ""));
}

export function belongsToCheckout(
  cwd,
  command,
  executable,
  windows = process.platform === "win32",
  checkoutRoot = CHECKOUT_ROOT,
) {
  const root = normalized(checkoutRoot, windows);
  const prefix = `${root}${windows ? "\\" : sep}`;
  const ownedPath = (value) => {
    if (!value) return false;
    const path = normalized(value, windows);
    return path === root || path.startsWith(prefix);
  };
  if (ownedPath(cwd) || ownedPath(executable)) return true;
  const haystack = windows
    ? String(command || "")
        .replaceAll("/", "\\")
        .toLowerCase()
    : String(command || "");
  let index = haystack.indexOf(root);
  while (index !== -1) {
    const previous = haystack[index - 1];
    const next = haystack[index + root.length];
    const startsArgument = previous === undefined || previous === "=" || /\s|["']/.test(previous);
    const endsPath = next === undefined || next === "/" || next === "\\" || /\s|["']/.test(next);
    if (startsArgument && endsPath) return true;
    index = haystack.indexOf(root, index + 1);
  }
  return false;
}

export function isUninspectableProcessError(error) {
  return ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error?.code);
}

function inspectLinux(pid) {
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterName = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const startTime = afterName[19]; // proc(5): field 22; this array starts at field 3.
    if (!startTime) return null;
    return {
      identity: `linux:${startTime}`,
      owned: belongsToCheckout(cwd, command, "", false),
    };
  } catch (error) {
    if (isUninspectableProcessError(error)) return null;
    throw error;
  }
}

export function stopUnixProcess(pid, force, kill = process.kill) {
  try {
    kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function inspectMac(pid) {
  const cwdResult = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
  });
  const startResult = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  const commandResult = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (startResult.status !== 0 || !startResult.stdout.trim()) return null;
  if (cwdResult.error) throw cwdResult.error;
  if (commandResult.error) throw commandResult.error;
  const cwdLine = cwdResult.stdout.split(/\r?\n/).find((line) => line.startsWith("n"));
  const cwd = cwdLine?.slice(1) || "";
  return {
    identity: `mac:${startResult.stdout.trim()}`,
    owned: belongsToCheckout(cwd, commandResult.stdout.trim(), "", false),
  };
}

function inspectWindows(pid) {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if ($null -ne $p) {",
    "  $p | Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress",
    "}",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not inspect process ${pid}`);
  if (!result.stdout.trim()) return null;
  const info = JSON.parse(result.stdout);
  return {
    identity: `windows:${info.CreationDate}`,
    owned: belongsToCheckout("", info.CommandLine, info.ExecutablePath, true),
  };
}

function systemOperations() {
  const windows = process.platform === "win32";
  return {
    // Windows taskkill targets a reusable PID, not the inspected process
    // instance. Refuse automatic termination until it can be handle-bound.
    canStop: !windows,
    // macOS exposes process start time to ps at one-second resolution. That is
    // sufficient for a graceful stop, but not safe proof for SIGKILL escalation.
    canForce: process.platform !== "darwin",
    listeners: windows ? windowsListeners : unixListeners,
    inspect: windows ? inspectWindows : process.platform === "darwin" ? inspectMac : inspectLinux,
    stop(pid, force) {
      stopUnixProcess(pid, force);
    },
    sleep(ms) {
      return new Promise((done) => setTimeout(done, ms));
    },
  };
}

async function inspectSameProcess(ops, pid, expectedIdentity) {
  const current = await ops.inspect(pid);
  if (!current || current.identity !== expectedIdentity) return null;
  if (!current.owned) throw new Error(`Refusing to stop unrelated process ${pid}`);
  return current;
}

export async function clearDevPortsWith(ports, ops) {
  const listeners = await ops.listeners(ports);
  for (const pid of listeners) {
    const first = await ops.inspect(pid);
    if (!first) continue;
    if (!first.owned) throw new Error(`Refusing to stop unrelated process ${pid}`);
    if (ops.canStop === false) {
      throw new Error(
        `VoiceStudio process ${pid} is using a development port; stop it in Task Manager and retry`,
      );
    }

    if (!(await inspectSameProcess(ops, pid, first.identity))) continue;
    await ops.stop(pid, false, first.identity);

    let current = first;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await ops.sleep(50);
      current = await inspectSameProcess(ops, pid, first.identity);
      if (!current) break;
    }
    if (!current) continue;
    if (ops.canForce === false) continue;

    // Revalidate immediately before escalation. A recycled PID is never killed.
    if (!(await inspectSameProcess(ops, pid, first.identity))) continue;
    await ops.stop(pid, true, first.identity);
  }

  let remaining = await ops.listeners(ports);
  for (let attempt = 0; attempt < 10 && remaining.length; attempt += 1) {
    await ops.sleep(50);
    remaining = await ops.listeners(ports);
  }
  if (remaining.length) throw new Error(`Ports still occupied by process ${remaining.join(", ")}`);
}

export async function clearDevPorts(ports = DEFAULT_PORTS) {
  const uniquePorts = [...new Set(ports.map(Number))];
  if (uniquePorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new TypeError(`Invalid port list: ${ports.join(", ")}`);
  }
  return clearDevPortsWith(uniquePorts, systemOperations());
}

if (import.meta.main) {
  const ports = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : DEFAULT_PORTS;
  await clearDevPorts(ports);
}
