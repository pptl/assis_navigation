import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withDefaults } from "../src/config.js";
import { makeReadOnlyClassifier } from "../src/distill/layer1ReadOnly.js";
import { reachability } from "../src/distill/layer2aReachability.js";
import { captureRecent, discardRecent, loginUsername } from "../src/distill/capture.js";
import { createOpenApiProvider } from "../src/distill/schemaEvidence/openapi.js";
import { createEfCoreProvider } from "../src/distill/schemaEvidence/efcore.js";
import { AuthProvenance } from "../src/distill/layer2bAuthProvenance.js";
import { appendEvent } from "../src/store/raw.js";
import { loadClaimState } from "../src/store/claimState.js";
import { loadRecipe } from "../src/store/recipes.js";
import { writeJsonAtomic } from "../src/util/fs.js";
import { scanSource } from "../src/store/dataSourceMap.js";
import type { NavConfig, NavigationEvent, RequestEvent, RecorderEvent } from "../src/types.js";
import type { ApiStep } from "../src/recipe.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWxpY2UiLCJpYXQiOjE3MDAwMDAwMDB9.abcdefghijklmnopqrstuvwxyz012345";

const cfg: NavConfig = withDefaults({
  name: "t",
  appOrigins: ["http://localhost:3000"],
  apiBases: ["https://api.example/app/"],
  readOnlyPatterns: ["(Search|Detail|List|Check)$", "auth/(check|logout)$"],
  auth: { kind: "bearer", header: "Authorization", tokenSource: { area: "localStorage", key: "token" } },
  login: { kind: "ui", url: "/Login", fields: { username: "#u", password: "#p" }, submit: "#go", call: { method: "POST", url: "auth/login" } },
  schemaSources: [{ kind: "openapi", glob: "swagger/*.json" }, { kind: "efcore", glob: "**/Migrations/*.cs" }],
  dataSourceRules: [
    { pattern: "useQuery\\(", verdict: "api" },
    { pattern: "useSelector\\(", requiresAlso: "dispatch\\(", verdictIfMissing: "ui" },
  ],
});

let n = 0;
function req(over: Partial<RequestEvent> & { url: string }): RequestEvent {
  n++;
  return {
    v: 1, type: "request", requestId: `r${n}`, via: "fetch", tabId: 1, tabUrl: "http://localhost:3000/x", origin: "http://localhost:3000",
    ts: new Date(1700000000000 + n * 1000).toISOString(), durationMs: 10, method: "POST", requestHeaders: { authorization: `Bearer ${JWT}` },
    requestBody: null, status: 200, responseHeaders: {}, responseBody: '{"success":true}', responseTruncated: false, ...over,
  };
}
function nav(path: string): NavigationEvent {
  n++;
  const url = `http://localhost:3000${path}`;
  return { v: 1, type: "navigation", tabId: 1, tabUrl: url, origin: "http://localhost:3000", ts: new Date(1700000000000 + n * 1000).toISOString(), url, transition: "history" };
}

