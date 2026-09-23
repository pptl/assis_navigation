// Which project owns a loopback port — resolved, never registered.
//
// A project is never pinned to a port: the port it gets depends on what the dev server opens and
// what happens to be free. But at any instant the port has exactly one owning process, and that
// process's command line carries the project's absolute path (`node <project>/node_modules/vite/
// bin/vite.js`). So ownership is derived: port → pid → command line → the directory above it that
// holds a .nav-recorder/config.json. Ownership then follows the dev server automatically — restart
// it on another port, or hand the port to another project, and the answer changes by itself.
//
// Cost control: the pid lookup is cheap (`netstat -ano`, ~60 ms) and cached for seconds; the process
// table is expensive (a PowerShell spawn, ~600 ms) and only read when a port's pid actually changes,
// i.e. about once per dev server run. Command lines of unrelated processes are matched against
// project paths in memory and never logged or stored.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DATA_DIR_NAME } from "../paths.js";

export interface ProcRow {
  pid: number;
  parentPid: number;
  commandLine: string;
}

/** How long a `netstat` snapshot is reused. */
export const PORT_SCAN_TTL_MS = 10_000;
/** How long a resolved owner survives after its port stops listening (page stays open after the dev server dies). */
export const OWNER_GRACE_MS = 5 * 60_000;
/** Command line → project: how far up the parent chain to look (npm run dev → shim → server). */
export const MAX_PARENT_HOPS = 3;

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

/** Port of a loopback origin, or undefined when the origin is not loopback. */
export function loopbackPortOf(origin: string): number | undefined {
  let u: URL;
  try { u = new URL(origin); } catch { return undefined; }
  if (!isLoopbackHost(u.hostname)) return undefined;
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return Number.isInteger(port) ? port : undefined;
}

function portOfAddress(address: string): number | undefined {
  const i = address.lastIndexOf(":");
  if (i < 0) return undefined;
  const port = Number(address.slice(i + 1));
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * Listening TCP sockets from `netstat -ano`, keyed by port.
 * The state word is localized on non-English Windows, but a listener's foreign address is always the
 * wildcard, so both signals are accepted. Bind address is ignored: dev servers commonly listen on
 * 0.0.0.0 or [::] rather than 127.0.0.1, and the browser still reaches them as localhost.
 */
export function parseNetstat(out: string): Map<number, number> {
  const ports = new Map<number, number>();
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP") continue;
    const [, local, foreign, state, pidText] = cols;
    const listening = /^(0\.0\.0\.0|\[::\]|\*):0$/.test(foreign) || /^listen/i.test(state);
    if (!listening) continue;
    const port = portOfAddress(local);
    const pid = Number(pidText);
    if (port === undefined || !Number.isInteger(pid) || pid <= 0) continue;
    if (!ports.has(port)) ports.set(port, pid);
  }
  return ports;
}

/** `ss`/`lsof`-free POSIX fallback: `lsof -nP -iTCP -sTCP:LISTEN` output. */
export function parseLsof(out: string): Map<number, number> {
  const ports = new Map<number, number>();
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const pid = Number(cols[1]);
    const port = portOfAddress(cols[8].replace(/\s*\(LISTEN\)\s*$/i, ""));
    if (!Number.isInteger(pid) || pid <= 0 || port === undefined) continue;
    if (!ports.has(port)) ports.set(port, pid);
  }
  return ports;
}

/** Win32_Process rows as ConvertTo-Json writes them: one object for a single row, an array otherwise. */
export function parseProcessTable(json: string): Map<number, ProcRow> {
  const rows = new Map<number, ProcRow>();
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return rows; }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const raw of list) {
    const r = raw as { ProcessId?: number; ParentProcessId?: number; CommandLine?: string | null };
    if (!Number.isInteger(r?.ProcessId)) continue;
    rows.set(r.ProcessId as number, {
      pid: r.ProcessId as number,
      parentPid: Number.isInteger(r.ParentProcessId) ? (r.ParentProcessId as number) : 0,
      commandLine: typeof r.CommandLine === "string" ? r.CommandLine : "",
    });
  }
  return rows;
}

/** `ps -Ao pid=,ppid=,args=` output. */
export function parsePsTable(out: string): Map<number, ProcRow> {
  const rows = new Map<number, ProcRow>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.set(Number(m[1]), { pid: Number(m[1]), parentPid: Number(m[2]), commandLine: m[3] });
  }
  return rows;
}

/**
 * Absolute paths that may appear in a command line. Windows paths often contain spaces and are not
 * always quoted, so tokenizing on whitespace loses them: instead each drive letter (or UNC prefix)
 * starts a candidate that runs to the next quote, and `projectDirOf` trims it back from the right.
 */
