import type { CommandDef } from "../run.js";
import { saveControl } from "../../hosts.js";

/**
 * pause/resume write control.json. The native host re-reads it on every event and drops events
 * while paused (server-side enforcement), and also pushes pause/resume to the extension.
 */
export const pauseCommand: CommandDef = {
  name: "pause",
  usage: "pause",
  description: "Stop recording (use before driving the user's real browser).",
  handler: () => ({ ...saveControl(true) }),
};

export const resumeCommand: CommandDef = {
  name: "resume",
  usage: "resume",
  description: "Resume recording.",
  handler: () => ({ ...saveControl(false) }),
};
