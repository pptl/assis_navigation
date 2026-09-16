import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeNext, executeReport, executeStart, type NextInstruction, type DonePayload } from "../src/execute/session.js";
import { withDefaults } from "../src/config.js";
import { saveRecipe } from "../src/store/recipes.js";
import { writeJsonAtomic, readJson } from "../src/util/fs.js";
import type { Recipe } from "../src/recipe.js";
import type { NavConfig } from "../src/types.js";
import { loadParamConstraints } from "../src/store/paramConstraints.js";
import { setDataSource } from "../src/store/dataSourceMap.js";

function setup(): { dataDir: string; cfg: NavConfig } {
  const dataDir = mkdtempSync(join(tmpdir(), "navrec-sess-"));
  mkdirSync(join(dataDir, "preconditions"));
  const cfg = withDefaults({
    name: "t",
    appOrigins: ["http://localhost:3000"],
    apiBases: ["https://api.example/app/"],
    auth: { kind: "bearer", header: "Authorization", tokenSource: { area: "localStorage", key: "token" } },
    login: { kind: "ui", url: "/Login", fields: { username: "#u", password: "#p" }, submit: "#go", successCheck: { urlNot: "/Login" } },
    execute: { maxConsecutiveFailures: 3 },
  });
  writeJsonAtomic(join(dataDir, "actors.json"), { actors: { employee: { username: "e", password: "pe" }, manager: { username: "m", password: "pm", contextName: "boss" } } });
  return { dataDir, cfg };
}

const recipe: Recipe = {
  name: "two-actors",
  createdAt: "2026-09-07T00:00:00Z",
  steps: [
    { id: "create", actor: "employee", kind: "api", call: { method: "POST", url: "applications/create" }, bodyTemplate: { title: "x" }, params: { "/title": { type: "fixed", value: "hello" } }, capture: { appId: "$.response.data.id" } },
    { id: "approve", actor: "manager", kind: "api", call: { method: "POST", url: "applications/{appId}/approve" }, params: { appId: { type: "captured", ref: "appId" } } },
    { id: "open-list", actor: "employee", kind: "ui", action: { type: "click", gotoUrl: "/Apps/List", selector: "text=Refresh" } },
  ],
  finalNavigation: "/Apps/List",
  finalContext: "employee",
  targetHint: { url: "/Apps/Detail?id={appId}", note: "click the row" },
};

