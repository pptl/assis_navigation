#!/usr/bin/env node
// Entry point. Chrome launches the native host with `chrome-extension://<id>/` as an argument;
// anything else is a CLI invocation.
import { runNativeHost } from "./native/host.js";
import { runCli } from "./cli/run.js";

const args = process.argv.slice(2);
const nativeMode = args.some((a) => a.startsWith("chrome-extension://"));

if (nativeMode) {
  runNativeHost()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
} else {
  runCli(args)
    .then((code) => { process.exitCode = code; })
    .catch(() => { process.exitCode = 1; });
}
