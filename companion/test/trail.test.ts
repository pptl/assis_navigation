import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrail, describeHop, isUserNavigation } from "../src/distill/trail.js";
import type { InteractionEvent, InteractionTarget, NavigationEvent, RecorderEvent } from "../src/types.js";

const ORIGIN = "http://localhost:3000";
let seq = 0;
let clock = 1_700_000_000_000;
const tick = (ms: number): string => { clock += ms; return new Date(clock).toISOString(); };

function nav(path: string, over: Partial<NavigationEvent> = {}): NavigationEvent {
  const url = `${ORIGIN}${path}`;
  return { v: 1, type: "navigation", tabId: 1, tabUrl: url, origin: ORIGIN, ts: tick(1000), url, transition: "history", transitionType: "link", seq: ++seq, ...over };
}
function click(target: Partial<InteractionTarget> & { tag: string }, over: Partial<InteractionEvent> = {}, page = "/Index/Home"): InteractionEvent {
  const selectors = over.selectors ?? (target.accessibleName ? [`aria/${target.accessibleName}${target.role ? `[role="${target.role}"]` : ""}`] : [`${target.tag}:nth-of-type(1)`]);
  return { v: 1, type: "interaction", kind: "click", tabId: 1, tabUrl: `${ORIGIN}${page}`, origin: ORIGIN, ts: tick(1000), pageUrl: `${ORIGIN}${page}`, target, selectors, button: 0, seq: ++seq, ...over };
}
function input(name: string, value: string): InteractionEvent {
  return { v: 1, type: "interaction", kind: "input", tabId: 1, tabUrl: `${ORIGIN}/Login`, origin: ORIGIN, ts: tick(500), pageUrl: `${ORIGIN}/Login`, target: { tag: "input", name, role: "textbox" }, selectors: [`input[name="${name}"]`], value, seq: ++seq };
}
function reset(): void { seq = 0; clock = 1_700_000_000_000; }

/** A real SPA recording, with the three menu clicks that were missing back then. */
function spaScenario(): RecorderEvent[] {
  reset();
  return [
    nav("/", { transition: "committed", transitionType: "typed" }),
    nav("/Login", { transitionType: "auto_toplevel" }),
    input("login--userName", "demo-user"),
    input("login--password", "***"),
    click({ tag: "button", role: "button", accessibleName: "登入" }, {}, "/Login"),
    nav("/Index/Home"),
    nav("/Index/Home", { transition: "committed", transitionType: "reload" }),
    click({ tag: "a", role: "link", accessibleName: "排程", href: `${ORIGIN}/Schedule/ScheduleFirst` }),
    nav("/Schedule/ScheduleFirst"),
    click({ tag: "a", role: "link", accessibleName: "首頁", href: `${ORIGIN}/Index/Home` }, {}, "/Schedule/ScheduleFirst"),
    nav("/Index/Home"),
    click({ tag: "body" }),
    // the top-nav tab: a <span> inside a button whose aria-label ("topMainNavBar") is shared by every tab → no usable ancestor name
    click({ tag: "span", accessibleName: "分頁A", label: "分頁A", nameUnique: true, interactive: { tag: "button", role: "button", name: "topMainNavBar", nameUnique: false } }, { selectors: ["aria/分頁A", "text/分頁A"] }),
    // clicking the tab reloads /Index/Home in that app — a "reload" navigation must neither split the visit nor attach to the click
    nav("/Index/Home", { transition: "committed", transitionType: "reload" }),
    // MUI ListItemButton: the text <span> is promoted to its <div role="button"> ancestor
    click({ tag: "span", accessibleName: "預約管理", label: "預約管理", interactive: { tag: "div", role: "button", name: "預約管理", nameUnique: true } }, { selectors: ['aria/預約管理[role="button"]'] }),
    click({ tag: "span", accessibleName: "預約管理", label: "預約管理", interactive: { tag: "div", role: "button", name: "預約管理", nameUnique: true } }, { selectors: ['aria/預約管理[role="button"]'] }),
    // a plain wrapper div with no role anywhere near it: kept, but weak
    click({ tag: "div", accessibleName: "某個沒有語意的區塊", label: "某個沒有語意的區塊" }),
    click({ tag: "span", accessibleName: "預約", label: "預約", href: `${ORIGIN}/Booking/BookingFirst`, interactive: { tag: "div", role: "button", name: "預約 ❐", nameUnique: true } }, { selectors: ['aria/預約 ❐[role="button"]'] }),
    nav("/Booking/BookingFirst"),
  ];
}

