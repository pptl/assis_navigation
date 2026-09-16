# `.nav-recorder/config.json` 欄位說明

Companion 與 extension 本身不含任何專案特定邏輯；每個專案的差異全部由這個檔案描述。各專案的完整範例放在 `examples/<專案>/config.json`；未填的欄位套用 `companion/src/config.ts` 的 `DEFAULT_CONFIG`。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `name` | string | 專案名稱，只用於顯示。 |
| `appOrigins` | string[] | 前端的 origin（`http://localhost:3000`）。extension 只錄這些 origin；`init` 會把它們註冊進 `hosts.json`。 |
| `apiBases` | (string \| DerivedApiBase)[] | API 根網址，**必須以 `/` 結尾**。錄到的絕對 URL 會對這些 base 取相對路徑存進 recipe，執行時用 `apiBases[0]` 拼回去，換環境只要改這裡。主機值若寫在專案設定檔且會更換，改用推導物件（見下方），Companion 每次載入重新查值。 |
| `readOnlyPatterns` | string[] | Layer 1 的擴充：GET/HEAD/OPTIONS 永遠視為讀取；此外 URL path（完整 pathname 與相對 apiBase 的路徑都會測）符合任一 regex 者也視為讀取並丟棄。比對不分大小寫。**務必結尾錨定**（`(Search|Detail)$`），子字串比對會誤刪寫入（`OrderImportSearch` 是讀，`OrderImport` 是寫）。 |
| `auth.kind` | `bearer` / `cookie` / `none` | API 步驟怎麼帶身份。`bearer`：Agent dev 從 `tokenSource` 讀 token 放進 `header`；`cookie`：靠瀏覽器 cookie；`none`：不帶。 |
| `auth.header` | string | 預設 `Authorization`。 |
| `auth.tokenSource` | `{area, key}` | `area` 為 `localStorage` 或 `sessionStorage`。`localStorage` 在同 origin 的 tab 間共用，多角色時 Companion 會在切換 tab 時要求重灌。 |
| `login` | object | 每個 context 首次使用時的登入方式。 |
| `login.kind` | `ui` / `api` | `ui`：Agent dev 用 Playwright 填表單登入（最穩，應用程式自己把該寫的 storage 都寫好）。`api`：直接打登入 API 再依 `storageSeed` 寫 storage。 |
| `login.url` / `fields` / `submit` / `successCheck` | ui 專用 | 登入頁路徑、帳密欄位 selector、送出按鈕 selector、成功判定（`urlNot` / `urlIncludes` / `selector`）。 |
| `login.call` | `{method,url}` | 登入 API（相對 apiBase）。`ui` 模式下選填，只用來在蒸餾時辨識錄到的登入請求（辨識不到時會退回「是 Layer 2b 來源且自身沒帶 Authorization」的推論）。登入之後那些已帶 Authorization、body 沒有參數、只是回一顆新 token 的呼叫（token refresh）不會進 recipe，改列在 `evidence.dropped.authRefresh`。 |
| `login.bodyTemplate` | object | api 專用。字串值可用 `{{username}}`、`{{password}}`、`{{md5(password)}}`、`{{sha256(password)}}`、`{{base64(password)}}`、`{{uuid()}}`、`{{now()}}`；由 Companion 展開，Agent dev 不用自己算雜湊。 |
| `login.storageSeed` | `{localStorage?, sessionStorage?}` | api 專用。key → 登入 response 的 JSON path（`$.data.token`）。 |
| `storageReset` | `{indexedDB[], localStorage[], sessionStorage[]}` | 登入後清掉會影響可重現性的本機狀態，例如把「上次搜尋條件」存在 IndexedDB 的專案。`indexedDB` 每筆 `{db, stores}`。 |
| `schemaSources` | `[{kind, glob}]` | 參數唯一性的第一層（權威）證據來源，glob 相對於專案根目錄。`openapi`：讀 swagger JSON 的 `required/minLength/maxLength/enum/format`，`x-unique: true` 視為唯一。`efcore`：掃 `.cs` 找 `.IsUnique()` / `[Index(..., IsUnique = true)]` / `CreateIndex(... unique: true)`。查不到的參數靠 runtime-probe。 |
| `dataSourceRules` | `[{pattern, verdict?, requiresAlso?, verdictIfMissing?, note?}]` | `data-source scan` 用的 regex 規則，對元件原始碼做機械判斷：`pattern` 命中且無 `requiresAlso` → `verdict`；`pattern` 命中但 `requiresAlso` 沒命中 → `verdictIfMissing`。任何一條給 `ui` 就整體判 `ui`。 |
| `navigation.entry` | `deeplink` / `menu` / `unknown` | **全站預設的畫面進入方式**，`data-source-map` 沒記載的 route 一律套用它。`deeplink`：直接 navigate 到網址就能正確渲染。`menu`：外殼（側欄、主內容區）的渲染依賴瀏覽過程留下的前端狀態，冷啟動用網址進去會空白，必須走應用程式自己的選單。`unknown`（預設）：從未確認過——寧可讓 agent 當場觀察，也不要預設「深連結沒問題」而靜默把它送到空白畫面。這是**行為**不是架構：是不是單頁應用不決定答案，同一個站也可能兩種混合，所以個別 route 用 `data-source-map` 覆寫。`doctor` 會檢查它不是 `unknown`。 |
| `navigation.evidence` | string | 怎麼得到上面那個結論的：試了哪條路徑、看到什麼。日後要重新確認時的依據。 |
| `recording.maxBodyKB` | number | 紀錄用途（extension 目前固定 64 KB 截斷）。落盤時 512 字元以上的 response body 以 sha1 去重，同一天只在同名 `.bodies.ndjson` 存一份，事件行改帶 `responseBodyRef`；每次呼叫仍各佔一行。 |
| `recording.bufferHours` | number | 滾動緩衝保留時數（預設 2）。以整天為單位刪檔：某天的檔案（連同 `.bodies.ndjson`）要等「隔天 + bufferHours」過了、**而且檔內每筆事件都已被認領或 discard** 才會刪。清理在 extension 重新連上 host 時，以及 `capture-recent` / `discard` / `routes recent` 執行後觸發。 |
| `recording.unclaimedKeepDays` | number | 沒被認領的日檔最多保留幾天（預設 7，從該日結束起算）。避免 agent 從沒認領時 raw 無限累積，也不會隔天就刪掉還沒被認領的錄製。 |
| `recording.sessionGapMinutes` | number | 蒸餾時切「瀏覽段落」的閒置門檻（預設 20）。連續兩筆事件間隔超過它、新分頁首次載入、或回到 `login.url`，都算新的一段。`capture-recent` 預設只蒸餾到達目標畫面的那一段（同分頁回到登入頁的邊界會往前併），更早的段落照樣認領但不蒸餾，會留下的步驟列成 `excludedSteps` 決策；`--all` 或明確的 `--from-seq` 整段蒸餾。 |
| `execute.maxConsecutiveFailures` | number | 同一支 API 連續失敗幾次就 `halt`（預設 3）。 |

