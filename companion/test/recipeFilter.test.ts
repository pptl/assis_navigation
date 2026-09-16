import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../src/cli/run.js";
import type { Recipe, RecipeMatchResult, RecipeSummary } from "../src/recipe.js";
import { recipeShape } from "../src/recipe.js";
import { filterRecipes, listRecipes, saveRecipe } from "../src/store/recipes.js";
import { listCommand } from "../src/cli/commands/recipes.js";
import { normRoute } from "../src/util/route.js";
import { getDataSource, setDataSource } from "../src/store/dataSourceMap.js";
import { readJson } from "../src/util/fs.js";

function summary(name: string, targetUrl?: string, extra: Partial<RecipeSummary> = {}): RecipeSummary {
  return {
    name,
    description: extra.description,
    targetUrl,
    shape: extra.shape ?? "navigation",
    finalNavigation: extra.finalNavigation ?? "/Index/Home",
    createdAt: extra.createdAt ?? "2026-09-01T00:00:00.000Z",
    steps: extra.steps ?? 0,
    file: `/tmp/${name}.json`,
  };
}

const CORPUS: RecipeSummary[] = [
  summary("order-dispatchfirst", "/Order/DispatchFirst", { description: "分頁A-產生訂單(派單)頁面", createdAt: "2026-09-09T06:58:32.642Z" }),
  summary("order-orderlist", "/Order/OrderList", { description: "訂單列表", createdAt: "2026-09-05T00:00:00.000Z" }),
  summary("booking", "/Booking/BookingFirst", { description: "預約排程行事曆", createdAt: "2026-09-08T03:20:03.714Z" }),
  summary("login-ready", "/Index/Home", { description: "煙霧 recipe：以 employee 登入", createdAt: "2026-09-07T09:56:15.283Z" }),
  summary("no-target", undefined, { description: "手寫的訂單前置流程" }),
];

const by = (rs: RecipeSummary[] | RecipeMatchResult[]) => rs.map((r) => r.name);
const matchedOf = (rs: RecipeSummary[] | RecipeMatchResult[], name: string) =>
  (rs as RecipeMatchResult[]).find((r) => r.name === name)?.matched;

test("filterRecipes ranks exact, prefix and section matches on the target route", () => {
  const r = filterRecipes(CORPUS, { targetUrl: "/Order/DispatchFirst" });
  assert.deepEqual(by(r), ["order-dispatchfirst", "order-orderlist"]);
  assert.deepEqual(matchedOf(r, "order-dispatchfirst"), ["exact"]);
  assert.deepEqual(matchedOf(r, "order-orderlist"), ["section"]);

  const prefix = filterRecipes(CORPUS, { targetUrl: "/Order" });
  assert.deepEqual(matchedOf(prefix, "order-dispatchfirst"), ["prefix"]);
});

test("filterRecipes compares routes case-insensitively and accepts a full URL", () => {
  assert.deepEqual(matchedOf(filterRecipes(CORPUS, { targetUrl: "/order/dispatchfirst/" }), "order-dispatchfirst"), ["exact"]);
  assert.deepEqual(matchedOf(filterRecipes(CORPUS, { targetUrl: "http://localhost:3000/Order/DispatchFirst?x=1" }), "order-dispatchfirst"), ["exact"]);
});

test("filterRecipes keyword search covers name, description and targetUrl", () => {
  assert.deepEqual(by(filterRecipes(CORPUS, { match: "login-ready" })), ["login-ready"]);
  assert.deepEqual(by(filterRecipes(CORPUS, { match: "預約" })), ["booking"]);
  assert.deepEqual(by(filterRecipes(CORPUS, { match: "booking" })), ["booking"]);
});

test("filterRecipes AND-s both filters and accumulates how each one matched", () => {
  const r = filterRecipes(CORPUS, { targetUrl: "/Order/DispatchFirst", match: "訂單" });
  assert.deepEqual(by(r), ["order-dispatchfirst", "order-orderlist"]);
  assert.deepEqual(matchedOf(r, "order-dispatchfirst"), ["exact", "keyword"]);
  assert.deepEqual(matchedOf(r, "order-orderlist"), ["section", "keyword"]);

  // no-target matches the keyword but has no targetUrl, so the route filter drops it
  assert.ok(!by(r).includes("no-target"));
});

test("filterRecipes without filters returns the list untouched", () => {
  const r = filterRecipes(CORPUS, {});
  assert.equal(r, CORPUS);
  assert.ok(!("matched" in r[0]));
});

test("a recipe without targetUrl is excluded by route filtering but still reachable by keyword", () => {
  assert.ok(!by(filterRecipes(CORPUS, { targetUrl: "/Order/DispatchFirst" })).includes("no-target"));
  assert.deepEqual(by(filterRecipes(CORPUS, { match: "手寫" })), ["no-target"]);
});