test("full run: login per context, capture, tab switch with localStorage reseed, done payload", () => {
  const { dataDir, cfg } = setup();
  saveRecipe(dataDir, recipe);
  const start = executeStart(dataDir, cfg, "two-actors", false);
  assert.equal(start.totalSteps, 3);
  assert.deepEqual(start.contexts, ["employee", "boss"]);
  assert.equal(start.shape, "data", "enabled api steps decide the shape, whatever the file says");
  assert.equal(start.finalNavigationEntry.entry, "unknown", "nothing is known about this project's navigation yet");

  const n1 = executeNext(dataDir, cfg, start.sessionId) as NextInstruction;
  assert.equal(n1.kind, "api");
  assert.ok(n1.ensureContext, "first use of a context must log in");
  assert.equal(n1.ensureContext!.login.type, "login-ui");
  assert.equal((n1.ensureContext!.login as { credentials: { username: string } }).credentials.username, "e");
  assert.equal((n1.action as { url: string }).url, "https://api.example/app/applications/create");
  assert.deepEqual((n1.action as { body: unknown }).body, { title: "hello" });

  // re-issuing before reporting returns the same step
  const n1b = executeNext(dataDir, cfg, start.sessionId) as NextInstruction;
  assert.equal(n1b.repeat, true);
  assert.equal(n1b.stepId, "create");

  const r1 = executeReport(dataDir, cfg, start.sessionId, { status: "ok", httpStatus: 200, response: { success: true, data: { id: 42 } }, storageSnapshot: { localStorage: { token: "T-emp" }, sessionStorage: {} } });
  assert.equal(r1.next, "continue");
  assert.deepEqual((r1 as { captured: unknown }).captured, { appId: 42 });

  const n2 = executeNext(dataDir, cfg, start.sessionId) as NextInstruction;
  assert.equal(n2.contextName, "boss");
  assert.ok(n2.ensureContext, "manager context needs its own login");
  assert.equal(n2.switchTab, undefined, "no switchTab on first login of a context");
  assert.equal((n2.action as { url: string }).url, "https://api.example/app/applications/42/approve");
  executeReport(dataDir, cfg, start.sessionId, { status: "ok", httpStatus: 200, response: {}, storageSnapshot: { localStorage: { token: "T-boss" }, sessionStorage: {} } });

  const n3 = executeNext(dataDir, cfg, start.sessionId) as NextInstruction;
  assert.equal(n3.kind, "ui");
  assert.equal(n3.ensureContext, undefined, "employee already logged in");
  assert.deepEqual(n3.switchTab, { from: "boss", to: "employee", reseedLocalStorage: { token: "T-emp" }, relogin: false });
  assert.equal((n3.action as { gotoUrl: string }).gotoUrl, "http://localhost:3000/Apps/List");

  const done = executeReport(dataDir, cfg, start.sessionId, { status: "ok" }) as DonePayload;
  assert.equal(done.next, "done");
  assert.equal(done.finalNavigation, "http://localhost:3000/Apps/List");
  assert.equal(done.finalContext, "employee");
  assert.equal(done.targetHint?.url, "/Apps/Detail?id=42");
  assert.equal(done.shape, "data");
  // Handover needs to know whether the last page may be opened by URL; here nothing is recorded for
  // it, so it falls through to the site default.
  assert.deepEqual({ entry: done.finalNavigationEntry.entry, from: done.finalNavigationEntry.from }, { entry: "unknown", from: "site-default" });
  assert.ok(!existsSync(join(dataDir, "sessions", `${start.sessionId}.json`)), "session file removed on done");
});

test("handover carries how the last page must be entered: route override beats the site default", () => {
  const { dataDir, cfg } = setup();
  const navigationOnly: Recipe = {
    name: "nav-only", createdAt: "2026-09-10T00:00:00Z", steps: [],
    shape: "navigation-existing-data", existingDataRefs: [{ value: "APP-1", usedBy: "POST Apps/AppDetail", seenIn: "POST Apps/AppSearch" }],
    finalNavigation: "/Apps/List", finalContext: "employee", targetHint: { url: "/Apps/Detail" },
  };
  saveRecipe(dataDir, navigationOnly);
  // The site says menu; this one page was verified to work by URL, and that must win.
  const menuSite = { ...cfg, navigation: { entry: "menu" as const, evidence: "cold URL entry lands on a blank shell" } };
  setDataSource(dataDir, "/Apps/List", { verdict: "api", evidence: "verified: renders on a cold URL entry", source: "manual" }, menuSite.navigation);

  const start = executeStart(dataDir, menuSite, "nav-only", true);
  assert.equal(start.shape, "navigation-existing-data");
  assert.ok(start.warnings.some((w) => w.includes("--probe")), "probing a recipe with no api steps is pointless and should say so");
  assert.ok(start.warnings.some((w) => w.includes("APP-1")), "the assumed record is named up front, so an empty screen is not misread as a navigation failure");

  const done = executeNext(dataDir, menuSite, start.sessionId) as DonePayload;
  assert.equal(done.next, "done", "a recipe with no steps hands over immediately");
  assert.deepEqual({ entry: done.finalNavigationEntry.entry, from: done.finalNavigationEntry.from }, { entry: "deeplink", from: "route" });
  assert.deepEqual(done.existingDataRefs?.map((r) => r.value), ["APP-1"]);

  // A page with no row of its own inherits the site default instead.
  saveRecipe(dataDir, { ...navigationOnly, name: "nav-elsewhere", finalNavigation: "/Other/List" });
  const elsewhere = executeStart(dataDir, menuSite, "nav-elsewhere", false);
  assert.deepEqual({ entry: elsewhere.finalNavigationEntry.entry, from: elsewhere.finalNavigationEntry.from }, { entry: "menu", from: "site-default" });
});

