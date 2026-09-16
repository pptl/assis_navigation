import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeWarnings, requireComplete, setAnswer, startOnboarding, statusReport } from "../src/onboarding/state.js";
import { collectEndpointStats, trailingVerb, uncoveredVerbs } from "../src/onboarding/endpointStats.js";
import { validateAnswer } from "../src/onboarding/catalogue.js";
import { writeJsonAtomic } from "../src/util/fs.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");

function project(deps: Record<string, string> = {}): string {
  const projectDir = mkdtempSync(join(tmpdir(), "navrec-guard-"));
  mkdirSync(join(projectDir, ".nav-recorder"), { recursive: true });
  writeJsonAtomic(join(projectDir, "package.json"), { name: "Demo App", dependencies: deps, envConfig: { devDomain: "https://dev.example.com" } });
  cpSync(join(fixtures, "adapters"), join(projectDir, "src", "adapters"), { recursive: true });
  return projectDir;
}

test("apiBases: answers are resolved immediately; a bare origin is warned about; a broken derivation is rejected", () => {
  const projectDir = project();
  const state = startOnboarding(projectDir);
  const bare = setAnswer(state, "apiBases", [{ derive: "json", file: "package.json", path: "envConfig.devDomain", append: "/" }], "code", "x");
  assert.deepEqual(bare.resolved, ["https://dev.example.com/"]);
  const w1 = computeWarnings(state);
  assert.ok(w1.some((w) => /bare origin/.test(w)), w1.join("\n"));

  const good = setAnswer(state, "apiBases", [{ derive: "json", file: "package.json", path: "envConfig.devDomain", append: "/app/" }], "code", "x");
  assert.deepEqual(good.resolved, ["https://dev.example.com/app/"]);
  assert.ok(!computeWarnings(state).some((w) => /bare origin/.test(w)));
  assert.equal(statusReport(state).resolvedApiBases?.[0], "https://dev.example.com/app/");

  assert.throws(() => setAnswer(state, "apiBases", [{ derive: "json", file: "package.json", path: "envConfig.nope" }], "code", "x"), /cannot be resolved|no string at/);
  assert.throws(() => setAnswer(state, "apiBases", ["https://host.example.com/api"], "code", "x"), /must end with/);
});

test("endpoint stats: histogram, hints, proposed pattern, min threshold", () => {
  const projectDir = project();
  const stats = collectEndpointStats(projectDir, "src/adapters/*.ts", 2);
  assert.equal(stats.files, 2);
  assert.equal(trailingVerb("Orders/OrderImportSearch"), "Search");
  assert.equal(trailingVerb("auth/login"), "Login");
  assert.equal(trailingVerb("MeetingRoom/MeetingRoomBookingCreateFD"), "Create", "trailing acronym stripped");
  assert.equal(trailingVerb("Work/WorkClockPlaceUpdateIP"), "Update");
  assert.equal(trailingVerb("Files/UploadHtmlPDF"), "Upload");
  assert.equal(trailingVerb("Car/CarUpdateByOtherID"), "Update", "cut at preposition, then acronym");
  assert.equal(trailingVerb("Car/CarCreateFromExcel"), "Create");
  assert.equal(trailingVerb("Orders/OrderListByUserFD"), "List");
  assert.equal(trailingVerb("Meeting/GetMRInformationAWS"), "Get", "inner acronym kept whole, trailing one dropped, known verb found earlier");
  assert.equal(trailingVerb("Meal/UpdateOne"), "Update", "qualifier suffix: fall back to the known verb before it");
  assert.equal(trailingVerb("User/UserSearchAllDealer"), "Search");
  assert.equal(trailingVerb("Orders/OrderRollup"), "Rollup", "no known verb anywhere → last token, left for the agent");
  assert.equal(trailingVerb("Order/OrderSubscribeAudit"), "Audit");
  const byVerb = Object.fromEntries(stats.verbs.map((v) => [v.verb, v.count]));
  assert.equal(byVerb.Search, 3);
  assert.equal(byVerb.Report, 3);
  assert.equal(byVerb.Statistics, 2);
  assert.equal(byVerb.Rollup, 2);
  assert.equal(byVerb.Create, 4, "OrderCreate + CustomerCreate + …CreateFD + …CreateFromExcel");
  assert.equal(byVerb.Update, 3, "OrderUpdate + …UpdateIP + …UpdateByOtherID");
  assert.equal(byVerb.List, 1);
  assert.equal(byVerb.Upload, 1);
  assert.equal(byVerb.Get, 1);
  assert.equal(byVerb.Html, undefined);
  assert.equal(byVerb.Information, undefined);
  assert.equal(byVerb.Endpoint, undefined, "https URLs are ignored");
  assert.ok(stats.verbs.every((v) => v.verb.length > 1), `no single-letter verbs: ${stats.verbs.map((v) => v.verb).join(",")}`);
  assert.equal(byVerb.Excel, undefined);
  assert.equal(byVerb.PDF, undefined);
  assert.ok(stats.suggestedReadVerbs.includes("Report") && stats.suggestedReadVerbs.includes("Statistics") && stats.suggestedReadVerbs.includes("Detail"));
  assert.ok(stats.suggestedWriteVerbs.includes("Create") && stats.suggestedWriteVerbs.includes("Update"));
  assert.ok(!stats.suggestedWriteVerbs.includes("Import"), "Import appears once → below min");
  assert.deepEqual(stats.unclassified, ["Rollup"], "unknown verbs are surfaced, not silently dropped");
  assert.match(stats.proposedPattern ?? "", /^\((.+\|)*Search(\|.+)*\)\$$/);
  assert.ok(!stats.proposedPattern?.includes("Login") && !stats.proposedPattern?.includes("Check"), "verbs seen once stay out of the proposal");
  const strict = collectEndpointStats(projectDir, "src/adapters/*.ts", 3);
  assert.deepEqual(strict.suggestedReadVerbs.sort(), ["Report", "Search"]);
});