/** A realistic recording: login, browse, create + submit an application, noise, land on the detail page, then wander off. */
function scenario(): RecorderEvent[] {
  n = 0;
  return [
    nav("/Login"),
    req({ requestId: "login", url: "https://api.example/app/auth/login", requestHeaders: {}, requestBody: '{"username":"e","password":"md5"}', responseBody: `{"success":true,"data":{"token":"${JWT}","user_id":"U001"}}` }),
    nav("/Index/Home"),
    req({ requestId: "check", url: "https://api.example/app/Auth/Check" }),
    nav("/Apps/List"),
    req({ requestId: "search1", url: "https://api.example/app/Apps/AppSearch", requestBody: '{"page":1,"keyword":""}', responseBody: '{"success":true,"data":[]}' }),
    req({ requestId: "noise", url: "https://api.example/app/Notes/NoteCreate", requestBody: '{"text":"unrelated note"}', responseBody: '{"success":true,"data":{"id":"NOTE-9999"}}' }),
    req({ requestId: "create", url: "https://api.example/app/Apps/AppCreate", requestBody: '{"title":"Laptop request","dept":"RD","amount":45000,"plateNo":"ABC-1234"}', responseBody: '{"success":true,"data":{"id":"APP-000123","title":"Laptop request"}}' }),
    req({ requestId: "failed", url: "https://api.example/app/Apps/AppSubmit", status: 400, requestBody: '{"app_id":"APP-000123"}', responseBody: '{"success":false,"message":"missing attachment"}' }),
    req({ requestId: "submit", url: "https://api.example/app/Apps/APP-000123/Submit", requestBody: '{"app_id":"APP-000123","comment":"please approve"}', responseBody: '{"success":true}' }),
    req({ requestId: "search2", url: "https://api.example/app/Apps/AppSearch", requestBody: '{"page":1,"keyword":"Laptop"}', responseBody: '{"success":true,"data":[{"id":"APP-000123","status":"submitted"}]}' }),
    nav("/Apps/Detail"),
    req({ requestId: "detail", url: "https://api.example/app/Apps/AppDetail", requestBody: '{"app_id":"APP-000123"}', responseBody: '{"success":true,"data":{"id":"APP-000123","status":"submitted"}}' }),
    nav("/Other/Page"),
    req({ requestId: "later", url: "https://api.example/app/Other/OtherCreate", requestBody: '{"x":"after target"}', responseBody: '{"success":true,"data":{"id":"OTH-1"}}' }),
  ];
}

function setupProject(): { dataDir: string; projectDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "navrec-distill-"));
  const dataDir = join(projectDir, ".nav-recorder");
  mkdirSync(join(dataDir, "preconditions"), { recursive: true });
  mkdirSync(join(projectDir, "swagger"), { recursive: true });
  cpSync(join(fixtures, "swagger.json"), join(projectDir, "swagger", "Apps.json"));
  cpSync(join(fixtures, "Migrations"), join(projectDir, "src", "Migrations"), { recursive: true });
  writeJsonAtomic(join(dataDir, "actors.json"), { actors: { employee: { username: "e", password: "p" }, manager: { username: "m", password: "p" } } });
  return { dataDir, projectDir };
}

test("Layer 1: GET is read-only; readOnlyPatterns are suffix-anchored and case-insensitive", () => {
  const ro = makeReadOnlyClassifier(cfg);
  const mk = (method: string, url: string) => req({ method, url });
  assert.equal(ro(mk("GET", "https://api.example/app/Anything/Whatever")), true);
  assert.equal(ro(mk("POST", "https://api.example/app/Orders/OrderImportSearch")), true);
  assert.equal(ro(mk("POST", "https://api.example/app/Orders/OrderImport")), false);
  assert.equal(ro(mk("POST", "https://api.example/app/orders/ordersearch")), true);
  assert.equal(ro(mk("POST", "https://api.example/app/Auth/Check")), true);
  assert.equal(ro(mk("POST", "https://api.example/app/Apps/AppCreate")), false);
});

test("Layer 2a: anchors on the target, seeds from the target page, keeps producers and operators, drops noise/failed/after-anchor", () => {
  const events = scenario().map((e, i) => ({ ...e, seq: i + 1 }));
  const r = reachability(events, "/Apps/Detail", makeReadOnlyClassifier(cfg));
  assert.equal(r.anchor.url, "http://localhost:3000/Apps/Detail");
  assert.equal(r.previousPage?.url, "http://localhost:3000/Apps/List");
  assert.deepEqual(r.kept.map((e) => e.requestId), ["create", "submit"]);
  // login is unreachable by value flow on purpose — Layer 2b (auth provenance) is what keeps it
  assert.deepEqual(r.droppedUnreachable.map((e) => e.requestId), ["login", "noise"]);
  assert.deepEqual(r.droppedFailed.map((e) => e.requestId), ["failed"]);
  assert.deepEqual(r.droppedAfterAnchor.map((e) => e.requestId), ["later"]);
  assert.throws(() => reachability(events, "/Never/Visited", makeReadOnlyClassifier(cfg)), /E_NO_ANCHOR|No navigation/);
});

