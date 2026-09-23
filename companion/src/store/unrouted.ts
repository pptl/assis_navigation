// The staging area for loopback recordings whose project could not be told.
//
// Same on-disk shape as a project's raw/ (so store/raw.ts reads it unchanged), plus one file:
// adopted.json remembers how far each port has been adopted, so a port can be claimed repeatedly
// without duplicating what was already taken. Staged day files are never rewritten — they age out.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RecorderEvent } from "../types.js";
import { unroutedDir } from "../paths.js";
import { readJson, writeJsonAtomic } from "../util/fs.js";
import { loopbackPortOf } from "../util/ports.js";
import { appendEvent, rawDir, readEvents } from "./raw.js";

export interface UnroutedPort {
  port: number;
  origins: string[];
  events: number;
  firstAt: string | null;
  lastAt: string | null;
  adoptedThrough: number;
}

function adoptedPath(): string {
  return join(unroutedDir(), "adopted.json");
}

export function loadAdopted(): Record<string, number> {
  return readJson<Record<string, number>>(adoptedPath(), {});
}

export function hasStagedEvents(): boolean {
  return existsSync(rawDir(unroutedDir()));
}

function stagedEvents(): RecorderEvent[] {
  return hasStagedEvents() ? readEvents(unroutedDir()) : [];
}

/** What is waiting in the staging area, newest port first — only what nobody has adopted yet. */
export function unroutedByPort(): UnroutedPort[] {
  const adopted = loadAdopted();
  const byPort = new Map<number, UnroutedPort>();
  for (const ev of stagedEvents()) {
    const port = ev.origin ? loopbackPortOf(ev.origin) : undefined;
    if (port === undefined) continue;
    const through = adopted[String(port)] ?? 0;
    if ((ev.seq ?? 0) <= through) continue;
    const at = ev.receivedAt ?? ev.ts;
    const entry = byPort.get(port) ?? { port, origins: [], events: 0, firstAt: at, lastAt: at, adoptedThrough: through };
    entry.events++;
    if (ev.origin && !entry.origins.includes(ev.origin)) entry.origins.push(ev.origin);
    if (at && (!entry.firstAt || at < entry.firstAt)) entry.firstAt = at;
    if (at && (!entry.lastAt || at > entry.lastAt)) entry.lastAt = at;
    byPort.set(port, entry);
  }
  return [...byPort.values()].sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
}

export interface AdoptResult {
  port: number;
  adopted: number;
  firstAt: string | null;
  lastAt: string | null;
  adoptedThrough: number;
}

/** Move a port's staged events into a project, keeping the time they were recorded. */
export function adoptPort(port: number, dataDir: string): AdoptResult {
  const adopted = loadAdopted();
  const through = adopted[String(port)] ?? 0;
  const mine = stagedEvents().filter((ev) => {
    if ((ev.seq ?? 0) <= through) return false;
    return ev.origin !== undefined && loopbackPortOf(ev.origin) === port;
  });
  let last = through;
  for (const ev of mine) {
    appendEvent(dataDir, ev, { keepReceivedAt: true });
    last = Math.max(last, ev.seq ?? 0);
  }
  if (mine.length) {
    adopted[String(port)] = last;
    writeJsonAtomic(adoptedPath(), adopted);
  }
  return {
    port,
    adopted: mine.length,
    firstAt: mine[0]?.receivedAt ?? mine[0]?.ts ?? null,
    lastAt: mine[mine.length - 1]?.receivedAt ?? mine[mine.length - 1]?.ts ?? null,
    adoptedThrough: last,
  };
}
