import { test } from "node:test";
import assert from "node:assert/strict";
import { findRoutes, listRoutes, mergeEntry, renderRouteCatalogue, type RouteCatalogueFile, type RouteEntry } from "../src/store/routeCatalogue.js";
import { extractRoutes, summarise } from "../src/routes/importTree.js";

const NOW = "2026-09-09T10:00:00.000Z";
const LATER = "2026-09-10T10:00:00.000Z";

test("mergeEntry accumulates instead of overwriting", () => {
  const first = mergeEntry(undefined, { source: "observed", seen: 2, enteredBy: ["預約管理"], evidence: "visited twice" }, NOW);
  assert.equal(first.seenInRecordings, 2);
  assert.equal(first.firstSeenAt, NOW);
  assert.deepEqual(first.names, []);

  const second = mergeEntry(first, { source: "agent", names: ["預約"], chains: [["分頁A", "sidebar", "預約管理"]], seen: 1 }, LATER);
  assert.equal(second.seenInRecordings, 3, "visit counts add up");
  assert.deepEqual(second.names, ["預約"]);
  assert.equal(second.placements.length, 1);
  assert.deepEqual(second.enteredBy, ["預約管理"], "earlier observations survive");
  assert.equal(second.firstSeenAt, NOW, "firstSeenAt is never moved forward");
  assert.equal(second.updatedAt, LATER);
});

test("names and placements are unioned, not duplicated", () => {
  let e = mergeEntry(undefined, { source: "import", names: ["產生訂單"], chains: [["Sales", "sidebar", "訂單管理"]] }, NOW);
  e = mergeEntry(e, { source: "agent", names: ["產生訂單", "派單"], chains: [["Sales", "sidebar", "訂單管理"]] }, LATER);
  assert.deepEqual(e.names, ["產生訂單", "派單"]);
  assert.equal(e.placements.length, 1, "the same chain twice stays one placement");
  assert.equal(e.placements[0].source, "agent", "a placement is upgraded to the more trusted source");
});

test("source confidence only ever goes up", () => {
  const observed = mergeEntry(undefined, { source: "observed", seen: 1 }, NOW);
  const upgraded = mergeEntry(observed, { source: "agent", names: ["產生訂單"] }, LATER);
  assert.equal(upgraded.source, "agent");
  const notDowngraded = mergeEntry(upgraded, { source: "observed", seen: 1 }, LATER);
  assert.equal(notDowngraded.source, "agent", "a later mechanical sighting does not undo the Agent's judgement");
});

test("one route can hang under many menu sections", () => {
  // /Index/Home is the shared dashboard: in a real app it appears under every top-nav tab.
  const tabs = ["Dashboard", "Inventory", "HR", "Meals", "Reports", "Parts", "Service", "Recruiting", "Sales"];
  let e: RouteEntry | undefined;
  for (const t of tabs) e = mergeEntry(e, { source: "import", names: ["控制台"], chains: [[t, "sidebar", "控制台"]] }, NOW);
  assert.equal(e!.placements.length, 9, "placements accumulate rather than overwrite each other");
  assert.deepEqual(e!.names, ["控制台"], "the repeated name is stored once");
});

test("evidence records which kind of source last spoke", () => {
  const e = mergeEntry(undefined, { source: "agent", names: ["x"], evidence: "使用者在畫面上確認" }, NOW);
  assert.equal(e.evidence, "[agent] 使用者在畫面上確認");
  const kept = mergeEntry(e, { source: "observed", seen: 1 }, LATER);
  assert.equal(kept.evidence, "[agent] 使用者在畫面上確認", "an observation with no evidence does not blank the entry");
});

function catalogue(): RouteCatalogueFile {
  return {
    entries: {
      "/Order/DispatchFirst": mergeEntry(undefined, { source: "import", names: ["產生訂單"], chains: [["Sales", "sidebar", "訂單管理"]] }, NOW),
      "/PotentialCustomer/PotentialCusFirst": mergeEntry(undefined, { source: "import", names: ["潛客查詢"], chains: [["Sales", "sidebar", "潛客管理"]] }, NOW),
      "/PotentialCustomerNew/PotentialCusFirst": mergeEntry(undefined, { source: "import", names: ["潛客查詢"], chains: [["Sales", "sidebar", "潛客管理(新版)"]] }, NOW),
      "/Board/BoardFirst": mergeEntry(undefined, { source: "observed", names: [], chains: [["Service", "sidebar", "狀態看板"]], seen: 3 }, NOW),
    },
  };
}

test("findRoutes matches route, name and menu chain", () => {
  const f = catalogue();
  assert.deepEqual(findRoutes(f, "訂單").map((h) => h.route), ["/Order/DispatchFirst"]);
  assert.deepEqual(findRoutes(f, "dispatch").map((h) => h.route), ["/Order/DispatchFirst"], "case-insensitive on the path");
  assert.deepEqual(findRoutes(f, "Service").map((h) => h.route), ["/Board/BoardFirst"], "matches the menu chain");
});