test("schema providers: openapi yields required/enum/x-unique; efcore yields unique indexes", () => {
  const { projectDir } = setupProject();
  const oa = createOpenApiProvider(projectDir, "swagger/*.json");
  assert.equal(oa.size, 1);
  const title = oa.lookup({ method: "POST", url: "Apps/AppCreate" }, "/title");
  assert.equal(title?.required, true);
  assert.equal(title?.minLength, 1);
  const dept = oa.lookup({ method: "POST", url: "apps/appcreate" }, "/dept");
  assert.deepEqual(dept?.enum, ["RD", "QA"]);
  assert.equal(oa.lookup({ method: "POST", url: "Apps/AppCreate" }, "/plateNo")?.unique, true);
  assert.equal(oa.lookup({ method: "POST", url: "Apps/AppCreate" }, "/nope"), null);
  assert.equal(oa.lookup({ method: "POST", url: "Apps/Unknown" }, "/title"), null);

  const ef = createEfCoreProvider(projectDir, "**/Migrations/*.cs");
  assert.equal(ef.size, 1);
  assert.equal(ef.lookup({ method: "POST", url: "x" }, "/plateNo")?.unique, true);
  assert.match(ef.lookup({ method: "POST", url: "x" }, "/applicantName")?.note ?? "", /composite/);
  assert.equal(ef.lookup({ method: "POST", url: "x" }, "/title"), null);
});

