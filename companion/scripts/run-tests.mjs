// Runs every compiled *.test.js under dist/test with node:test (Node 20 has no glob support for --test).
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, "..", "dist", "test");

if (!existsSync(testDir)) {
  console.error(`No compiled tests at ${testDir}. Run "npm run build" first.`);
  process.exit(1);
}

const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => join(testDir, f));

if (files.length === 0) {
  console.log("No test files found.");
  process.exit(0);
}

let failed = 0;
const stream = run({ files, concurrency: 1 });
stream.on("test:fail", () => { failed++; });
stream.compose(spec).pipe(process.stdout);
stream.on("end", () => { process.exitCode = failed > 0 ? 1 : 0; });
