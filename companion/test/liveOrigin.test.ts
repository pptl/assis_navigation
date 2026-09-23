import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavConfig, NavigationEvent } from "../src/types.js";
import { withDefaults } from "../src/config.js";
import { CliError } from "../src/errors.js";
import { liveOriginOf } from "../src/execute/urls.js";
import { appendEvent } from "../src/store/raw.js";
import { writeJsonAtomic } from "../src/util/fs.js";
import { resetPortCaches, type ProcRow } from "../src/util/ports.js";

function project(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "navrec-live-")), "app", ".nav-recorder");
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, "config.json"), { name: "app" }); // what marks a directory as a project
  return dir;
}

function deps(dataDir: string, ports: [number, number][]) {
  const table = new Map<number, ProcRow>(ports.map(([, pid]) => [pid, { pid, parentPid: 0, commandLine: `"${dataDir.replace(/\.nav-recorder$/, "")}server.js"` }]));
  return { readPorts: () => new Map(ports), readTable: () => table, now: Date.now() };
}

const cfg = (over: Partial<NavConfig> = {}): NavConfig => withDefaults({ appOrigins: ["http://localhost:3000"], ...over });

test("the live origin is the port this project is actually served from, not the configured one", () => {
  resetPortCaches();
  const dataDir = project();
  assert.equal(liveOriginOf(dataDir, cfg(), deps(dataDir, [[5183, 42]])), "http://localhost:5183");
});

test("a non-loopback origin is used as configured — a remote test site does not move", () => {
  resetPortCaches();
  const dataDir = project();
  const remote = cfg({ appOrigins: ["https://test.example.com"] });
  assert.equal(liveOriginOf(dataDir, remote, deps(dataDir, [])), "https://test.example.com");
});

test("two ports of this project: the one the recording used most recently wins", () => {
  resetPortCaches();
  const dataDir = project();
  const at = new Date().toISOString();
  const url = "http://localhost:3002/orders";
  appendEvent(dataDir, { v: 1, type: "navigation", tabId: 1, tabUrl: url, origin: "http://localhost:3002", ts: at, url, transition: "committed" } as NavigationEvent);
  assert.equal(liveOriginOf(dataDir, cfg(), deps(dataDir, [[3001, 11], [3002, 12]])), "http://localhost:3002");
});

test("nothing serving this project is an error, never a guess at a dead port", () => {
  resetPortCaches();
  const dataDir = project();
  const other = project(); // a real project, just not this one
  let err: CliError | undefined;
  try { liveOriginOf(dataDir, cfg(), deps(other, [[4200, 99]])); } catch (e) { err = e as CliError; }
  assert.equal(err?.code, "E_NO_DEV_SERVER");
  assert.deepEqual((err?.details as { listening: unknown[] }).listening, [{ port: 4200, pid: 99, project: other }]);
  resetPortCaches();
});
