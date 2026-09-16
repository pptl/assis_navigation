import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_EXTERNAL_BODY, appendEvent, bodiesPathOf, compactLegacyClaims, pruneRaw, rawStats, readEventFile, readEvents, writeEventFile } from "../src/store/raw.js";
import { advanceClaim } from "../src/store/claimState.js";
import type { NavigationEvent, RecorderEvent, RequestEvent } from "../src/types.js";

const policy = { bufferHours: 2, unclaimedKeepDays: 7 };
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.ndjson$/;

function nav(url: string): NavigationEvent {
  return { v: 1, type: "navigation", tabId: 1, tabUrl: url, origin: new URL(url).origin, ts: new Date().toISOString(), url, transition: "history" };
}
function req(id: string, responseBody: string | null): RequestEvent {
  return {
    v: 1, type: "request", requestId: id, via: "fetch", tabId: 1, tabUrl: "http://localhost:3000/x", origin: "http://localhost:3000",
    ts: new Date().toISOString(), durationMs: 3, method: "POST", url: "https://api.example/app/Users/UserSearchAll",
    requestHeaders: {}, requestBody: null, status: 200, responseHeaders: {}, responseBody, responseTruncated: false,
  };
}
/** A list response well over MIN_EXTERNAL_BODY, like the search a screen fires once per row. */
function listBody(tag: string): string {
  return JSON.stringify({ tag, rows: Array.from({ length: 200 }, (_, i) => ({ id: `U${String(i).padStart(4, "0")}`, name: `user ${i}` })) });
}
function dayFileOf(dir: string): string {
  const name = readdirSync(join(dir, "raw")).find((f) => DAY_FILE.test(f));
  assert.ok(name, "no day file");
  return join(dir, "raw", name);
}

test("appendEvent assigns increasing seq and readEvents honours afterSeq", () => {
  const dir = mkdtempSync(join(tmpdir(), "navrec-raw-"));
  const a = appendEvent(dir, nav("http://localhost:3000/a"));
  const b = appendEvent(dir, nav("http://localhost:3000/b"));
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(readEvents(dir).length, 2);
  assert.deepEqual(readEvents(dir, { afterSeq: 1 }).map((e) => e.seq), [2]);
  assert.equal(rawStats(dir).lastSeq, 2);
});

test("identical long response bodies are stored once; every call keeps its own line, seq and body on read", () => {
  const dir = mkdtempSync(join(tmpdir(), "navrec-dedup-"));
  const body = listBody("same");
  assert.ok(body.length >= MIN_EXTERNAL_BODY);
  for (let i = 0; i < 50; i++) appendEvent(dir, req(`r${i}`, body));
  appendEvent(dir, req("other", listBody("other")));
  appendEvent(dir, req("small", '{"success":true}'));

  const events = readEvents(dir) as RequestEvent[];
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: 52 }, (_, i) => i + 1));
  assert.deepEqual(events.slice(48).map((e) => e.requestId), ["r48", "r49", "other", "small"]);
  assert.ok(events.slice(0, 50).every((e) => e.responseBody === body));
  assert.equal(events[50].responseBody, listBody("other"));
  assert.equal(events[51].responseBody, '{"success":true}');

  const file = dayFileOf(dir);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as RequestEvent);
  assert.equal(lines.length, 52, "one line per call, nothing merged");
  assert.ok(lines.slice(0, 50).every((l) => l.responseBody === null && l.responseBodyRef === lines[0].responseBodyRef));
  assert.equal(lines[51].responseBodyRef, undefined, "short bodies stay inline");
  assert.equal(readFileSync(bodiesPathOf(file), "utf8").trim().split("\n").length, 2, "two distinct long bodies");
  const stats = rawStats(dir);
  assert.ok(stats.bytes + stats.bodyBytes < (50 * body.length) / 3, `stored ${stats.bytes}+${stats.bodyBytes} bytes`);
});

