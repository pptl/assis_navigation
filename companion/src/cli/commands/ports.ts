import type { CommandDef } from "../run.js";
import { resolveDataDir } from "../../paths.js";
import { portsReport } from "../portsReport.js";

export const portsCommand: CommandDef = {
  name: "ports",
  usage: "ports [--project <dir>]",
  description: "Which loopback port belongs to which project right now, and what is waiting unclaimed in the staging area.",
  handler: (ctx) => {
    let dataDir: string | undefined;
    try { dataDir = resolveDataDir(ctx.project); } catch { /* usable outside a project too */ }
    const report = portsReport(dataDir);
    return {
      project: dataDir ?? null,
      ...report,
      note:
        "Ownership is resolved from the process holding each port, so it follows the dev server on its own — nothing to register when the port changes. `project: null` means the command line did not name a project (a .NET or Python server, say): those recordings are staged and `activate --port <n> --adopt` takes them.",
    };
  },
};
