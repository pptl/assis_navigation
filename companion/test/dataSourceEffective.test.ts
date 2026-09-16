import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDefaults } from "../src/config.js";
import {
  effectiveEntry, entryOfVerdict, getDataSource, loadDataSourceMap, renderDataSourceMap, setDataSource,
  type DataSourceMapFile,
} from "../src/store/dataSourceMap.js";
import type { NavConfig } from "../src/types.js";

function cfgWith(entry: NavConfig["navigation"]["entry"], evidence?: string): NavConfig {
  return withDefaults({ navigation: { entry, evidence } });
}

function mapOf(entries: DataSourceMapFile["entries"]): DataSourceMapFile {
  return { entries };
}

const BOOKING = {
  verdict: "ui" as const,
  evidence: "main area blank on a cold URL entry; the sidebar stayed on the previous tab",
  source: "manual" as const,
  updatedAt: "2026-09-08T03:40:03.775Z",
};
const HOME = {
  verdict: "api" as const,
  evidence: "login landing page; renders on a cold URL entry",
  source: "manual" as const,
  updatedAt: "2026-09-10T00:00:00.000Z",
};

test("a route in the map answers for itself, in navigation vocabulary", () => {
  const cfg = cfgWith("menu");
  const map = mapOf({ "/Booking/BookingFirst": BOOKING, "/Index/Home": HOME });
  const ui = effectiveEntry(cfg, map, "/Booking/BookingFirst");
  assert.deepEqual({ entry: ui.entry, from: ui.from, verdict: ui.verdict }, { entry: "menu", from: "route", verdict: "ui" });
  const api = effectiveEntry(cfg, map, "/Index/Home");
  // the point of the site default: on a menu site a verified `api` row is a deep-link shortcut
  assert.deepEqual({ entry: api.entry, from: api.from, verdict: api.verdict }, { entry: "deeplink", from: "route", verdict: "api" });
  assert.equal(entryOfVerdict("api"), "deeplink");
  assert.equal(entryOfVerdict("ui"), "menu");
});

test("a route absent from the map inherits the site default rather than being unknowable", () => {
  const map = mapOf({ "/Booking/BookingFirst": BOOKING });
  const menu = effectiveEntry(cfgWith("menu", "sidebar follows the top-nav tab"), map, "/Order/DispatchFirst");
  assert.deepEqual({ entry: menu.entry, from: menu.from, evidence: menu.evidence }, { entry: "menu", from: "site-default", evidence: "sidebar follows the top-nav tab" });
  const deeplink = effectiveEntry(cfgWith("deeplink"), map, "/Order/DispatchFirst");
  assert.deepEqual({ entry: deeplink.entry, from: deeplink.from }, { entry: "deeplink", from: "site-default" });
  assert.equal(deeplink.verdict, undefined, "the site default is not a per-route verdict");
});

test("an unanswered project defaults to unknown, never to deep-link-is-fine", () => {
  const cfg = withDefaults({});
  assert.equal(cfg.navigation.entry, "unknown");
  assert.equal(effectiveEntry(cfg, mapOf({}), "/Anything/AtAll").entry, "unknown");
});

test("lookups survive the casing and URL forms routes arrive in", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "navrec-dse-"));
  const dataDir = join(projectDir, ".nav-recorder");
  mkdirSync(dataDir, { recursive: true });
  const cfg = cfgWith("menu");
  setDataSource(dataDir, "/Booking/BookingFirst", BOOKING, cfg.navigation);
  const map = loadDataSourceMap(dataDir);
  assert.equal(effectiveEntry(cfg, map, "/booking/bookingfirst").from, "site-default", "normRoute preserves case, so a different casing is a different route");
  assert.equal(effectiveEntry(cfg, map, "http://localhost:3000/Booking/BookingFirst?x=1").from, "route", "a full URL with a query resolves to the same route");
  assert.equal(getDataSource(dataDir, "/Booking/BookingFirst/")?.verdict, "ui");
});

test("the rendered table states the site default and what the rows mean", () => {
  const md = renderDataSourceMap(mapOf({ "/Booking/BookingFirst": BOOKING }), { entry: "menu", evidence: "sidebar follows the top-nav tab" });
  assert.match(md, /Site default \(config\.navigation\.entry\).*`menu`/);
  assert.match(md, /Evidence: sidebar follows the top-nav tab/);
  assert.match(md, /listed below inherits that default/);
  assert.match(md, /\| `\/Booking\/BookingFirst` \| ui \|/);

  const noSite = renderDataSourceMap(mapOf({}));
  assert.match(noSite, /`unknown`/, "a map rendered without a config still says the default is unestablished");
  assert.match(noSite, /_\(empty\)_/);
});

test("a pipe in the evidence cannot break the table", () => {
  const md = renderDataSourceMap(mapOf({ "/A/B": { ...BOOKING, evidence: "blank | sidebar wrong" } }), { entry: "menu" });
  assert.match(md, /blank \\\| sidebar wrong/);
});