### `apiBases` 推導物件

```json
{
  "derive": "json",
  "file": "package.json",
  "path": "$1",
  "append": "/api/",
  "pathFrom": { "file": "src/http.ts", "regex": "config\\.(env\\.\\w+Domain)", "template": "$1" }
}
```

- `file` / `path`：從專案內的 JSON 檔取一個字串（dotted path）。
- `append`：接在取到的值後面，結果保證以 `/` 結尾。
- `pathFrom`（選填）：先用 `regex` 在某個原始碼檔抓 capture group，套進 `template` 得到 `path`。適用於「程式碼裡指定用設定檔的哪個 key，而 key 會被人改來改去」的情況。
- `append` **必須含 API 路徑前綴**（應用程式名、`/api`、`/v1`…）；只填 `/` 會得到純 origin，`init answer` 會以 warning 標出。
- 推導失敗（檔案不存在、path 取不到字串）時 `init answer` 立即拒絕，`loadConfig` 也會報 `E_CONFIG_INVALID` 並說明原因。`init answer` / `init status` 的 `resolvedPreview` / `resolvedApiBases` 顯示目前解析結果。

## 每個欄位怎麼蒐集（onboarding 問卷）

`nav-recorder init` 的問卷就是這張表；`nav-recorder init catalogue` 印出程式裡的版本（以程式為準）。

