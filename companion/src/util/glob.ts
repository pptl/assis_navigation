import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// Tiny glob: supports `*`, `**` and `?` segments — enough for patterns such as
// "swagger/*.json" or "**/Migrations/*.cs". Skips node_modules / .git / bin / obj directories.
export function globFiles(baseDir: string, pattern: string): string[] {
  const parts = pattern.split(/[\\/]+/).filter((p) => p.length > 0);
  const out: string[] = [];
  const root = resolve(baseDir);
  if (!existsSync(root)) return out;
  walk(root, parts, 0, out);
  return out.sort();
}

const SKIP = new Set(["node_modules", ".git", "bin", "obj", "dist", ".nav-recorder"]);

function walk(dir: string, parts: string[], idx: number, out: string[]): void {
  if (idx >= parts.length) return;
  const part = parts[idx];
  const last = idx === parts.length - 1;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }

  if (part === "**") {
    // zero or more directories; never descends into dot-directories (tooling folders) unless named explicitly
    walk(dir, parts, idx + 1, out);
    for (const e of entries) {
      if (SKIP.has(e) || e.startsWith(".")) continue;
      const full = join(dir, e);
      if (isDir(full)) walk(full, parts, idx, out);
    }
    return;
  }

  const re = toRegex(part);
  for (const e of entries) {
    if (!re.test(e)) continue;
    const full = join(dir, e);
    if (last) { if (!isDir(full)) out.push(full); }
    else if (isDir(full) && !SKIP.has(e)) walk(full, parts, idx + 1, out);
  }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function toRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, process.platform === "win32" ? "i" : "");
}

export function relPath(from: string, to: string): string {
  return to.startsWith(from) ? to.slice(from.length).replace(new RegExp(`^\\${sep}`), "") : to;
}
