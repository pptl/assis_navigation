# nav-recorder

nav-recorder 是一個 AI 開發輔助導航工具。讓 Agent dev（Claude Code）在開發複雜網頁時，不必每一輪測試都重新摸索「要怎麼走到某個功能畫面」。

使用者在本地啓用localhost使用 Chrome 確認需求時，extension 會在背景錄下 API 流量、導航與點擊。Agent dev 接手任務後，把這段錄製蒸餾成一份 **precondition recipe**。之後每次要測試，它照著 recipe 用 Playwright MCP 把瀏覽器準備到**目標畫面的上一站**，最後再自己邊看邊點進去。

---

## 目錄

- [為什麼需要它](#為什麼需要它)
- [整體架構](#整體架構)
- [核心概念](#核心概念)
- [Repo 結構](#repo-結構)
- [快速開始](#快速開始)
- [日常使用流程](#日常使用流程)
- [CLI 命令一覽](#cli-命令一覽)
- [專案內的 `.nav-recorder/` 知識庫](#專案內的-nav-recorder-知識庫)
- [錄製與歸屬](#錄製與歸屬)
- [蒸餾：從原始流量到 recipe](#蒸餾從原始流量到-recipe)
- [開發與測試](#開發與測試)
- [與設計文件的差異](#與設計文件的差異)
- [文件索引](#文件索引)

---

## 為什麼需要它

開發時的典型迴圈：

```
1. 到系統實際看看需求                 ← extension 背景錄製
2. 確認需求（人已站在目標畫面附近）
3. 在 code 裡找對應元件
4. 跟 Agent dev 說明要改什麼
5. Agent dev 實作
6. Agent dev 開始測試
7. 把畫面準備到改動畫面「附近」       ← 本工具只負責這一步
8. Agent dev 用 Playwright MCP 操控、測試
9. 沒問題就匯報；有問題就修，回到 6
```

步驟 6→9 是一個高頻迴圈，同一條前置路徑在一次任務內會被重複走很多次。沒有這個工具時，Agent dev 每一輪都得翻 router、選單設定、權限設定去推路徑，推錯了還會誤判成「沒有權限」。

本工具**只處理導航**，不做斷言或回歸測試。導航知識錯了代價低，而且會自我修正：照著走失敗後重錄、覆蓋即可。斷言錯了卻可能靜默掩蓋 regression，所以不在範圍內。

## 整體架構

```
使用者真實 Chrome ──extension──► Companion (native host) ──► <專案>/.nav-recorder/raw/*.ndjson
                                                                      │
Claude Code ──Skill──► nav-recorder capture-recent  ──► precondition recipe (JSON)
            ──Skill──► nav-recorder execute-start/next/report ◄──► Playwright MCP 執行
```

三個交付物：

| 交付物 | 角色 |
|---|---|
| **Chrome extension**（MV3） | 錄製端。MAIN world 改寫 `fetch` / `XMLHttpRequest` 攔截請求與回應；ISOLATED world 錄點擊 / Enter / change，並轉送事件；service worker 透過 native messaging 把事件送給 Companion。不使用 `chrome.debugger`。 |
| **Companion**（Node.js + TypeScript） | 同一支程式兩種模式。Chrome 啟動它時是 native messaging host，負責落盤；Agent dev 呼叫它時是 CLI，負責蒸餾、查詢與執行協調。**Companion 不啟動瀏覽器，也不呼叫 LLM。** |
| **Skill**（`SKILL.md`） | 教 Agent dev 怎麼跟 Companion 協作：什麼時候查知識庫、怎麼認領錄製、怎麼補完 recipe、怎麼跑執行迴圈、什麼時候交棒。 |

**工具本身不認識任何專案。** 專案的 origin、API 路徑、認證方式、登入流程、讀取型 API 的命名慣例、schema 位置，全部寫在該專案的 `.nav-recorder/config.json`（見 [docs/CONFIG.md](docs/CONFIG.md)）。extension 與 companion 原始碼裡不放任何專案特有邏輯。

## 核心概念

### Precondition recipe

一份 JSON（schema：[schemas/recipe.schema.json](schemas/recipe.schema.json)），描述「怎麼把瀏覽器準備到目標畫面的上一站」：

- `steps`：每一步各自標 `kind`。`api` 直接打後端建立狀態，`ui` 用真實點擊觸發應用程式自己的載入邏輯。
- `params`：每個參數的型別是 `fixed`（錄製值）、`faker`（每次重新生成，避免撞唯一性限制）或 `captured`（引用前一步的回傳值）。
- `finalNavigation`：交棒的那個穩定畫面，例如列表頁、入口頁。
- `targetHint`：目標畫面的網址與「最後一跳要點什麼」。**這一跳不由 recipe 執行**，交給 Agent dev 自己做。
- `verify`：上一站一定會出現的元素或文字。

### 終點選擇原則（硬性約束）

recipe 在改動前錄製、在改動後執行，而改動它的就是 Agent dev 自己。所以 **recipe 的任何步驟都不得依賴本次要改的畫面的 DOM**，`finalNavigation` 必須是本次改動碰不到的穩定畫面。這條約束同時解掉兩個問題：selector 被自己改壞，以及 SPA 用 deep link 進去 store 是空的。

### Shape

`capture-recent` 會機械判定 recipe 屬於哪一種，決定之後該驗證什麼：

| shape | 意思 |
|---|---|
| `navigation` | 純導航，什麼都不用建立 |
| `navigation-existing-data` | 不用建立資料，但目標畫面依賴一筆「沒有任何步驟會建立」的既有資料 |
| `data` | 有 api 步驟會建立狀態，可以用 `--probe` 探測參數唯一性 |

### 進入方式：deeplink 或 menu

有些站台可以直接用網址進任何畫面，有些站台的外殼（側欄、主內容區）依賴瀏覽過程留下的前端狀態，冷啟動會一片空白。全站預設記在 `config.navigation.entry`，個別 route 的例外記在 `data-source-map`。這是**觀察到的行為**，不從程式碼推論。

### 三段式執行協定

```
execute-start <recipe>        → sessionId
loop:
  execute-next <sessionId>    → 下一個具體動作（login / fetch / navigate / click / fill / waitFor）
  （Agent dev 用 Playwright MCP 執行）
  execute-report <sessionId>  → continue | halt | done
```

解析 faker、追蹤 captured 值、計算連續失敗次數這類機械邏輯都在 Companion 裡。Agent dev 只負責操作瀏覽器、回報結果。多角色時「一個 context = 一個 tab」，由 Companion 指示何時切換、何時重灌 localStorage。

## Repo 結構

| 目錄 | 內容 |
|---|---|
| [extension/](extension/) | MV3 extension：`interceptor.js`（MAIN world 攔截 fetch/XHR）、`interactions.js`（錄使用者互動）、`relay.js`（轉送）、`background.js`（service worker，native messaging）。只對 loopback 頁面與 Companion 指定的非 loopback 站台注入。 |
| [companion/](companion/) | Node.js（TypeScript）native host + CLI，細節見下表。 |
| [skill/nav-recorder/](skill/nav-recorder/) | Agent dev 的行為指引 `SKILL.md`，安裝時複製到 `~/.claude/skills/nav-recorder/`。 |
| [schemas/](schemas/) | config / actors / recipe / event / session 的 JSON Schema。 |
| [examples/](examples/) | 各目標專案的範本（`config.json`、去掉密碼的 `actors.example.json`、`preconditions/login-ready.json`），由 `init finalize` 自動回寫，`init --template <專案>` 讀取。**專案特有的內容只准出現在這裡**；[examples/demo/](examples/demo/) 是匿名化的參考範例。 |
| [docs/](docs/) | [INSTALL.md](docs/INSTALL.md)（安裝與疑難排解）、[CONFIG.md](docs/CONFIG.md)（config 欄位與 onboarding 問卷）。 |

`companion/src/` 內部分層：

| 路徑 | 職責 |
|---|---|
| `main.ts`、`cli/` | 進入點（依啟動方式切換 host / CLI 模式）、參數解析、各命令實作 |
| `native/` | native messaging 的 framing 與 host 主迴圈（落盤、歸屬判斷） |
| `distill/` | 蒸餾管線：Layer 1 唯讀過濾、Layer 2a 可達性、Layer 2b 認證供應鏈、瀏覽段落切割、點擊路徑組裝、shape 判定、schema 證據（OpenAPI / EF Core）、草稿組裝 |
| `execute/` | 執行協調：session 狀態、參數解析（faker/fixed/captured）、JSON path、`{{md5(password)}}` 等模板、URL 組裝 |
| `store/` | `.nav-recorder/` 內各檔案的讀寫：raw、認領狀態、recipes、sessions、route-catalogue、data-source-map、param-constraints、unrouted 暫存區、本機 README |
| `routes/` | `routes recent`（錄製實際走過哪些 route）與一次性的選單樹匯入 |
| `onboarding/` | 問卷目錄（單一真相來源）、骨架建立、端點動詞統計、煙霧 recipe、範本匯出 |
| `util/` | 檔案、glob、log、route 正規化、埠 → process → 專案的解析 |

## 快速開始

需求：Node.js ≥ 20、Google Chrome（或 Edge）、Claude Code + Playwright MCP。詳細步驟與各平台差異見 [docs/INSTALL.md](docs/INSTALL.md)。

```powershell
# 1. 建置並安裝 Companion
cd companion
npm install
npm run build
npm link                     # nav-recorder 進 PATH

# 2. 註冊 native messaging host（extension ID 由 manifest 內的 key 固定，見 docs/INSTALL.md）
nav-recorder register-host --extension-id <extension ID>

# 3. chrome://extensions → 開發人員模式 → 載入未封裝項目 → 選 extension/

# 4. 安裝 Skill
Copy-Item ..\skill\nav-recorder\SKILL.md $env:USERPROFILE\.claude\skills\nav-recorder\SKILL.md

# 5. 在目標專案 onboarding（第一次接這個專案）
nav-recorder init --project <目標專案根目錄> --pretty
#    …回答問卷（建議交給 Agent dev 依 Skill 步驟 0 完成）…
nav-recorder init finalize --project <目標專案根目錄> --pretty

# 6. 檢查環境
nav-recorder doctor --project <目標專案根目錄> --pretty
```

finalize 會產生 `config.json`、`actors.json`（密碼留 `CHANGE_ME`，請自行填入）與煙霧 recipe `login-ready`，並把 `.nav-recorder/` 與 `.playwright-mcp/` 加進 `.gitignore`。同一專案換一台機器時，`nav-recorder init --template <專案名> --project <dir>` 可以直接套用範本，不用重答問卷。

> 若 config 含有不想進工具 repo 的真實設定，finalize 時加 `--no-export`，就不會回寫 `examples/`。

**建議的 onboarding 方式**：在 Claude Code 裡對目標專案說「幫我 onboarding nav-recorder」。Skill 會帶 Agent dev 讀原始碼找證據、用 Playwright 對活站台驗證，推不出來的欄位再集中問你。

## 日常使用流程

Skill 會自動帶 Agent dev 走以下步驟；手動操作時也是同一套命令。

1. **你在 Chrome 操作**：開本機 dev server，走到要改的畫面，確認需求。extension 在背景錄製。
2. **找目標畫面**：`nav-recorder routes recent --pretty` 列出剛才實際走過的 route，附畫面名稱與選單位置。清單裡沒有時用 `routes find "<畫面名稱>"`。
3. **查知識庫**：`data-source get <route>` 看怎麼進這個畫面；`list --target-url <route>` 看有沒有現成 recipe。
4. **認領並蒸餾**：
   ```powershell
   nav-recorder capture-recent "一句話描述任務" --target-url /<目標路由> --pretty
   ```
   得到一份 `draft: true` 的草稿與 `pendingDecisions`。
5. **補完草稿**：依 `shape` 處理每個決策（確認上一站、最後一跳、參數型別、角色……），然後 `save-recipe` 做結構驗證。
6. **實作前自我驗證**：`execute-start <name> [--probe]` 跑完整個迴圈，再照 `targetHint.clicks` 實際走一次最後一跳。
7. **測試迴圈**：每一輪用 recipe 把畫面準備到上一站，然後交棒給 Playwright MCP。**交棒後不關瀏覽器**，下一輪直接重用。
8. **任務結束**：`nav-recorder capture-recent --discard`（或 `nav-recorder discard`），把測試期間的雜訊排除在下次認領之外。

過程中確認到的畫面名稱、選單位置、進入方式，都要當下用 `routes set` / `data-source set` 寫回知識庫，下一個 agent 才讀得到。

## CLI 命令一覽

所有命令在專案目錄內執行，或加 `--project <dir>`。stdout 是單行 JSON，加 `--pretty` 換行輸出；錯誤以 JSON 寫到 stderr（`{error, code, details}`），exit code 為 1。`nav-recorder help` 列出完整 usage。

| 類別 | 命令 | 用途 |
|---|---|---|
| 安裝 | `register-host --extension-id <id> [--browser chrome\|edge]` | 寫 native host manifest 與 wrapper，並註冊到瀏覽器 |
| | `doctor [--extension-id <id>]` | 檢查 node、host 註冊、config、actors、gitignore、最近事件、互動錄製 |
| Onboarding | `init [--template <name>]` / `init status` / `init answer …` / `init suggest-readonly --files <glob>` / `init finalize [--no-export]` / `init export-template` / `init catalogue` | 問卷式建立專案設定，每個答案附出處 |
| 錄製歸屬 | `ports` | 目前每個 loopback 埠屬於哪個專案，以及暫存區裡還沒被認領的錄製 |
| | `activate --port <n> [--adopt]` / `activate --forget <n>` | 命令列看不出專案時的人工後路；`--adopt` 把暫存區的錄製認回專案 |
| | `pause` / `resume` | 直接操控使用者真實 Chrome 前暫停錄製 |
| 認領蒸餾 | `capture-recent ["<描述>"] [--target-url <path>] [--actor <name>] [--from-seq <n>] [--all] [--dry-run]` | 認領上次到現在的錄製，蒸餾成草稿 recipe；不帶 `--target-url` 時只列出候選 route |
| | `capture-recent --discard`（別名 `discard`） | 只推進認領點，不產生 recipe |
| 知識庫 | `routes recent \| find \| list \| get \| set \| import` | route-catalogue：畫面名稱 ↔ 路徑 ↔ 選單位置 |
| | `data-source list \| get \| set \| scan` | 每條 route 可否直接 deep link |
| Recipe | `list [--target-url <path>] [--match <kw>]` / `get-recipe <name>` / `save-recipe <file>` | 查詢、讀取、驗證並儲存 recipe |
| | `get-actor <name>` | 取出測試帳號 |
| 執行 | `execute-start <name> [--probe]` / `execute-next <id>` / `execute-report <id> …` / `execute-cancel <id>` | 三段式執行協定 |

## 專案內的 `.nav-recorder/` 知識庫

`.nav-recorder/` 是目標專案**累積下來的知識庫**，不是一次性的設定檔。**整個資料夾不進 git**，裡面有帳密與原始流量。

```
.nav-recorder/
  config.json              專案設定（見 docs/CONFIG.md）
  onboarding.json          每個設定值的出處（source / evidence）
  actors.json              測試帳號（密碼明文，自行填入）
  README.md                給 Agent dev 的本機入口：有哪些 recipe、各是什麼 shape
  route-catalogue.json/.md 畫面名稱 ↔ 路徑 ↔ 選單位置
  data-source-map.json/.md 每條 route 的進入方式（deeplink 捷徑 / 必須走選單）
  param-constraints.json/.md 參數唯一性判斷與證據
  preconditions/           login-ready.json 與之後蒸餾出的 recipe
  raw/                     滾動緩衝：<日期>.ndjson、去重 body 的 .bodies.ndjson、auth-provenance.json、claims/
  sessions/                execute-* 暫存
```

全域檔案放在 `%USERPROFILE%\.nav-recorder\`（可用 `NAV_RECORDER_HOME` 覆寫）：`hosts.json`、`unrouted/`、`control.json`、`host/`、`host.log`。

這些表只能透過實際使用累積（錄製觀察、Agent dev 寫回、一次性匯入），不會在查詢時重新掃描專案檔案。

## 錄製與歸屬

- extension 錄**所有 loopback 頁面**（`localhost`、`127.0.0.1`，不分埠號），外加 `hosts.json` 指定的非 loopback 站台，而且只錄目前作用中的分頁。
- **埠不需要登記。** dev server 拿到哪個埠是浮動的，所以「這筆錄製屬於哪個專案」由 host 事後判斷：先找出佔用該埠的 process，再讀它（必要時往上找父行程）的命令列，從中取出專案路徑。
- 判斷不出來的錄製（例如命令列不含專案路徑的 .NET、Python server）不會被丟掉，會先收進 `unrouted/` 暫存區，等 `activate --port <n> --adopt` 認領，逾期才清掉。
- Playwright MCP 自己開的瀏覽器 extension 看不到，所以 Agent dev 的測試操作不會污染錄製。

## 蒸餾：從原始流量到 recipe

全部是機械規則，不需要 AI 語意判斷：

1. **瀏覽段落切割**：遇到閒置超過 `sessionGapMinutes`、新分頁首次載入、回到登入頁，就切成新的一段。預設只蒸餾到達目標畫面的那一段，被排除但可能相關的步驟列成 `excludedSteps` 決策。
2. **Layer 1 唯讀過濾**：丟掉 GET/HEAD/OPTIONS，以及符合 `readOnlyPatterns` 的請求（給讀取也走 POST 的系統用，pattern 必須結尾錨定）。
3. **Layer 2a 可達性分析**：從終點畫面往回追值流，保留「回傳值被後續引用」或「request 值引用到終點相關資料」的請求。
4. **Layer 2b 認證供應鏈**：追蹤 token 由哪個請求產生，產生者必留；token refresh 呼叫另外列出。
5. **路徑組裝**：把導航與錄到的點擊拼成 `pages` / `hops`，每個點擊附多組候選 selector（aria 名稱優先，其次 data-testid、id、css、text），最後一跳預填進 `targetHint.clicks`。
6. **參數判斷**：唯一性依兩層證據判定。第一層讀 schema（OpenAPI、EF Core 的 unique index），第二層用 `--probe` 以相同值重送一次實測。兩層都判斷不出來時預設 `fixed`，因為誤判成 faker 會靜默製造垃圾資料。

## 開發與測試

```powershell
cd companion
npm run build          # tsc
npm test               # build + 執行測試
npm run test:only      # 只跑測試（node:test，含 spawn 真實 native host 的端到端測試）
npm run clean
```

- 修改 `extension/` 後，要到 `chrome://extensions` 按「重新載入」，再重新整理應用程式分頁。
- 移動 repo 位置後要重跑 `register-host`。
- 更新 `skill/nav-recorder/SKILL.md`（唯一來源）後要重新複製到 `~/.claude/skills/`。
- **不要把任何真實專案的識別資訊寫進這個 repo**，包括測試、fixture、註解與範例。一律使用通用替身（`demo-user`、`COMPANY_A`、`/Order/DispatchFirst` 之類）。

## 與設計文件的差異

實作時有幾處刻意偏離設計文件，理由記錄於此：

- **Layer 1** 從「丟棄所有 GET」泛化為「GET ∪ `readOnlyPatterns`」：不少後台系統的讀取也走 POST，靠 method 無法區分。
- **Layer 2a** 除了「回傳值被後續引用」，也保留「request 值引用到終點相關資料」的請求：否則 submit 這類回傳空值的步驟會被判成死路。
- **多角色**：Playwright MCP 沒有具名 BrowserContext，改成「一個 context = 一個 tab」，切換時以 storage snapshot 重灌 localStorage；cookie 型 auth 無法並行兩個身份。
- **content script** 改為執行期註冊，不用 manifest 靜態 `matches`，避免 patch 使用者瀏覽的其他網站：只註冊 loopback 與 Companion 指定的站台。
- **錄製歸屬**不靠登記：埠是浮動的，host 從佔用該埠的 process 的命令列推出專案（`nav-recorder ports`），推不出來的先收進 `~/.nav-recorder/unrouted/` 等人認領。
- **recipe 用 JSON** 而不是 `.ts`，並附 schema。
- **語意判斷由 Agent dev 完成**，Companion 不呼叫 LLM。
- **raw 的 response body 去重**：設計文件是每筆事件原樣 append。實測一天 99% 的 body 位元組是完全相同的重複內容（畫面逐列呼叫同一支 API），所以 512 字元以上的 body 以 sha1 在 `.bodies.ndjson` 存一份，事件行只留 `responseBodyRef`；每次呼叫仍各佔一行，時間順序不變。claim 檔同樣格式且自帶 body，日檔刪掉也不受影響。
- **認領範圍 ≠ 蒸餾範圍**：設計文件是把「上次認領到現在」整段一起蒸餾。一天做好幾個任務時，這會把前一個任務的步驟串進來（實測 11 步中有 4 步來自早上的另一個任務）。所以預設只蒸餾到達目標畫面的那段瀏覽，其餘照樣認領，並把被排除、但整段蒸餾時會留下的步驟列成 `excludedSteps` 決策；`--all` / `--from-seq` 則整段蒸餾。
- **滾動緩衝只刪已認領的日檔**：設計文件是超過緩衝時數就丟。改為「過期且整檔已認領」才刪，沒認領的最多保留 `recording.unclaimedKeepDays` 天。清理時機除了 extension 重連，`capture-recent` / `discard` / `routes recent` 也會觸發。

## 文件索引

| 文件 | 內容 |
|---|---|
| [navigation-recorder-design.md](navigation-recorder-design.md) | 設計文件：範圍、邊界、終點選擇原則、錄製架構、去雜訊分層、競品調研 |
| [docs/INSTALL.md](docs/INSTALL.md) | 安裝、onboarding、驗證、端到端試跑、疑難排解 |
| [docs/CONFIG.md](docs/CONFIG.md) | `config.json` 欄位、`apiBases` 推導物件、問卷蒐集方式、常見專案型態、全域檔案 |
| [skill/nav-recorder/SKILL.md](skill/nav-recorder/SKILL.md) | Agent dev 的完整協作協定 |
| [schemas/](schemas/) | 各檔案格式的 JSON Schema |