test("same-rank matches are ordered newest first", () => {
  const r = filterRecipes(CORPUS, { match: "訂單" });
  assert.deepEqual(by(r), ["order-dispatchfirst", "order-orderlist", "no-target"]);
});

test("list command reports the unfiltered total alongside the narrowed result", () => {
  const project = mkdtempSync(join(tmpdir(), "navrec-list-"));
  const dataDir = join(project, ".nav-recorder");
  mkdirSync(join(dataDir, "preconditions"), { recursive: true });
  writeFileSync(join(dataDir, "config.json"), "{}");
  for (const r of CORPUS.slice(0, 3)) {
    writeFileSync(join(dataDir, "preconditions", `${r.name}.json`), JSON.stringify({ ...r, steps: [] }));
  }
  const ctx = (flags: Record<string, string>): CommandContext => ({
    positionals: [],
    flags,
    str: (k) => flags[k],
    bool: () => false,
    project,
  });

  const all = listCommand.handler(ctx({})) as { total: number; filtered: boolean; recipes: RecipeSummary[] };
  assert.equal(all.total, 3);
  assert.equal(all.filtered, false);

  const narrowed = listCommand.handler(ctx({ "target-url": "/Order/DispatchFirst" })) as {
    total: number; filtered: boolean; query: { targetUrl?: string }; recipes: RecipeMatchResult[];
  };
  assert.equal(narrowed.total, 3);
  assert.equal(narrowed.filtered, true);
  assert.equal(narrowed.query.targetUrl, "/Order/DispatchFirst");
  assert.deepEqual(by(narrowed.recipes), ["order-dispatchfirst", "order-orderlist"]);
});

test("a recipe's shape follows its steps, so an added api step is never missed", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "navrec-shape-"));
  mkdirSync(join(dataDir, "preconditions"), { recursive: true });

  // Recipes distilled before shapes existed carry no field at all.
  const legacy: Recipe = { name: "legacy", createdAt: "2026-09-07T00:00:00Z", steps: [], finalNavigation: "/Index/Home" };
  assert.equal(recipeShape(legacy), "navigation");
  saveRecipe(dataDir, legacy);
  assert.equal(readJson<Recipe>(join(dataDir, "preconditions", "legacy.json")).shape, "navigation");

  // A ui-only recipe (the login-ready smoke recipe is one) is still navigation: nothing is created.
  const uiOnly: Recipe = { ...legacy, name: "ui-only", steps: [{ id: "s1", actor: "employee", kind: "ui", action: { type: "navigate", url: "/Index/Home" } }] };
  assert.equal(recipeShape(uiOnly), "navigation");

  // The stored value only settles the two navigation flavours...
  const existing: Recipe = { ...legacy, name: "existing", shape: "navigation-existing-data", existingDataRefs: [{ value: "APP-1", usedBy: "POST Detail", seenIn: "POST Search" }] };
  assert.equal(recipeShape(existing), "navigation-existing-data");

  // ...and an api step the Agent adds by hand overrides it on save.
  const withApi: Recipe = { ...existing, steps: [{ id: "s1", actor: "employee", kind: "api", call: { method: "POST", url: "Apps/AppCreate" } }] };
  assert.equal(recipeShape(withApi), "data");
  saveRecipe(dataDir, withApi);
  assert.equal(readJson<Recipe>(join(dataDir, "preconditions", "existing.json")).shape, "data");

  // A disabled api step is not a step: it does not make the recipe build state.
  assert.equal(recipeShape({ ...withApi, steps: [{ ...withApi.steps[0], disabled: true }] }), "navigation-existing-data");

  assert.deepEqual(listRecipes(dataDir).map((r) => [r.name, r.shape]), [["existing", "data"], ["legacy", "navigation"]]);
});

test("normRoute keeps route casing so existing data-source-map keys stay reachable", () => {
  assert.equal(normRoute("/Booking/BookingFirst"), "/Booking/BookingFirst");
  assert.equal(normRoute("Booking/BookingFirst/"), "/Booking/BookingFirst");
  assert.equal(normRoute("http://localhost:3000/Booking/BookingFirst?tab=1"), "/Booking/BookingFirst");

  const dataDir = mkdtempSync(join(tmpdir(), "navrec-dsm-"));
  setDataSource(dataDir, "/Booking/BookingFirst", { verdict: "ui", evidence: "側欄依賴 top-nav 分頁狀態", source: "manual" });
  assert.equal(getDataSource(dataDir, "/Booking/BookingFirst")?.verdict, "ui");
  assert.equal(getDataSource(dataDir, "http://localhost:3000/Booking/BookingFirst")?.verdict, "ui");
});
