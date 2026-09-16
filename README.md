# nav-recorder

AI 開發輔助導航工具：讓 Agent dev（Claude Code）在開發複雜網頁時，不必每輪測試都重新探查「怎麼走到某個功能畫面」。設計文件見 [navigation-recorder-design.md](navigation-recorder-design.md)。

```
使用者真實 Chrome ──extension──► Companion (native host) ──► <專案>/.nav-recorder/raw/*.ndjson
                                                                      │
Claude Code ──Skill──► nav-recorder capture-recent  ──► precondition recipe (JSON)
            ──Skill──► nav-recorder execute-start/next/report ◄──► Playwright MCP 執行
```

工具本身與任何特定專案無關：專案的 origin、API 路徑、認證方式、登入流程、讀取型 API 的命名慣例、schema 位置，全部由該專案 `.nav-recorder/config.json` 描述（見 [docs/CONFIG.md](docs/CONFIG.md)）。

| 目錄 | 內容 |
|---|---|
| `extension/` | MV3 extension：MAIN world 攔截 fetch/XHR、ISOLATED world 轉送、service worker 走 native messaging。只對白名單 origin 注入。 |
| `companion/` | Node.js（TypeScript）。同一支程式兩種模式：Chrome 啟動時是 native messaging host；Agent dev 呼叫時是 CLI。 |
| `skill/nav-recorder/` | Agent dev 的行為指引（`SKILL.md`），安裝時複製到 `~/.claude/skills/nav-recorder/`。 |
| `schemas/` | config / actors / recipe / event / session 的 JSON Schema。 |
| `examples/<專案>/` | 各目標專案的範本（`config.json`、去掉密碼的 `actors.example.json`、`preconditions/login-ready.json`），由 `init finalize` 自動回寫。每個專案一個資料夾，`init --template <專案>` 會讀這裡。專案特有的一切只准出現在這裡。 |
| `docs/` | [INSTALL.md](docs/INSTALL.md)、[CONFIG.md](docs/CONFIG.md)。 |

## 快速開始

```powershell
cd companion && npm install && npm run build && npm link
nav-recorder register-host --extension-id <extension ID，見 docs/INSTALL.md>
# chrome://extensions → 載入未封裝 → 選 extension/
nav-recorder init --project <目標專案根目錄>          # 開始問卷；由 Agent dev 依 Skill 步驟 0 填答，或手動 init answer
nav-recorder init finalize --project <目標專案根目錄>  # 產生 config.json / actors.json / login-ready 煙霧 recipe，回寫 examples/<專案名>/
nav-recorder doctor --project <目標專案根目錄> --pretty
```

同一專案在別台機器：`nav-recorder init --template <專案名>` 直接用範本。

## 開發

```powershell
cd companion
npm run build
npm run test:only      # node:test，含 spawn 真實 native host 的端到端測試
```

## 與設計文件的差異

實作時有幾處刻意偏離，理由記錄於此：

- **Layer 1** 從「丟棄所有 GET」泛化為「GET ∪ `readOnlyPatterns`」：不少後台系統的讀取也走 POST，靠 method 無法區分。
- **Layer 2a** 除了「回傳值被後續引用」，也保留「request 值引用到終點相關資料」的請求：否則 submit 這類回傳空值的步驟會被判成死路。
- **多角色**：Playwright MCP 沒有具名 BrowserContext，改成「一個 context = 一個 tab」，以 storage snapshot 在切換時重灌 localStorage；cookie 型 auth 無法並行兩個身份。
- **content script** 改為執行期依白名單註冊，而非 manifest 靜態 `matches`，避免 patch 使用者瀏覽的其他網站。
- **recipe 用 JSON** 而非 `.ts`，附 schema。
- **語意判斷由 Agent dev 完成**，Companion 不呼叫 LLM。
- **raw 的 response body 去重**：設計文件是每筆事件原樣 append。實測一天 99% 的 body 位元組是完全相同的重複內容（畫面逐列呼叫同一支 API），所以 512 字元以上的 body 以 sha1 在 `.bodies.ndjson` 存一份，事件行只留 `responseBodyRef`；每次呼叫仍各佔一行，時間順序不變。claim 檔同樣格式且自帶 body，日檔刪掉也不受影響。
- **認領範圍 ≠ 蒸餾範圍**：設計文件是整段「上次認領到現在」一起蒸餾。一天多個任務時會把前一個任務的步驟串進來（實測 11 步中 4 步來自早上另一個任務），所以預設只蒸餾到達目標畫面的那段瀏覽，其餘照樣認領，並把被排除、但整段蒸餾會留下的步驟列成 `excludedSteps` 決策；`--all` / `--from-seq` 整段蒸餾。
- **滾動緩衝只刪已認領的日檔**：設計文件是超過緩衝時數就丟。改為過期且整檔已認領才刪，沒認領的最多留 `recording.unclaimedKeepDays` 天；清理除了 extension 重連，`capture-recent` / `discard` / `routes recent` 也會觸發。
