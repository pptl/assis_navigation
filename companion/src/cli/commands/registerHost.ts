import { execFileSync } from "node:child_process";
import { existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandDef } from "../run.js";
import { CliError } from "../../errors.js";
import { HOST_NAME, hostDir, mainScriptPath } from "../../paths.js";
import { ensureDir, writeJsonAtomic, writeText } from "../../util/fs.js";

export function hostManifestPath(name = HOST_NAME): string {
  return join(hostDir(), `${name}.json`);
}

export function hostWrapperPath(): string {
  return join(hostDir(), process.platform === "win32" ? "nav-recorder-host.cmd" : "nav-recorder-host.sh");
}

export function registryKey(name = HOST_NAME, browser: "chrome" | "edge" = "chrome"): string {
  const vendor = browser === "edge" ? "Microsoft\\Edge" : "Google\\Chrome";
  return `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${name}`;
}

function unixManifestDir(browser: "chrome" | "edge"): string {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", browser === "edge" ? "Microsoft Edge" : "Google/Chrome", "NativeMessagingHosts");
  }
  return join(home, ".config", browser === "edge" ? "microsoft-edge" : "google-chrome", "NativeMessagingHosts");
}

export const registerHostCommand: CommandDef = {
  name: "register-host",
  usage: "register-host --extension-id <id> [--browser chrome|edge] [--node <path>]",
  description: "Write the native messaging host manifest + launcher and register it for the browser.",
  handler: (ctx) => {
    const extensionId = ctx.str("extension-id");
    if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
      throw new CliError("E_USAGE", "--extension-id must be the 32-char id shown on chrome://extensions (letters a-p).");
    }
    const browser = (ctx.str("browser") ?? "chrome") as "chrome" | "edge";
    const nodePath = ctx.str("node") ?? process.execPath;
    const main = mainScriptPath();
    if (!existsSync(main)) throw new CliError("E_NOT_BUILT", `Companion is not built: ${main} missing. Run "npm run build" in companion/.`);

    ensureDir(hostDir());
    const wrapper = hostWrapperPath();
    if (process.platform === "win32") {
      // Any stray stdout output would corrupt native messaging frames — keep the wrapper silent.
      writeText(wrapper, `@echo off\r\n"${nodePath}" "${main}" %*\r\n`);
    } else {
      writeText(wrapper, `#!/bin/sh\nexec "${nodePath}" "${main}" "$@"\n`);
      chmodSync(wrapper, 0o755);
    }

    const manifest = {
      name: HOST_NAME,
      description: "nav-recorder companion (navigation recorder native messaging host)",
      path: wrapper,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    };
    const manifestFile = hostManifestPath();
    writeJsonAtomic(manifestFile, manifest);

    let registration: string;
    if (process.platform === "win32") {
      const key = registryKey(HOST_NAME, browser);
      execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestFile, "/f"], { stdio: "pipe" });
      registration = `registry ${key} → ${manifestFile}`;
    } else {
      const dir = unixManifestDir(browser);
      ensureDir(dir);
      writeJsonAtomic(join(dir, `${HOST_NAME}.json`), manifest);
      registration = `manifest copied to ${dir}`;
    }

    return {
      hostName: HOST_NAME,
      manifest: manifestFile,
      wrapper,
      node: nodePath,
      main,
      registration,
      next: ["Restart the browser so it re-reads the native host registration.", "Run `nav-recorder doctor`."],
    };
  },
};
