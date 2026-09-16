import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyShape, type ShapeInput } from "../src/distill/shape.js";
import type { NavigationEvent, RecorderEvent, RequestEvent } from "../src/types.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWxpY2UiLCJpYXQiOjE3MDAwMDAwMDB9.abcdefghijklmnopqrstuvwxyz012345";

let seq = 0;
function req(over: Partial<RequestEvent> & { url: string }): RequestEvent {
  seq++;
  return {
    v: 1, type: "request", requestId: `r${seq}`, seq, via: "fetch", tabId: 1, tabUrl: "http://localhost:3000/x",
    origin: "http://localhost:3000", ts: new Date(1700000000000 + seq * 1000).toISOString(), durationMs: 10,
    method: "POST", requestHeaders: {}, requestBody: null, status: 200, responseHeaders: {},
    responseBody: '{"success":true}', responseTruncated: false, ...over,
  };
}
function nav(path: string): NavigationEvent {
  seq++;
  const url = `http://localhost:3000${path}`;
  return { v: 1, type: "navigation", seq, tabId: 1, tabUrl: url, origin: "http://localhost:3000", ts: new Date(1700000000000 + seq * 1000).toISOString(), url, transition: "history" };
}

/** Everything classifyShape needs, derived from a flat event list the way capture.ts derives it. */
function inputFor(events: RecorderEvent[], targetPath: string, over: Partial<ShapeInput> = {}): ShapeInput {
  const navs = events.filter((e): e is NavigationEvent => e.type === "navigation");
  const anchor = [...navs].reverse().find((n) => new URL(n.url).pathname.toLowerCase() === targetPath.toLowerCase())!;
  const previousPage = [...navs].reverse().find((n) => (n.seq ?? 0) < (anchor.seq ?? 0) && new URL(n.url).pathname.toLowerCase() !== targetPath.toLowerCase());
  const targetWindowReads = events.filter((e): e is RequestEvent => e.type === "request" && (e.seq ?? 0) > (anchor.seq ?? 0));
  return {
    events, kept: [], anchor, targetUrl: targetPath, previousPage, targetWindowReads,
    show: (r) => `${r.method} ${new URL(r.url).pathname.replace(/^\/app\//, "")}`,
    ...over,
  };
}

function login(): RequestEvent {
  return req({
    requestId: "login", url: "https://api.example/app/auth/login",
    requestBody: '{"username":"emp01","password":"md5hash"}',
    responseBody: `{"success":true,"data":{"token":"${JWT}","user_id":"USER-7781","company":"COMPANY-A"}}`,
  });
}

test("kept requests make it a data recipe whatever the page asked for", () => {
  seq = 0;
  const events = [nav("/Apps/List"), nav("/Apps/Detail"), req({ url: "https://api.example/app/Apps/AppDetail", requestBody: '{"app_id":"APP-000123"}' })];
  const created = req({ url: "https://api.example/app/Apps/AppCreate", responseBody: '{"data":{"id":"APP-000123"}}' });
  const res = classifyShape(inputFor(events, "/Apps/Detail", { kept: [created] }));
  assert.equal(res.shape, "data");
  assert.deepEqual(res.existingDataRefs, []);
});

test("browsing to a screen that asks for nothing in particular is plain navigation", () => {
  seq = 0;
  const events = [
    login(),
    nav("/Index/Home"),
    nav("/Apps/List"),
    req({ url: "https://api.example/app/Apps/AppSearch", requestBody: '{"page":1,"keyword":""}', responseBody: '{"data":[]}' }),
  ];
  const res = classifyShape(inputFor(events, "/Apps/List", { authEvent: events[0] as RequestEvent }));
  assert.equal(res.shape, "navigation");
  assert.deepEqual(res.existingDataRefs, []);
});

