// Shared type definitions for events, config and on-disk files.

// ---------- Recorder events (produced by the extension, enriched by the host) ----------

export interface BaseEvent {
  v: 1;
  tabId: number;
  tabUrl: string;
  origin: string;
  ts: string;
  /** Assigned by the host when the event lands on disk (monotonic per project). */
  seq?: number;
  receivedAt?: string;
}

export interface RequestEvent extends BaseEvent {
  type: "request";
  requestId: string;
  via: "fetch" | "xhr";
  durationMs: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  responseTruncated: boolean;
  /** on disk only: a long body stored once in the file's `.bodies.ndjson` sidecar (sha1); readers restore responseBody */
  responseBodyRef?: string;
  error?: string;
  /** response arrived but its body could not be read (status/headers are still valid) */
  bodyError?: string;
  /** requestIds whose auth artefacts (token / cookie) this request carried. Filled by the host. */
  authSources?: string[];
}

export interface NavigationEvent extends BaseEvent {
  type: "navigation";
  url: string;
  transition: "committed" | "history";
  /** chrome.webNavigation transitionType: "link", "typed", "reload", "auto_bookmark", ... (absent on old recordings) */
  transitionType?: string;
  transitionQualifiers?: string[];
}

/** What the user clicked/typed, as described by extension/interactions.js. Every field is best-effort. */
export interface InteractionTarget {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  /** explicit role attribute or the tag's implicit role (link, button, tab, textbox, ...) */
  role?: string;
  accessibleName?: string;
  /** whether accessibleName + role single out this element on the page (aria-label reused as a tag → false) */
  nameUnique?: boolean;
  /** best human label: the accessible name when unique, else the visible text */
  label?: string;
  text?: string;
  /** absolute href of the element or its closest <a href> */
  href?: string;
  testId?: { attr: string; value: string };
  /** closest ancestor with a widget role when the clicked node itself has none (MUI: <span> inside <div role="button">) */
  interactive?: { tag: string; role?: string; name?: string; nameUnique?: boolean };
  /** up to 3 ancestors that carry a role or aria-label, nearest first */
  ancestors?: { tag: string; role?: string; name?: string }[];
}

export interface InteractionEvent extends BaseEvent {
  type: "interaction";
  kind: "click" | "input" | "key";
  /** location.href at the time of the interaction */
  pageUrl: string;
  target: InteractionTarget;
  /** alternative selectors, most stable first: "aria/Name[role=...]", "[data-testid=...]", "#id", css path, "text/..." */
  selectors: string[];
  key?: string;
  /** change events only; passwords are always "***" */
  value?: string;
  button?: number;
}

export type RecorderEvent = RequestEvent | NavigationEvent | InteractionEvent;

export function isRequestEvent(ev: RecorderEvent): ev is RequestEvent {
  return ev.type === "request";
}

export function isInteractionEvent(ev: RecorderEvent): ev is InteractionEvent {
  return ev.type === "interaction";
}

// ---------- Project config (.nav-recorder/config.json) ----------

export interface ApiCall {
  method: string;
  /** Relative to apiBases[] (no leading slash) or absolute. */
  url: string;
}

export interface LoginUi {
  kind: "ui";
  url: string;
  fields: { username: string; password: string };
  submit: string;
  successCheck?: { urlNot?: string; urlIncludes?: string; selector?: string };
  /** Optional: the login API as recorded, used only to classify the recorded login request. */
  call?: ApiCall;
}

export interface LoginApi {
  kind: "api";
  call: ApiCall;
  /** Template body; string values may contain {{username}}, {{password}}, {{md5(password)}}, {{uuid()}}, {{now()}}. */
  bodyTemplate: Record<string, unknown>;
  storageSeed?: {
    localStorage?: Record<string, string>;
    sessionStorage?: Record<string, string>;
  };
}

export type LoginConfig = LoginUi | LoginApi;

export interface AuthConfig {
  kind: "bearer" | "cookie" | "none";
  header?: string;
  tokenSource?: { area: "localStorage" | "sessionStorage"; key: string };
}

export interface StorageResetConfig {
  indexedDB: { db: string; stores: string[] }[];
  localStorage: string[];
  sessionStorage: string[];
}

export type SchemaSource =
  | { kind: "openapi"; glob: string }
  | { kind: "efcore"; glob: string };

export interface DataSourceRule {
  pattern: string;
  verdict?: "api" | "ui";
  requiresAlso?: string;
  verdictIfMissing?: "api" | "ui";
  note?: string;
}

/**
 * How a screen is reached when nothing more specific is known about it.
 * `deeplink` = navigating straight to the URL renders the screen correctly;
 * `menu` = the app needs to be walked through its own navigation first (a shell whose sidebar /
 * main area depends on client-side state that a cold URL entry does not restore);
 * `unknown` = never established — the Agent must observe once and write the result back.
 * This is an observed behaviour, not an architecture: SPA vs. MPA does not decide it.
 */
export type NavigationEntry = "deeplink" | "menu" | "unknown";

export interface NavigationConfig {
  entry: NavigationEntry;
  /** what was tried and what happened, so the value can be re-checked */
  evidence?: string;
}

/**
 * An API base that is looked up at load time instead of hard-coded, for projects whose dev host
 * changes over time: read `path` from a JSON `file` (relative to the project), optionally deriving
 * the path itself from a regex capture in a source file, then append a suffix.
 */
export interface DerivedApiBase {
  derive: "json";
  file: string;
  /** dotted path into the JSON file, e.g. "testConfig.devDomain"; may contain $1 when pathFrom is set */
  path: string;
  /** appended to the looked-up value; result always ends with "/" */
  append?: string;
  pathFrom?: { file: string; regex: string; template: string };
}

export type ApiBaseSpec = string | DerivedApiBase;

export interface NavConfig {
  name: string;
  appOrigins: string[];
  /** resolved API bases (always strings ending with "/") */
  apiBases: string[];
  /** the unresolved specs as written in config.json — kept so exports/round-trips preserve derivations */
  apiBasesSpec?: ApiBaseSpec[];
  readOnlyPatterns: string[];
  auth: AuthConfig;
  login: LoginConfig;
  storageReset: StorageResetConfig;
  schemaSources: SchemaSource[];
  dataSourceRules: DataSourceRule[];
  /** site-wide default for how screens are entered; per-route exceptions live in data-source-map */
  navigation: NavigationConfig;
  recording: { maxBodyKB: number; bufferHours: number; sessionGapMinutes: number; unclaimedKeepDays: number; unroutedKeepHours: number };
  execute: { maxConsecutiveFailures: number };
}

// ---------- actors.json ----------

export interface Actor {
  username: string;
  password: string;
  contextName?: string;
  note?: string;
}

export interface ActorsFile {
  actors: Record<string, Actor>;
}

// ---------- Global files under %USERPROFILE%/.nav-recorder ----------

export interface PortLease {
  /** absolute path of the project's .nav-recorder directory */
  dataDir: string;
  /** pid owning the port when the lease was written; a different pid means the lease is stale */
  pid?: number;
  since: string;
}

export interface HostsFile {
  /** origin → absolute path of the project's .nav-recorder directory. Non-loopback sites only:
   *  loopback ownership is resolved from the process holding the port, never registered. */
  origins: Record<string, string>;
  /** manual fallback for loopback ports whose owner cannot be resolved (non-node dev servers) */
  ports?: Record<string, PortLease>;
}

export interface ControlFile {
  paused: boolean;
  updatedAt: string;
}
