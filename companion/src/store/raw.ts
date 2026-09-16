import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RecorderEvent, RequestEvent } from "../types.js";
import { p } from "../paths.js";
import { appendLine, ensureDir, readJson, writeJsonAtomic } from "../util/fs.js";
import { loadClaimState } from "./claimState.js";

interface RawMeta {
  lastSeq: number;
  lastReceivedAt: string | null;
}

/**
 * Response bodies at least this long are stored once per event file, in a `.bodies.ndjson` sidecar,
 * and the event line carries `responseBodyRef` (sha1) instead. Screens that mount the same list per
 * row repeat byte-identical bodies hundreds of times a minute (measured on a real project: 99% of a
 * day's body bytes). Every call still has its own line, seq and timestamps — only the text moves.
 * Shorter bodies stay inline: the reference would be longer than they are.
 */
export const MIN_EXTERNAL_BODY = 512;

const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.ndjson$/;

export function rawDir(dataDir: string): string {
  return p(dataDir, "raw");
}

export function claimsDir(dataDir: string): string {
  return join(rawDir(dataDir), "claims");
}

function metaPath(dataDir: string): string {
  return join(rawDir(dataDir), "meta.json");
}

export function readMeta(dataDir: string): RawMeta {
  return readJson<RawMeta>(metaPath(dataDir), { lastSeq: 0, lastReceivedAt: null });
}

function localDateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** `2026-09-11.ndjson` → `2026-09-11.bodies.ndjson` (same for claim files). */
export function bodiesPathOf(eventFile: string): string {
  return `${eventFile.replace(/\.ndjson$/, "")}.bodies.ndjson`;
}

interface BodyLine { h: string; b: string }

function loadBodies(sidecar: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(sidecar)) return out;
  for (const line of readFileSync(sidecar, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const { h, b } = JSON.parse(line) as BodyLine;
      if (typeof h === "string" && typeof b === "string" && !out.has(h)) out.set(h, b);
    } catch { /* torn line */ }
  }
  return out;
}

function needsExternal(ev: RecorderEvent): boolean {
  return ev.type === "request" && typeof ev.responseBody === "string" && ev.responseBody.length >= MIN_EXTERNAL_BODY;
}

/** Replace a long response body by its hash; `store` receives the sidecar line for hashes not yet in `known`. */
function externalize(ev: RecorderEvent, known: Set<string>, store: (line: string) => void): RecorderEvent {
  if (ev.type !== "request" || typeof ev.responseBody !== "string" || ev.responseBody.length < MIN_EXTERNAL_BODY) return ev;
  const h = createHash("sha1").update(ev.responseBody).digest("hex");
  if (!known.has(h)) {
    store(JSON.stringify({ h, b: ev.responseBody } satisfies BodyLine));
    known.add(h);
  }
  return { ...ev, responseBody: null, responseBodyRef: h };
}

/** Hashes already in a sidecar. Cached because the host appends for hours; dropped when the file vanished underneath. */
const knownBodies = new Map<string, Set<string>>();

function knownIn(sidecar: string): Set<string> {
  let known = knownBodies.get(sidecar);
  if (known && known.size > 0 && !existsSync(sidecar)) known = undefined;
  if (!known) {
    known = new Set(loadBodies(sidecar).keys());
    knownBodies.set(sidecar, known);
  }
  return known;
}

/** Append one event to today's NDJSON file, assigning seq/receivedAt. Returns the enriched event (body inline). */
export function appendEvent(dataDir: string, ev: RecorderEvent): RecorderEvent {
  ensureDir(rawDir(dataDir));
  const meta = readMeta(dataDir);
  const now = new Date();
  const seq = meta.lastSeq + 1;
  const receivedAt = now.toISOString();
  const enriched: RecorderEvent = { ...ev, seq, receivedAt };
  const file = join(rawDir(dataDir), `${localDateStamp(now)}.ndjson`);
  const sidecar = bodiesPathOf(file);
  // Body before event: a crash in between leaves an unreferenced body, never a dangling reference.
  const stored = externalize(enriched, knownIn(sidecar), (line) => appendLine(sidecar, line));
  appendLine(file, JSON.stringify(stored));
  writeJsonAtomic(metaPath(dataDir), { lastSeq: seq, lastReceivedAt: receivedAt } satisfies RawMeta);
  return enriched;
}

export function listRawFiles(dataDir: string): string[] {
  const dir = rawDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => DAY_FILE.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** Read one event file — a day file or a claim — restoring externalized bodies from its sidecar. */
export function readEventFile(file: string, keep: (ev: RecorderEvent) => boolean = () => true): RecorderEvent[] {
  const out: RecorderEvent[] = [];
  let bodies: Map<string, string> | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: RecorderEvent;
    try { ev = JSON.parse(line) as RecorderEvent; } catch { continue; }
    if (!keep(ev)) continue;
    if (ev.type === "request" && ev.responseBodyRef && ev.responseBody == null) {
      bodies ??= loadBodies(bodiesPathOf(file));
      const body = bodies.get(ev.responseBodyRef);
      if (body !== undefined) ev.responseBody = body;
      else ev.bodyError ??= `stored body ${ev.responseBodyRef} is missing from ${basename(bodiesPathOf(file))}`;
    }
    out.push(ev);
  }
  return out;
}