test("capture-recent end to end: draft recipe with captured/url params, auth metadata, evidence, claim state; discard advances", () => {
  const { dataDir } = setupProject();
  const pv = new AuthProvenance();
  for (const ev of scenario()) {
    if (ev.type === "request") { const s = pv.process(ev); if (s.length) ev.authSources = s; }
    appendEvent(dataDir, ev);
  }
  const res = captureRecent(dataDir, cfg, { description: "送出申請單後檢視明細", targetUrl: "/Apps/Detail" });
  assert.match(res.recipeName, /^apps-detail-\d{8}$/);
  assert.ok(res.recipeFile && existsSync(res.recipeFile));
  assert.equal(res.anchor.url, "http://localhost:3000/Apps/Detail");
  assert.equal(res.finalNavigationGuess, "/Apps/List");
  assert.equal(res.evidence.authRequest?.requestId, "login");
  assert.deepEqual(res.evidence.kept.map((k) => k.requestId), ["create", "submit"]);
  assert.deepEqual(res.evidence.dropped.unreachable, ["POST Notes/NoteCreate"]);
  assert.deepEqual(res.evidence.dropped.authRefresh, []);
  assert.ok(res.evidence.dropped.readOnly >= 4);
  assert.equal(res.probeRecommended, true);

  const recipe = loadRecipe(dataDir, res.recipeName);
  assert.equal(recipe.draft, true);
  assert.deepEqual(recipe.auth, { role: "auth", call: { method: "POST", url: "auth/login" }, bodyShape: ["username", "password"] });
  const s1 = recipe.steps[0] as ApiStep;
  const s2 = recipe.steps[1] as ApiStep;
  assert.equal(s1.call.url, "Apps/AppCreate");
  assert.deepEqual(s1.params?.["/title"], { type: "fixed", value: "Laptop request" });
  assert.equal(s1.constraintEvidence?.["/title"].source, "code");
  assert.equal(s1.constraintEvidence?.["/amount"].source, "code");
  assert.match(s1.constraintEvidence?.["/dept"].note ?? "", /enum/);
  assert.equal(s1.params?.["/plateNo"].type, "faker", "x-unique in swagger → faker");
  assert.equal(s1.capture?.id, "$.response.data.id");
  assert.equal(s2.call.url, "Apps/{id}/Submit");
  assert.deepEqual(s2.urlParams, { id: { type: "captured", ref: "id" } });
  assert.deepEqual(s2.params?.["/app_id"], { type: "captured", ref: "id" });
  assert.deepEqual(s2.params?.["/comment"], { type: "fixed", value: "please approve" });
  assert.equal(s2.constraintEvidence?.["/comment"].source, "none", "Submit is not in swagger → no evidence → probe");
  assert.equal(recipe.finalNavigation, "/Apps/List");
  assert.equal(recipe.targetHint?.url, "/Apps/Detail");
  // no interactions in this recording: the path is navigations only and the hint stays a TODO
  assert.deepEqual(res.path.pages, ["/Login", "/Index/Home", "/Apps/List", "/Apps/Detail"]);
  assert.deepEqual(res.path.hops.map((h) => `${h.from}>${h.to}:${h.clicks.length}`), ["/Login>/Index/Home:0", "/Index/Home>/Apps/List:0", "/Apps/List>/Apps/Detail:0"]);
  assert.match(recipe.targetHint?.note ?? "", /^TODO/);
  assert.equal(recipe.targetHint?.clicks, undefined);
  assert.ok(recipe.pendingDecisions?.some((d) => d.kind === "confirmFinalNavigation"));
  assert.ok(recipe.pendingDecisions?.some((d) => d.kind === "actor"));
  assert.ok(existsSync(join(dataDir, "raw", "claims", `${res.recipeName}.ndjson`)));
  assert.ok(existsSync(join(dataDir, "raw", "claims", `${res.recipeName}.bodies.ndjson`)), "claims carry their own bodies");
  assert.equal(res.scope.mode, "session");
  assert.deepEqual(res.scope.excludedSegments, []);
  assert.equal(res.scope.events, 15);

  const claim = loadClaimState(dataDir);
  assert.equal(claim.lastSeq, 15);
  assert.equal(claim.history.length, 1);
  assert.equal(claim.history[0].distilledFromSeq, 1);

  assert.throws(() => captureRecent(dataDir, cfg, { description: "again", targetUrl: "/Apps/Detail" }), /E_NO_EVENTS|No recorded events/);
  appendEvent(dataDir, nav("/Apps/List"));
  const d = discardRecent(dataDir);
  assert.equal(d.discarded, 1);
  assert.equal(loadClaimState(dataDir).lastSeq, 16);
});

