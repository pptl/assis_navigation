import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavigationEvent } from "../src/types.js";
import { unroutedDir } from "../src/paths.js";
import { appendEvent, readEvents } from "../src/store/raw.js";
import { adoptPort, unroutedByPort } from "../src/store/unrouted.js";

function nav(port: number, path: string, at: string): NavigationEvent {
  const url = `http://localhost:${port}${path}`;
  return { v: 1, type: "navigation", tabId: 1, tabUrl: url, origin: `http://localhost:${port}`, ts: at, receivedAt: at, url, transition: "committed" };
}

test("staged recordings are adopted per port, keep their recording time, and are never taken twice", () => {
  const home = mkdtempSync(join(tmpdir(), "navrec-adopt-"));
  process.env.NAV_RECORDER_HOME = home;
  const dataDir = join(home, "proj", ".nav-recorder");
  mkdirSync(dataDir, { recursive: true });

  const t = (min: number): string => new Date(Date.UTC(2026, 8, 16, 9, min)).toISOString();
  appendEvent(unroutedDir(), nav(4000, "/a", t(1)), { keepReceivedAt: true });
  appendEvent(unroutedDir(), nav(5000, "/other-project", t(2)), { keepReceivedAt: true });
  appendEvent(unroutedDir(), nav(4000, "/b", t(3)), { keepReceivedAt: true });

  const waiting = unroutedByPort();
  assert.deepEqual(waiting.map((u) => [u.port, u.events]), [[4000, 2], [5000, 1]], "newest port first");

  const first = adoptPort(4000, dataDir);
  assert.equal(first.adopted, 2);
  const mine = readEvents(dataDir);
  assert.deepEqual(mine.map((e) => (e as NavigationEvent).url), ["http://localhost:4000/a", "http://localhost:4000/b"]);
  assert.deepEqual(mine.map((e) => e.seq), [1, 2], "seq is renumbered for the destination");
  assert.deepEqual(mine.map((e) => e.receivedAt), [t(1), t(3)], "but the time it was recorded is kept");

  assert.equal(adoptPort(4000, dataDir).adopted, 0, "nothing left to take");
  assert.equal(readEvents(dataDir).length, 2);
  assert.deepEqual(unroutedByPort().map((u) => u.port), [5000], "the other project's port is untouched");

  // a later recording on the same port is still adoptable
  appendEvent(unroutedDir(), nav(4000, "/c", t(9)), { keepReceivedAt: true });
  assert.equal(adoptPort(4000, dataDir).adopted, 1);
  assert.equal(readEvents(dataDir).length, 3);
  delete process.env.NAV_RECORDER_HOME;
});
