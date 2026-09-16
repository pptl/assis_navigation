import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthProvenance, extractTokens, parseSetCookieNames } from "../src/distill/layer2bAuthProvenance.js";
import type { RequestEvent } from "../src/types.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWxpY2UiLCJpYXQiOjE3MDAwMDAwMDB9.abcdefghijklmnopqrstuvwxyz012345";

function req(id: string, over: Partial<RequestEvent>): RequestEvent {
  return {
    v: 1, type: "request", requestId: id, via: "fetch", tabId: 1, tabUrl: "http://localhost:3000/", origin: "http://localhost:3000",
    ts: "2026-09-07T00:00:00Z", durationMs: 1, method: "POST", url: "https://api/x", requestHeaders: {}, requestBody: null,
    status: 200, responseHeaders: {}, responseBody: null, responseTruncated: false, ...over,
  };
}

test("extractTokens finds JWTs and long opaque tokens but not numbers", () => {
  const keys = extractTokens(`{"token":"${JWT}","id":12345678901234567890123456789012345,"s":"short"}`);
  assert.ok(keys.includes(JWT.slice(0, 32)));
  assert.ok(!keys.some((k) => /^\d+$/.test(k)));
});

test("bearer token in a later request marks the login request as its source", () => {
  const pv = new AuthProvenance();
  const login = req("login", { url: "https://api/auth/login", responseBody: `{"success":true,"data":{"token":"${JWT}"}}` });
  assert.deepEqual(pv.process(login), []);
  const search = req("search", { url: "https://api/orders/OrderSearch", requestHeaders: { authorization: `Bearer ${JWT}` } });
  assert.deepEqual(pv.process(search), ["login"]);
  const unrelated = req("other", { url: "https://api/other", requestHeaders: { authorization: "Bearer nope" } });
  assert.deepEqual(pv.process(unrelated), []);
});

test("set-cookie is tracked with high confidence, cookie first-appearance with low confidence", () => {
  const pv = new AuthProvenance();
  pv.process(req("a", { responseHeaders: { "set-cookie": "sid=abc; Path=/; HttpOnly, theme=dark; Path=/" } }));
  assert.equal(pv.state.cookies.sid.requestId, "a");
  assert.equal(pv.state.cookies.sid.confidence, "high");
  assert.deepEqual(pv.process(req("b", { requestHeaders: { cookie: "sid=abc; theme=dark" } })), ["a"]);

  pv.process(req("c", {}));
  const d = pv.process(req("d", { requestHeaders: { cookie: "sid=abc; newone=1" } }));
  assert.ok(d.includes("a"));
  assert.ok(d.includes("c"));
  assert.equal(pv.state.cookies.newone.confidence, "low");
  assert.deepEqual(parseSetCookieNames("x=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, y=2"), ["x", "y"]);
});

test("state round-trips through load/save", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "navrec-"));
  const file = join(dir, "auth-provenance.json");
  const pv = new AuthProvenance();
  pv.process(req("login", { responseBody: `{"token":"${JWT}"}` }));
  pv.save(file);
  const again = AuthProvenance.load(file);
  assert.deepEqual(again.process(req("s", { requestHeaders: { Authorization: `Bearer ${JWT}` } })), ["login"]);
});
