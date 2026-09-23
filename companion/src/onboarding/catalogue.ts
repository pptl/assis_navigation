import type { NavConfig } from "../types.js";
import { validateConfig, withDefaults } from "../config.js";
import { validateApiBaseSpec } from "../derive.js";

/**
 * The onboarding questionnaire. This is the single source of truth for:
 *  - which facts a project config needs,
 *  - where Agent dev should look for evidence in the code (hint),
 *  - how to verify against the live app with Playwright (verify),
 *  - what to ask the user when inference fails (question).
 * Wording must stay project-neutral — a test scans it for project-specific vocabulary.
 */

export type AnswerSource = "code" | "user" | "verified" | "default" | "template";

export interface FieldDef {
  key: string;
  required: boolean;
  /** dotted path into NavConfig; undefined for fields that do not land in config.json */
  configPath?: string;
  hint: string;
  verify?: string;
  question?: string;
  default?: unknown;
  validate: (value: unknown) => string[];
}

function viaConfig(section: keyof NavConfig): (value: unknown) => string[] {
  return (value) => {
    const cfg = withDefaults({ [section]: value } as Partial<NavConfig>);
    return validateConfig(cfg).filter((e) => e.toLowerCase().includes(String(section).toLowerCase()));
  };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export interface ActorAnswer {
  role: string;
  username: string;
  contextName?: string;
  note?: string;
}

export interface SmokeVerifyAnswer {
  selector?: string;
  text?: string;
}

export const CATALOGUE: FieldDef[] = [
  {
    key: "name",
    required: false,
    configPath: "name",
    hint: "專案名稱，只用於顯示與範本資料夾名（examples/<name>/）。預設為專案資料夾名稱轉小寫；一律小寫，避免在不分大小寫的檔案系統上與既有範本撞名。",
    validate: (v) => (isNonEmptyString(v) && /^[a-z0-9._-]+$/.test(v) ? [] : ["name must be lowercase and match [a-z0-9._-]+"]),
  },
  {
    key: "appOrigins",
    required: true,
    configPath: "appOrigins",
    hint: "本機開發站台的 origin。看 package.json scripts（PORT=、--port）、vite.config.* 的 server.port、.env*（PORT / VITE_PORT）、angular.json 的 serve 設定、launchSettings.json 的 applicationUrl、webpack devServer.port；都沒有就用框架預設（CRA/Next 3000、Vite 5173、Angular 4200）。埠只是這裡的預設值，不必固定：錄製歸屬與執行網址都是依實際在監聽的埠判斷的（nav-recorder ports）。",
    verify: "用 browser_navigate 打開該網址，能載入應用程式即為 verified。",
    question: "本機開發站台的網址是什麼（含 http(s):// 與埠號）？",
    validate: viaConfig("appOrigins"),
  },
  {
    key: "apiBases",
    required: true,
    configPath: "apiBases",
    hint: "API 根網址 = 主機 + 應用程式路徑前綴，以 / 結尾。主機：看請求封裝層（fetch/axios/ky 的 baseURL 常數、環境變數如 *_API_URL / *_API_BASE）、package.json 的 proxy、vite.config 的 server.proxy。前綴：看組 URL 的工具函式（`${domain}/…` 的拼接）或另一個設定檔（例如 IIS 應用程式名、/api、/v1）——前綴幾乎一定存在，主機後面只接 / 幾乎一定是錯的。dev 環境若打遠端主機，填遠端。若主機值存在某個 JSON（例如 package.json 裡的環境對照表）且會隨時間更換，改填推導物件 {derive:'json', file, path, append, pathFrom?:{file, regex, template}}，其中 append 必須含前綴（例如 '/app-name/'），Companion 每次載入都會重新查值。",
    verify: "回答後看輸出的 resolvedPreview：它必須等於瀏覽器真實請求的 origin + 前綴（打開站台做一次操作，用 browser_network_requests 對照）。resolvedPreview 若只是純 origin（結尾是 host/），代表 append 漏了前綴。",
    question: "API 主機是什麼（dev 環境打本機還是遠端）？API 路徑前綴是什麼（例如 /api、/v1 或應用程式名稱）？主機值是固定的，還是寫在某個設定檔裡會更換？",
    validate: (v) => {
      if (!Array.isArray(v) || v.length === 0) return ["apiBases must be a non-empty array"];
      return v.flatMap((s, i) => validateApiBaseSpec(s, i));
    },
  },
  {
    key: "auth",
    required: true,
    configPath: "auth",
    hint: "API 請求怎麼帶身份。看請求封裝層：有 Authorization: Bearer 且 token 來自 localStorage/sessionStorage.getItem(<key>) → {kind:'bearer', header, tokenSource:{area,key}}；用 credentials:'include' / withCredentials 而沒有 header → {kind:'cookie'}；都沒有 → {kind:'none'}。",
    verify: "登入後用 browser_evaluate 讀該 storage key，確認 token 真的在那裡。",
    question: "登入後 API 的身份怎麼帶：是 Bearer token（存在哪個 storage 的哪個 key），還是 cookie？",
    validate: viaConfig("auth"),
  },
  {
    key: "login",
    required: true,
    configPath: "login",
    hint: "登入方式。優先 {kind:'ui'}：路由設定找登入頁 path；登入元件找帳號/密碼欄位的 name / id / data-testid / placeholder 與送出按鈕，寫成 selector；登入成功後導向哪裡寫進 successCheck（urlNot / urlIncludes / selector）；登入 API 的 method 與相對路徑寫進 call（用來辨識錄製裡的登入請求）。只有登入流程無法用 UI 完成時才用 {kind:'api'} 並填 bodyTemplate 與 storageSeed。",
    verify: "用 browser_navigate 開登入頁、browser_snapshot 確認三個 selector 都能唯一對上元素。",
    question: "登入頁網址是什麼？帳號、密碼欄位與登入按鈕要怎麼辨識？登入成功後會跳到哪一頁？",
    validate: viaConfig("login"),
  },
  {
    key: "readOnlyPatterns",
    required: false,
    configPath: "readOnlyPatterns",
    default: [],
    hint: "讀取型 API 的辨識規則（結尾錨定的 regex，比對不分大小寫）。先看請求封裝層的預設 method：讀取都用 GET 就回答 [] 並在 evidence 說明。讀取也走 POST 時，先跑 `nav-recorder init suggest-readonly --files \"<service/adapter 層的 glob>\"` 取得端點結尾動詞的完整直方圖；直方圖裡每個出現 ≥2 次的動詞都要歸類為讀取 / 寫入 / 不確定，不可只取前幾名；不確定的動詞去看該端點的 request body 與呼叫處決定。最後把所有讀取動詞放進一個結尾錨定的 pattern（例如 (Search|Detail|List|Report)$）。切勿用子字串比對，會誤刪寫入型請求。回答後檢查輸出的 warnings，它會列出直方圖中還沒被任何 pattern 涵蓋的高頻動詞。",
    verify: "回答後的 warnings 沒有未涵蓋動詞；之後 capture-recent 的 evidence.dropped 會回饋是否誤刪。",
    question: "這個專案的讀取型 API 是 GET 嗎？如果也走 POST，讀取型端點的命名慣例是什麼（請把所有讀取用的結尾動詞列完整，例如 Search / List / Detail / Report / Statistics）？",
    validate: (v) => {
      const errors = viaConfig("readOnlyPatterns")(v);
      if (Array.isArray(v)) {
        v.forEach((s, i) => {
          if (typeof s === "string" && !s.includes("$") && !s.startsWith("^")) errors.push(`readOnlyPatterns[${i}] must be anchored ($ at the end or ^ at the start); a bare substring would also match write endpoints: ${s}`);
        });
      }
      return errors;
    },
  },
  {
    key: "storageReset",
    required: false,
    configPath: "storageReset",
    default: { indexedDB: [], localStorage: [], sessionStorage: [] },
    hint: "登入後要清掉的本機狀態，避免上次操作影響可重現性。搜尋 indexedDB.open、localforage、redux-persist、以及把查詢條件寫進 localStorage / sessionStorage 的程式碼；找到就列出 {indexedDB:[{db, stores}], localStorage:[keys], sessionStorage:[keys]}。",
    question: "畫面會記住上一次的查詢條件或分頁狀態嗎？存在哪裡（IndexedDB 的哪個 store、或哪個 storage key）？",
    validate: viaConfig("storageReset"),
  },
  {
    key: "schemaSources",
    required: false,
    configPath: "schemaSources",
    default: [],
    hint: "參數唯一性的權威證據來源。找 swagger / openapi 的 JSON（**/swagger*/*.json、**/*swagger*.json、**/openapi*.json）與 EF Core migration（**/Migrations/*.cs），寫成 [{kind:'openapi'|'efcore', glob}]，glob 相對於專案根目錄。",
    validate: viaConfig("schemaSources"),
  },
  {
    key: "dataSourceRules",
    required: true,
    configPath: "dataSourceRules",
    hint: "判斷畫面能否 deep link 的 regex 規則，對元件原始碼比對。至少要回答兩類：(a) 掛載時自行抓資料的慣例 → verdict 'api'（例如在 useEffect / onMounted / componentDidMount 內呼叫固定的載入函式，或呼叫 query 套件）；(b) 依賴上一頁塞進來的狀態才顯示得出來 → verdict 'ui'（例如從 sessionStorage / history.state / 全域 store 取 id，而不是從網址）。Companion 依 package.json 套件預填的規則（query / redux / zustand…）只是起點；沒有這些套件的專案更需要自己寫。找法：打開一個代表性的列表頁與一個明細頁元件，看資料從哪裡來、id 從哪裡來。確定專案沒有任何可辨識的慣例時才回答 []，且必須在 evidence 說明理由。",
    question: "這個專案的頁面掛載時怎麼抓資料（呼叫什麼函式或套件）？明細頁的 id 是從網址來，還是從上一頁存的狀態來？",
    validate: viaConfig("dataSourceRules"),
  },
  {
    key: "navigation",
    required: true,
    configPath: "navigation",
    hint: "整個站台的預設進入方式，值為 {entry, evidence}。**這是行為事實，不要從程式碼推論**——框架是不是單頁應用不決定答案。用 Playwright 實測：先登入，然後在同一個乾淨 session 直接 browser_navigate 到一條「不是登入落地頁」的功能頁路徑（從 route-catalogue 挑一條，或問使用者一個常用畫面），再 browser_snapshot 看主內容區有沒有真的渲染出該畫面、側邊選單有沒有停在對的分類。渲染正常 → {entry:'deeplink'}；主畫面空白、或選單停在別的分類 → {entry:'menu'}（代表外殼的渲染依賴瀏覽過程留下的前端狀態，冷啟動用網址進不去）。evidence 寫「試了哪條路徑、看到什麼」。個別 route 的例外之後由 data-source-map 覆寫，這裡只填全站預設。",
    verify: "登入後 browser_navigate 到一條功能頁路徑，browser_snapshot 檢查主內容區與選單狀態；結論用 --source verified 回答。",
    question: "登入之後，直接在網址列輸入某個功能頁的路徑，畫面會正常顯示嗎？還是一定要從選單一層一層點進去才會正確？",
    // Spreading a bare string / null into the defaults silently yields the default entry, so the
    // shape has to be checked before viaConfig sees it.
    validate: (v) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return ['navigation must be an object: {"entry":"deeplink"|"menu","evidence":"<what you tried and saw>"}'];
      return viaConfig("navigation")(v);
    },
  },
  {
    key: "actors",
    required: true,
    hint: "測試角色與帳號。不從程式碼推論、不從其他 repo 或 e2e 設定翻找；一律向使用者詢問。值為 [{role, username, contextName?, note?}]，密碼不在這裡填（finalize 會在 actors.json 留 CHANGE_ME 由使用者自行填入）。",
    question: "測試需要哪些角色（例如 employee / manager）？各角色的測試帳號名稱是什麼？密碼請之後直接填進 .nav-recorder/actors.json。",
    validate: (v) => {
      if (!Array.isArray(v) || v.length === 0) return ["actors must be a non-empty array of {role, username}"];
      const errors: string[] = [];
      const roles = new Set<string>();
      for (const [i, a] of (v as Partial<ActorAnswer>[]).entries()) {
        if (!isNonEmptyString(a?.role) || !/^[A-Za-z0-9_-]+$/.test(a.role)) errors.push(`actors[${i}].role must match [A-Za-z0-9_-]+`);
        else if (roles.has(a.role)) errors.push(`actors[${i}].role duplicated: ${a.role}`);
        else roles.add(a.role);
        if (!isNonEmptyString(a?.username)) errors.push(`actors[${i}].username is required`);
      }
      return errors;
    },
  },
  {
    key: "smoke.landingPath",
    required: true,
    hint: "登入後的落地頁：一個穩定、主要 actor 一定看得到的頁面（首頁或某個列表頁）。看登入成功後的導向、預設路由、選單設定裡的第一個項目。",
    verify: "登入後用 browser_navigate 打開它，確認不會被導回登入頁。",
    question: "登入後要停在哪個穩定的頁面（首頁或某個列表頁）？請給路徑。",
    validate: (v) => (isNonEmptyString(v) && v.startsWith("/") ? [] : ["smoke.landingPath must be a path starting with /"]),
  },
  {
    key: "smoke.verify",
    required: true,
    hint: "落地頁上一定會出現的元素或文字，用來確認登入與導航成功。值為 {selector} 或 {text}。挑不會因功能改動而消失的東西（頁面標題、主表格）。",
    verify: "在落地頁 browser_snapshot，確認該 selector / 文字存在。",
    question: "落地頁上有什麼固定會出現的文字或元素（例如頁面標題）？",
    validate: (v) => {
      const o = (typeof v === "string" ? { selector: v } : v) as SmokeVerifyAnswer | null;
      if (!o || typeof o !== "object") return ["smoke.verify must be {selector} or {text}"];
      return isNonEmptyString(o.selector) || isNonEmptyString(o.text) ? [] : ["smoke.verify needs selector or text"];
    },
  },
  {
    key: "recording",
    required: false,
    configPath: "recording",
    default: { maxBodyKB: 64, bufferHours: 2, sessionGapMinutes: 20, unclaimedKeepDays: 7 },
    hint: "錄製參數，通常用預設。",
    validate: viaConfig("recording"),
  },
  {
    key: "execute",
    required: false,
    configPath: "execute",
    default: { maxConsecutiveFailures: 3 },
    hint: "執行參數，通常用預設。",
    validate: viaConfig("execute"),
  },
];

