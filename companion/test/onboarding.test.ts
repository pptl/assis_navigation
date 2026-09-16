import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOGUE, presetDataSourceRules, validateAnswer } from "../src/onboarding/catalogue.js";
import { answersFromTemplate, computeWarnings, requireComplete, setAnswer, smokeAnswers, startOnboarding, statusReport, toActors, toConfig } from "../src/onboarding/state.js";
import { buildSmokeRecipe } from "../src/onboarding/smokeRecipe.js";
import { exportTemplate } from "../src/onboarding/exportTemplate.js";
import { validateConfig } from "../src/config.js";
import { validateRecipe } from "../src/recipe.js";
import { saveRecipe } from "../src/store/recipes.js";
import { executeNext, executeStart, type NextInstruction } from "../src/execute/session.js";
import { writeJsonAtomic } from "../src/util/fs.js";
import { examplesDir } from "../src/paths.js";

function project(): { projectDir: string; dataDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "navrec-onb-"));
  const dataDir = join(projectDir, ".nav-recorder");
  mkdirSync(dataDir, { recursive: true });
  writeJsonAtomic(join(projectDir, "package.json"), { name: "demo", dependencies: { react: "18", "@tanstack/react-query": "5", "react-redux": "9" } });
  mkdirSync(join(projectDir, "api", "swagger"), { recursive: true });
  writeJsonAtomic(join(projectDir, "api", "swagger", "Orders.json"), { openapi: "3.0.1", paths: {} });
  return { projectDir, dataDir };
}

function answerRequired(state: ReturnType<typeof startOnboarding>): void {
  setAnswer(state, "appOrigins", ["http://localhost:5173"], "code", "vite.config.ts server.port");
  setAnswer(state, "apiBases", ["http://localhost:8080/api/"], "verified", "browser_network_requests");
  setAnswer(state, "auth", { kind: "bearer", header: "Authorization", tokenSource: { area: "localStorage", key: "access_token" } }, "code", "src/http.ts");
  setAnswer(state, "login", { kind: "ui", url: "/login", fields: { username: "#user", password: "#pass" }, submit: "button[type=submit]", successCheck: { urlNot: "/login" }, call: { method: "POST", url: "auth/login" } }, "verified", "snapshot of /login");
  setAnswer(state, "navigation", { entry: "deeplink", evidence: "navigated straight to /orders in a fresh session; the table rendered" }, "verified", "browser_snapshot");
  setAnswer(state, "actors", [{ role: "employee", username: "emp01" }, { role: "manager", username: "mgr01", note: "approver" }], "user", "asked");
  setAnswer(state, "smoke.landingPath", "/orders", "user", "asked");
  setAnswer(state, "smoke.verify", { text: "Orders" }, "verified", "snapshot");
}

test("startOnboarding prefills only mechanical facts and lists every required field as missing", () => {
  const { projectDir } = project();
  const state = startOnboarding(projectDir);
  const report = statusReport(state);
  assert.equal(report.complete, false);
  assert.deepEqual(report.missingRequired.map((m) => m.key), ["appOrigins", "apiBases", "auth", "login", "navigation", "actors", "smoke.landingPath", "smoke.verify"]);
  for (const m of report.missingRequired) { assert.ok(m.hint.length > 10, m.key); assert.ok(m.question, m.key); }
  assert.equal(state.fields.dataSourceRules.status, "inferred");
  assert.ok((state.fields.dataSourceRules.value as unknown[]).length >= 2, "query + redux presets");
  assert.deepEqual(state.fields.schemaSources.value, [{ kind: "openapi", glob: "api/swagger/*.json" }]);
  assert.equal(state.fields.name.value, projectDir.split(/[\\/]/).pop()!.toLowerCase().replace(/[^a-z0-9._-]/g, "-"));
});

test("navigation is a required, observed answer that reaches config.navigation", () => {
  const { projectDir } = project();
  const state = startOnboarding(projectDir);
  assert.equal(state.fields.navigation.status, "missing", "it cannot be guessed from package.json");

  // A bare string would spread into the defaults and silently keep entry: "unknown".
  assert.ok(validateAnswer("navigation", "menu").length > 0);
  assert.ok(validateAnswer("navigation", null).length > 0);
  assert.ok(validateAnswer("navigation", { entry: "spa" }).length > 0);
  assert.deepEqual(validateAnswer("navigation", { entry: "menu", evidence: "blank main area on a cold URL entry" }), []);

  answerRequired(state);
  assert.equal(toConfig(state).navigation.entry, "deeplink");

  setAnswer(state, "navigation", { entry: "unknown" }, "user", "user was not sure");
  assert.ok(computeWarnings(state).some((w) => w.includes('navigation.entry is "unknown"')));
  setAnswer(state, "navigation", { entry: "deeplink" }, "code", "guessed from the router file");
  assert.ok(computeWarnings(state).some((w) => w.includes("runtime behaviour")), "answering it from code is worth flagging");
});