test("pruneRaw: an expired day file goes with its bodies once claimed; unclaimed ones wait up to unclaimedKeepDays", () => {
  const dir = mkdtempSync(join(tmpdir(), "navrec-prune-"));
  mkdirSync(join(dir, "raw"));
  const now = new Date(2026, 8, 3, 12); // local noon on 09-03

  const day = join(dir, "raw", "2026-09-01.ndjson");
  writeFileSync(day, `${JSON.stringify({ ...nav("http://localhost:3000/a"), seq: 5 })}\n`);
  writeFileSync(bodiesPathOf(day), "");
  assert.deepEqual(pruneRaw(dir, policy, now), [], "past the buffer, but seq 5 was never claimed");
  advanceClaim(dir, { recipeName: null, fromSeq: 0, toSeq: 5, events: 5, discarded: true });
  assert.deepEqual(pruneRaw(dir, policy, now), [day]);
  assert.ok(!existsSync(day) && !existsSync(bodiesPathOf(day)));

  const stale = join(dir, "raw", "2026-08-01.ndjson");
  writeFileSync(stale, `${JSON.stringify({ ...nav("http://localhost:3000/b"), seq: 99 })}\n`);
  assert.deepEqual(pruneRaw(dir, policy, now), [stale], "unclaimed, but older than unclaimedKeepDays");

  const fresh = join(dir, "raw", "2026-09-03.ndjson");
  writeFileSync(fresh, "");
  assert.deepEqual(pruneRaw(dir, policy, now), [], "inside the buffer: kept whatever the claim says");
});

test("a claim file is self-contained: it survives its day files and their bodies being deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "navrec-claim-"));
  const body = listBody("claim");
  for (let i = 0; i < 5; i++) appendEvent(dir, req(`c${i}`, body));
  const claim = join(dir, "raw", "claims", "demo.ndjson");
  writeEventFile(claim, readEvents(dir));
  for (const f of readdirSync(join(dir, "raw"))) if (/^\d{4}-/.test(f)) rmSync(join(dir, "raw", f));

  const back = readEventFile(claim) as RequestEvent[];
  assert.deepEqual(back.map((e) => e.responseBody), Array(5).fill(body));
  assert.deepEqual(back.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(readFileSync(bodiesPathOf(claim), "utf8").trim().split("\n").length, 1);
});

test("legacy claims with inline bodies are compacted losslessly, once", () => {
  const dir = mkdtempSync(join(tmpdir(), "navrec-compact-"));
  const claims = join(dir, "raw", "claims");
  mkdirSync(claims, { recursive: true });
  const body = listBody("legacy");
  const legacy: RecorderEvent[] = Array.from({ length: 30 }, (_, i) => ({ ...req(`l${i}`, body), seq: i + 1 }));
  legacy.push({ ...nav("http://localhost:3000/z"), seq: 31 });
  const file = join(claims, "old-recipe.ndjson");
  writeFileSync(file, legacy.map((e) => `${JSON.stringify(e)}\n`).join(""));
  const small = join(claims, "tiny.ndjson");
  writeFileSync(small, `${JSON.stringify({ ...nav("http://localhost:3000/t"), seq: 1 })}\n`);
  const before = statSync(file).size;

  assert.deepEqual(compactLegacyClaims(dir), [file]);
  assert.ok(statSync(file).size + statSync(bodiesPathOf(file)).size < before / 5);
  const back = readEventFile(file).map((e) => {
    const { responseBodyRef: _ref, ...rest } = e as RequestEvent;
    return rest;
  });
  assert.deepEqual(back, legacy);
  assert.deepEqual(compactLegacyClaims(dir), [], "the sidecar marks both files as done");
  assert.deepEqual(readdirSync(claims).sort(), ["old-recipe.bodies.ndjson", "old-recipe.ndjson", "tiny.bodies.ndjson", "tiny.ndjson"]);
});
