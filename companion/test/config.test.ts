import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, validateConfig, withDefaults } from "../src/config.js";
import { examplesDir } from "../src/paths.js";
import { readJson } from "../src/util/fs.js";
import type { NavConfig } from "../src/types.js";
import { parseArgs } from "../src/cli/args.js";

test("default config is valid", () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
});

test("every template under examples/ has a valid config.json (derived apiBases checked for shape only)", async () => {
  const { validateApiBaseSpec } = await import("../src/derive.js");
  const templates = readdirSync(examplesDir()).filter((d) => existsSync(join(examplesDir(), d, "config.json")));
  assert.ok(templates.length > 0, "no templates found");
  for (const t of templates) {
    const raw = readJson<Partial<NavConfig> & { $schema?: string; apiBases?: unknown[] }>(join(examplesDir(), t, "config.json"));
    delete raw.$schema;
    const specs = raw.apiBases ?? [];
    assert.ok(specs.length > 0, `template ${t} has no apiBases`);
    assert.deepEqual(specs.flatMap((s, i) => validateApiBaseSpec(s, i)), [], `template ${t} apiBases`);
    // derivations point at files inside the target project, so validate the rest with a placeholder base
    const cfg = withDefaults({ ...(raw as Partial<NavConfig>), apiBases: ["https://placeholder.invalid/"] });
    assert.deepEqual(validateConfig(cfg), [], `template ${t}`);
  }
});

test("validateConfig reports broken fields", () => {
  const bad = withDefaults({ appOrigins: ["localhost:3000/"], apiBases: ["https://x/api"], readOnlyPatterns: ["("], auth: { kind: "bearer" } });
  const errors = validateConfig(bad);
  assert.ok(errors.some((e) => e.includes("appOrigins")));
  assert.ok(errors.some((e) => e.includes('must end with "/"')));
  assert.ok(errors.some((e) => e.includes("readOnlyPatterns")));
  assert.ok(errors.some((e) => e.includes("tokenSource")));
});

test("navigation.entry defaults to unknown and only accepts the three verbs", () => {
  // A project that never answered must not read as "deep links are fine" — that would send the
  // Agent to a blank screen with no warning.
  assert.equal(withDefaults({}).navigation.entry, "unknown");
  assert.equal(withDefaults({ navigation: { entry: "menu", evidence: "why" } }).navigation.evidence, "why");
  assert.deepEqual(validateConfig(withDefaults({ navigation: { entry: "menu" } })), []);
  assert.ok(validateConfig(withDefaults({ navigation: { entry: "spa" } as never })).some((e) => e.includes("navigation.entry")));
});

test("derived apiBases are looked up from a JSON file, optionally via a regex capture in a source file", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolveConfig, configForDisk } = await import("../src/config.js");
  const dir = mkdtempSync(join(tmpdir(), "navrec-derive-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ envConfig: { devDomain: "https://dev.example.com", stagingDomain: "https://staging.example.com/" } }));
  writeFileSync(join(dir, "src", "domain.ts"), "let testDomain = packageJson.envConfig.stagingDomain;\n");
  const raw = {
    appOrigins: ["http://localhost:5173"],
    apiBases: [
      { derive: "json" as const, file: "package.json", path: "envConfig.devDomain", append: "/api" },
      { derive: "json" as const, file: "package.json", path: "$1", append: "/app/", pathFrom: { file: "src/domain.ts", regex: "packageJson\\.(envConfig\\.\\w+)", template: "$1" } },
      "https://fixed.example.com/x/",
    ],
  };
  const cfg = resolveConfig(raw, dir);
  assert.deepEqual(cfg.apiBases, ["https://dev.example.com/api/", "https://staging.example.com/app/", "https://fixed.example.com/x/"]);
  assert.equal(cfg.apiBasesSpec?.length, 3, "specs kept for round-trip");
  assert.deepEqual((configForDisk(cfg) as { apiBases: unknown[] }).apiBases, raw.apiBases);
  assert.throws(() => resolveConfig({ appOrigins: ["http://localhost:5173"], apiBases: [{ derive: "json", file: "package.json", path: "envConfig.nope" }] }, dir), /no string at envConfig.nope/);
  assert.throws(() => resolveConfig({ appOrigins: ["http://localhost:5173"], apiBases: [{ derive: "json", file: "missing.json", path: "a" }] }, dir), /file not found/);
});

test("parseArgs handles positionals, --k v, --k=v and booleans", () => {
  const p = parseArgs(["execute-report", "abc", "--status", "ok", "--captured={\"a\":1}", "--pretty", "--project", "C:\\x"]);
  assert.equal(p.command, "execute-report");
  assert.deepEqual(p.positionals, ["abc"]);
  assert.equal(p.flags.status, "ok");
  assert.equal(p.flags.captured, "{\"a\":1}");
  assert.equal(p.flags.pretty, true);
  assert.equal(p.flags.project, "C:\\x");
});
