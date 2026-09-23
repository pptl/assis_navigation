import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FrameParser, encodeFrame } from "../src/native/framing.js";
import { bodiesPathOf, readEvents } from "../src/store/raw.js";
import { writeJsonAtomic } from "../src/util/fs.js";
import type { InteractionEvent, NavigationEvent, RequestEvent } from "../src/types.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWxpY2UiLCJpYXQiOjE3MDAwMDAwMDB9.abcdefghijklmnopqrstuvwxyz012345";
const BIG = JSON.stringify({ rows: Array.from({ length: 30 }, (_, i) => ({ id: `ROW-${i}`, name: `order row ${i}` })) });

// A port nothing on the machine is likely to hold, so resolution finds no owning process and the
// pid-less lease (the manual fallback) decides. ORPHAN stands for a loopback port nobody claims.
const PORT = 39517;
const ORPHAN = 39518;
const APP = `http://localhost:${PORT}`;

function req(id: string, over: Partial<RequestEvent>): RequestEvent {
  return {
    v: 1, type: "request", requestId: id, via: "fetch", tabId: 1, tabUrl: `${APP}/Login`, origin: APP,
    ts: new Date().toISOString(), durationMs: 5, method: "POST", url: "https://api.example/app/x", requestHeaders: {}, requestBody: null,
    status: 200, responseHeaders: {}, responseBody: null, responseTruncated: false, ...over,
  };
}

test("native host: ident-ack, routes loopback events by port, stages what it cannot place, enriches authSources", async () => {
  const home = mkdtempSync(join(tmpdir(), "navrec-home-"));
  const dataDir = join(home, "proj", ".nav-recorder");
  mkdirSync(dataDir, { recursive: true });
  writeJsonAtomic(join(home, "hosts.json"), { origins: {}, ports: { [String(PORT)]: { dataDir, since: new Date().toISOString() } } });

  const main = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.js");
  const child = spawn(process.execPath, [main, "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"], {
    env: { ...process.env, NAV_RECORDER_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const parser = new FrameParser();
  const replies: unknown[] = [];
  child.stdout.on("data", (c: Buffer) => replies.push(...parser.push(c)));
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });

  child.stdin.write(encodeFrame({ type: "ident", extensionId: "abc", version: "0.1.0" }));
  child.stdin.write(encodeFrame(req("login", { url: "https://api.example/app/auth/login", responseBody: `{"success":true,"data":{"token":"${JWT}"}}` })));
  child.stdin.write(encodeFrame(req("search", { url: "https://api.example/app/orders/OrderSearch", requestHeaders: { authorization: `Bearer ${JWT}` } })));
  child.stdin.write(encodeFrame({ v: 1, type: "navigation", tabId: 1, tabUrl: `${APP}/Orders/List`, origin: APP, ts: new Date().toISOString(), url: `${APP}/Orders/List`, transition: "history", transitionType: "link", transitionQualifiers: [] }));
  child.stdin.write(encodeFrame({ v: 1, type: "interaction", kind: "click", tabId: 1, tabUrl: `${APP}/Orders/List`, origin: APP, ts: new Date().toISOString(), pageUrl: `${APP}/Orders/List`, target: { tag: "a", role: "link", accessibleName: "明細", href: `${APP}/Orders/Detail` }, selectors: ['aria/明細[role="link"]', "a[href=\"/Orders/Detail\"]"], button: 0 }));
  child.stdin.write(encodeFrame(req("list1", { url: "https://api.example/app/orders/OrderList", responseBody: BIG })));
  child.stdin.write(encodeFrame(req("list2", { url: "https://api.example/app/orders/OrderList", responseBody: BIG })));
  child.stdin.write(encodeFrame(req("foreign", { origin: "http://other:1234", tabUrl: "http://other:1234/" })));
  child.stdin.write(encodeFrame(req("orphan", { origin: `http://localhost:${ORPHAN}`, tabUrl: `http://localhost:${ORPHAN}/` })));
  child.stdin.end();

  const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
  assert.equal(code, 0, stderr);

  const ack = replies.find((r) => (r as { type?: string }).type === "ident-ack") as { origins: string[]; paused: boolean } | undefined;
  assert.ok(ack, "ident-ack missing");
  assert.deepEqual(ack.origins, [], "loopback needs no whitelist: the extension records every loopback page");
  assert.equal(ack.paused, false);

  const events = readEvents(dataDir);
  assert.deepEqual(events.map((e) => e.type), ["request", "request", "navigation", "interaction", "request", "request"]);
  assert.deepEqual(events.slice(4).map((e) => (e as RequestEvent).responseBody), [BIG, BIG], "bodies read back in full");
  const search = events[1] as RequestEvent;
  assert.deepEqual(search.authSources, ["login"]);
  assert.equal(events[2].seq, 3);
  const nav = events[2] as NavigationEvent;
  assert.equal(nav.transitionType, "link");
  const click = events[3] as InteractionEvent;
  assert.equal(click.seq, 4);
  assert.equal(click.kind, "click");
  assert.equal(click.target.accessibleName, "明細");
  assert.deepEqual(click.selectors, ['aria/明細[role="link"]', "a[href=\"/Orders/Detail\"]"]);
  assert.ok(!("authSources" in click), "interactions never go through auth provenance");
  assert.ok(existsSync(join(dataDir, "raw", "auth-provenance.json")));
  assert.ok(existsSync(join(home, "host.log")));

  // The loopback port nobody owns is staged, not dropped; the non-loopback origin is ignored entirely.
  const staged = readEvents(join(home, "unrouted"));
  assert.deepEqual(staged.map((e) => (e as RequestEvent).requestId), ["orphan"]);

  // on disk the repeated body is stored once and referenced from both lines
  const dayName = readdirSync(join(dataDir, "raw")).find((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f));
  assert.ok(dayName);
  const dayFile = join(dataDir, "raw", dayName);
  const lines = readFileSync(dayFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as RequestEvent);
  assert.equal(lines.filter((l) => l.responseBodyRef).length, 2);
  assert.equal(readFileSync(bodiesPathOf(dayFile), "utf8").trim().split("\n").length, 1);
});
