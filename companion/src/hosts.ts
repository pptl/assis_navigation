import { existsSync } from "node:fs";
import type { ControlFile, HostsFile } from "./types.js";
import { controlPath, hostsPath } from "./paths.js";
import { readJson, writeJsonAtomic } from "./util/fs.js";

export function loadHosts(): HostsFile {
  const file = readJson<Partial<HostsFile>>(hostsPath(), {});
  return { origins: file.origins ?? {} };
}

export function saveHosts(hosts: HostsFile): void {
  writeJsonAtomic(hostsPath(), hosts);
}

export function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/+$/, "");
  }
}

export function registerOrigins(origins: string[], dataDir: string): HostsFile {
  const hosts = loadHosts();
  for (const o of origins) hosts.origins[normalizeOrigin(o)] = dataDir;
  saveHosts(hosts);
  return hosts;
}

export function lookupDataDir(origin: string, hosts?: HostsFile): string | undefined {
  const h = hosts ?? loadHosts();
  return h.origins[normalizeOrigin(origin)];
}

export function loadControl(): ControlFile {
  if (!existsSync(controlPath())) return { paused: false, updatedAt: "" };
  const c = readJson<Partial<ControlFile>>(controlPath(), {});
  return { paused: !!c.paused, updatedAt: c.updatedAt ?? "" };
}

export function saveControl(paused: boolean): ControlFile {
  const c: ControlFile = { paused, updatedAt: new Date().toISOString() };
  writeJsonAtomic(controlPath(), c);
  return c;
}
