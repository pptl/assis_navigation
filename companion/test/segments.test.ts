import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentEvents, segmentIndexOf, segmentWarnings } from "../src/distill/segments.js";
import type { NavigationEvent, RecorderEvent, RequestEvent } from "../src/types.js";

const T0 = Date.parse("2026-09-07T09:45:00.000Z");
let seq = 0;
function nav(path: string, over: Partial<NavigationEvent> & { minutes?: number } = {}): NavigationEvent {
  const { minutes = 0, ...rest } = over;
  seq++;
  const url = `http://localhost:3000${path}`;
  const at = new Date(T0 + minutes * 60_000 + seq * 1000).toISOString();
  return { v: 1, type: "navigation", tabId: 1, tabUrl: url, origin: "http://localhost:3000", ts: at, receivedAt: at, url, transition: "history", seq, ...rest };
}
function req(over: Partial<RequestEvent> & { minutes?: number } = {}): RequestEvent {
  const { minutes = 0, ...rest } = over;
  seq++;
  const at = new Date(T0 + minutes * 60_000 + seq * 1000).toISOString();
  return {
    v: 1, type: "request", requestId: `r${seq}`, via: "fetch", tabId: 1, tabUrl: "http://localhost:3000/x", origin: "http://localhost:3000",
    ts: at, receivedAt: at, durationMs: 5, method: "POST", url: "https://api.example/app/Foo/FooSearch", requestHeaders: {}, requestBody: null,
    status: 200, responseHeaders: {}, responseBody: "{}", responseTruncated: false, seq, ...rest,
  };
}
const opts = { gapMinutes: 20, loginPath: "/Login" };

test("single browsing session is one segment; '/' → '/Login' boot does not split", () => {
  seq = 0;
  const events: RecorderEvent[] = [nav("/", { transition: "committed" }), nav("/Login"), req(), nav("/Index/Home"), req(), nav("/Apps/List")];
  const segs = segmentEvents(events, opts);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].reason, "start");
  assert.deepEqual([segs[0].fromSeq, segs[0].toSeq], [1, 6]);
  assert.deepEqual(segs[0].navigations, ["/", "/Login", "/Index/Home", "/Apps/List"]);
  assert.equal(segs[0].requests, 2);
  assert.deepEqual(segmentWarnings(segs, 6), []);
});

test("idle gap starts a new segment", () => {
  seq = 0;
  const events: RecorderEvent[] = [nav("/Apps/List"), req(), nav("/Apps/List", { minutes: 38 }), req({ minutes: 38 })];
  const segs = segmentEvents(events, opts);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].reason, "gap");
  assert.deepEqual([segs[1].fromSeq, segs[1].toSeq], [3, 4]);
  assert.equal(segmentIndexOf(segs, 2), 0);
  assert.equal(segmentIndexOf(segs, 4), 1);
});

test("first committed navigation on a new tab starts a new segment (once it carries requests)", () => {
  seq = 0;
  const events: RecorderEvent[] = [
    nav("/Apps/List"), req(),
    nav("/", { tabId: 2, transition: "committed" }), nav("/Login", { tabId: 2 }), req({ tabId: 2 }), nav("/Index/Home", { tabId: 2 }),
  ];
  const segs = segmentEvents(events, opts);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].reason, "newTab");
  assert.deepEqual(segs[1].tabIds, [2]);
  assert.equal(segs[1].fromSeq, 3);
  // a reload of a known tab is not a boundary
  seq = 0;
  const same: RecorderEvent[] = [nav("/Apps/List", { transition: "committed" }), req(), nav("/Apps/List", { transition: "committed" }), req()];
  assert.equal(segmentEvents(same, opts).length, 1);
});

test("returning to the login page starts a new segment and is flagged as a possible role switch", () => {
  seq = 0;
  const events: RecorderEvent[] = [nav("/Login"), req(), nav("/Apps/List"), req(), nav("/Login"), req(), nav("/Approvals/List"), nav("/Approvals/Detail")];
  const segs = segmentEvents(events, opts);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].reason, "login");
  assert.equal(segs[1].fromSeq, 5);
  const w = segmentWarnings(segs, 8);
  assert.equal(w.length, 1);
  assert.match(w[0], /2 browsing sessions/);
  assert.match(w[0], /login/);
  // anchor in an earlier session → extra warning about trailing events
  const w2 = segmentWarnings(segs, 3);
  assert.equal(w2.length, 2);
  assert.match(w2[1], /session 1 of 2/);
});

test("no login path configured → login navigations never split", () => {
  seq = 0;
  const events: RecorderEvent[] = [nav("/Login"), req(), nav("/Login"), req()];
  assert.equal(segmentEvents(events, { gapMinutes: 20 }).length, 1);
});