test("validateAnswer rejects bad values field by field", () => {
  assert.ok(validateAnswer("appOrigins", ["localhost:3000/"]).length > 0);
  assert.ok(validateAnswer("apiBases", ["http://x/api"]).length > 0);
  assert.ok(validateAnswer("readOnlyPatterns", ["("]).length > 0);
  assert.ok(validateAnswer("auth", { kind: "bearer" }).length > 0);
  assert.ok(validateAnswer("login", { kind: "ui", url: "/login" }).length > 0);
  assert.ok(validateAnswer("actors", []).length > 0);
  assert.ok(validateAnswer("actors", [{ role: "a b", username: "" }]).length > 0);
  assert.ok(validateAnswer("smoke.landingPath", "orders").length > 0);
  assert.ok(validateAnswer("smoke.verify", {}).length > 0);
  assert.deepEqual(validateAnswer("smoke.verify", "table"), []);
  assert.ok(validateAnswer("nope", 1)[0].includes("Unknown field"));
});

test("finalize is blocked with the list of questions until required fields are answered", () => {
  const { projectDir } = project();
  const state = startOnboarding(projectDir);
  assert.throws(() => requireComplete(state), (e: { code: string; details: { key: string; question?: string }[] }) => e.code === "E_ONBOARDING_INCOMPLETE" && e.details.some((d) => d.key === "actors" && !!d.question));
  answerRequired(state);
  requireComplete(state);
});

test("answers produce a valid config, placeholder passwords, and a runnable login-ready recipe", () => {
  const { projectDir, dataDir } = project();
  const state = startOnboarding(projectDir);
  answerRequired(state);
  setAnswer(state, "readOnlyPatterns", ["(Search|List)$"], "user", "asked");

  const cfg = toConfig(state);
  assert.deepEqual(validateConfig(cfg), []);
  assert.deepEqual(cfg.appOrigins, ["http://localhost:5173"]);
  assert.equal(cfg.auth.tokenSource?.key, "access_token");
  assert.equal(cfg.login.kind, "ui");

  const actors = toActors(state, { actors: { employee: { username: "emp01", password: "real-secret" } } });
  assert.equal(actors.actors.employee.password, "real-secret", "existing password is kept");
  assert.equal(actors.actors.manager.password, "CHANGE_ME");
  assert.equal(actors.actors.manager.contextName, "manager");

  const recipe = buildSmokeRecipe(state);
  assert.deepEqual(validateRecipe(recipe), []);
  assert.equal(recipe.name, "login-ready");
  assert.equal(recipe.draft, false);
  assert.equal(recipe.finalNavigation, "/orders");
  mkdirSync(join(dataDir, "preconditions"), { recursive: true });
  saveRecipe(dataDir, recipe);
  writeJsonAtomic(join(dataDir, "actors.json"), actors);
  const { sessionId } = executeStart(dataDir, cfg, "login-ready", false);
  const n1 = executeNext(dataDir, cfg, sessionId) as NextInstruction;
  assert.equal(n1.ensureContext?.login.type, "login-ui");
  assert.equal((n1.ensureContext?.login as { url: string }).url, "http://localhost:5173/login");
  assert.equal((n1.action as { url: string }).url, "http://localhost:5173/orders");
});

test("exportTemplate scrubs passwords and the exported template re-onboards another project", () => {
  const { projectDir, dataDir } = project();
  const state = startOnboarding(projectDir, "demo-app");
  answerRequired(state);
  const cfg = toConfig(state);
  const actors = toActors(state, { actors: { employee: { username: "emp01", password: "real-secret" } } });
  mkdirSync(join(dataDir, "preconditions"), { recursive: true });
  saveRecipe(dataDir, buildSmokeRecipe(state));

  const name = `zz-test-${Date.now()}`;
  const res = exportTemplate(dataDir, cfg, actors, name);
  try {
    assert.ok(res.files.some((f) => f.endsWith("config.json")));
    assert.ok(res.files.some((f) => f.endsWith("login-ready.json")));
    const exportedActors = JSON.parse(readFileSync(join(res.templateDir, "actors.example.json"), "utf8")) as { actors: Record<string, { password: string }> };
    assert.equal(exportedActors.actors.employee.password, "CHANGE_ME");
    assert.throws(() => exportTemplate(dataDir, cfg, actors, name), /E_EXISTS|already exists/);

    const other = project();
    const s2 = startOnboarding(other.projectDir);
    const { copiedRecipes } = answersFromTemplate(s2, res.templateDir);
    assert.equal(copiedRecipes.length, 1);
    assert.equal(s2.fields.appOrigins.source, "template");
    assert.equal(s2.fields.actors.status, "confirmed");
    assert.equal(smokeAnswers(s2), null, "smoke answers are not part of a template; the recipe is copied instead");
    assert.deepEqual(validateConfig(toConfig(s2)), []);
  } finally {
    rmSync(res.templateDir, { recursive: true, force: true });
  }
  assert.ok(!existsSync(join(examplesDir(), name)));
});

test("presetDataSourceRules picks rules from dependencies", () => {
  assert.equal(presetDataSourceRules(["react"]).length, 0);
  assert.equal(presetDataSourceRules(["@tanstack/vue-query"])[0].verdict, "api");
  assert.equal(presetDataSourceRules(["pinia"])[0].verdictIfMissing, "ui");
});

test("catalogue wording stays project-neutral", () => {
  const banned = [/vehicle/i, /localhost:3000/];
  for (const f of CATALOGUE) {
    const text = [f.hint, f.verify ?? "", f.question ?? ""].join(" ");
    for (const re of banned) assert.ok(!re.test(text), `${f.key} mentions ${re}`);
  }
});
