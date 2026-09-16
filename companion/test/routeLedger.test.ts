import { test } from "node:test";
import assert from "node:assert/strict";
import { routeLedger } from "../src/distill/routeLedger.js";
import type { InteractionEvent, InteractionTarget, NavigationEvent, RecorderEvent } from "../src/types.js";

const ORIGIN = "http://localhost:3000";
let seq = 0;
let clock = 1_700_000_000_000;
const tick = (ms: number): string => { clock += ms; return new Date(clock).toISOString(); };

function nav(path: string, over: Partial<NavigationEvent> = {}): NavigationEvent {
  const url = `${ORIGIN}${path}`;
  return { v: 1, type: "navigation", tabId: 1, tabUrl: url, origin: ORIGIN, ts: tick(1000), url, transition: "history", transitionType: "link", seq: ++seq, ...over };
}
function click(target: Partial<InteractionTarget> & { tag: string }, page: string): InteractionEvent {
  return {
    v: 1, type: "interaction", kind: "click", tabId: 1, tabUrl: `${ORIGIN}${page}`, origin: ORIGIN, ts: tick(500),
    pageUrl: `${ORIGIN}${page}`, target, selectors: [`${target.tag}:nth-of-type(1)`], button: 0, seq: ++seq,
  };
}
function reset(): void { seq = 0; clock = 1_700_000_000_000; }

/**
 * The shape of a real SPA recording: land on the dashboard, switch the top-nav tab (which does
 * NOT navigate), then click the sidebar item (which does).
 */
function spaScenario(): RecorderEvent[] {
  reset();
  return [
    nav("/Login", { transition: "committed", transitionType: "typed" }),
    click({ tag: "button", role: "button", accessibleName: "登入", label: "登入" }, "/Login"),
    nav("/Index/Home"),
    click({ tag: "span", label: "分頁A" }, "/Index/Home"),
    click({ tag: "a", role: "link", label: "預約管理", href: `${ORIGIN}/Booking/BookingFirst` }, "/Index/Home"),
    nav("/Booking/BookingFirst"),
    click({ tag: "a", role: "link", label: "首頁", href: `${ORIGIN}/Index/Home` }, "/Booking/BookingFirst"),
    nav("/Index/Home"),
    click({ tag: "a", role: "link", label: "看板", href: `${ORIGIN}/Board/BoardFirst` }, "/Index/Home"),
    nav("/Board/BoardFirst"),
  ];
}

test("counts visits and keeps first/last position", () => {
  const ledger = routeLedger(spaScenario());
  const home = ledger.find((r) => r.route === "/Index/Home")!;
  assert.equal(home.visits, 2, "a route revisited after a detour counts twice");
  assert.ok(home.firstSeq < home.lastSeq);
  assert.equal(ledger.find((r) => r.route === "/Login")!.visits, 1);
});

test("the whole window of clicks is the way in, not just the one that navigated", () => {
  // The tab switch ("分頁A") produces no navigation of its own, but without it the sidebar item is
  // not even on screen. Losing it is exactly the knowledge gap this ledger exists to close.
  const ledger = routeLedger(spaScenario());
  const booking = ledger.find((r) => r.route === "/Booking/BookingFirst")!;
  assert.deepEqual(booking.enteredBy.map((c) => c.text), ["分頁A", "預約管理"]);
  assert.deepEqual(booking.enteredBy.map((c) => c.fromRoute), ["/Index/Home", "/Index/Home"]);
  assert.equal(booking.enteredBy[0].weak, true, "a plain span is flagged so the Agent can judge it");
  assert.equal(booking.enteredBy[1].weak, undefined, "a real link is not");
});

test("most recently visited routes come first", () => {
  const ledger = routeLedger(spaScenario());
  assert.deepEqual(ledger.map((r) => r.route), [
    "/Board/BoardFirst",
    "/Index/Home",
    "/Booking/BookingFirst",
    "/Login",
  ]);
});

test("reloads of the same page are one visit", () => {
  reset();
  const events: RecorderEvent[] = [
    nav("/Index/Home"),
    nav("/Index/Home", { transition: "committed", transitionType: "reload" }),
    nav("/Index/Home", { transition: "committed", transitionType: "reload" }),
    nav("/Order/DispatchFirst"),
  ];
  const ledger = routeLedger(events);
  assert.equal(ledger.find((r) => r.route === "/Index/Home")!.visits, 1);
});

test("query strings and trailing slashes fold into one route", () => {
  reset();
  const ledger = routeLedger([nav("/Order/DispatchFirst?id=1"), nav("/Index/Home"), nav("/Order/DispatchFirst/")]);
  assert.equal(ledger.filter((r) => r.route.toLowerCase() === "/order/dispatchfirst").length, 1);
  assert.equal(ledger.find((r) => r.route === "/Order/DispatchFirst")!.visits, 2);
});

test("a recording with no interactions still produces a ledger", () => {
  reset();
  const ledger = routeLedger([nav("/Index/Home"), nav("/Order/DispatchFirst")]);
  assert.equal(ledger.length, 2);
  assert.deepEqual(ledger[0].enteredBy, []);
});

test("clicks on the page body are not menu items", () => {
  reset();
  const events: RecorderEvent[] = [
    nav("/Index/Home"),
    click({ tag: "body" }, "/Index/Home"),
    click({ tag: "input", name: "q", role: "textbox" }, "/Index/Home"),
    click({ tag: "a", role: "link", label: "訂單管理" }, "/Index/Home"),
    nav("/Order/DispatchFirst"),
  ];
  const order = routeLedger(events).find((r) => r.route === "/Order/DispatchFirst")!;
  assert.deepEqual(order.enteredBy.map((c) => c.text), ["訂單管理"]);
});

test("the first page of a recording has no way in", () => {
  const ledger = routeLedger(spaScenario());
  assert.deepEqual(ledger.find((r) => r.route === "/Login")!.enteredBy, []);
});

test("no navigations at all is an empty ledger, not a crash", () => {
  reset();
  assert.deepEqual(routeLedger([click({ tag: "a", label: "x" }, "/Index/Home")]), []);
  assert.deepEqual(routeLedger([]), []);
});

test("enteredBy is capped so one noisy page cannot flood the entry", () => {
  reset();
  const events: RecorderEvent[] = [nav("/Index/Home")];
  for (let i = 0; i < 12; i++) events.push(click({ tag: "a", role: "link", label: `項目${i}` }, "/Index/Home"));
  events.push(nav("/Order/DispatchFirst"));
  assert.equal(routeLedger(events).find((r) => r.route === "/Order/DispatchFirst")!.enteredBy.length, 5);
});