export function candidatePaths(commandLine: string): string[] {
  const out: string[] = [];
  const starts = /([a-zA-Z]:[\\/])|(\\\\[^\\/"]+[\\/])|(^|\s)(\/[^\s"]+)/g;
  for (let m = starts.exec(commandLine); m; m = starts.exec(commandLine)) {
    const from = m[4] ? m.index + m[0].indexOf("/") : m.index;
    const rest = commandLine.slice(from);
    const end = rest.indexOf('"');
    const candidate = (end >= 0 ? rest.slice(0, end) : rest).trim();
    if (candidate && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * Deepest ancestor of `path` that is a nav-recorder project, as its .nav-recorder directory.
 * Trailing junk (arguments that followed an unquoted path) simply fails the existence check and is
 * trimmed away with the rest.
 */
export function projectDirOf(path: string, exists: (p: string) => boolean = existsSync): string | undefined {
  // Separators come from whatever produced the command line, so they are kept as they are rather
  // than normalized: the caller compares these strings against paths from the same source.
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]+/);
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop(); // a trailing separator is not a segment
  for (let end = parts.length; end >= 1; end--) {
    const dir = parts.slice(0, end).join(sep);
    if (!dir || /^[a-zA-Z]:$/.test(dir)) break; // empty or a bare drive root: nothing above it to test
    const dataDir = dir + sep + DATA_DIR_NAME;
    if (exists(dataDir + sep + "config.json")) return dataDir;
  }
  return undefined;
}

/** First project found in a command line, as its .nav-recorder directory. */
export function projectOfCommandLine(commandLine: string, exists?: (p: string) => boolean): string | undefined {
  for (const candidate of candidatePaths(commandLine)) {
    const found = projectDirOf(candidate, exists);
    if (found) return found;
  }
  return undefined;
}

/** Walk up the parent chain until a command line names a project. */
export function projectOfPid(
  pid: number,
  table: Map<number, ProcRow>,
  exists?: (p: string) => boolean,
): string | undefined {
  let current = pid;
  for (let hop = 0; hop <= MAX_PARENT_HOPS; hop++) {
    const row = table.get(current);
    if (!row) return undefined;
    const found = projectOfCommandLine(row.commandLine, exists);
    if (found) return found;
    if (!row.parentPid || row.parentPid === current) return undefined;
    current = row.parentPid;
  }
  return undefined;
}

// ---------- process-touching layer (everything above is pure) ----------

function run(file: string, args: string[]): string | undefined {
  try {
    return execFileSync(file, args, { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined; // no such tool, timeout, non-zero exit — the caller degrades to "unknown owner"
  }
}

export function readListeningPorts(): Map<number, number> {
  if (process.platform === "win32") {
    const out = run("netstat", ["-ano", "-p", "tcp"]);
    return out ? parseNetstat(out) : new Map();
  }
  const out = run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  return out ? parseLsof(out) : new Map();
}

export function readProcessTable(): Map<number, ProcRow> {
  if (process.platform === "win32") {
    const script =
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
    const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return out ? parseProcessTable(out) : new Map();
  }
  const out = run("ps", ["-Ao", "pid=,ppid=,args="]);
  return out ? parsePsTable(out) : new Map();
}

// ---------- caches ----------

interface OwnerEntry {
  pid: number | undefined;
  dataDir: string | undefined;
  /** when the process table was consulted for this pid */
  resolvedAt: number;
  /** when this answer was last handed out, for the grace period */
  usedAt: number;
}

/** One process-table read serves every port asked about at the same time (a scan asks about dozens). */
export const PROCESS_TABLE_TTL_MS = 5_000;
/** A port whose owner could not be told is asked again this often: the dev server may have started since. */
export const UNRESOLVED_RETRY_MS = 30_000;

let scan: { at: number; ports: Map<number, number> } | undefined;
let table: { at: number; rows: Map<number, ProcRow> } | undefined;
const owners = new Map<number, OwnerEntry>();

export function resetPortCaches(): void {
  scan = undefined;
  table = undefined;
  owners.clear();
}

function processTable(now: number, read: () => Map<number, ProcRow>): Map<number, ProcRow> {
  if (!table || now - table.at >= PROCESS_TABLE_TTL_MS) table = { at: now, rows: read() };
  return table.rows;
}

export function listeningPorts(now = Date.now(), read = readListeningPorts): Map<number, number> {
  if (!scan || now - scan.at >= PORT_SCAN_TTL_MS) scan = { at: now, ports: read() };
  return scan.ports;
}

export interface ResolveDeps {
  now?: number;
  readPorts?: () => Map<number, number>;
  readTable?: () => Map<number, ProcRow>;
  exists?: (p: string) => boolean;
}

/**
 * The project owning a loopback port, as its .nav-recorder directory, or undefined when it cannot be
 * told. Re-resolves only when the owning pid changes; keeps the last answer for a grace period after
 * the port stops listening so events from a page left open after the dev server died still land in
 * the right project.
 */
export function resolveProjectOfPort(port: number, deps: ResolveDeps = {}): string | undefined {
  const now = deps.now ?? Date.now();
  const pid = listeningPorts(now, deps.readPorts ?? readListeningPorts).get(port);
  const hit = owners.get(port);
  // A known owner stands as long as the same process holds the port. "Nobody" is only held briefly:
  // the process table may simply have been read a moment before the dev server appeared.
  if (hit && hit.pid === pid && (hit.dataDir !== undefined || now - hit.resolvedAt < UNRESOLVED_RETRY_MS)) {
    hit.usedAt = now;
    return hit.dataDir;
  }
  if (pid === undefined) {
    if (hit && now - hit.usedAt < OWNER_GRACE_MS) {
      hit.usedAt = now;
      return hit.dataDir;
    }
    owners.delete(port);
    return undefined;
  }
  const dataDir = projectOfPid(pid, processTable(now, deps.readTable ?? readProcessTable), deps.exists);
  owners.set(port, { pid, dataDir, resolvedAt: now, usedAt: now });
  return dataDir;
}

/** Everything currently listening on loopback with the project each port resolves to. */
export function portOverview(deps: ResolveDeps = {}): { port: number; pid: number; dataDir?: string }[] {
  const now = deps.now ?? Date.now();
  const ports = [...listeningPorts(now, deps.readPorts ?? readListeningPorts).entries()];
  return ports
    .sort((a, b) => a[0] - b[0])
    .map(([port, pid]) => ({ port, pid, dataDir: resolveProjectOfPort(port, { ...deps, now }) }));
}
