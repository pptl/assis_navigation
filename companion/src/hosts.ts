import { existsSync } from "node:fs";
import type { ControlFile, HostsFile, PortLease } from "./types.js";
import { controlPath, hostsPath } from "./paths.js";
import { readJson, writeJsonAtomic } from "./util/fs.js";
import { listeningPorts, loopbackPortOf, resolveProjectOfPort, type ResolveDeps } from "./util/ports.js";

export function loadHosts(): HostsFile {
  const file = readJson<Partial<HostsFile>>(hostsPath(), {});
  return { origins: file.origins ?? {}, ports: file.ports ?? {} };
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

/** Register non-loopback sites (a remote test site). Loopback origins are ignored: their owner is resolved. */
export function registerOrigins(origins: string[], dataDir: string): HostsFile {
  const hosts = loadHosts();
  for (const o of origins) {
    if (loopbackPortOf(o) !== undefined) continue;
    hosts.origins[normalizeOrigin(o)] = dataDir;
  }
  saveHosts(hosts);
  return hosts;
}

export function leasePort(port: number, dataDir: string, pid?: number): PortLease {
  const hosts = loadHosts();
  const lease: PortLease = { dataDir, pid, since: new Date().toISOString() };
  hosts.ports = { ...hosts.ports, [String(port)]: lease };
  saveHosts(hosts);
  return lease;
}

export function forgetPort(port: number): boolean {
  const hosts = loadHosts();
  if (!hosts.ports || !(String(port) in hosts.ports)) return false;
  delete hosts.ports[String(port)];
  saveHosts(hosts);
  return true;
}

export interface OwnerResult {
  dataDir: string;
  via: "lease" | "resolved";
}

/**
 * Who owns a loopback port right now.
 *
 * A lease pinned to the pid that still holds the port is an explicit override and wins. Otherwise
 * live resolution wins, because it is evidence about the process actually serving the port. A lease
 * without a pid (written before the server started) is only a last resort, and a lease whose pid no
 * longer matches is ignored entirely — that is exactly the moment a port changed hands.
 */
export function ownerOfLoopbackPort(port: number, hosts?: HostsFile, deps: ResolveDeps = {}): OwnerResult | undefined {
  const lease = (hosts ?? loadHosts()).ports?.[String(port)];
  const now = deps.now ?? Date.now();
  if (lease?.pid !== undefined) {
    const pid = listeningPorts(now, deps.readPorts).get(port);
    if (pid === lease.pid) return { dataDir: lease.dataDir, via: "lease" };
  }
  const resolved = resolveProjectOfPort(port, { ...deps, now });
  if (resolved) return { dataDir: resolved, via: "resolved" };
  if (lease && lease.pid === undefined) return { dataDir: lease.dataDir, via: "lease" };
  return undefined;
}

/** Project owning the origin of a recorded event: resolved for loopback, registered for anything else. */
export function ownerOfOrigin(origin: string, hosts?: HostsFile, deps?: ResolveDeps): OwnerResult | undefined {
  const port = loopbackPortOf(origin);
  if (port !== undefined) return ownerOfLoopbackPort(port, hosts, deps);
  const dataDir = (hosts ?? loadHosts()).origins[normalizeOrigin(origin)];
  return dataDir ? { dataDir, via: "lease" } : undefined;
}

export function lookupDataDir(origin: string, hosts?: HostsFile): string | undefined {
  return ownerOfOrigin(origin, hosts)?.dataDir;
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