test("capture-recent distils only the session that reached the target, names the steps it left out; --all / --from-seq distil the whole range", () => {
  const { dataDir } = setupProject();
  const first = scenario();
  // 2nd session: new tab, fresh login, straight to the same target page
  const secondTab = (e: RecorderEvent): RecorderEvent => ({ ...e, tabId: 2 });
  const second: RecorderEvent[] = [
    secondTab({ ...nav("/"), transition: "committed" }),
    secondTab(nav("/Login")),
    secondTab(req({ requestId: "login-b", url: "https://api.example/app/auth/login", requestHeaders: {}, requestBody: '{"username":"e","password":"md5"}', responseBody: `{"success":true,"data":{"token":"${JWT}","user_id":"U001"}}` })),
    secondTab(nav("/Index/Home")),
    secondTab(nav("/Apps/List")),
    secondTab(req({ requestId: "search-b", url: "https://api.example/app/Apps/AppSearch", requestBody: '{"page":1,"keyword":"Laptop"}', responseBody: '{"success":true,"data":[{"id":"APP-000123","status":"submitted"}]}' })),
    secondTab(nav("/Apps/Detail")),
    secondTab(req({ requestId: "detail-b", url: "https://api.example/app/Apps/AppDetail", requestBody: '{"app_id":"APP-000123"}', responseBody: '{"success":true,"data":{"id":"APP-000123","status":"submitted"}}' })),
  ];
  const pv = new AuthProvenance();
  for (const ev of [...first, ...second]) {
    if (ev.type === "request") { const s = pv.process(ev); if (s.length) ev.authSources = s; }
    appendEvent(dataDir, ev);
  }
  const res = captureRecent(dataDir, cfg, { description: "x", targetUrl: "/Apps/Detail", dryRun: true });
  assert.equal(res.segments.length, 2);
  assert.equal(res.segments[1].reason, "newTab");
  assert.equal(res.segments[1].fromSeq, first.length + 1);
  assert.equal(res.anchorSegment, 1);
  assert.equal(res.warnings.filter((w) => /2 browsing sessions/.test(w)).length, 1);
  assert.equal(res.claimedRange.events, first.length + second.length, "the earlier session is still claimed");
  assert.equal(res.scope.mode, "session");
  assert.equal(res.scope.fromSeq, first.length + 1);
  assert.equal(res.scope.events, second.length);
  assert.deepEqual(res.scope.excludedSegments, [0]);
  // Session 1 created the record session 2 looks at. By default it is left out — but by name, not silently.
  assert.deepEqual(res.evidence.kept, []);
  assert.deepEqual(res.scope.excludedWouldKeep, ["POST Apps/AppCreate (seq 8)", "POST Apps/APP-000123/Submit (seq 10)"]);
  const excluded = res.pendingDecisions.find((d) => d.kind === "excludedSteps");
  assert.ok(excluded, "excludedSteps decision expected");
  assert.match(excluded.message, /--from-seq 0/);
  assert.deepEqual(excluded.options, res.scope.excludedWouldKeep);
  // Zero steps, but the detail page still asks for APP-000123, which only session 1 produced.
  // That dependency must not read as "nothing needed".
  assert.equal(res.shape, "navigation-existing-data");
  assert.deepEqual(res.existingDataRefs.map((r) => r.value), ["APP-000123"]);
  assert.match(res.existingDataRefs[0].usedBy, /AppDetail/);
  assert.match(res.existingDataRefs[0].seenIn, /AppSearch/);
  assert.equal(res.pendingDecisions.filter((d) => d.kind === "existingData").length, 1);

  for (const whole of [
    captureRecent(dataDir, cfg, { description: "x", targetUrl: "/Apps/Detail", dryRun: true, all: true }),
    captureRecent(dataDir, cfg, { description: "x", targetUrl: "/Apps/Detail", dryRun: true, fromSeq: 0 }),
  ]) {
    assert.equal(whole.scope.mode, "range");
    assert.deepEqual(whole.scope.excludedSegments, []);
    assert.deepEqual(whole.evidence.kept.map((k) => k.requestId), ["create", "submit"]);
    assert.equal(whole.shape, "data");
    assert.equal(whole.pendingDecisions.filter((d) => d.kind === "excludedSteps").length, 0);
    assert.equal(whole.warnings.filter((w) => /2 browsing sessions/.test(w)).length, 1);
  }

  const narrowed = captureRecent(dataDir, cfg, { description: "x", targetUrl: "/Apps/Detail", dryRun: true, fromSeq: res.segments[1].fromSeq - 1 });
  assert.equal(narrowed.segments.length, 1);
  assert.equal(narrowed.warnings.filter((w) => /browsing sessions/.test(w)).length, 0);
  assert.deepEqual(narrowed.evidence.kept, []);
  assert.equal(narrowed.shape, "navigation-existing-data");

  try {
    captureRecent(dataDir, cfg, { description: "x", targetUrl: "/Never/Visited", dryRun: true });
    assert.fail("expected E_NO_ANCHOR");
  } catch (e) {
    const err = e as { code?: string; details?: { segments?: unknown[]; recentNavigations?: string[] } };
    assert.equal(err.code, "E_NO_ANCHOR");
    assert.equal(err.details?.segments?.length, 2);
    assert.ok(err.details?.recentNavigations?.length);
  }
});

