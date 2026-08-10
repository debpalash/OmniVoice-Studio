#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

const DEFAULT_PORTS = [3900, 3901];

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

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function stopUnix(pid) {
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Bun.sleep(50);
    if (!isAlive(pid)) return;
  }
  process.kill(pid, "SIGKILL");
}

export async function clearDevPorts(ports = DEFAULT_PORTS) {
  const uniquePorts = [...new Set(ports.map(Number))];
  if (uniquePorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new TypeError(`Invalid port list: ${ports.join(", ")}`);
  }

  const windows = process.platform === "win32";
  const listeners = windows ? windowsListeners(uniquePorts) : unixListeners(uniquePorts);
  for (const pid of listeners) {
    if (windows) {
      const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
      if (result.status !== 0) throw new Error(`Could not stop process ${pid}`);
    } else {
      await stopUnix(pid);
    }
  }

  const remaining = windows ? windowsListeners(uniquePorts) : unixListeners(uniquePorts);
  if (remaining.length) throw new Error(`Ports still occupied by process ${remaining.join(", ")}`);
}

if (import.meta.main) {
  const ports = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : DEFAULT_PORTS;
  await clearDevPorts(ports);
}
