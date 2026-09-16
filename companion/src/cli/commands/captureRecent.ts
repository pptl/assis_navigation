import type { CommandDef } from "../run.js";
import { CliError } from "../../errors.js";
import { loadConfig } from "../../config.js";
import { resolveDataDir } from "../../paths.js";
import { captureRecent, discardRecent } from "../../distill/capture.js";
import { recentRoutes } from "../../routes/recent.js";
import { tidyRaw } from "../tidyRaw.js";

export const discardCommand: CommandDef = {
  name: "discard",
  usage: "discard",
  description: "Alias for `capture-recent --discard`: mark everything recorded so far as claimed without producing a recipe (day files then go by the retention rule).",
  handler: (ctx) => {
    const dataDir = resolveDataDir(ctx.project);
    return { mode: "discard", ...discardRecent(dataDir), ...tidyRaw(dataDir) };
  },
};

export const captureRecentCommand: CommandDef = {
  name: "capture-recent",
  usage: 'capture-recent ["<description>"] [--target-url <path>] [--actor <name>] [--from-seq <n>] [--all] [--dry-run] | capture-recent --discard',
  description: "Claim everything recorded since the last claim and distil the browsing session that reached the target into a draft recipe (--all or an explicit --from-seq distils the whole range). Without --target-url it only lists the routes the recording visited, so you can pick one instead of guessing.",
  handler: (ctx) => {
    const dataDir = resolveDataDir(ctx.project);
    if (ctx.bool("discard")) return { mode: "discard", ...discardRecent(dataDir), ...tidyRaw(dataDir) };
    const description = ctx.positionals[0];
    const targetUrl = ctx.str("target-url");
    const cfg = loadConfig(dataDir);
    const fromSeqRaw = ctx.str("from-seq");
    // No target yet: answer "which screen was this?" instead of failing. Nothing is claimed, so
    // the same recording is still there for the real call.
    if (!targetUrl) {
      const recent = recentRoutes(dataDir, cfg, fromSeqRaw !== undefined ? Number(fromSeqRaw) : undefined);
      if (!recent.events) throw new CliError("E_NO_EVENTS", `No recorded events after seq ${recent.fromSeq}. Is the extension loaded and the origin registered? (nav-recorder doctor)`);
      return {
        mode: "candidates",
        ...recent,
        note: 'Pick the route the user was describing and call again with --target-url <path> (and a description). Nothing has been claimed. Use `nav-recorder routes find <keyword>` if none of these is it.',
      };
    }
    if (!description) {
      throw new CliError("E_USAGE", 'capture-recent "<description>" --target-url <path>   (or: capture-recent --discard)');
    }
    const dryRun = ctx.bool("dry-run");
    const result = captureRecent(dataDir, cfg, {
      description,
      targetUrl,
      actor: ctx.str("actor"),
      fromSeq: fromSeqRaw !== undefined ? Number(fromSeqRaw) : undefined,
      all: ctx.bool("all"),
      dryRun,
    });
    return dryRun ? result : { ...result, ...tidyRaw(dataDir) };
  },
};
