import type { CommandDef } from "../run.js";
import { CliError } from "../../errors.js";
import { resolveDataDir } from "../../paths.js";
import { forgetPort, leasePort, loadHosts } from "../../hosts.js";
import { listeningPorts } from "../../util/ports.js";
import { adoptPort, unroutedByPort } from "../../store/unrouted.js";
import { portsReport } from "../portsReport.js";
import { tidyRaw } from "../tidyRaw.js";

export const activateCommand: CommandDef = {
  name: "activate",
  usage: "activate --port <n> [--project <dir>] [--adopt] | activate --forget <n>",
  description: "Fallback for a dev server whose command line does not name its project: say that this port is this project, and optionally adopt what it already recorded into the staging area.",
  handler: (ctx) => {
    const dataDir = resolveDataDir(ctx.project);
    const forget = ctx.str("forget");
    if (forget !== undefined) {
      const port = Number(forget);
      if (!Number.isInteger(port)) throw new CliError("E_USAGE", "activate --forget <port>");
      return { mode: "forget", port, removed: forgetPort(port), leases: loadHosts().ports ?? {} };
    }
    const portRaw = ctx.str("port");
    if (portRaw === undefined) {
      // Nothing to do without a port: show where recordings are going so the caller can pick one.
      return {
        mode: "status",
        project: dataDir,
        ...portsReport(dataDir),
        note: "Ownership resolves itself from the process holding each port. Pass --port <n> only for a port whose `project` is null.",
      };
    }
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0) throw new CliError("E_USAGE", "activate --port <port>");

    const pid = listeningPorts().get(port);
    const previous = loadHosts().ports?.[String(port)];
    const lease = leasePort(port, dataDir, pid);
    const staged = unroutedByPort().find((u) => u.port === port);
    const adopted = ctx.bool("adopt") && staged ? adoptPort(port, dataDir) : undefined;

    return {
      mode: "lease",
      project: dataDir,
      port,
      lease,
      movedFrom: previous && previous.dataDir !== dataDir ? previous.dataDir : undefined,
      staged: staged ? { events: staged.events, firstAt: staged.firstAt, lastAt: staged.lastAt } : undefined,
      adopted,
      ...(adopted ? tidyRaw(dataDir) : {}),
      note: pid === undefined
        ? "Nothing is listening on that port yet, so the lease is not pinned to a process: it will be dropped as soon as the port resolves to a project on its own. Run this again once the dev server is up to pin it."
        : staged && !adopted
          ? "Recordings from this port are staged — add --adopt to take them into this project."
          : undefined,
    };
  },
};
