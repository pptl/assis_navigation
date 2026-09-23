import type { CommandDef } from "../run.js";
import { CliError } from "../../errors.js";
import { loadConfig } from "../../config.js";
import { resolveDataDir } from "../../paths.js";
import { executeNext, executeReport, executeStart, type ReportInput } from "../../execute/session.js";
import { deleteSession, loadSession, type StorageSnapshot } from "../../store/sessions.js";
import { withLiveOrigin } from "../../execute/urls.js";
import { existsSync } from "node:fs";
import { readText } from "../../util/fs.js";

function parseJsonFlag(value: string | undefined, name: string): unknown {
  if (value === undefined) return undefined;
  // Accept @file to avoid shell-quoting large JSON bodies.
  const text = value.startsWith("@") && existsSync(value.slice(1)) ? readText(value.slice(1)) : value;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError("E_USAGE", `--${name} is not valid JSON: ${(e as Error).message}`);
  }
}

export const executeStartCommand: CommandDef = {
  name: "execute-start",
  usage: "execute-start <recipe-name> [--probe]",
  description: "Start coordinating a recipe run; returns a sessionId.",
  handler: (ctx) => {
    const name = ctx.positionals[0];
    if (!name) throw new CliError("E_USAGE", "execute-start <recipe-name>");
    const dataDir = resolveDataDir(ctx.project);
    const { cfg, appOrigin } = withLiveOrigin(dataDir, loadConfig(dataDir));
    return { ...executeStart(dataDir, cfg, name, ctx.bool("probe")), appOrigin };
  },
};

export const executeNextCommand: CommandDef = {
  name: "execute-next",
  usage: "execute-next <sessionId>",
  description: "Get the next concrete action for Agent dev to perform (login/fetch/click...).",
  handler: (ctx) => {
    const id = ctx.positionals[0];
    if (!id) throw new CliError("E_USAGE", "execute-next <sessionId>");
    const dataDir = resolveDataDir(ctx.project);
    const { cfg, appOrigin } = withLiveOrigin(dataDir, loadConfig(dataDir));
    return { ...executeNext(dataDir, cfg, id), appOrigin };
  },
};

export const executeCancelCommand: CommandDef = {
  name: "execute-cancel",
  usage: "execute-cancel <sessionId>",
  description: "Abort a coordination session (browser state is untouched).",
  handler: (ctx) => {
    const id = ctx.positionals[0];
    if (!id) throw new CliError("E_USAGE", "execute-cancel <sessionId>");
    const dataDir = resolveDataDir(ctx.project);
    const s = loadSession(dataDir, id);
    deleteSession(dataDir, id);
    return { sessionId: id, recipeName: s.recipeName, wasAtStep: s.pending?.stepIndex ?? s.cursor.stepIndex, cancelled: true };
  },
};

export const executeReportCommand: CommandDef = {
  name: "execute-report",
  usage: "execute-report <sessionId> --status ok|error [--http-status <n>] [--response <json|@file>] [--captured <json>] [--storage-snapshot <json|@file>] [--message <text>]",
  description: "Report the outcome of the last action; returns continue | halt | done.",
  handler: (ctx) => {
    const id = ctx.positionals[0];
    const status = ctx.str("status");
    if (!id || (status !== "ok" && status !== "error")) throw new CliError("E_USAGE", "execute-report <sessionId> --status ok|error ...");
    const dataDir = resolveDataDir(ctx.project);
    // Best effort: an outcome must still be reportable when the dev server has gone away mid-run.
    const { cfg } = withLiveOrigin(dataDir, loadConfig(dataDir), { required: false });
    const httpStatusRaw = ctx.str("http-status");
    const input: ReportInput = {
      status,
      message: ctx.str("message"),
      httpStatus: httpStatusRaw !== undefined ? Number(httpStatusRaw) : undefined,
      response: parseJsonFlag(ctx.str("response"), "response"),
      captured: parseJsonFlag(ctx.str("captured"), "captured") as Record<string, unknown> | undefined,
      storageSnapshot: parseJsonFlag(ctx.str("storage-snapshot"), "storage-snapshot") as StorageSnapshot | undefined,
    };
    if (input.httpStatus !== undefined && Number.isNaN(input.httpStatus)) throw new CliError("E_USAGE", "--http-status must be a number");
    return executeReport(dataDir, cfg, id, input);
  },
};
