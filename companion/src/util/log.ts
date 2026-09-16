import { appendLine } from "./fs.js";

/**
 * File logger for native-host mode. stdout is reserved for native messaging frames and
 * Chrome swallows stderr, so anything diagnostic has to go to a file.
 */
export class FileLogger {
  constructor(private readonly path: string) {}

  log(level: "info" | "warn" | "error", message: string, extra?: unknown): void {
    const line = `${new Date().toISOString()} [${level}] ${message}` + (extra !== undefined ? ` ${safeJson(extra)}` : "");
    try {
      appendLine(this.path, line);
    } catch {
      // logging must never crash the host
    }
  }

  info(message: string, extra?: unknown): void { this.log("info", message, extra); }
  warn(message: string, extra?: unknown): void { this.log("warn", message, extra); }
  error(message: string, extra?: unknown): void { this.log("error", message, extra); }
}

function safeJson(v: unknown): string {
  try {
    if (v instanceof Error) return JSON.stringify({ message: v.message, stack: v.stack });
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
