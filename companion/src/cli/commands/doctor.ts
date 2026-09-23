import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandDef } from "../run.js";
import type { ActorsFile } from "../../types.js";
import { loadConfig } from "../../config.js";
import { loadControl, loadHosts } from "../../hosts.js";
import { HOST_NAME, globalDir, hostLogPath, mainScriptPath, resolveDataDir } from "../../paths.js";
import { rawStats, readEvents } from "../../store/raw.js";
import { loadClaimState } from "../../store/claimState.js";
import { segmentEvents } from "../../distill/segments.js";
import { readJson } from "../../util/fs.js";
import { hostManifestPath, hostWrapperPath, registryKey } from "./registerHost.js";
import { CliError } from "../../errors.js";
import { loadOnboarding, statusReport } from "../../onboarding/state.js";
import { IGNORE_PATTERNS, findGitRoot, gitignoreHas } from "../../onboarding/scaffold.js";
import { noEventsHint, portsReport } from "../portsReport.js";

interface Check { name: string; ok: boolean; detail: string }

export const doctorCommand: CommandDef = {
  name: "doctor",
  usage: "doctor [--project <dir>] [--extension-id <id>]",
  description: "Check node, native host registration, origin whitelist, project config, actors and recent events.",
  handler: (ctx) => {
    const checks: Check[] = [];
    const add = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };

    const major = Number(process.versions.node.split(".")[0]);
    add("node", major >= 20, `node ${process.versions.node} (need >= 20)`);
    add("companion built", existsSync(mainScriptPath()), mainScriptPath());
    add("global dir", existsSync(globalDir()), globalDir());

    const manifestFile = hostManifestPath();
    if (existsSync(manifestFile)) {
      const m = readJson<{ path?: string; allowed_origins?: string[] }>(manifestFile, {});
      add("host manifest", true, manifestFile);
      add("host wrapper", !!m.path && existsSync(m.path), m.path ?? "(missing path)");
      const wantId = ctx.str("extension-id");
      const origins = m.allowed_origins ?? [];
      add("allowed_origins", origins.length > 0 && (!wantId || origins.includes(`chrome-extension://${wantId}/`)), origins.join(", ") || "(none)");
    } else {
      add("host manifest", false, `${manifestFile} missing — run "nav-recorder register-host --extension-id <id>"`);
    }
    if (process.platform === "win32") {
      try {
        const out = execFileSync("reg", ["query", registryKey(HOST_NAME), "/ve"], { stdio: "pipe" }).toString();
        add("registry", out.includes(manifestFile), out.trim().split(/\r?\n/).pop() ?? out.trim());
      } catch {
        add("registry", false, `${registryKey(HOST_NAME)} not found`);
      }
    }
    add("wrapper file", existsSync(hostWrapperPath()), hostWrapperPath());

    const hosts = loadHosts();
    const extraOrigins = Object.entries(hosts.origins);
    if (extraOrigins.length) add("non-loopback origins", true, extraOrigins.map(([o, d]) => `${o} → ${d}`).join("; "));
    const control = loadControl();
    add("recording", !control.paused, control.paused ? `PAUSED since ${control.updatedAt} (nav-recorder resume)` : "active");
    add("host log", existsSync(hostLogPath()), existsSync(hostLogPath()) ? hostLogPath() : "no host log yet — Chrome has not launched the host (check extension + restart Chrome)");

    let dataDir: string | undefined;
    try { dataDir = resolveDataDir(ctx.project, { allowOnboarding: true }); } catch (e) { add("project", false, (e as CliError).message); }
    if (dataDir) {
      const ob = loadOnboarding(dataDir);
      if (ob && ob.status === "collecting") {
        const report = statusReport(ob);
        add("onboarding", false, `in progress — ${report.missingRequired.length} required field(s) missing: ${report.missingRequired.map((m) => m.key).join(", ") || "(none; run init finalize)"}`);
      } else if (ob) {
        add("onboarding", true, `finalized ${ob.finalizedAt ?? ""}`);
      }
    }
    if (dataDir) {
      const projectDir = join(dataDir, "..");
      const gitRoot = findGitRoot(projectDir);
      if (!gitRoot) add("gitignore", false, `no git repository above ${projectDir} — make sure ${IGNORE_PATTERNS.join(" and ")} are ignored wherever this project is versioned`);
      else {
        const gi = join(gitRoot, ".gitignore");
        const missing = IGNORE_PATTERNS.filter((p) => !gitignoreHas(gi, p));
        add("gitignore", missing.length === 0, missing.length === 0
          ? `${IGNORE_PATTERNS.join(", ")} ignored in ${gi}`
          : `${missing.join(", ")} NOT ignored in ${gi} — add before committing (.nav-recorder/ = credentials + raw traffic; .playwright-mcp/ = Playwright MCP snapshots/console logs)`);
      }
    }
    if (dataDir && existsSync(join(dataDir, "config.json"))) {
      try {
        const cfg = loadConfig(dataDir);
        add("config", true, `${dataDir} (${cfg.name}; onboarding origins ${cfg.appOrigins.join(", ")})`);
        // Ports are not registered anywhere: what matters is whether a live one resolves to this project.
        const report = portsReport(dataDir);
        add("ports serving this project", report.mine.length > 0, report.mine.length
          ? `${report.mine.join(", ")} — recordings from these ports land here`
          : `none — ${noEventsHint(report)}`);
        if (report.unrouted.length) {
          add("staged recordings", false, `${report.unrouted.map((u) => `port ${u.port}: ${u.events} event(s), last ${u.lastAt}`).join("; ")} — \`nav-recorder activate --port <n> --adopt\` takes them into a project, otherwise they age out`);
        }
        // Without this, every route not in data-source-map is a coin flip on handover.
        const entry = cfg.navigation.entry;
        add("navigation entry", entry !== "unknown", entry === "unknown"
          ? 'unknown — no route inherits an answer. Log in, browser_navigate straight to one non-landing route in a fresh session, and record whether it renders: `nav-recorder init answer navigation --value \'{"entry":"deeplink"|"menu","evidence":"..."}\' --source verified --force` then `init finalize --force`'
          : `${entry}${cfg.navigation.evidence ? ` — ${cfg.navigation.evidence}` : ""}`);
      } catch (e) {
        add("config", false, `${(e as CliError).message} ${JSON.stringify((e as CliError).details ?? "")}`);
      }
      const actorsFile = join(dataDir, "actors.json");
      if (existsSync(actorsFile)) {
        const a = readJson<ActorsFile>(actorsFile, { actors: {} });
        const names = Object.keys(a.actors ?? {});
        const placeholders = names.filter((n) => /CHANGE_ME/i.test(a.actors[n].username) || /CHANGE_ME/i.test(a.actors[n].password));
        add("actors", names.length > 0 && placeholders.length === 0, names.length ? (placeholders.length ? `placeholders still present: ${placeholders.join(", ")}` : names.join(", ")) : "no actors defined");
      } else {
        add("actors", false, `${actorsFile} missing`);
      }
      const stats = rawStats(dataDir);
      const age = stats.lastReceivedAt ? Math.round((Date.now() - Date.parse(stats.lastReceivedAt)) / 1000) : null;
      add("recent events", stats.lastSeq > 0, stats.lastSeq > 0 ? `seq ${stats.lastSeq}, last ${age}s ago, ${stats.files} file(s), ${stats.bytes} bytes + ${stats.bodyBytes} bytes of stored bodies` : "no events recorded yet");
      if (stats.lastSeq > 0) {
        // Interactions are recorded by a content script added later than requests: a recording with
        // requests but no interactions usually means the extension has not been reloaded.
        const recent = readEvents(dataDir).slice(-200);
        const counts = { request: 0, navigation: 0, interaction: 0 };
        for (const ev of recent) counts[ev.type]++;
        const ok = counts.request === 0 || counts.interaction > 0;
        add("interactions recorded", ok, ok
          ? `last ${recent.length} events: ${counts.interaction} interaction(s), ${counts.navigation} navigation(s), ${counts.request} request(s)`
          : `last ${recent.length} events have ${counts.request} request(s) but no interaction — reload the extension at chrome://extensions and refresh the app tab (interactions.js is not registered)`);
      }
      try {
        const cfg = loadConfig(dataDir);
        const claim = loadClaimState(dataDir);
        const unclaimed = readEvents(dataDir, { afterSeq: claim.lastSeq });
        const segs = segmentEvents(unclaimed, { gapMinutes: cfg.recording.sessionGapMinutes, loginPath: cfg.login.kind === "ui" ? cfg.login.url : undefined });
        add("unclaimed", true, unclaimed.length
          ? `${unclaimed.length} event(s) since seq ${claim.lastSeq} across ${segs.length} browsing session(s) [${segs.map((s) => `${s.fromSeq}-${s.toSeq}`).join(", ")}] — capture-recent claims them; \`nav-recorder discard\` drops them (day files then go by recording.bufferHours / unclaimedKeepDays)`
          : `nothing since seq ${claim.lastSeq}`);
      } catch { /* config invalid — already reported above */ }
    }

    return { ok: checks.every((c) => c.ok), checks };
  },
};
