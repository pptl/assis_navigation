import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDefaults } from "../src/config.js";
import { appendEvent } from "../src/store/raw.js";
import { loadClaimState } from "../src/store/claimState.js";
import { loadRouteCatalogue } from "../src/store/routeCatalogue.js";
import { writeJsonAtomic } from "../src/util/fs.js";
import { routesCommand } from "../src/cli/commands/routes.js";
import { captureRecentCommand } from "../src/cli/commands/captureRecent.js";
import type { CommandContext } from "../src/cli/run.js";
import type { InteractionEvent, NavConfig, NavigationEvent, RecorderEvent, RequestEvent } from "../src/types.js";

const ORIGIN = "http://localhost:3000";

const cfg: NavConfig = withDefaults({
  name: "t",
  appOrigins: [ORIGIN],
  apiBases: ["https://api.example/app/"],
  readOnlyPatterns: ["(Search|Detail|List|Check)$"],
  auth: { kind: "cookie" },
  login: { kind: "ui", url: "/Login", fields: { username: "#u", password: "#p" }, submit: "#go" },
});

let n = 0;
function nav(path: string): NavigationEvent {
  n++;
  const url = `${ORIGIN}${path}`;
  return { v: 1, type: "navigation", tabId: 1, tabUrl: url, origin: ORIGIN, ts: new Date(1700000000000 + n * 1000).toISOString(), url, transition: "history", transitionType: "link" };
}
function click(label: string, page: string, tag = "a"): InteractionEvent {
  n++;
  return {
    v: 1, type: "interaction", kind: "click", tabId: 1, tabUrl: `${ORIGIN}${page}`, origin: ORIGIN,
    ts: new Date(1700000000000 + n * 1000).toISOString(), pageUrl: `${ORIGIN}${page}`,
    target: { tag, role: tag === "a" ? "link" : undefined, label }, selectors: [`${tag}:nth-of-type(1)`], button: 0,
  };
}
function req(url: string): RequestEvent {
  n++;
  return {
    v: 1, type: "request", requestId: `r${n}`, via: "fetch", tabId: 1, tabUrl: `${ORIGIN}/x`, origin: ORIGIN,
    ts: new Date(1700000000000 + n * 1000).toISOString(), durationMs: 5, method: "POST", url,
    requestHeaders: {}, requestBody: '{"a":1}', status: 200, responseHeaders: {}, responseBody: '{"success":true,"data":{"id":"A1"}}', responseTruncated: false,
  };
}

function setupProject(): string {
  const projectDir = mkdtempSync(join(tmpdir(), "navrec-routes-"));
  const dataDir = join(projectDir, ".nav-recorder");
  mkdirSync(join(dataDir, "preconditions"), { recursive: true });
  writeJsonAtomic(join(dataDir, "config.json"), cfg);
  writeJsonAtomic(join(dataDir, "actors.json"), { actors: { employee: { username: "e", password: "p" } } });
  n = 0;
  for (const ev of recording()) appendEvent(dataDir, ev);
  return projectDir;
}

/** Land on the dashboard, switch tab, open a screen through the menu. */
function recording(): RecorderEvent[] {
  return [
    nav("/Login"),
    nav("/Index/Home"),
    click("分頁A", "/Index/Home", "span"),
    click("訂單管理", "/Index/Home"),
    nav("/Order/DispatchFirst"),
    req("https://api.example/app/Orders/OrderCreate"),
  ];
}

function ctx(positionals: string[], flags: Record<string, string | boolean>, project: string): CommandContext {
  return {
    positionals,
    flags,
    str: (k) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined),
    bool: (k) => flags[k] === true || flags[k] === "true",
    project,
  };
}

test("capture-recent without --target-url answers with candidates and claims nothing", () => {
  const projectDir = setupProject();
  const dataDir = join(projectDir, ".nav-recorder");
  const before = loadClaimState(dataDir).lastSeq;

  const res = captureRecentCommand.handler(ctx([], {}, projectDir)) as { mode: string; routes: { route: string; enteredBy: { text?: string }[] }[]; note: string };
  assert.equal(res.mode, "candidates");
  assert.deepEqual(res.routes.map((r) => r.route), ["/Order/DispatchFirst", "/Index/Home", "/Login"]);
  assert.deepEqual(res.routes[0].enteredBy.map((c) => c.text), ["分頁A", "訂單管理"]);
  assert.match(res.note, /--target-url/);

  assert.equal(loadClaimState(dataDir).lastSeq, before, "the recording is still there for the real call");
  assert.equal(existsSync(join(dataDir, "route-catalogue.json")), false, "listing candidates writes nothing");
});

test("a claimed recording teaches the catalogue every route it visited", () => {
  const projectDir = setupProject();
  const dataDir = join(projectDir, ".nav-recorder");

  const res = captureRecentCommand.handler(ctx(["測試派單頁"], { "target-url": "/Order/DispatchFirst" }, projectDir)) as { routesLearned: string[] };
  assert.deepEqual(res.routesLearned.sort(), ["/Index/Home", "/Login", "/Order/DispatchFirst"]);

  const f = loadRouteCatalogue(dataDir);
  const order = f.entries["/Order/DispatchFirst"];
  assert.equal(order.source, "observed");
  assert.equal(order.seenInRecordings, 1);
  assert.deepEqual(order.enteredBy, ["分頁A", "訂單管理"]);
  assert.deepEqual(order.names, [], "naming the screen is the Agent's job, not the distiller's");
  assert.ok(existsSync(join(dataDir, "route-catalogue.md")));
});