test("three consecutive failures on the same API halt the session; earlier failures retry", () => {
  const { dataDir, cfg } = setup();
  saveRecipe(dataDir, recipe);
  const { sessionId } = executeStart(dataDir, cfg, "two-actors", false);
  executeNext(dataDir, cfg, sessionId);
  const r1 = executeReport(dataDir, cfg, sessionId, { status: "error", message: "500 boom" });
  assert.equal(r1.next, "continue");
  assert.equal((r1 as { retry: boolean }).retry, true);
  const again = executeNext(dataDir, cfg, sessionId) as NextInstruction;
  assert.equal(again.stepId, "create");
  assert.equal(again.attempt, 2);
  executeReport(dataDir, cfg, sessionId, { status: "error", message: "500 boom" });
  executeNext(dataDir, cfg, sessionId);
  const halt = executeReport(dataDir, cfg, sessionId, { status: "ok", httpStatus: 500, response: { error: "x" } });
  assert.equal(halt.next, "halt");
  assert.match((halt as { reason: string }).reason, /3 times/);
  assert.throws(() => executeNext(dataDir, cfg, sessionId), /halted/);
});

test("missing capture is an error, not a silent continue", () => {
  const { dataDir, cfg } = setup();
  saveRecipe(dataDir, recipe);
  const { sessionId } = executeStart(dataDir, cfg, "two-actors", false);
  executeNext(dataDir, cfg, sessionId);
  const r = executeReport(dataDir, cfg, sessionId, { status: "ok", httpStatus: 200, response: { success: false } });
  assert.equal(r.next, "continue");
  assert.equal((r as { retry: boolean }).retry, true);
  const s = readJson<{ log: { event: string; detail?: { message?: string } }[] }>(join(dataDir, "sessions", `${sessionId}.json`));
  assert.match(s.log[s.log.length - 1].detail?.message ?? "", /capture "appId"/);
});

test("probe mode replays identical values and records a duplicate signal into param-constraints", () => {
  const { dataDir, cfg } = setup();
  saveRecipe(dataDir, recipe);
  const { sessionId } = executeStart(dataDir, cfg, "two-actors", true);
  const n1 = executeNext(dataDir, cfg, sessionId) as NextInstruction;
  assert.equal(n1.probeRound, 1);
  executeReport(dataDir, cfg, sessionId, { status: "ok", httpStatus: 200, response: { data: { id: 1 } }, storageSnapshot: { localStorage: {}, sessionStorage: {} } });
  const n1r2 = executeNext(dataDir, cfg, sessionId) as NextInstruction;
  assert.equal(n1r2.probeRound, 2);
  assert.equal(n1r2.stepId, "create");
  assert.deepEqual((n1r2.action as { body: unknown }).body, (n1.action as { body: unknown }).body);
  const r2 = executeReport(dataDir, cfg, sessionId, { status: "error", message: "409 Conflict: title already exists" });
  assert.equal(r2.next, "continue");
  assert.equal((r2 as { stepIndex: number }).stepIndex, 1, "round-2 failure does not retry, moves on");
  const pc = loadParamConstraints(dataDir);
  assert.equal(pc.entries["POST applications/create"]["/title"].unique, true);
  assert.equal(pc.entries["POST applications/create"]["/title"].source, "runtime-probe");
  assert.ok(existsSync(join(dataDir, "param-constraints.md")));

  // step 2 has only captured params → not probed
  const n2 = executeNext(dataDir, cfg, sessionId) as NextInstruction;
  assert.equal(n2.stepId, "approve");
  executeReport(dataDir, cfg, sessionId, { status: "ok", httpStatus: 200, response: {}, storageSnapshot: { localStorage: {}, sessionStorage: {} } });
  const n3 = executeNext(dataDir, cfg, sessionId) as NextInstruction;
  assert.equal(n3.stepId, "open-list");
  const done = executeReport(dataDir, cfg, sessionId, { status: "ok" }) as DonePayload;
  assert.equal(done.next, "done");
  assert.equal(done.probeReport?.length, 1);
  assert.equal(done.probeReport?.[0].round2?.duplicateSignal, true);
});
