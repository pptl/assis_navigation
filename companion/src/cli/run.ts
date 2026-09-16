import { parseArgs, flagBool, flagString } from "./args.js";
import { printError, printJson } from "./output.js";
import { commands } from "./commands/index.js";

export interface CommandContext {
  positionals: string[];
  flags: Record<string, string | boolean>;
  str(key: string): string | undefined;
  bool(key: string): boolean;
  /** --project <dir> */
  project?: string;
}

export interface CommandDef {
  name: string;
  usage: string;
  description: string;
  handler: (ctx: CommandContext) => Promise<unknown> | unknown;
}

export function usageText(): string {
  const lines = ["nav-recorder <command> [args] [--project <dir>] [--pretty]", ""];
  for (const c of Object.values(commands)) lines.push(`  ${c.usage.padEnd(70)} ${c.description}`);
  return lines.join("\n");
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const pretty = flagBool(parsed.flags, "pretty");
  if (!parsed.command || parsed.command === "help" || flagBool(parsed.flags, "help")) {
    process.stdout.write(usageText() + "\n");
    return parsed.command ? 0 : 1;
  }
  const cmd = commands[parsed.command];
  if (!cmd) {
    printError({ message: `Unknown command: ${parsed.command}`, code: "E_USAGE" });
    process.stdout.write(usageText() + "\n");
    return 1;
  }
  const ctx: CommandContext = {
    positionals: parsed.positionals,
    flags: parsed.flags,
    str: (k) => flagString(parsed.flags, k),
    bool: (k) => flagBool(parsed.flags, k),
    project: flagString(parsed.flags, "project"),
  };
  try {
    const result = await cmd.handler(ctx);
    if (result !== undefined) printJson(result, pretty);
    return 0;
  } catch (e) {
    printError(e);
    return 1;
  }
}