| 欄位 | 必填 | 去哪找證據 | 用 Playwright 驗證 | 推不出來時問使用者 |
|---|---|---|---|---|
| `appOrigins` | 是 | `package.json` scripts 的埠、`vite.config.*` `server.port`、`.env*`、`angular.json`、`launchSettings.json`、webpack `devServer.port`；框架預設埠 | `browser_navigate` 打得開 | 本機開發站台的網址？ |
| `apiBases` | 是 | 主機：請求封裝層的 baseURL / 環境變數、`package.json` `proxy`、vite `server.proxy`；前綴：組 URL 的函式或設定檔（應用程式名、`/api`） | `resolvedPreview` 必須等於 `browser_network_requests` 看到的 origin + 前綴 | API 主機與路徑前綴？dev 打本機還是遠端？值會更換嗎？ |
| `auth` | 是 | 請求封裝層：`Authorization: Bearer` + storage key → bearer；`credentials: include` → cookie | 登入後 `browser_evaluate` 讀 storage | token 存哪裡，還是 cookie？ |
| `login` | 是 | 路由找登入頁；登入元件找欄位 selector 與按鈕；登入後導向；登入 API | 開登入頁 `browser_snapshot` 對 selector | 登入頁網址、欄位辨識、成功後到哪？ |
| `readOnlyPatterns` | 建議 | 請求封裝層預設 method；`init suggest-readonly --files <glob>` 產生端點結尾動詞直方圖，每個 ≥2 次的動詞都要歸類 | 回答後 `warnings` 無未涵蓋動詞；之後由 `capture-recent` 的 `evidence.dropped` 回饋 | 讀取型結尾動詞完整清單？ |
| `storageReset` | 否 | `indexedDB.open`、localforage、redux-persist、存查詢條件的 storage 寫入 | — | 畫面會記住上次查詢條件嗎？存哪？ |
| `schemaSources` | 否（自動掃描） | swagger / openapi JSON、`Migrations/*.cs` | — | — |
| `dataSourceRules` | 是（套件預填非空時已算回答） | `package.json` deps 預填只是起點；開一個列表頁與一個明細頁元件，寫出「掛載時抓資料」→ api 與「依賴上一頁狀態」→ ui 兩類規則 | — | 頁面掛載時怎麼抓資料？明細頁 id 從網址還是上一頁狀態來？ |
| `navigation` | 是 | **不從程式碼推**——這是行為不是架構 | 登入後在乾淨 session 直接 `browser_navigate` 到一條非落地頁的 route，`browser_snapshot` 看主內容區有沒有渲染、側欄停在哪；答案用 `--source verified` | 直接在網址列輸入功能頁路徑會正常顯示嗎，還是一定要從選單點進去？ |
| `actors` | 是 | **不從程式碼或其他 repo 推論** | — | 需要哪些角色、各自的測試帳號？密碼由使用者填檔 |
| `smoke.landingPath` | 是 | 登入後導向、預設路由、選單第一項 | 登入後 `browser_navigate` | 登入後停在哪個穩定頁面？ |
| `smoke.verify` | 是 | 落地頁元件的標題或主表格 | `browser_snapshot` | 該頁固定會出現的文字或元素？ |

## 常見專案型態怎麼填

**讀取全走 POST 的後台系統（controller/action 式路由）**
`readOnlyPatterns` 用 action 結尾動詞；`auth.kind: bearer` + `localStorage`；`login.kind: ui`；若列表頁會把搜尋條件存 IndexedDB，填 `storageReset.indexedDB`。

**RESTful + cookie session**
`readOnlyPatterns` 留空（GET 規則已足夠）；`auth.kind: cookie`；`login.kind: api` 且 `storageSeed` 通常不用填。注意 cookie 模式一個瀏覽器 profile 只能有一個身份，多角色 recipe 每次切換都得重新登入。

**Redux / TanStack Query 前端**
`dataSourceRules` 用預設的 `useQuery(` → api、`useSelector(` 無 `dispatch(` → ui。

**外殼式後台（上方分頁 + 側欄，選單內容跟著分頁狀態走）**
`navigation.entry: "menu"`。之後每驗證一條「網址直接進去也正常」的 route，就 `data-source set <route> --verdict api`——在 `menu` 站，那張表累積的是深連結捷徑；在 `deeplink` 站，累積的則是要避開的陷阱（`--verdict ui`）。

## 全域檔案（不在專案內）

`%USERPROFILE%\.nav-recorder\`（可用環境變數 `NAV_RECORDER_HOME` 覆寫）：

- `hosts.json`：`{"origins": {"<origin>": "<dataDir>"}}`。Chrome 啟動 host 時沒有工作目錄，事件靠這張表路由到專案。`init` 自動維護。
- `control.json`：`pause` / `resume` 寫入；host 每筆事件先讀它。
- `host/`：native messaging manifest 與 wrapper。
- `host.log`：host 的診斷紀錄（stdout 留給 framing，stderr 會被 Chrome 吞掉）。