test("readOnlyPatterns: unanchored patterns are rejected; frequent verbs left uncovered become warnings", () => {
  const projectDir = project();
  const state = startOnboarding(projectDir);
  assert.ok(validateAnswer("readOnlyPatterns", ["Search"]).some((e) => /anchored/.test(e)));
  assert.deepEqual(validateAnswer("readOnlyPatterns", ["(Search|Detail)$", "^auth/"]), []);

  state.meta = { endpointStats: collectEndpointStats(projectDir, "src/adapters/*.ts", 2) };
  setAnswer(state, "readOnlyPatterns", ["(Search|Detail)$"], "code", "top two only");
  const w = computeWarnings(state).find((x) => /does not cover/.test(x));
  assert.ok(w, "expected an uncovered-verbs warning");
  assert.match(w!, /Report\(3/);
  assert.match(w!, /Statistics\(2/);
  assert.match(w!, /Rollup\(2/);
  assert.ok(!/Create\(/.test(w!), "obvious writes are not demanded");
  assert.deepEqual(uncoveredVerbs(state.meta.endpointStats!, ["(Search|Detail|Report|Statistics|Check|Rollup)$"]), []);
  setAnswer(state, "readOnlyPatterns", ["(Search|Detail|Report|Statistics|Check|Rollup)$"], "code", "all classified");
  assert.ok(!computeWarnings(state).some((x) => /does not cover/.test(x)));
});

test("dataSourceRules: required when no preset applies; empty answer needs evidence", () => {
  const plain = startOnboarding(project());
  assert.equal(plain.fields.dataSourceRules.status, "missing");
  assert.ok(statusReport(plain).missingRequired.some((m) => m.key === "dataSourceRules"));
  assert.throws(() => setAnswer(plain, "dataSourceRules", [], "code"), /is empty/);
  setAnswer(plain, "dataSourceRules", [], "code", "pages read everything from the URL; no store hand-over");
  assert.ok(computeWarnings(plain).some((w) => /dataSourceRules is empty/.test(w)));
  setAnswer(plain, "dataSourceRules", [{ pattern: "useEffect\\([^)]*load\\(", verdict: "api" }, { pattern: "history\\.state", verdict: "ui" }], "code", "x");
  assert.ok(!computeWarnings(plain).some((w) => /dataSourceRules is empty/.test(w)));

  const withPreset = startOnboarding(project({ "@tanstack/react-query": "5" }));
  assert.equal(withPreset.fields.dataSourceRules.status, "inferred");
  assert.ok(!statusReport(withPreset).missingRequired.some((m) => m.key === "dataSourceRules"));
  assert.throws(() => requireComplete(plain), /appOrigins/);
});

test("gitignore: added at the nearest git root (possibly above the project), idempotent, and reported when there is no git root", async () => {
  const { ensureGitignore, gitignoreHas } = await import("../src/onboarding/scaffold.js");
  const { readFileSync } = await import("node:fs");
  const repo = mkdtempSync(join(tmpdir(), "navrec-git-"));
  mkdirSync(join(repo, ".git"));
  const projectDir = join(repo, "apps", "web");
  mkdirSync(projectDir, { recursive: true });
  const first = ensureGitignore(projectDir);
  assert.equal(first.status, "added");
  assert.equal(first.gitRoot, repo);
  assert.equal(first.aboveProject, true);
  assert.deepEqual(first.added, [".nav-recorder/", ".playwright-mcp/"]);
  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), ".nav-recorder/\n.playwright-mcp/\n");
  const again = ensureGitignore(projectDir);
  assert.equal(again.status, "present");
  assert.deepEqual(again.present, [".nav-recorder/", ".playwright-mcp/"]);
  assert.ok(gitignoreHas(join(repo, ".gitignore")));
  assert.ok(gitignoreHas(join(repo, ".gitignore"), ".playwright-mcp/"));
  const loose = mkdtempSync(join(tmpdir(), "navrec-nogit-"));
  const none = ensureGitignore(loose);
  assert.equal(none.status, "no-git-root");
  assert.deepEqual(none.patterns, [".nav-recorder/", ".playwright-mcp/"]);
});

test("gitignore: only the missing pattern is appended when .nav-recorder/ is already ignored (older projects)", async () => {
  const { ensureGitignore } = await import("../src/onboarding/scaffold.js");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const repo = mkdtempSync(join(tmpdir(), "navrec-git-partial-"));
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.nav-recorder\n");
  const r = ensureGitignore(repo);
  assert.equal(r.status, "added");
  assert.equal(r.aboveProject, false);
  assert.deepEqual(r.present, [".nav-recorder/"]);
  assert.deepEqual(r.added, [".playwright-mcp/"]);
  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), "node_modules/\n.nav-recorder\n.playwright-mcp/\n");
});

test("name defaults to the lowercased directory name and rejects uppercase", () => {
  const projectDir = project();
  const state = startOnboarding(projectDir);
  assert.equal(state.fields.name.value, state.fields.name.value?.toString().toLowerCase());
  assert.ok(validateAnswer("name", "MyApp").length > 0);
  assert.deepEqual(validateAnswer("name", "my-app.v2"), []);
  const named = startOnboarding(projectDir, "MyApp");
  assert.equal(named.fields.name.value, "myapp");
  assert.equal(named.fields.name.source, "user");
});
