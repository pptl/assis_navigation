import { CliError } from "../errors.js";

/** Every command prints exactly one JSON document to stdout so Agent dev can parse it. */
export function printJson(value: unknown, pretty = false): void {
  process.stdout.write((pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)) + "\n");
}

export function printError(err: unknown): void {
  const body = err instanceof CliError
    ? { error: err.message, code: err.code, details: err.details }
    : { error: err instanceof Error ? err.message : String(err), code: "E_UNEXPECTED", stack: err instanceof Error ? err.stack : undefined };
  process.stderr.write(JSON.stringify(body) + "\n");
}