test("routes set then find: what one task works out, the next task reads", () => {
  const projectDir = setupProject();
  captureRecentCommand.handler(ctx(["測試派單頁"], { "target-url": "/Order/DispatchFirst" }, projectDir));

  routesCommand.handler(ctx(["set", "/Order/DispatchFirst"], { name: "產生訂單", chain: "分頁A > 訂單管理", evidence: "側欄點進去確認過" }, projectDir));

  const found = routesCommand.handler(ctx(["find", "產生訂單"], {}, projectDir)) as { filtered: number; hits: { route: string; entry: { placements: { chain: string[] }[]; seenInRecordings: number; source: string } }[] };
  assert.equal(found.filtered, 1);
  assert.equal(found.hits[0].route, "/Order/DispatchFirst");
  assert.deepEqual(found.hits[0].entry.placements[0].chain, ["分頁A", "訂單管理"]);
  assert.equal(found.hits[0].entry.seenInRecordings, 1, "the observed visit count survives the Agent's write");
  assert.equal(found.hits[0].entry.source, "agent");

  const byTab = routesCommand.handler(ctx(["list"], { tab: "分頁A" }, projectDir)) as { filtered: number };
  assert.equal(byTab.filtered, 1);
});

test("routes recent joins the ledger with what the catalogue already knows", () => {
  const projectDir = setupProject();
  routesCommand.handler(ctx(["set", "/Order/DispatchFirst"], { name: "產生訂單", chain: "分頁A > 訂單管理" }, projectDir));

  const res = routesCommand.handler(ctx(["recent"], {}, projectDir)) as { routes: { route: string; names: string[]; known: boolean }[] };
  const order = res.routes.find((r) => r.route === "/Order/DispatchFirst")!;
  assert.deepEqual(order.names, ["產生訂單"]);
  assert.equal(order.known, true);
  assert.equal(res.routes.find((r) => r.route === "/Login")!.known, false);
});

test("routes import seeds the catalogue from a project route table", () => {
  const projectDir = setupProject();
  const file = join(projectDir, "menu.json");
  writeFileSync(file, JSON.stringify([
    { name: "Sales", children: [{ name: "sidebar", children: [{ name: "訂單管理", children: [{ name: "產生訂單", path: "/Order/DispatchFirst" }] }] }] },
  ]), "utf8");

  const dry = routesCommand.handler(ctx(["import", file], { "dry-run": true }, projectDir)) as { applied: boolean; entries: number };
  assert.equal(dry.applied, false);
  assert.equal(dry.entries, 1);
  assert.equal(existsSync(join(projectDir, ".nav-recorder", "route-catalogue.json")), false);

  const applied = routesCommand.handler(ctx(["import", file], {}, projectDir)) as { applied: boolean };
  assert.equal(applied.applied, true);
  const entry = loadRouteCatalogue(join(projectDir, ".nav-recorder")).entries["/Order/DispatchFirst"];
  assert.deepEqual(entry.names, ["產生訂單"]);
  assert.deepEqual(entry.placements[0].chain, ["Sales", "sidebar", "訂單管理"]);
  assert.equal(entry.source, "import");
});

test("import then observe: the seeded name survives the mechanical write", () => {
  const projectDir = setupProject();
  const file = join(projectDir, "menu.json");
  writeFileSync(file, JSON.stringify([{ name: "Sales", children: [{ name: "產生訂單", path: "/Order/DispatchFirst" }] }]), "utf8");
  routesCommand.handler(ctx(["import", file], {}, projectDir));

  captureRecentCommand.handler(ctx(["測試派單頁"], { "target-url": "/Order/DispatchFirst" }, projectDir));

  const entry = loadRouteCatalogue(join(projectDir, ".nav-recorder")).entries["/Order/DispatchFirst"];
  assert.deepEqual(entry.names, ["產生訂單"], "an observation never blanks a name");
  assert.equal(entry.source, "import");
  assert.equal(entry.seenInRecordings, 1);
});

test("a route stored under one casing is not duplicated by another", () => {
  const projectDir = setupProject();
  routesCommand.handler(ctx(["set", "/Order/DispatchFirst"], { name: "產生訂單" }, projectDir));
  routesCommand.handler(ctx(["set", "/order/dispatchfirst"], { name: "派單" }, projectDir));

  const f = loadRouteCatalogue(join(projectDir, ".nav-recorder"));
  assert.deepEqual(Object.keys(f.entries), ["/Order/DispatchFirst"], "the first casing wins, as with data-source-map keys");
  assert.deepEqual(f.entries["/Order/DispatchFirst"].names, ["產生訂單", "派單"]);

  const got = routesCommand.handler(ctx(["get", "/ORDER/DISPATCHFIRST"], {}, projectDir)) as { found: boolean };
  assert.equal(got.found, true);
});