test("capture-recent keeps a same-tab return to the login page inside the task (role switch): nothing is left out", () => {
  const { dataDir } = setupProject();
  const events = scenario();
  // back to the login page in the same tab: the manager logs in and opens the same detail page
  events.push(
    nav("/Login"),
    req({ requestId: "login-m", url: "https://api.example/app/auth/login", requestHeaders: {}, requestBody: '{"username":"m","password":"md5"}', responseBody: `{"success":true,"data":{"token":"${JWT}"}}` }),
    nav("/Apps/List"),
    nav("/Apps/Detail"),
    req({ requestId: "detail-m", url: "https://api.example/app/Apps/AppDetail", requestBody: '{"app_id":"APP-000123"}', responseBody: '{"success":true,"data":{"id":"APP-000123"}}' }),
  );
  const pv = new AuthProvenance();
  for (const ev of events) {
    if (ev.type === "request") { const s = pv.process(ev); if (s.length) ev.authSources = s; }
    appendEvent(dataDir, ev);
  }
  const res = captureRecent(dataDir, cfg, { description: "x", targetUrl: "/Apps/Detail", dryRun: true });
  assert.equal(res.segments.length, 2);
  assert.equal(res.segments[1].reason, "login");
  assert.equal(res.anchorSegment, 1);
  assert.equal(res.scope.mode, "session");
  assert.deepEqual(res.scope.excludedSegments, []);
  assert.deepEqual(res.evidence.kept.map((k) => k.requestId), ["create", "submit"]);
});

test("capture-recent flags logins by accounts actors.json does not know (newActor)", () => {
  const { dataDir } = setupProject();
  const events = scenario();
  // a second login as an unknown account, before the anchor
  const extra = req({ requestId: "login2", url: "https://api.example/app/auth/login", requestHeaders: {}, requestBody: '{"username":"boss42","password":"md5"}', responseBody: '{"success":true,"data":{"token":"other-token-value-that-is-long-enough-000"}}' });
  events.splice(3, 0, extra);
  const pv = new AuthProvenance();
  for (const ev of events) {
    if (ev.type === "request") { const s = pv.process(ev); if (s.length) ev.authSources = s; }
    appendEvent(dataDir, ev);
  }
  const res = captureRecent(dataDir, cfg, { description: "x", targetUrl: "/Apps/Detail" });
  const na = res.pendingDecisions.find((d) => d.kind === "newActor");
  assert.ok(na, "newActor decision expected");
  assert.deepEqual(na?.options, ["boss42"]);
  assert.equal(loginUsername(extra), "boss42");
  assert.equal(loginUsername(req({ url: "x", requestBody: "account=alice&password=x" })), "alice");
});

test("data-source scan applies rules mechanically", () => {
  assert.deepEqual(scanSource(cfg, "const q = useQuery(['x'], fetchX);").map((s) => s.verdict), ["api"]);
  assert.deepEqual(scanSource(cfg, "const v = useSelector(s => s.v);").map((s) => s.verdict), ["ui"]);
  assert.deepEqual(scanSource(cfg, "const v = useSelector(s => s.v); useEffect(() => { dispatch(load()) }, [])").map((s) => s.verdict), ["api"]);
  assert.deepEqual(scanSource(cfg, "plain component"), []);
});