export const CATALOGUE_BY_KEY: Record<string, FieldDef> = Object.fromEntries(CATALOGUE.map((f) => [f.key, f]));

export function validateAnswer(key: string, value: unknown): string[] {
  const def = CATALOGUE_BY_KEY[key];
  if (!def) return [`Unknown field: ${key}. Known: ${CATALOGUE.map((f) => f.key).join(", ")}`];
  return def.validate(value);
}

/** Mechanical preset: pick data-source rules from the project's dependencies. */
export function presetDataSourceRules(deps: string[]): NavConfig["dataSourceRules"] {
  const has = (re: RegExp) => deps.some((d) => re.test(d));
  const rules: NavConfig["dataSourceRules"] = [];
  if (has(/^@tanstack\/(react|vue|solid|svelte)-query$/) || has(/^react-query$/) || has(/^vue-query$/)) {
    rules.push({ pattern: "useQuery\\(", verdict: "api", note: "query 套件掛載時自動抓資料" });
  }
  if (has(/^swr$/)) rules.push({ pattern: "useSWR\\(", verdict: "api", note: "SWR 掛載時自動抓資料" });
  if (has(/^react-redux$/) || has(/^@reduxjs\/toolkit$/)) {
    rules.push({ pattern: "useSelector\\(", requiresAlso: "dispatch\\(", verdictIfMissing: "ui", note: "Redux 且無掛載時 dispatch → 需真實 UI 進入" });
  }
  if (has(/^zustand$/)) rules.push({ pattern: "use[A-Z]\\w*Store\\(", requiresAlso: "useEffect\\(", verdictIfMissing: "ui", note: "zustand store 且無掛載時載入 → 需真實 UI 進入" });
  if (has(/^pinia$/)) rules.push({ pattern: "use[A-Z]\\w*Store\\(", requiresAlso: "onMounted\\(", verdictIfMissing: "ui", note: "pinia store 且無 onMounted 載入 → 需真實 UI 進入" });
  if (has(/^vuex$/)) rules.push({ pattern: "mapState|useStore\\(", requiresAlso: "dispatch\\(", verdictIfMissing: "ui", note: "vuex 且無掛載時 dispatch → 需真實 UI 進入" });
  return rules;
}