/** Write a self-contained event file and its sidecar (used for claims): temp files renamed into place, sidecar first. */
export function writeEventFile(file: string, events: RecorderEvent[]): void {
  const sidecar = bodiesPathOf(file);
  const known = new Set<string>();
  const bodyLines: string[] = [];
  const lines = events.map((ev) => JSON.stringify(externalize(ev, known, (line) => bodyLines.push(line))));
  ensureDir(dirname(file));
  const tmpBodies = `${sidecar}.${process.pid}.tmp`;
  const tmpEvents = `${file}.${process.pid}.tmp`;
  writeFileSync(tmpBodies, bodyLines.map((l) => `${l}\n`).join(""), "utf8");
  writeFileSync(tmpEvents, lines.map((l) => `${l}\n`).join(""), "utf8");
  renameSync(tmpBodies, sidecar);
  renameSync(tmpEvents, file);
}

export interface ReadRange {
  /** inclusive, compared against receivedAt */
  from?: string;
  /** inclusive */
  to?: string;
  /** exclusive: only events with seq > afterSeq */
  afterSeq?: number;
}

export function readEvents(dataDir: string, range: ReadRange = {}): RecorderEvent[] {
  const inRange = (ev: RecorderEvent): boolean => {
    const at = ev.receivedAt ?? ev.ts;
    if (range.from && at < range.from) return false;
    if (range.to && at > range.to) return false;
    if (range.afterSeq !== undefined && (ev.seq ?? 0) <= range.afterSeq) return false;
    return true;
  };
  const out = listRawFiles(dataDir).flatMap((file) => readEventFile(file, inRange));
  out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return out;
}

/** seq of the last line of an event file; 0 when empty, MAX_SAFE_INTEGER when unreadable (treated as unclaimed). */
function lastSeqOfFile(file: string): number {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return 0;
    const len = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const seq = (JSON.parse(lines[i]) as RecorderEvent).seq;
        if (typeof seq === "number") return seq;
      } catch { /* partial first line of the tail window */ }
    }
    return lines.length ? Number.MAX_SAFE_INTEGER : 0;
  } finally {
    closeSync(fd);
  }
}

export interface RetentionPolicy {
  /** a day file is kept until this many hours after its day ends… */
  bufferHours: number;
  /** …and, while it still holds events no claim has covered, until this many days after its day ends */
  unclaimedKeepDays: number;
}

/**
 * Rolling buffer, whole-day granularity. A day file goes (with its body sidecar) once its day plus
 * `bufferHours` is over and every event in it has been claimed or discarded. A recording nobody
 * claimed waits longer, up to `unclaimedKeepDays` — the Agent that should have claimed it may simply
 * not have run yet — but not forever.
 */
export function pruneRaw(dataDir: string, policy: RetentionPolicy, now = new Date()): string[] {
  const claimedThrough = loadClaimState(dataDir).lastSeq;
  const removed: string[] = [];
  for (const file of listRawFiles(dataDir)) {
    const m = DAY_FILE.exec(basename(file));
    if (!m) continue;
    const dayEnd = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime();
    if (dayEnd + policy.bufferHours * 3600_000 >= now.getTime()) continue;
    const claimed = lastSeqOfFile(file) <= claimedThrough;
    if (!claimed && dayEnd + policy.unclaimedKeepDays * 86_400_000 >= now.getTime()) continue;
    const sidecar = bodiesPathOf(file);
    try {
      unlinkSync(file);
      removed.push(file);
      if (existsSync(sidecar)) unlinkSync(sidecar);
      knownBodies.delete(sidecar);
    } catch { /* locked or already gone: the next run retries */ }
  }
  return removed;
}

function sameEvent(a: RecorderEvent, b: RecorderEvent): boolean {
  const strip = (ev: RecorderEvent): string => {
    const { responseBodyRef: _ref, ...rest } = ev as RequestEvent;
    return JSON.stringify(rest);
  };
  return strip(a) === strip(b);
}

/**
 * Claims written before bodies were externalized carry every body inline (one reached 17 MB).
 * Rewrite each in the sidecar format — but only after reading the result back and finding it
 * identical event for event; otherwise the original stays untouched. The sidecar (empty when no
 * body was long enough) marks a file as done.
 */
export function compactLegacyClaims(dataDir: string): string[] {
  const dir = claimsDir(dataDir);
  if (!existsSync(dir)) return [];
  const compacted: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ndjson") || name.endsWith(".bodies.ndjson")) continue;
    const file = join(dir, name);
    const sidecar = bodiesPathOf(file);
    if (existsSync(sidecar)) continue;
    const original = readEventFile(file);
    if (!original.some(needsExternal)) {
      writeFileSync(sidecar, "", "utf8");
      continue;
    }
    const work = join(dir, `.compact-${process.pid}`);
    const tmp = join(work, name);
    try {
      writeEventFile(tmp, original);
      const back = readEventFile(tmp);
      if (back.length !== original.length || !back.every((ev, i) => sameEvent(ev, original[i]))) continue;
      renameSync(bodiesPathOf(tmp), sidecar);
      renameSync(tmp, file);
      compacted.push(file);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return compacted;
}

export interface RawMaintenance {
  removed: string[];
  compacted: string[];
}

/** Everything that keeps raw/ bounded; run by the CLI commands that read or claim recordings. */
export function maintainRaw(dataDir: string, policy: RetentionPolicy, now = new Date()): RawMaintenance {
  return { removed: pruneRaw(dataDir, policy, now), compacted: compactLegacyClaims(dataDir) };
}

export function rawStats(dataDir: string): { files: number; bytes: number; bodyBytes: number; lastSeq: number; lastReceivedAt: string | null } {
  const files = listRawFiles(dataDir);
  const size = (f: string): number => (existsSync(f) ? statSync(f).size : 0);
  const bytes = files.reduce((n, f) => n + size(f), 0);
  const bodyBytes = files.reduce((n, f) => n + size(bodiesPathOf(f)), 0);
  const meta = readMeta(dataDir);
  return { files: files.length, bytes, bodyBytes, lastSeq: meta.lastSeq, lastReceivedAt: meta.lastReceivedAt };
}
