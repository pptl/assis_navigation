import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveApiStep, resolveFaker } from "../src/execute/resolver.js";
import { jsonPathGet, jsonPointerSet } from "../src/execute/jsonpath.js";
import { expandTemplate } from "../src/execute/template.js";
import type { ApiStep } from "../src/recipe.js";

test("jsonPathGet handles dots, indexes and quoted keys", () => {
  const root = { response: { data: { id: 42, items: [{ code: "A" }, { code: "B" }], "odd key": 1 } }, status: 200 };
  assert.equal(jsonPathGet(root, "$.response.data.id"), 42);
  assert.equal(jsonPathGet(root, "$.response.data.items[1].code"), "B");
  assert.equal(jsonPathGet(root, '$.response.data["odd key"]'), 1);
  assert.equal(jsonPathGet(root, "$.status"), 200);
  assert.equal(jsonPathGet(root, "$.response.nope.deeper"), undefined);
});

test("jsonPointerSet creates intermediate containers", () => {
  const out = jsonPointerSet({ a: { keep: 1 } }, "/a/b/0/c", "x") as { a: { keep: number; b: { c: string }[] } };
  assert.equal(out.a.keep, 1);
  assert.equal(out.a.b[0].c, "x");
});

test("resolveApiStep applies fixed / faker / captured params over the body template and URL placeholders", () => {
  const step: ApiStep = {
    id: "s1", actor: "employee", kind: "api",
    call: { method: "POST", url: "applications/{applicationId}/submit" },
    bodyTemplate: { filter: { name: "recorded", dept: "R&D" }, page: 1 },
    params: {
      "/filter/name": { type: "faker", fn: "string.alphanumeric", args: [8] },
      "/filter/dept": { type: "fixed", value: "QA" },
      "/ownerId": { type: "captured", ref: "ownerId" },
      "/applicationId": { type: "captured", ref: "applicationId" },
    },
  };
  const r = resolveApiStep(step, { ownerId: 7, applicationId: 42 });
  const body = r.body as { filter: { name: string; dept: string }; page: number; ownerId: number };
  assert.equal(body.filter.name.length, 8);
  assert.equal(body.filter.dept, "QA");
  assert.equal(body.page, 1);
  assert.equal(body.ownerId, 7);
  assert.equal(r.url, "applications/42/submit");

  const again = resolveApiStep(step, { ownerId: 7, applicationId: 42 }, r);
  assert.deepEqual(again.body, r.body);
});

test("captured reference that does not exist fails loudly", () => {
  const step: ApiStep = { id: "s", actor: "a", kind: "api", call: { method: "POST", url: "x" }, params: { id: { type: "captured", ref: "missing" } } };
  assert.throws(() => resolveApiStep(step, {}), /E_CAPTURE_MISSING|captured "missing"/);
});

test("resolveFaker supports locale prefix", () => {
  const name = resolveFaker("zh_TW:person.lastName") as string;
  assert.ok(typeof name === "string" && name.length > 0);
  assert.throws(() => resolveFaker("nope.nothing"));
});

test("expandTemplate handles variables and hash functions", () => {
  const out = expandTemplate({ username: "{{username}}", password: "{{md5(password)}}", device_type: "WEB", id: "{{uuid()}}" }, { username: "alice", password: "secret" });
  assert.equal(out.username, "alice");
  assert.equal(out.password, "5ebe2294ecd0e0f08eab7690d2a6ee69");
  assert.match(out.id, /^[0-9a-f-]{36}$/);
  assert.throws(() => expandTemplate("{{nope}}", {}));
});