test("Layer 2b: an authenticated, parameterless token producer is a refresh, not a step; a context switch with parameters is kept", () => {
  // payloads must differ inside the first 32 chars of each segment: that is the provenance key length
  const JWT2 = "eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3MDAwMDAwMDEsInVzZXIiOiJhbGljZSJ9.zyxwvutsrqponmlkjihgfedcba543210";
  const JWT3 = "eyJhbGciOiJIUzI1NiJ9.eyJjbyI6IkNPTVBBTllfQSIsInVzZXIiOiJhbGljZSJ9.0123456789abcdefghijklmnopqrstuv";
  const build = (): RecorderEvent[] => {
    n = 0;
    return [
      nav("/Login"),
      req({ requestId: "login", url: "https://api.example/app/auth/login", requestHeaders: {}, requestBody: '{"username":"e","password":"md5"}', responseBody: `{"success":true,"data":{"token":"${JWT}","user_id":"U001"}}` }),
      nav("/Index/Home"),
      // rotates the token on every call (like an auth/check endpoint): authenticated, body {}, no query
      req({ requestId: "check", url: "https://api.example/app/Auth/Check", requestBody: "{}", responseBody: `{"success":true,"data":{"token":"${JWT2}","user_id":"U001"}}` }),
      // context switch: authenticated, but carries a parameter → still a real precondition step
      req({ requestId: "select", url: "https://api.example/app/Auth/SelectCompany", requestHeaders: { authorization: `Bearer ${JWT2}` }, requestBody: '{"company_code":"COMPANY_A"}', responseBody: `{"success":true,"data":{"token":"${JWT3}"}}` }),
      nav("/Apps/List"),
      req({ requestId: "create", url: "https://api.example/app/Apps/AppCreate", requestHeaders: { authorization: `Bearer ${JWT3}` }, requestBody: '{"title":"Laptop request","dept":"RD","amount":45000,"plateNo":"ABC-1234"}', responseBody: '{"success":true,"data":{"id":"APP-000123","title":"Laptop request"}}' }),
      req({ requestId: "submit", url: "https://api.example/app/Apps/APP-000123/Submit", requestHeaders: { authorization: `Bearer ${JWT3}` }, requestBody: '{"app_id":"APP-000123","comment":"please approve"}', responseBody: '{"success":true}' }),
      nav("/Apps/Detail"),
      req({ requestId: "detail", url: "https://api.example/app/Apps/AppDetail", requestHeaders: { authorization: `Bearer ${JWT3}` }, requestBody: '{"app_id":"APP-000123"}', responseBody: '{"success":true,"data":{"id":"APP-000123","status":"submitted"}}' }),
    ];
  };
  const record = (dataDir: string, events: RecorderEvent[]) => {
    const pv = new AuthProvenance();
    for (const ev of events) {
      if (ev.type === "request") { const s = pv.process(ev); if (s.length) ev.authSources = s; }
      appendEvent(dataDir, ev);
    }
  };

  {
    const { dataDir } = setupProject();
    const events = build();
    record(dataDir, events);
    const select = events.find((e): e is RequestEvent => e.type === "request" && e.requestId === "select");
    assert.deepEqual(select?.authSources, ["check"], "the check's rotated token is what SelectCompany carried");
    const res = captureRecent(dataDir, cfg, { description: "x", targetUrl: "/Apps/Detail", dryRun: true });
    assert.equal(res.evidence.authRequest?.requestId, "login");
    assert.deepEqual(res.evidence.kept.map((k) => k.requestId), ["select", "create", "submit"]);
    assert.deepEqual(res.evidence.dropped.authRefresh, ["POST Auth/Check"]);
    assert.ok(res.evidence.kept[0].reason.some((r) => /Layer 2b/.test(r)));
    assert.ok(!res.pendingDecisions.some((d) => d.kind === "duplicate"));
  }

  {
    // login.call not configured: the login is still inferred (source without Authorization), the refresh still dropped
    const { dataDir } = setupProject();
    record(dataDir, build());
    const cfgNoCall: NavConfig = { ...cfg, login: { kind: "ui", url: "/Login", fields: { username: "#u", password: "#p" }, submit: "#go" } };
    const res = captureRecent(dataDir, cfgNoCall, { description: "x", targetUrl: "/Apps/Detail", dryRun: true });
    assert.equal(res.evidence.authRequest?.requestId, "login");
    assert.deepEqual(res.evidence.kept.map((k) => k.requestId), ["select", "create", "submit"]);
    assert.deepEqual(res.evidence.dropped.authRefresh, ["POST Auth/Check"]);
  }
});
