import { relative } from "node:path";
import type { ApiCall } from "../../types.js";
import type { SchemaHint, SchemaProvider } from "./types.js";
import { globFiles } from "../../util/glob.js";
import { readText } from "../../util/fs.js";

interface UniqueIndex { file: string; line: number; columns: string[]; entity?: string }

/**
 * EF Core evidence: `.IsUnique()` on HasIndex(...) (Fluent API / migrations) and
 * `[Index(nameof(X), IsUnique = true)]` attributes. Match is by column/property name only —
 * the API param name is compared case-insensitively to the column name.
 */
export function createEfCoreProvider(projectDir: string, glob: string): SchemaProvider {
  const indexes: UniqueIndex[] = [];
  const files = globFiles(projectDir, glob).filter((f) => f.toLowerCase().endsWith(".cs"));
  for (const file of files) {
    let text: string;
    try { text = readText(file); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const window = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
      if (/\.IsUnique\(\s*(true\s*)?\)/.test(lines[i])) {
        const cols = new Set<string>();
        for (const m of window.matchAll(/HasIndex\(\s*(?:\w+\s*=>\s*)?(?:new\s*\{([^}]*)\}|\w+\.(\w+)|"([^"]+)"|nameof\((\w+)\))/g)) {
          if (m[1]) for (const c of m[1].split(",")) { const name = c.trim().split(".").pop(); if (name) cols.add(name); }
          if (m[2]) cols.add(m[2]);
          if (m[3]) for (const c of m[3].split(",")) cols.add(c.trim());
          if (m[4]) cols.add(m[4]);
        }
        for (const m of window.matchAll(/CreateIndex\([^)]*columns?:\s*(?:new\[\]\s*\{([^}]*)\}|"([^"]+)")/g)) {
          if (m[1]) for (const c of m[1].split(",")) cols.add(c.trim().replace(/"/g, ""));
          if (m[2]) cols.add(m[2]);
        }
        const entity = /Entity<(\w+)>/.exec(window)?.[1] ?? /table:\s*"(\w+)"/.exec(window)?.[1];
        if (cols.size) indexes.push({ file, line: i + 1, columns: [...cols], entity });
      }
      const attr = /\[Index\(([^\]]*IsUnique\s*=\s*true[^\]]*)\)\]/.exec(lines[i]);
      if (attr) {
        const cols = new Set<string>();
        for (const m of attr[1].matchAll(/nameof\((\w+)\)|"(\w+)"/g)) cols.add(m[1] ?? m[2]);
        if (cols.size) indexes.push({ file, line: i + 1, columns: [...cols] });
      }
    }
  }

  return {
    kind: "efcore",
    size: files.length,
    lookup(_call: ApiCall, pointer: string): SchemaHint | null {
      const name = pointer.split("/").pop() ?? "";
      if (!name) return null;
      const hit = indexes.find((ix) => ix.columns.some((c) => c.toLowerCase() === name.toLowerCase()));
      if (!hit) return null;
      return {
        location: `${relative(projectDir, hit.file).replace(/\\/g, "/")}:${hit.line}`,
        unique: true,
        note: hit.columns.length > 1 ? `composite unique index on ${hit.columns.join(", ")}${hit.entity ? ` (${hit.entity})` : ""}` : `unique index${hit.entity ? ` on ${hit.entity}` : ""}`,
      };
    },
  };
}
