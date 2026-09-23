import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidatePaths, isLoopbackHost, loopbackPortOf, parseLsof, parseNetstat, parsePsTable, parseProcessTable,
  projectDirOf, projectOfPid, resetPortCaches, resolveProjectOfPort, OWNER_GRACE_MS, PORT_SCAN_TTL_MS, type ProcRow,
} from "../src/util/ports.js";
import { ownerOfLoopbackPort } from "../src/hosts.js";

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       5678
  TCP    [::]:4200              [::]:0                 LISTENING       9012
  TCP    192.168.1.5:5173       0.0.0.0:0              ABHOEREN        3456
  TCP    127.0.0.1:3000         127.0.0.1:52344        ESTABLISHED     7777
  UDP    0.0.0.0:5353           *:*                                    999
`;

test("netstat: every listening TCP port whatever the bind address or the locale", () => {
  const ports = parseNetstat(NETSTAT);
  assert.equal(ports.get(135), 1234);
  assert.equal(ports.get(3000), 5678, "an established connection on the same port must not overwrite the listener");
  assert.equal(ports.get(4200), 9012, "IPv6 wildcard");
  assert.equal(ports.get(5173), 3456, "a localized state word still has the wildcard foreign address");
  assert.equal(ports.get(5353), undefined, "UDP is not a listener");
});

test("lsof: listening ports on posix", () => {
  const out = [
    "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    "node    41234 alen   23u  IPv4 0x1234      0t0  TCP *:3000 (LISTEN)",
    "node    41234 alen   24u  IPv6 0x5678      0t0  TCP [::1]:4200 (LISTEN)",
  ].join("\n");
  const ports = parseLsof(out);
  assert.equal(ports.get(3000), 41234);
  assert.equal(ports.get(4200), 41234);
});

test("process table: one row and many rows", () => {
  const one = parseProcessTable('{"ProcessId":10,"ParentProcessId":4,"CommandLine":"node x.js"}');
  assert.deepEqual([...one.keys()], [10]);
  const many = parseProcessTable('[{"ProcessId":10,"ParentProcessId":4,"CommandLine":null},{"ProcessId":11,"ParentProcessId":10,"CommandLine":"a"}]');
  assert.equal(many.get(10)?.commandLine, "", "a null command line is not readable, not a crash");
  assert.equal(many.get(11)?.parentPid, 10);
  assert.equal(parseProcessTable("not json").size, 0);
  assert.equal(parsePsTable("  4123  1 node /srv/app/x.js").get(4123)?.commandLine, "node /srv/app/x.js");
});

test("command line: absolute paths survive spaces, quotes and trailing arguments", () => {
  const quoted = String.raw`"C:\nvm4w\node.exe"  "C:\Users\A B\proj\node_modules\vite\bin\vite.js" --port 3001`;
  assert.deepEqual(candidatePaths(quoted), [String.raw`C:\nvm4w\node.exe`, String.raw`C:\Users\A B\proj\node_modules\vite\bin\vite.js`]);
  const unquoted = String.raw`node C:\Users\A B\proj\server.js --watch`;
  assert.deepEqual(candidatePaths(unquoted), [String.raw`C:\Users\A B\proj\server.js --watch`], "trailing junk is trimmed later, by walking up");
  assert.deepEqual(candidatePaths("node /srv/app/server.js"), ["/srv/app/server.js"]);
});

test("project dir: deepest ancestor holding .nav-recorder/config.json, junk trimmed from the right", () => {
  const project = String.raw`C:\Users\A B\proj`;
  const exists = (p: string): boolean => p === `${project}\\.nav-recorder\\config.json`;
  assert.equal(projectDirOf(String.raw`C:\Users\A B\proj\node_modules\vite\bin\vite.js --port 3001`, exists), `${project}\\.nav-recorder`);
  assert.equal(projectDirOf(String.raw`C:\Users\A B\other\x.js`, exists), undefined);
  assert.equal(projectDirOf("C:\\Users\\A B\\proj\\", exists), `${project}\\.nav-recorder`, "a trailing separator is not a segment");
  const posixExists = (p: string): boolean => p === "/srv/app/.nav-recorder/config.json";
  assert.equal(projectDirOf("/srv/app/node_modules/.bin/vite", posixExists), "/srv/app/.nav-recorder", "posix separators are kept");
});

test("pid → project walks up the parent chain, but not forever", () => {
  const exists = (p: string): boolean => p === String.raw`C:\proj\.nav-recorder\config.json`;
  const row = (pid: number, parentPid: number, commandLine: string): ProcRow => ({ pid, parentPid, commandLine });
  const table = new Map<number, ProcRow>([
    [10, row(10, 11, "server.exe --port 3000")],
    [11, row(11, 12, "cmd.exe /c start")],
    [12, row(12, 13, String.raw`"C:\proj\node_modules\.bin\dev"`)],
    [20, row(20, 21, "a")], [21, row(21, 22, "b")], [22, row(22, 23, "c")], [23, row(23, 24, "d")],
    [24, row(24, 0, String.raw`"C:\proj\x"`)],
  ]);
  assert.equal(projectOfPid(10, table, exists), String.raw`C:\proj\.nav-recorder`);
  assert.equal(projectOfPid(20, table, exists), undefined, "four hops away is out of reach");
  assert.equal(projectOfPid(999, table, exists), undefined);
});

test("loopback origins", () => {
  assert.equal(loopbackPortOf("http://localhost:3000"), 3000);
  assert.equal(loopbackPortOf("http://127.0.0.1:5173"), 5173);
  assert.equal(loopbackPortOf("http://[::1]:8080"), 8080);
  assert.equal(loopbackPortOf("https://localhost"), 443, "default port");
  assert.equal(loopbackPortOf("https://test.example.com"), undefined);
  assert.equal(isLoopbackHost("app.localhost"), true);
});

test("port ownership is re-resolved only when the owning process changes", () => {
  resetPortCaches();
  const exists = (p: string): boolean => p === "C:\\a\\.nav-recorder\\config.json" || p === "C:\\b\\.nav-recorder\\config.json";
  const table = new Map<number, ProcRow>([
    [100, { pid: 100, parentPid: 0, commandLine: String.raw`"C:\a\node_modules\vite\bin\vite.js"` }],
    [200, { pid: 200, parentPid: 0, commandLine: String.raw`"C:\b\node_modules\vite\bin\vite.js"` }],
  ]);
  let tableReads = 0;
  const readTable = (): Map<number, ProcRow> => { tableReads++; return table; };
  let pid = 100;
  const readPorts = (): Map<number, number> => new Map(pid ? [[3000, pid]] : []);
  const at = (t: number) => ({ now: t, readPorts, readTable, exists });

  assert.equal(resolveProjectOfPort(3000, at(0)), String.raw`C:\a\.nav-recorder`);
  assert.equal(resolveProjectOfPort(3000, at(1_000)), String.raw`C:\a\.nav-recorder`);
  assert.equal(tableReads, 1, "same pid: no second process-table read");

  // the port changes hands: the answer follows the process, with no registration anywhere
  pid = 200;
  const afterScan = PORT_SCAN_TTL_MS + 1;
  assert.equal(resolveProjectOfPort(3000, at(afterScan)), String.raw`C:\b\.nav-recorder`);
  assert.equal(tableReads, 2);

  // dev server stopped: the page may still be open, so the last owner stands for a grace period
  pid = 0;
  assert.equal(resolveProjectOfPort(3000, at(afterScan + PORT_SCAN_TTL_MS + 1)), String.raw`C:\b\.nav-recorder`);
  assert.equal(resolveProjectOfPort(3000, at(afterScan + PORT_SCAN_TTL_MS + 1 + OWNER_GRACE_MS)), undefined, "…but not forever");
  resetPortCaches();
});

test("a manual lease only counts while its process still holds the port", () => {
  resetPortCaches();
  const manual = String.raw`C:\manual\.nav-recorder`;
  const hosts = { origins: {}, ports: { "3000": { dataDir: manual, pid: 500, since: "" } } };
  const exists = (p: string): boolean => p === String.raw`C:\auto\.nav-recorder\config.json`;
  const server = (pid: number): Map<number, ProcRow> => new Map([[pid, { pid, parentPid: 0, commandLine: String.raw`"C:\auto\server.js"` }]]);

  const pinned = { readPorts: () => new Map([[3000, 500]]), readTable: () => server(500), exists, now: 1 };
  assert.deepEqual(ownerOfLoopbackPort(3000, hosts, pinned), { dataDir: manual, via: "lease" },
    "an explicit override for this exact process");

  // the port changed hands: the lease is stale, so what is actually serving the port decides
  const handedOver = { readPorts: () => new Map([[3000, 501]]), readTable: () => server(501), exists, now: 100_000 };
  assert.deepEqual(ownerOfLoopbackPort(3000, hosts, handedOver), { dataDir: String.raw`C:\auto\.nav-recorder`, via: "resolved" });
  resetPortCaches();
});