test("trail: folds the detour, keeps the last visit's clicks, attaches the navigation to the link click", () => {
  const events = spaScenario();
  const anchor = events[events.length - 1];
  const trail = buildTrail(events, anchor.seq!, { fromSeq: 1 });
  assert.deepEqual(trail.pages, ["/", "/Login", "/Index/Home", "/Booking/BookingFirst"]);
  assert.equal(trail.hops.length, 3);

  const last = trail.hops[2];
  assert.equal(last.from, "/Index/Home");
  assert.equal(last.to, "/Booking/BookingFirst");
  assert.equal(last.transitionType, "link");
  // body click dropped, the duplicated group click folded into one, four clicks remain
  assert.deepEqual(last.clicks.map((c) => c.text), ["分頁A", "預約管理", "某個沒有語意的區塊", "預約"]);
  assert.equal(last.clicks[0].role, "button", "role comes from the promoted interactive ancestor");
  assert.equal(last.clicks[0].weak, undefined);
  assert.equal(last.clicks[0].assertedNavigation, undefined, "the reload after the tab click is not attributed to it");
  assert.equal(last.clicks[1].role, "button");
  assert.equal(last.clicks[1].weak, undefined, "span inside div[role=button] is strong");
  assert.equal(last.clicks[2].weak, true, "plain div without any widget role is kept but marked weak");
  assert.equal(last.clicks[3].assertedNavigation, "/Booking/BookingFirst");
  assert.equal(last.clicks[3].role, "button");
  assert.equal(trail.dropped.noiseClicks, 1);
  assert.equal(trail.dropped.inputs, 2);

  // the login hop: the submit click leads to /Index/Home
  const login = trail.hops[1];
  assert.equal(login.from, "/Login");
  assert.equal(login.to, "/Index/Home");
  assert.deepEqual(login.clicks.map((c) => c.text), ["登入"]);
  assert.equal(login.clicks[0].assertedNavigation, "/Index/Home");

  const note = describeHop(last, ORIGIN);
  assert.match(note, /^在 \/Index\/Home：點「分頁A」\(button\) → 點「預約管理」\(button\) → 點「某個沒有語意的區塊」\(weak\) → 點「預約」\(button, href \/Booking\/BookingFirst\) → 進入 \/Booking\/BookingFirst$/);
});

test("trail: typed / reload navigations are not attached to a preceding click; old recordings without transitionType still attach", () => {
  reset();
  const events: RecorderEvent[] = [
    nav("/Index/Home", { transition: "committed", transitionType: "typed" }),
    click({ tag: "button", role: "button", accessibleName: "無關的按鈕" }),
    nav("/Orders/List", { transition: "committed", transitionType: "typed" }),
    click({ tag: "a", role: "link", accessibleName: "明細", href: `${ORIGIN}/Orders/Detail` }, {}, "/Orders/List"),
    nav("/Orders/Detail", { transitionType: undefined }),
  ];
  const trail = buildTrail(events, events[events.length - 1].seq!);
  assert.equal(trail.hops[0].clicks[0].assertedNavigation, undefined, "typed navigation must not be attributed to the click");
  assert.equal(trail.hops[1].clicks[0].assertedNavigation, "/Orders/Detail", "missing transitionType (pre-upgrade extension) is treated as user navigation");
  assert.equal(isUserNavigation(nav("/x", { transitionType: "reload" })), false);
  assert.equal(isUserNavigation(nav("/x", { transitionType: "link" })), true);
});

test("trail: a click older than the attach window is not attached; a 'key' Enter on a form field is kept", () => {
  reset();
  const events: RecorderEvent[] = [
    nav("/Orders/List", { transition: "committed", transitionType: "typed" }),
    click({ tag: "input", role: "textbox", name: "keyword" }, { kind: "key", key: "Enter", selectors: ['input[name="keyword"]'] }, "/Orders/List"),
    click({ tag: "a", role: "link", accessibleName: "第一筆", href: `${ORIGIN}/Orders/Detail` }, {}, "/Orders/List"),
    nav("/Orders/Detail", { ts: new Date(clock + 20_000).toISOString() }),
  ];
  const trail = buildTrail(events, events[events.length - 1].seq!, { attachWindowMs: 5000 });
  const hop = trail.hops[0];
  assert.deepEqual(hop.clicks.map((c) => c.kind), ["key", "click"]);
  assert.equal(hop.clicks[1].assertedNavigation, undefined, "20 s later is outside the attach window");
  assert.equal(trail.dropped.noiseClicks, 0, "Enter on an input is a submission, not noise");
});

test("trail: no interactions recorded → hops come from navigations alone with empty clicks", () => {
  reset();
  const events: RecorderEvent[] = [nav("/Login", { transition: "committed", transitionType: "typed" }), nav("/Index/Home"), nav("/Apps/Detail")];
  const trail = buildTrail(events, 3);
  assert.deepEqual(trail.pages, ["/Login", "/Index/Home", "/Apps/Detail"]);
  assert.deepEqual(trail.hops.map((h) => h.clicks.length), [0, 0]);
});