test("a screen opened on a record the recording never created is navigation-existing-data", () => {
  seq = 0;
  const auth = login();
  const events = [
    auth,
    nav("/Apps/List"),
    req({ url: "https://api.example/app/Apps/AppSearch", requestBody: '{"page":1}', responseBody: '{"data":[{"id":"APP-000123","title":"Laptop request"}]}' }),
    nav("/Apps/Detail"),
    req({ url: "https://api.example/app/Apps/AppDetail", requestBody: '{"app_id":"APP-000123"}', responseBody: '{"data":{"id":"APP-000123"}}' }),
  ];
  const res = classifyShape(inputFor(events, "/Apps/Detail", { authEvent: auth }));
  assert.equal(res.shape, "navigation-existing-data");
  assert.deepEqual(res.existingDataRefs.map((r) => r.value), ["APP-000123"]);
  assert.match(res.existingDataRefs[0].usedBy, /AppDetail/);
  assert.match(res.existingDataRefs[0].seenIn, /AppSearch/);
});

test("values minted at login identify the user, not a record, so they do not count", () => {
  seq = 0;
  const auth = login();
  const events = [
    auth,
    nav("/Profile/List"),
    req({ url: "https://api.example/app/Profile/ProfileSearch", requestBody: '{"page":1}', responseBody: '{"data":[{"id":"USER-7781"}]}' }),
    nav("/Profile/Detail"),
    req({ url: "https://api.example/app/Profile/ProfileDetail", requestBody: '{"user_id":"USER-7781"}', responseBody: '{"data":{"id":"USER-7781"}}' }),
  ];
  const res = classifyShape(inputFor(events, "/Profile/Detail", { authEvent: auth }));
  assert.equal(res.shape, "navigation");
});

test("a value the client was already sending before the previous page is session context", () => {
  seq = 0;
  const auth = login();
  const events = [
    auth,
    nav("/Index/Home"),
    // every screen sends the branch code; it is not a record the user picked
    req({ url: "https://api.example/app/Home/HomeDashboard", requestBody: '{"branch":"BRANCH-0042"}', responseBody: '{"data":{}}' }),
    nav("/Apps/List"),
    req({ url: "https://api.example/app/Apps/AppSearch", requestBody: '{"page":1}', responseBody: '{"data":[{"branch":"BRANCH-0042"}]}' }),
    nav("/Apps/Detail"),
    req({ url: "https://api.example/app/Apps/AppDetail", requestBody: '{"branch":"BRANCH-0042"}', responseBody: '{"data":{}}' }),
  ];
  const res = classifyShape(inputFor(events, "/Apps/Detail", { authEvent: auth }));
  assert.equal(res.shape, "navigation");
});

test("an id carried in the target URL counts, but the route's own path segments do not", () => {
  seq = 0;
  const auth = login();
  const events: RecorderEvent[] = [
    auth,
    nav("/Apps/List"),
    req({ url: "https://api.example/app/Apps/AppSearch", requestBody: '{"page":1}', responseBody: '{"data":[{"id":"APP-000123"}]}' }),
    nav("/Apps/Detail?id=APP-000123"),
  ];
  const res = classifyShape(inputFor(events, "/Apps/Detail", { authEvent: auth }));
  assert.equal(res.shape, "navigation-existing-data");
  assert.deepEqual(res.existingDataRefs.map((r) => r.value), ["APP-000123"]);
  // "Apps" and "Detail" are the route itself and were never treated as data
  assert.equal(res.existingDataRefs.some((r) => /^(Apps|Detail)$/.test(r.value)), false);
});

test("a record the target asks for that no earlier response produced is not a dependency we can name", () => {
  seq = 0;
  const auth = login();
  const events = [
    auth,
    nav("/Apps/List"),
    nav("/Apps/Detail"),
    // typed in by hand, never handed over by a list
    req({ url: "https://api.example/app/Apps/AppDetail", requestBody: '{"keyword":"handtyped-value"}', responseBody: '{"data":{}}' }),
  ];
  const res = classifyShape(inputFor(events, "/Apps/Detail", { authEvent: auth }));
  assert.equal(res.shape, "navigation");
});
