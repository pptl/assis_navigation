// "Where are my recordings going?" — one answer, shared by `ports`, `activate` and the E_NO_EVENTS hint.

import { loadHosts } from "../hosts.js";
import { samePath } from "../paths.js";
import { portOverview, type ResolveDeps } from "../util/ports.js";
import { unroutedByPort } from "../store/unrouted.js";

export interface ListeningPort {
  port: number;
  pid: number;
  /** .nav-recorder dir the port resolves to, null when it cannot be told */
  project: string | null;
  mine: boolean;
  /** set when a manual lease claims this port */
  leasedTo?: string;
}

export interface PortsReport {
  /** ports that belong to a project, are leased, or have staged recordings */
  listening: ListeningPort[];
  /** everything else listening above 1024, as bare numbers: a dev server nobody has browsed yet is in here */
  otherListening: number[];
  /** ports currently serving this project */
  mine: number[];
  /** staged recordings waiting to be adopted */
  unrouted: { port: number; events: number; lastAt: string | null }[];
}

export function portsReport(dataDir?: string, deps: ResolveDeps = {}): PortsReport {
  const hosts = loadHosts();
  const staged = unroutedByPort();
  const rows = portOverview(deps).map((row): ListeningPort => {
    const lease = hosts.ports?.[String(row.port)];
    const project = row.dataDir ?? (lease && lease.pid === undefined ? lease.dataDir : null) ?? null;
    return {
      port: row.port,
      pid: row.pid,
      project,
      mine: !!dataDir && !!project && samePath(project, dataDir),
      leasedTo: lease?.dataDir,
    };
  });
  // A machine listens on dozens of ports; only the ones something knows about are worth naming.
  const named = (r: ListeningPort): boolean => !!r.project || !!r.leasedTo || staged.some((u) => u.port === r.port);
  const listening = rows.filter(named);
  return {
    listening,
    otherListening: rows.filter((r) => !named(r) && r.port >= 1024).map((r) => r.port),
    mine: listening.filter((r) => r.mine).map((r) => r.port),
    unrouted: staged.map((u) => ({ port: u.port, events: u.events, lastAt: u.lastAt })),
  };
}

/** The sentence to show when a project expected recordings and found none. */
export function noEventsHint(report: PortsReport): string {
  if (report.unrouted.length) {
    const ports = report.unrouted.map((u) => `${u.port} (${u.events})`).join(", ");
    return `Staged recordings are waiting for a project: port ${ports}. If the dev server on that port is this project, run \`nav-recorder activate --port <n> --adopt\` to take them.`;
  }
  if (report.mine.length) {
    return `This project is serving port ${report.mine.join(", ")} and recording is routed there, so nothing was recorded — browse the app in Chrome (only the active tab is recorded), then try again.`;
  }
  const seen = [...report.listening.map((r) => r.port), ...report.otherListening];
  if (!seen.length) return "Nothing is listening on loopback: start the dev server, browse the app in Chrome, then try again.";
  const sample = seen.slice(0, 8).join(", ") + (seen.length > 8 ? `, … (${seen.length} in total, see \`nav-recorder ports\`)` : "");
  return `No listening port resolves to this project (seen: ${sample}). Start this project's dev server, or run \`nav-recorder activate --port <n>\` if its command line does not name the project.`;
}
