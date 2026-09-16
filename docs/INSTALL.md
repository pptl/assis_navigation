# 安裝說明（給 Agent dev 與人類）

整套工具三個交付物：Chrome extension（錄製端）、Companion（Node.js，兼 native messaging host 與 CLI）、Skill（Agent dev 行為指引）。以下步驟在 Windows 上驗證過；macOS / Linux 差異在各步驟標註。

## 需求

- Node.js ≥ 20（Companion 用 Node 執行，不需要 TypeScript loader）
- Google Chrome（或 Edge：`register-host --browser edge`）
- Claude Code + Playwright MCP（Agent dev 執行 precondition 用；Companion 本身不啟動瀏覽器）

## 1. 建置並安裝 Companion

```powershell
cd <repo>\companion
npm install
npm run build
npm link          # 讓 nav-recorder 進 PATH；或 npm i -g .
nav-recorder help
```

## 2. 固定 extension 的 ID

`extension/manifest.json` 已內含 `key`（由 `companion/scripts/gen-extension-key.mjs` 產生），因此以「載入未封裝擴充功能」方式安裝時 ID 固定。目前的 ID：

```
dmhhbopjoeacoepdebhmlhfoindichio
```

若要換一組 key（例如 fork 出去給別台機器用），執行 `node companion/scripts/gen-extension-key.mjs --force`，它會改寫 manifest 並印出新的 ID；之後步驟 3 要用新 ID 重新註冊。

## 3. 註冊 native messaging host

```powershell
nav-recorder register-host --extension-id dmhhbopjoeacoepdebhmlhfoindichio
```

它會：

- 寫 `%USERPROFILE%\.nav-recorder\host\nav-recorder-host.cmd`（`@echo off` + 絕對路徑呼叫 node；任何多餘 stdout 都會破壞 native messaging framing，所以 wrapper 必須安靜）
- 寫 `%USERPROFILE%\.nav-recorder\host\com.navrecorder.companion.json`（`allowed_origins` 指向上面的 extension ID）
- Windows：寫入 registry `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.navrecorder.companion`
- macOS / Linux：把 manifest 放到 Chrome 的 `NativeMessagingHosts` 目錄

Chrome 以未知的工作目錄啟動 host，所以所有路徑都是絕對路徑。若之後移動了 repo，重跑一次 `register-host`。

## 4. 載入 extension

1. Chrome 開 `chrome://extensions`，打開「開發人員模式」。
2. 「載入未封裝項目」→ 選 `<repo>\extension`。
3. 核對卡片上的 ID 與步驟 2 相同。不同代表 manifest 的 `key` 被改過，用實際 ID 重跑步驟 3。
4. **之後每次更新 `extension/` 的檔案**（例如新增了 `interactions.js`），都要回到 `chrome://extensions` 按該卡片的「重新載入」，再重新整理應用程式的分頁；content script 是在頁面載入時注入的，沒重新整理的分頁還跑舊版。`nav-recorder doctor` 的 `interactions recorded` 項目會在錄到請求卻沒錄到點擊時提醒。
4. 點一下工具列上的 nav-recorder 圖示可強制重新連線 host（`nav-recorder init` 之後用得到）。

Extension 不會固定注入任何網站：它在啟動時向 Companion 要 origin 白名單（`hosts.json`），只對白名單 origin 註冊 content script。白名單為空時什麼都不錄。

## 5. 在目標專案 onboarding（第一次接這個專案）

工具不認識任何專案。第一次接專案時要回答一份問卷，Companion 驗證答案後產生 `config.json`、`actors.json` 與煙霧 recipe `login-ready`，並把去掉密碼的範本回寫到 `examples/<專案名>/`。

**由 Agent dev 做（建議）**：在 Claude Code 裡對該專案說「幫我 onboarding nav-recorder」，Skill 的步驟 0 會帶它讀原始碼找證據、用 Playwright 對活站台驗證、推不出來的集中問你，最後 finalize。你只需要回答它的問題，並在 `actors.json` 填密碼。

**手動做**：

```powershell
nav-recorder init --project <專案根目錄> --pretty     # 建骨架 + 問卷；列出每個欄位的 hint / question
nav-recorder init catalogue --pretty                   # 完整欄位目錄
nav-recorder init answer appOrigins --value '["http://localhost:5173"]' --source user --evidence "..."
nav-recorder init answer --from-file answers.json      # 一次填多個：{"<field>": {"value": ..., "source": "...", "evidence": "..."}}
nav-recorder init suggest-readonly --files "src/services/*.ts" --pretty   # 讀取走 POST 的專案：端點結尾動詞直方圖，供 readOnlyPatterns 歸類
nav-recorder init status --pretty                      # complete: true 才能 finalize
nav-recorder init finalize --pretty                    # 產生三個檔案 + 回寫 examples/<name>/
```

