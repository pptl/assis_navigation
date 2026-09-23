import type { CommandDef } from "../run.js";
import { initCommand } from "./init.js";
import { doctorCommand } from "./doctor.js";
import { registerHostCommand } from "./registerHost.js";
import { pauseCommand, resumeCommand } from "./pause.js";
import { getActorCommand, getRecipeCommand, listCommand, saveRecipeCommand } from "./recipes.js";
import { executeCancelCommand, executeNextCommand, executeReportCommand, executeStartCommand } from "./execute.js";
import { captureRecentCommand, discardCommand } from "./captureRecent.js";
import { dataSourceCommand } from "./dataSource.js";
import { routesCommand } from "./routes.js";
import { portsCommand } from "./ports.js";
import { activateCommand } from "./activate.js";

const all: CommandDef[] = [
  initCommand,
  registerHostCommand,
  doctorCommand,
  listCommand,
  getRecipeCommand,
  saveRecipeCommand,
  getActorCommand,
  captureRecentCommand,
  discardCommand,
  executeStartCommand,
  executeNextCommand,
  executeReportCommand,
  executeCancelCommand,
  dataSourceCommand,
  routesCommand,
  portsCommand,
  activateCommand,
  pauseCommand,
  resumeCommand,
];

export const commands: Record<string, CommandDef> = Object.fromEntries(all.map((c) => [c.name, c]));