test("an ambiguous name returns every candidate", () => {
  // Real menus reuse a screen name for more than one path; the chain is what tells them apart.
  const hits = findRoutes(catalogue(), "潛客查詢");
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.entry.placements[0].chain[2]), ["潛客管理", "潛客管理(新版)"]);
});

test("listRoutes filters by outermost menu entry", () => {
  assert.equal(listRoutes(catalogue(), "Sales").length, 3);
  assert.equal(listRoutes(catalogue(), "service").length, 1, "tab match is case-insensitive");
  assert.equal(listRoutes(catalogue()).length, 4);
});

test("renderRouteCatalogue groups by menu tab and escapes pipes", () => {
  const f = catalogue();
  f.entries["/Weird/Route"] = mergeEntry(undefined, { source: "agent", names: ["a|b"] }, NOW);
  const md = renderRouteCatalogue(f);
  assert.match(md, /## Service/);
  assert.match(md, /## Sales/);
  assert.match(md, /## \(未歸類\)/, "a route with no known placement still shows up");
  assert.match(md, /a\\\|b/, "pipes are escaped so the table survives");
  assert.ok(md.indexOf("## Sales") < md.indexOf("## (未歸類)"), "unplaced routes sort last");
});

test("renderRouteCatalogue handles an empty table", () => {
  assert.match(renderRouteCatalogue({ entries: {} }), /empty/);
});

// ---------- importTree ----------

/** Shaped like a real menu tree: ragged depth, unnamed grouping levels, repeated paths. */
const TREE = [
  {
    name: "Sales",
    children: [
      {
        name: "sidebar",
        children: [
          { name: "訂單管理", children: [{ name: "產生訂單", path: "/Order/DispatchFirst" }] },
          { name: "控制台", children: [{ name: "控制台", path: "/Index/Home" }] },
        ],
      },
    ],
  },
  {
    name: "Inventory",
    children: [
      {
        name: "sidebar",
        children: [
          // one level deeper than its neighbours
          { name: "倉庫管理", children: [{ name: "倉庫管理", children: [{ name: "編輯倉庫", path: "/Warehouse/WarehouseSecond" }] }] },
          { name: "控制台", children: [{ name: "控制台", path: "/Index/Home" }] },
        ],
      },
    ],
  },
  // an unnamed tab, as a real admin export has at the end
  { name: "", children: [{ name: "sidebar", children: [{ name: "孤兒頁", path: "/Orphan/Page" }] }] },
];

test("extractRoutes walks a ragged tree and keeps the ancestor chain", () => {
  const routes = extractRoutes(TREE);
  const dispatch = routes.find((r) => r.path === "/Order/DispatchFirst");
  assert.deepEqual(dispatch, { path: "/Order/DispatchFirst", name: "產生訂單", chain: ["Sales", "sidebar", "訂單管理"] });

  const warehouse = routes.find((r) => r.path === "/Warehouse/WarehouseSecond");
  assert.deepEqual(warehouse!.chain, ["Inventory", "sidebar", "倉庫管理", "倉庫管理"], "depth is not assumed");

  const orphan = routes.find((r) => r.path === "/Orphan/Page");
  assert.deepEqual(orphan!.chain, ["sidebar"], "an unnamed ancestor is skipped, not rendered as an empty level");
});

test("extractRoutes emits one entry per placement of a shared path", () => {
  const homes = extractRoutes(TREE).filter((r) => r.path === "/Index/Home");
  assert.equal(homes.length, 2);
  assert.deepEqual(homes.map((h) => h.chain[0]), ["Sales", "Inventory"]);
});

test("extractRoutes honours custom field names and a non-array root", () => {
  const root = { label: "Root", kids: [{ label: "頁", route: "/A/B" }, { label: "沒路徑的節點" }] };
  const routes = extractRoutes(root, { pathField: "route", nameField: "label", childrenField: "kids" });
  assert.deepEqual(routes, [{ path: "/A/B", name: "頁", chain: ["Root"] }]);
});

test("extractRoutes returns nothing when the fields do not match", () => {
  assert.deepEqual(extractRoutes(TREE, { pathField: "href" }), []);
  assert.deepEqual(extractRoutes(null), []);
  assert.deepEqual(extractRoutes("not a tree"), []);
});

test("summarise counts entries, unique paths and named entries", () => {
  // 5 placements over 4 distinct paths — /Index/Home hangs under two tabs.
  assert.deepEqual(summarise(extractRoutes(TREE)), { entries: 5, uniquePaths: 4, named: 5 });
});