必填欄位：`appOrigins`、`apiBases`、`auth`、`login`、`dataSourceRules`、`actors`（角色與帳號名稱）、`smoke.landingPath`（登入後停留的穩定頁面）、`smoke.verify`（該頁一定會出現的元素或文字）。其餘有預設值；`dataSourceRules` 與 `schemaSources` 會依 `package.json` 相依套件與檔案掃描機械預填（預填為空時 `dataSourceRules` 仍要回答）。每次 `answer` / `status` / `finalize` 的 `warnings` 都要處理完：apiBases 解析成純 origin、readOnlyPatterns 漏掉高頻動詞、dataSourceRules 為空，都會被標出。

finalize 後的 `<專案>/.nav-recorder/`：

```
.nav-recorder/
  config.json            專案設定（見 CONFIG.md）
  onboarding.json        每個設定值的出處（source / evidence）
  actors.json            測試帳號 ← 密碼是 CHANGE_ME，請自行填入
  README.md              給 Agent dev 的本機入口
  data-source-map.json   + .md
  param-constraints.json + .md
  preconditions/         login-ready.json（煙霧 recipe）與之後蒸餾出的 recipe
  raw/                   滾動緩衝（<日期>.ndjson + 去重 body 的 .bodies.ndjson）、auth-provenance.json、claims/
  sessions/              execute-* 暫存
```

同時：把 `.nav-recorder/` 和 `.playwright-mcp/` 加進最近的 git 根目錄 `.gitignore`（前者是帳密與原始流量，後者是 Playwright MCP server 落地的頁面快照、console log 與截圖；finalize 輸出的 `gitignore` 欄位會說明是 `added` / `present` / `no-git-root`，`added` / `present` 陣列列出各自補了哪幾行；git 根目錄可能在專案上層，改到的是使用者 repo 裡被追蹤的檔案，記得一起 commit；找不到 git 根目錄時要手動加）；把 `config.appOrigins` 註冊進 `%USERPROFILE%\.nav-recorder\hosts.json`（origin → dataDir）。`doctor` 會持續檢查這兩個目錄是否被忽略。

**同一專案在別台機器**：`nav-recorder init --template <專案名> --project <dir>` 直接用 `examples/<專案名>/` 的範本 finalize，不用重答問卷（仍要填密碼）。

`actors.json` 能真的登入系統，請維持基本檔案權限；密碼明文，`login.kind: "api"` 時 Companion 依 `bodyTemplate` 做 md5 等雜湊。

## 6. 安裝 Skill

```powershell
Copy-Item <repo>\skill\nav-recorder\SKILL.md $env:USERPROFILE\.claude\skills\nav-recorder\SKILL.md
```

`skill/nav-recorder/SKILL.md` 是唯一來源；更新後重新複製。

## 7. 驗證

```powershell
nav-recorder doctor --project <專案根目錄> --extension-id dmhhbopjoeacoepdebhmlhfoindichio --pretty
```

全部 `ok: true` 後重啟 Chrome（或重新載入 extension）。然後：

1. 開 config 裡 `appOrigins` 的網址，登入、做一次查詢。
2. `.nav-recorder/raw/<日期>.ndjson` 應出現 request / navigation 事件，**其中登入請求必須是 status 200 且 `responseBody` 含 token**（body 超過 512 字元時該行是 `responseBodyRef`，內容在同名的 `<日期>.bodies.ndjson`）（只看到 status 0 / 404 代表 extension 沒抓到成功回應）；`raw/auth-provenance.json` 應有 token 對映。
3. 再跑一次 `doctor`，「recent events」應顯示幾秒前；「unclaimed」列出還沒被認領的事件數與瀏覽段落。

## 8. 端到端試跑

0. 先用煙霧 recipe 證明 config：在 Claude Code 裡依 Skill 執行 `nav-recorder execute-start login-ready`，跑到 `done` 且畫面停在落地頁。
1. 在 Chrome 走一遍某個功能的前置操作，停在目標畫面。
2. `nav-recorder capture-recent "試跑" --target-url /<目標路由> --pretty` → 得到草稿 recipe。
3. 用 Claude Code 依 Skill 補完草稿並執行 `execute-start … --probe`。
4. 結束時 `nav-recorder capture-recent --discard`（或別名 `nav-recorder discard`）。想丟掉剛才的操作重錄一次時也用它：它只推進認領點，不刪檔。

## 疑難排解

- `doctor` 說沒有 host log：Chrome 從未啟動 host。確認 registry / manifest 路徑、extension ID、以及 Chrome 是否重啟過。看 `%USERPROFILE%\.nav-recorder\host.log`。
- 有 host log 但沒有事件：origin 沒在 `hosts.json`；或該 tab 不是作用中的分頁（只錄目前 focus 的分頁）；或 `nav-recorder pause` 後忘了 `resume`。
- 事件有但 `capture-recent` 說 `E_NO_ANCHOR`：`--target-url` 的 path 跟實際導航不同，看 `details.recentNavigations`。
- 寫入型請求被丟掉：`readOnlyPatterns` 太寬。pattern 必須結尾錨定（`…Search$`），不要用子字串。
