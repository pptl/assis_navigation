# AI 開發輔助導航工具 — 設計文件

## 0. 背景與範圍

**核心問題**：讓 AI（Agent dev，如 Claude Code）在開發複雜網頁時，減少「探查怎麼到達某個功能畫面」的成本。經過反覆討論後，範圍刻意收斂為**只處理導航**，不包含「測試其他功能有沒有壞掉」（斷言/回歸測試）——後者是完全不同的問題，錯誤代價不對稱、需要人類治理，屬於另一個獨立子專案的範疇，本文件不涵蓋。

**判斷依據**：導航知識錯了，代價低且會自我修正（agent 照著走失敗 → 自動重新探查 → 覆蓋舊快取，不需要人介入）。測試/斷言錯了，代價高且會被靜默吞掉（AI 誤判「這是正常變化」掩蓋真正的 regression）。這個不對稱性，是本文件決定「導航層不需要治理 GUI」的核心理由。

### 參考使用流程（全文件的對照基準）

本工具的主要使用情景是**開發的當下**，不是跨天的知識累積。以下 9 步是設計時假定的參考流程，後續每個機制都應該能指出它服務的是哪一步：

```
1. 看到 HR 的需求，到系統實際看看瞭解情況
2. 確認需求（此時人已在目標畫面或附近，extension 正在背景錄製）
3. 在 code 中尋找頁面上對應的 function/component
4. 跟 dev agent 說明會改動哪些東西
5. dev agent 開始實作
6. dev agent 告一段落，開始測試
7. dev agent 用 precondition 導航到改動畫面「附近」   ← 本工具的職責範圍
8. dev agent 用 Playwright MCP 操控、測試改動的部分
9. 沒問題 → 匯報做了什麼並結束；有問題 → 修好後回到 6
```

**本工具的職責只有步驟 7**：把畫面狀態準備到「改動畫面的上一站」，讓 AI 不必每輪測試都重新探查怎麼走到那裡。步驟 8 之後（操控、驗證、判斷改動是否正確）完全交給 dev agent 自己的工具鏈。

這個流程有兩個特徵，深刻影響了後續多項設計決策，值得先標示出來：

- **步驟 6→9 是一個高頻迴圈**：同一個 precondition 在單次開發任務內就會被執行很多次。這使得「重複使用」變成必然而非例外（見第 2 節「即時蒸餾」）。
- **變更來源就是 dev agent 自己**：precondition 錄製於改動前（步驟 2），卻執行於改動後（步驟 7）。這跟一般「上游變更導致失效」的情況本質不同，是本工具特有的風險（見第 1 節、第 2 節「終點選擇原則」）。

---

## 1. 工具的職責邊界：只到「目標畫面的上一站準備好」為止

導航原本考慮過三種類型，但釐清工具邊界後，範圍收斂為只做其中一種：

| 類型 | 定義 | 是否本工具處理 |
|---|---|---|
| **A. Precondition（固定前置路徑）** | 到達功能 A 畫面前的操作。「新功能不會影響它」不是假設，而是由第 2 節「終點選擇原則」強制保證 | **是，本工具全部職責** |
| ~~B. 探索紀錄（開發中操作）~~ | 開發功能本身時的操作路徑 | **否，見下方說明** |
| C.（範圍外）測試斷言 | 驗證某個功能是否正確 | 否，獨立子專案範圍 |

**為什麼拿掉 Type B**：一開始曾考慮把「Agent dev 開發新功能時的探索過程」也錄下來當參考資料（類似 site-memory 的模式）。但推敲後發現這個假設不成立：

1. 新功能的操作路徑本質上每次都不一樣，「記下來給下次參考」的重播價值趨近於零——連維護都不需要的東西，記錄它的意義也很有限。
2. Agent dev 本來就有自己的 Playwright/瀏覽器工具，可以直接 `observe → act → observe` 即時探查、即時操作、即時判斷結果，不需要透過一份錄下來的紀錄去反推別人（甚至是自己）當初在幹嘛。
3. **工具的正確邊界，就停在「畫面狀態準備好」這條線**：線之前是本工具的職責（precondition），線之後——包含開發新功能本身的探索、以及驗證新功能有沒有正常運作——完全交給 Agent dev 自己的工具鏈處理，不屬於本工具範圍。

### 這條線要畫在目標畫面的「上一站」，不是目標畫面本身

上述第 3 點的「畫面狀態準備好」還需要再精確一次。參考流程（第 0 節）揭露了一個本工具特有的風險：**precondition 錄製於改動前（步驟 2），卻執行於改動後（步驟 7），而變更來源就是 Agent dev 自己**。

如果 recipe 的最後一段依賴目標畫面的 DOM（例如 `kind: "ui"` 點擊某個 selector），而 Agent dev 在步驟 5 剛好改掉了那個元素的結構或 selector，precondition 在步驟 7 當場失效。更麻煩的是步驟 6→9 的迴圈——每一輪改動都可能再壞一次，要使用者反覆手動重錄，正好摧毀這個工具原本要省下的成本。

第 7 節「失效處理」的「重新錄製、直接覆蓋」假設變更來自**上游**（別人改的、偶發的）；本節這個風險則是**內生的、每輪迴圈都可能觸發**，不能用同一套處理方式打發。

因此邊界精確定義為：**precondition 負責把狀態準備到「目標畫面的上一站」，最後一跳交給 Agent dev 的 Playwright 即時處理**。具體約束見第 2 節「終點選擇原則」。

---

## 2. Precondition 的最佳實作：優先跳過 UI

**關鍵原則**（來自 Playwright 官方最佳實踐）：前置設定不該走 UI 完成，該直接用 API 呼叫把狀態建好，再用 deep link 跳轉到目標畫面。

優先順序：

1. **API/DB 直接造狀態**（首選）：`page.request.post()` 直接打後端 API 建立資料，`page.goto()` 直接跳到目標頁。完全不碰 DOM，速度快、不受前端改版影響。
2. **Playwright codegen 錄製的固定 UI 腳本**（次選）：只在沒有對應 API，或這段 UI 流程本身就是待測目標時使用。用 `npx playwright codegen` 錄製。
3. **混合使用**：同一個 recipe 裡，不同步驟可以各自標記走 API 或 UI，見下方「混合步驟」說明。

### 終點選擇原則（硬性約束）

承第 1 節，因為 Agent dev 自己就是變更來源：

> **recipe 的任何步驟都不得依賴「本次要改動的那個畫面」的 DOM。`finalNavigation` 必須指向一個本次改動不會碰到的穩定畫面**（列表頁、入口頁、上一層選單）。目標畫面本身寫在 `targetHint` 欄位，**不由 recipe 執行**，只作為 Agent dev 最後一跳的指引。

實務上這條約束幾乎不增加成本：Agent dev 在步驟 8 本來就要操控 DOM 做測試，多走一跳（在列表頁點進去）是它原本就會做的事，且它是**即時 observe 後才 act**，能直接看到自己剛改完的畫面長什麼樣，不受任何錄製時快照的影響。

**這條約束同時解掉了下一小節「SPA 資料來源陷阱」的主要案例**——見下。

### SPA 資料來源陷阱：deep link 不是萬用解

`finalNavigation` 假設「跳到某個 URL 就能看到正確畫面」，但這個假設只在**畫面渲染需要的資料能從 URL 重建**時成立。SPA 常見情況：

- 資料存在 **URL params**：安全，SPA 路由層掛載時自己會用 URL 帶的 ID 發請求重建畫面。
- 資料存在**後端 session**：安全。注意這裡指的是 precondition 執行時**自己那個獨立瀏覽器 context** 內部的 session 一致性（`page.request` 跟後續 `page.goto()` 共用同一組 cookie），不是跟使用者真實瀏覽器共用——執行環境是完全獨立、透過測試帳號自行登入的乾淨瀏覽器，見第 8 節「Precondition 執行時的登入身份」。
- 資料存在 **client-side store（Redux/Context）**，且沒有掛載時自動 dispatch 抓資料的邏輯：**危險**。這種畫面通常假設「使用者是從某個特定上一頁點進來的，store 早就被填好」，純 API + deep link 會導到一個結構對、資料空的畫面。

**與終點選擇原則的交集**：上述第三種危險情況，如果發生在**目標畫面本身**，現在由終點選擇原則結構性地解決了——recipe 停在上一站，Agent dev 用真實 UI 點擊進入目標畫面，正好觸發應用程式原本就會跑的載入邏輯，store 自然被正確填入。也就是說「selector 被自己改壞」與「deep link 導到資料空的畫面」兩個問題，被同一個決定一起解掉。

**但這不表示混合步驟機制可以拿掉**：危險情況仍可能出現在**中間步驟**（例如 precondition 途中必須先進入某個 Redux 型的中繼畫面才能繼續），那裡仍需要下方的 `kind` 標記與資料來源對照表來判斷。結構解決的只是「終點畫面是 Redux 型」這個最常見的案例。

### 混合步驟（解決上述 SPA 陷阱）

不是整套走 API 或整套走 UI 二選一，而是每個步驟各自標記 `kind`：用 API 把資料庫狀態建好（快、確定性高），需要讓 store 被正確填入的那一段改用真實 UI 操作，觸發應用程式原本就會跑的資料載入邏輯（不用自己猜 store shape 手動組裝）：

```typescript
steps: [
  { kind: "api", call: { method: "POST", url: "/api/applications" }, params: {...}, capture: {...} },
  { kind: "api", call: { method: "POST", url: "/api/applications/{id}/submit" }, params: {...} },
  // 中繼畫面是 Redux 型且沒有掛載時自動抓資料 → 必須用真實 UI 進入，否則後續步驟看不到資料
  { kind: "ui", action: "click", selector: '[data-testid="workspace-tab"]' },
  { kind: "api", call: { method: "POST", url: "/api/applications/{id}/assign" }, params: {...} },
]
// finalNavigation 停在列表頁，進入目標畫面那一跳不寫在 steps 裡（見「終點選擇原則」）
```

注意這裡的 `kind: "ui"` 是**中繼**步驟，不是最後一跳。「從列表點進目標畫面」那一步刻意不寫進 recipe——它由 Agent dev 依 `targetHint` 自己執行，這樣既避開了 selector 被自己改壞的風險，又同樣達成了觸發真實載入邏輯的效果。

該對哪些步驟標 `kind: "ui"`，由下方「資料來源對照表」機制判斷，不用每次臨場猜測。

### 資料唯一性問題：怎麼判斷哪些參數不能重複、哪些該固定

不是「每次手動編輯」，而是**一次性判斷每個欄位該用哪種類型**，之後每次呼叫零編輯成本。判斷依兩層權威性由高到低進行：

**第一層（權威）：讀程式碼/schema，查得到就直接採信**

- EF Core migration 檔案或 Fluent API 設定裡的 `.IsUnique()`，或 Data Annotation 的 `[Index(IsUnique = true)]`——這是資料庫的事實，可信度最高。
- 明確寫在 service 層的重複檢查邏輯（例如呼叫端有 `CheckXxxExists` 這類明確方法）。
- 只要查到明確依據，就直接判定，不需要再進第二層驗證。

**第二層（推論補位）：查無文件/程式碼依據時，才用實測補上**

這是很多團隊的實際情況——swagger 沒有標注唯一性、業務邏輯層的規則沒有結構化記錄，前端本來就是憑經驗猜。這種情況下第一層查不到不代表限制不存在，只是沒被記錄下來，這時才動用實測：

- 生成 recipe 後的「自我驗證」步驟（見下方），額外用**完全相同的參數值**連續執行兩次。
- 第二次若回傳 409 Conflict，或錯誤訊息包含 `duplicate`/`already exists`/`unique` 等字眼 → 判定該參數需要唯一性，標 `faker`。
- 兩次都成功 → 維持 `fixed`。
- 這一層屬於**推論**，可信度中等（可能只驗證到某個特定條件下的限制，不代表完整規則邊界，例如「同一天同一人不能建立兩張同類型申請單」這種複合條件，實測未必剛好觸發到）。

**兩者都無法判斷時的預設值**：標 `fixed`。理由是誤判成本不對稱——誤判成 `fixed`（本該 faker）會在 reuse 時直接撞 constraint 報錯，屬於顯性失敗，第 7 節的自我修正機制接得住；誤判成 `faker`（本該 fixed）會靜默造出一筆不該存在的垃圾資料，屬於隱性錯誤，風險更高。預設值該偏向風險較低的一邊。

**每個判斷結果都要標記 `source`**（`code` 或 `runtime-probe`），讓 Agent dev 之後看到 `runtime-probe` 的判斷時，知道這是相對沒那麼確定的推論，遇到相關問題應優先重新檢視；`code` 的判斷可以直接信任。

### Precondition Recipe 格式（範例）

```typescript
export const readyForApprovalSubmission: PreconditionRecipe = {
  name: "已建立待簽核的申請單",
  steps: [
    {
      call: { method: "POST", url: "/api/applications" },
      params: {
        applicantName: { type: "faker", fn: "person.fullName" },
        department: { type: "fixed", value: "研發部" },
        amount: { type: "faker", fn: "number.int", args: [1000, 50000] },
      },
      capture: { applicationId: "$.response.id" },
      constraintEvidence: {
        // 判斷依據，說明每個 type 是怎麼決定的
        applicantName: {
          source: "runtime-probe",  // 查無 schema/程式碼依據，靠實測推論得出
          observedError: "409 Conflict: applicantName 'XXX' already exists for this month",
        },
        department: {
          source: "code",  // 查到 EF Core migration 裡對應欄位是外鍵指向固定選項表
        },
      },
    },
    {
      call: { method: "POST", url: "/api/applications/{applicationId}/submit" },
      params: { applicationId: "$.captured.applicationId" },
    },
  ],
  // 上一站的 deep link：必須是本次改動不會碰到的穩定畫面（見「終點選擇原則」）
  finalNavigation: "/applications/list",
  // 目標畫面：不由 recipe 執行，只交給 Agent dev 當最後一跳的指引
  targetHint: {
    url: "/apply/{applicationId}/review",
    note: "從列表點進 applicationId 對應的那一筆",
  },
}
```

`type` 三種：`faker`（動態生成，避免重複；若受限於合法值集合但仍需變化，用 `faker.helpers.arrayElement([...])` 從固定清單隨機選，而非自由生成）、`fixed`（錄製當下的固定值）、`captured`（引用前一步驟回傳值）。這個判斷由 Agent test 從錄製紀錄 + 上述兩層判斷邏輯自動萃取，人類可讀、可隨時直接開啟檢視，`constraintEvidence` 讓人類（或 Agent dev）能回頭檢視判斷依據是否可靠。

### 執行：Companion 協調 + Agent dev 執行（方案 Y）

**分工原則**：Companion 不啟動任何瀏覽器、不執行任何 Playwright 呼叫；所有真實瀏覽器操作全部由 Agent dev 用自己的 Playwright MCP 執行。Companion 只提供「執行協調」CLI，每次呼叫回傳一個具體指令描述給 Agent dev 照做，Agent dev 執行完把結果回報給 Companion，如此循環直到 recipe 結束。

**為什麼是這個分工，不是純 Skill 指引**：判斷 faker/追蹤 captured/計失敗次數這些是純機械邏輯，寫進 Companion 的程式碼一次寫對，比每次讓 Agent dev 從 Skill 規範裡推理跑一遍可靠得多；Skill 只教「怎麼跟 Companion 協作」，不教「怎麼實作 precondition 執行邏輯」。

**CLI 介面**：

```
# 開始執行一個 recipe，建立 session file，回傳 session ID
$ nav-recorder execute-start <recipe-name>
{ "sessionId": "abc123", "totalSteps": 3 }

# 取得下一步指令（Companion 內部 resolve faker/fixed/captured、決定 actor/context、判斷 kind）
$ nav-recorder execute-next <sessionId>
{
  "stepIndex": 0,
  "actor": "automation-employee",
  "contextName": "employee",   # Agent dev 要在 Playwright 裡開這個 context 名稱
  "kind": "api",
  "action": {
    "type": "fetch",
    "method": "POST",
    "url": "/api/applications",
    "body": { "applicantName": "Jane Doe", ... }   # 已 resolve 過的具體值
  },
  "captureKeys": ["applicationId"]   # Agent dev 執行完要回報這幾個從 response 抓的欄位
}

# 或收到 UI 步驟指令
{
  "stepIndex": 2,
  "actor": "automation-employee",
  "contextName": "employee",
  "kind": "ui",
  "action": {
    "type": "click",
    "gotoUrl": "/applications/list",
    "selector": "[data-testid=\"application-list-item\"]"
  }
}

# Agent dev 執行完回報結果（成功時附上 captured 值；失敗附上 error）
$ nav-recorder execute-report <sessionId> --status ok --captured '{"applicationId":42}'
$ nav-recorder execute-report <sessionId> --status error --message "409 Conflict: ..."
# 回應會告知下一步狀態
{ "next": "continue" }
# 或
{ "next": "halt", "reason": "同一支 API 連續失敗 3 次" }
# 或
{
  "next": "done",
  "finalNavigation": "/applications/list",       # 上一站，由 Agent dev 跳轉
  "finalContext": "employee",                    # 跳轉用哪個 context，且此 context 不關閉、留給步驟 8
  "targetHint": {                                # 目標畫面，Companion 不執行、僅供指引
    "url": "/apply/42/review",
    "note": "從列表點進 applicationId 42 的那一筆"
  }
}
```

**Companion 內部處理的機械邏輯**（Agent dev 不用碰）：
- resolve `faker`/`fixed`/`captured` 三種參數
- 決定每個 step 該用哪個 `contextName`
- 計算連續失敗次數，超過 3 次回 `halt`
- 記錄 error message 到 `param-constraints.md`（若第二層唯一性推論觸發）
- 判斷 `finalNavigation` 該由哪個 context 執行

**Agent dev 依 Skill 指引做的事**：
- 開一個 Playwright browser instance
- 依照 Companion 每次回傳的 `contextName` 建立/複用 `BrowserContext`（多角色場景就是多個 context 並行，各自獨立 cookie jar）
- 每個 context 首次使用時，先讀 `.nav-recorder/actors.json` 拿對應 actor 的憑證，打登入 API 建立 session
- 執行 Companion 回傳的 `action`（`fetch` 或 UI 操作），把結果 `execute-report` 回去
- 收到 `done` 時，用 `finalContext` 對應的 context 跳轉到 `finalNavigation`（上一站），**然後保持 browser 與所有 context 開著**，依 `targetHint` 自行走完最後一跳，接續進入測試

### 執行結束後的交棒：browser 不關閉

Recipe 執行完（`done`）不是「收工」，而是參考流程步驟 7 → 步驟 8 的**交棒點**。Agent dev 必須：

- **不關閉 browser instance，也不關閉任何 BrowserContext**。`finalContext` 那個 context 已登入、已導航到上一站，正是步驟 8 要用的；關掉就要重新登入導航，前面全部白做。
- 多角色情境同理：步驟 8 若需要換個身份驗證結果（例如用主管帳號看簽核畫面），直接沿用該 recipe 已經建立好的另一個 context，不重登。
- 步驟 6→9 迴圈中，只要 browser 還活著，後續幾輪測試可以直接重用這些 context；只有在資料狀態需要重置時才重跑一次 recipe。

**Session file**：因為 Companion 非常駐（native messaging host 用完就退出），recipe 執行狀態必須跨 CLI 呼叫存活。`nav-recorder execute-start` 建立一個 `.nav-recorder/sessions/<sessionId>.json`，內含 recipe 副本、目前執行到第幾步、captured 累積值、每支 API 的失敗計數，`execute-next`/`execute-report` 讀寫這個檔案。recipe 結束或 halt 時刪除。

**注意**：session file 的刪除只代表「這次協調流程結束」，**與瀏覽器生命週期無關**——Companion 從頭到尾就不持有瀏覽器（見上方分工原則），刪 session file 不會、也不該連帶收掉 Agent dev 那邊的 browser。

### 自我驗證，不需要人工審查每一次

配方生成後自動執行一次，檢查 `finalNavigation` 跳轉後的畫面是否出現預期關鍵元素。成功即視為可用；只有失敗才丟回來讓人看。

**檢查對象是「上一站」的關鍵元素**（承終點選擇原則），且應避開任何本次可能被改動的元素——否則自我驗證本身就會變成第二個內生失效點。

**驗證時機固定在參考流程的步驟 4**（使用者向 Agent dev 說明改動內容、Agent dev 呼叫 `capture-recent` 的當下）。這個時機有兩個好處：

1. **跑的是尚未被修改的系統**。步驟 5 的實作還沒開始，此時驗證通過，代表 recipe 本身確實是對的；日後若在步驟 7 失敗，可以直接排除「recipe 一開始就錄錯」這個可能性，縮小定位範圍。
2. **不佔用使用者的等待時間**。此時使用者正在說明需求，Agent dev 本來就有空檔。

**若第二層唯一性推論有觸發（見上方），失敗時的完整 error message 必須回傳給 Agent dev**，不能只在內部判斷完就丟棄——原因：
1. 若當初的實測推論不完整（業務邏輯限制比實測驗證到的更複雜），Agent dev 之後開發時撞到同一類錯誤，能比對到當初生成階段見過的錯誤模式，加快定位。
2. Error message 裡常帶著程式碼掃描抓不到的規則細節（例如「同一部門一天內不能有兩張待簽核單」），比單純的「這個欄位需要唯一」更有資訊量。

### 執行邊界：連續失敗自動停止

同一支 API 連續失敗 3 次（不限於唯一性探測，涵蓋自我驗證、正式執行時的任何呼叫），**立即停止，不再重試**，把完整 error message 回報給使用者/Agent dev，等待人工判斷再繼續。目的是避免無意義的重試耗費資源、以及避免在未知失敗原因時繼續累積更多可能有問題的資料。

### 即時蒸餾（取代原本的延遲蒸餾）

**曾經的設計**：第一次用到某個 precondition 只存原始紀錄，等到第二次被需要時才投入生成 recipe 的成本，用「是否被重複使用」這個客觀訊號取代「值不值得」的主觀判斷。

**為什麼推翻**：這個設計的前提是「很多 precondition 是一次性的，不值得蒸餾」。但參考流程（第 0 節）的步驟 6→9 是一個測試迴圈，**同一個 precondition 在單次開發任務內就會被執行很多次**——重複使用是必然而非例外，一次性的 precondition 幾乎不存在。前提失效後，延遲蒸餾省不到任何成本，反而付出兩個代價：

1. 步驟 7 的第一輪沒有 recipe 可用，只能把導航推回給 Agent dev 自己讀原始紀錄想辦法——而那正是本工具要省下的 token。
2. 原設計從未定義「第一次被需要時該怎麼導航」，這一段是空白的。

**現行設計**：`capture-recent` 被呼叫的當下就一次做完去噪（第 4 節三層）、結構化萃取（faker/fixed/captured 判斷）、自我驗證，直接回傳一支可執行的 recipe。步驟 7 的每一輪——包含第一輪——都是零 LLM 成本的 `execute-start`。

原本「用客觀訊號取代主觀判斷」的精神保留，只是訊號換成**有沒有傳入 `--target-url`**：有明確目標畫面，代表這是一次真的開發任務，值得蒸餾；沒有則只推進認領時間戳、不生成配方（見第 5 節 `--discard`）。

### 資料來源對照表：讓「該不該混 UI 步驟」的判斷可累積、不用每次重查

判斷某個畫面該標 `kind: "api"` 還是 `kind: "ui"`，最可靠的方式不是從錄製行為猜測，而是**直接讀專案原始碼**——這是自己開發的專案才有的優勢，site-memory、Yad 這類面對任意第三方網站的工具沒有原始碼可看，只能靠行為推測。具體判斷邏輯（用 grep 抓 hook 呼叫模式即可，不需要複雜的靜態分析）：

- 有 `useQuery(...)`（TanStack Query）：安全，掛載時自己會抓資料 → `kind: "api"` 即可。
- 有 `useSelector(...)` 讀 Redux，但同一元件（或上層）也有掛載時 `dispatch` 抓資料的 `useEffect`：等同安全 → `kind: "api"`。
- 有 `useSelector(...)`，但找不到對應的掛載時自動 dispatch：危險訊號 → 該步驟標 `kind: "ui"`，模擬觸發點擊。

**填表時機可以搭便車，不必另外開一趟**：參考流程的步驟 3（在 code 中尋找頁面對應的 function/component）本來就要打開目標畫面相關的元件檔案，跟這裡要 grep 的是同一批檔案。Skill 應要求 Agent dev 在步驟 3-4 定位元件時順手做完這個判斷並寫回對照表，避免步驟 7 蒸餾時再掃一次同樣的程式碼。

這個判斷結果**增量累積**成一份對照表（見第 8 節目錄結構的 `.nav-recorder/data-source-map.md`），每次生成新 recipe 前先查表，查不到才重新分析、分析完寫回表裡。因為同一專案的資料抓取模式通常有慣例，累積幾筆之後大部分新畫面可以直接靠既有模式歸類，不用每次完整重新分析。此表存放於本機（見第 5 節，整個 `.nav-recorder/` 都不進 git），人類可隨時開啟檢視；若判斷過時（例如某天把某畫面從 Redux 遷移到 TanStack Query），表沒更新只會導致「多跑了不必要的 UI 步驟」——顯性、低風險，不需要額外治理機制。

同一份對照機制也適用於參數唯一性判斷（`.nav-recorder/param-constraints.md`）：存的不只是「這個欄位是 unique」的結論，還要存**判斷依據**——`source: "code"` 時記錄查到的 schema 位置；`source: "runtime-probe"` 時記錄實測當下的完整 error message（呼應上方 Recipe 格式裡的 `constraintEvidence`）。這樣之後同一支 API 被別的 precondition 用到時，不只能直接查表沿用結論，還能回頭檢視這個結論可信到什麼程度。

---

## 3. MV3 背景錄製架構

### 3.1 為什麼不用 `chrome.debugger` (CDP)

- `chrome.debugger.attach()` 會**獨佔**該分頁的 debugger 連線，跟原生 Chrome DevTools 衝突（`Another debugger is already attached` 錯誤）。
- 附加後會跳出無法隱藏的黃色警示條。
- 查證過官方文件與社群文章，這個限制**沒有解法**，官方建議的緩解策略是「只在任務執行期間短暫附加、做完立刻 detach」——這個策略跟「整天背景常駐錄製、同時可能隨時開 DevTools」的需求本質衝突，不適用。
- **結論：放棄 CDP 路線。**

### 3.2 改用：MAIN world content script 改寫 fetch/XHR

完全不經過 CDP，因此不會跟 DevTools 衝突，也不會跳出警示條。

```json
// manifest.json
{
  "manifest_version": 3,
  "permissions": ["nativeMessaging", "webNavigation"],
  "content_scripts": [
    { "matches": ["http://localhost/*"], "js": ["interceptor.js"], "world": "MAIN", "run_at": "document_start" },
    { "matches": ["http://localhost/*"], "js": ["relay.js"], "world": "ISOLATED" }
  ]
}
```

- `interceptor.js`（MAIN world）：改寫 `window.fetch` 與 `XMLHttpRequest.prototype.open/send`，攔截 request/response，用 `window.postMessage` 送出（MAIN world 拿不到 `chrome.runtime`，必須這樣中轉）。**務必 `response.clone()`**，否則會把 body 串流吃掉，導致頁面自己讀不到回應。
- `relay.js`（ISOLATED world）：監聽 `postMessage`，呼叫 `chrome.runtime.sendMessage` 轉送給 background。
- 路徑/導航變化改用 `chrome.webNavigation.onHistoryStateUpdated`（涵蓋 SPA 的 `pushState` 路由切換），同樣不經過 CDP。導航事件同時帶 `transitionType`（`link`／`typed`／`reload`…）。
- `interactions.js`（ISOLATED world）：錄使用者互動。**這是 SPA 上不可缺的一層**——切上方分頁、展開側欄群組只改 state 與 DOM，不換 URL、不打 API，光靠上面兩層完全看不到，Agent 只能靠 deep link 失敗後反推走法（2026-09-08 目標專案實錄）。做法仿 Chrome DevTools Recorder 與 Playwright codegen：capture phase 監聽 `click`／Enter `keydown`／`change`，只收 `isTrusted`；目標取 `composedPath()` 第一個尺寸非零的元素；每筆事件在頁面裡算好多組候選 selector（`aria/名稱[role=…]` → 測試屬性 → `#id` → 最短唯一 CSS 路徑 → `text/最短唯一文字`），加上 `text`／`role`／`href`／`ancestors`（最近三層有 role 或 aria-label 的祖先）。`change` 只記 select／input 的最終值，密碼一律 `***`。

**互動事件與導航附掛**（在 Companion 讀取時做，`distill/trail.ts`，host 端不保存跨事件狀態）：一個 `transitionType` 不屬於 typed／address_bar／reload／auto_bookmark 的導航，會附掛到同一 tab 內、5 秒內最近的一個 click（Playwright 的 `signalThreshold` 同為 5 秒）。有附掛的 click 是一跳的終點，前面沒有導航的 click（切分頁、展開群組）就是這一跳的中繼動作。頁面序列做「重訪即折回」去迴圈（`/Home → /X → /Home → target` 折成 `/Home → target`），每頁只取最後一次造訪視窗內的點擊；html／body／表單欄位上的 click 視為雜訊丟掉，沒有導航語意的 div／span 保留但標 `weak` 交 Agent 判斷。最後一跳直接預填 recipe 的 `targetHint.note` 與 `targetHint.clicks`。

已知限制（可接受）：抓不到繞過 JS 的原生 `<form>` submit（現代 SPA 幾乎不會這樣做）；若頁面對 `fetch` 做防篡改保護可能衝突（少見，遇到再處理）；selector 只在錄製當下驗證唯一性，回放時仍可能因畫面狀態不同而失效，所以每步存多組候選由 Agent 依序嘗試。

### 3.3 錄製範圍與觸發方式

- **白名單自動開**（如 `localhost`），不設「開始錄製」按鈕——按鈕會變成一個要記得做的額外動作，違背「錄製應該是背景無感副產品」的原則。
- 因為改走 MAIN world fetch/XHR patch（而非 `chrome.debugger`），**原本設計的「暫停/逃生口」機制已不再需要**——這個機制原本是為了應對 CDP 與 DevTools 的資源衝突，換路線後衝突本身就不存在了。
- 建議先只錄**目前 focus 中的分頁**（`chrome.tabs.onActivated`），避免多個背景分頁同時產生雜訊。

### 3.4 排除 Agent dev 自己操控瀏覽器時產生的雜訊

**架構前提**：本設計約定 Agent dev **在自己新開的獨立瀏覽器**（透過 Playwright MCP）裡執行 precondition 跟後續探索,不接管使用者當下的真實 Chrome。這個獨立瀏覽器跟裝有本 extension 的真實 Chrome 是不同程序,extension 天生看不到,**因此絕大多數情況這個問題不存在,不需要處理**。

**唯一的例外**：Agent dev 選用「直接接管使用者真實瀏覽器」的工具（例如 Claude in Chrome 這類）。這種情況違反本設計的架構前提，但為了穩健起見保留一個輕量的備援機制：Skill 行為準則要求 Agent dev 若判斷自己即將直接操作使用者真實瀏覽器，先呼叫 `nav-recorder pause`，操作結束後 `resume`。這是 Agent dev 遵照文件指令執行、不會「忘記」，成本可接受。

**簡化說明**：先前版本設計了 `chrome.debugger.getTargets()` 自動偵測機制當主要防線,現在因為架構前提改為「Agent dev 用獨立瀏覽器」,自動偵測不再必要,已移除。`"debugger"` permission 也隨之不再需要,見 3.2 節 manifest 已更新。

---

## 4. 去除雜訊（不需要 AI 語意判斷，用機械規則）

### Layer 1：丟棄所有 GET 請求

查看性操作（展開選單、點進去看一眼）幾乎全是 GET，不影響任何狀態。直接丟棄，濾掉大部分「到處按」的雜訊。

### Layer 2a：從終點畫面往回做可達性分析

對剩下的 mutating 請求（POST/PUT/PATCH/DELETE），從終點畫面往回追：這個請求的回傳值有沒有被後續步驟引用、或跟終點畫面顯示內容對得上。**沒有被引用、也跟終點對不上的，判定為死路自動丟棄**（原理同編譯器的 dead code elimination，不需要理解語意）。

**終點畫面的來源是明確傳入的，不是猜的**：錨點取自 `capture-recent --target-url`（見第 5 節），由 Agent dev 從參考流程步驟 4「使用者說明會改動哪些東西」的對話內容推斷。曾考慮過取「緩衝區最後一個導航事件」，但那個做法很脆弱——使用者在步驟 2 確認完需求後只要多點兩下，錨點就飄了，整層可達性分析會從錯誤的終點往回追、把真正需要的請求整批誤刪。改用明確傳入的目標後，錨點來自**使用者陳述的意圖**而非行為猜測，且對使用者仍是零額外動作（他本來就在描述要改哪個畫面）。

單獨用這一層會漏抓「認證類請求」——登入 API 的 response（Set-Cookie 或 token）不會出現在後續請求的 request body 裡（認證通常透過 Cookie/Authorization header 隱性帶出去），也不會出現在終點畫面上，Layer 2a 會誤判成死路。所以還要跑 Layer 2b。

### Layer 2b：認證供應鏈追蹤

獨立於 Layer 2a 執行，專門處理「有 header 供應鏈關係」的請求。判斷規則：**一個 mutating 請求 R 應視為必留，若它的 response 有 `Set-Cookie` header 且該 cookie 被後續某個請求真的帶出去，或它的 response body 裡的某個 token 值被後續某個請求的 `Authorization`/`Cookie` header 引用**。

實作要點：

- **狀態放在 Companion 端**，不是 extension（extension 的 service worker 易失，跨請求狀態不適合放這；Companion 本來就在維護滾動緩衝，多維護一份供應鏈映射成本低）。
- **`Set-Cookie` 追蹤**：Companion 維護 `Map<cookieName, sourceRequestId>`。凡是後續請求的 `Cookie` header 帶了對應的 name，就標記 source 為必留。
- **`Authorization` token 追蹤**：token 傳出去時常被包裝（加 `Bearer ` 前綴、base64 encode 等），不能做字串完全比對。改為從每個 response body 用正則抓「看起來像 token」的字串（JWT 的 `xxx.yyy.zzz` 格式、32 字元以上的 base64/hex 等），存進 `Map<tokenValueSubstring, sourceRequestId>`；後續請求的 `Authorization` header 值用 `.includes()` 掃有沒有包含這些 substring，有的話標記 source 為必留。
- **refresh 排除**：供應鏈追蹤會把「每次都回一顆新 token」的呼叫（例如某個目標專案的 `auth/check`，App 拿新 token 打下一個請求）也標成產生者，但它們只是靠既有登入態換 token，執行時 `ensureContext` 的登入就涵蓋了。因此一個被標記的產生者若同時滿足：不是登入呼叫、自身已帶 Authorization（或 cookie 來源非空）、request body 沒有任何可辨識的值、URL 沒有 query string，就視為 **token refresh**，不進必留集合，改列在 `evidence.dropped.authRefresh` 給 Agent dev 檢視。殘餘風險：`POST /tenant/{id}/switch` 這種參數只在 path 上、body 為空的 context 切換呼叫會一併被排除，需由 Agent dev 從 `authRefresh` 清單手動加回。
- **偏差取捨**：這種 substring 比對會**可能誤留**（response 裡某個看起來像 token 但實際不是的字串，剛好被後續 header 值包含）——這是「寧可誤留、不要誤刪」的方向，跟第 2 節「預設偏向風險低的一邊」原則一致（誤留只是多帶一支無害請求進 recipe；誤刪會導致認證步驟消失，後續整段執行失敗，代價完全不對稱）。

### 最終必留集合 = Layer 2a ∪ Layer 2b

兩層各自跑完，任一層判定為必留的請求都納入，避免任一邊漏抓。Layer 1（GET 丟棄）跟 Layer 3（模糊案例人工）不受影響。

### Layer 3：僅剩極少數模糊案例才需要人工

例如同一動作被重複觸發兩次、且兩次都各自被後續步驟引用，機械規則無法判斷取捨。此時才讓 Agent test 標記出來，明確問一句「這裡出現兩次 X，要用哪一筆？」——介入應精準、稀少，不是常態流程，也不要求使用者重新錄製整段。

### 登入請求不需要特殊排除

登入請求（含帳密）**不需要在攔截層額外過濾**，跟其他請求一樣正常走上述三層去噪流程即可——因為所有原始資料都不進 git（見第 5 節），加上開發時使用的帳號本來就是測試帳號，敏感度跟 `actors.json` 裡存放的測試憑證是同一等級，不需要多一層特殊處理。

登入請求本身之所以不會被 Layer 2 誤刪，是因為 **Layer 2b 認證供應鏈追蹤**（見上方）會偵測到「這個請求的 Set-Cookie/token 被後續請求引用」而把它標記為必留，不需要額外的 URL pattern 白名單。

但**錄到的登入請求，不能拿來當 precondition 執行時的實際登入憑證**，理由與是否敏感、進不進 git 無關，是純功能性問題：
1. 錄製當下只能是單一角色，處理不了「送出簽核」這類天生需要多角色（申請人、簽核主管）的情境。
2. 若登入涉及 OTP，錄下的驗證碼是一次性的，重播必定失敗。
3. 密碼可能被自行重設而悄悄過期，導致失敗原因跟程式碼改動無關，混淆真正該關注的訊號。

因此登入請求該取用的，只有 **URL、method、request body 欄位格式**（幫助確認登入 API 長相），憑證值一律改用 `.nav-recorder/actors.json` 裡各角色的測試帳密填入，執行時的登入機制見第 8 節「Precondition 執行時的登入身份」。

---

## 5. 錄製資料的存放方式

不用「開始/結束錄製」劃分 session，也不需要使用者額外下指令保存，改用**背景持續捕捉 + 隱式認領**：

- 本機 Companion 程式維持一個**滾動緩衝**（例如最近 2 小時），超過自動丟棄。
- **保存的觸發點，就是使用者交付任務給 Agent dev 的那一刻**：使用者跟 Agent dev 說「開始改動 XX」或「執行這個 plan」，這句話本身就隱含「我剛剛的操作是這次任務的前置導航」。不需要使用者再額外打一句保存指令。
- 具體實作寫進 Skill 行為準則：**Agent dev 每次任務開始時（參考流程步驟 4），自動呼叫 `nav-recorder capture-recent "<description>" --target-url <url>`**，把「上次認領時間點到現在」這段從滾動緩衝裡截取出來蒸餾成 recipe。時間邊界由工具自己追蹤上次認領的時間戳，不需要使用者判斷該存哪一段；`--target-url` 由 Agent dev 從使用者的需求說明中推斷（見第 4 節 Layer 2a）。
- 即使這段裡混了不相關操作，也不需要擔心：第 4 節 Layer 1 先丟掉所有 GET（探索性瀏覽幾乎全是 GET），Layer 2a 再**從 `--target-url` 這個明確錨點往回追**，跟目標畫面對不上、也沒被後續引用的操作會被判成死路丟棄。誤認領的成本低，靠的是**錨點精準**，不是靠延後投入成本。
- 這一步完全由 Agent dev 自動觸發，使用者不需要做任何多餘動作，成本趨近於零。

### `capture-recent` 的回傳值

蒸餾改為即時進行後（見第 2 節），`capture-recent` 必須回傳一個可直接接續的 handle，否則步驟 7 的 `execute-start <recipe-name>` 接不上——剛認領的那段還沒有名字：

```json
{
  "recipeName": "apply-review-20260907",
  "selfVerification": "passed",
  "targetHint": { "url": "/apply/{applicationId}/review", "note": "從列表點進對應那一筆" },
  "claimedRange": { "from": "2026-09-07T09:12:33Z", "to": "2026-09-07T09:41:07Z" }
}
```

`recipeName` 由 `--target-url` 與日期自動生成，Agent dev 在步驟 7 直接拿它餵給 `execute-start`。`selfVerification` 若為 `failed`，Skill 應要求 Agent dev 立刻把失敗原因回報給使用者，而不是等到步驟 7 才撞上。

### 測試迴圈期間的錄製污染

參考流程步驟 8 由 Agent dev 在獨立瀏覽器操作，extension 天生看不到（見第 3.4 節），不構成問題。但步驟 6→9 的迴圈中，**使用者自己去真實 Chrome 看一眼結果**是很常見的——這段會被照常錄下，而 `capture-recent` 只在任務開始時呼叫，所以這些「驗證用」的操作會一直留在緩衝區，被**下一個任務**的認領撈走。

兩道防線：

1. **主要緩解已由 `--target-url` 提供**：下一個任務的 Layer 2a 從**新的**目標畫面往回追，上一個功能的驗證操作跟新終點對不上，自動判死路丟棄。
   **殘餘風險（誠實標註）**：若上次驗證過程剛好造了資料，而那筆資料出現在新任務的終點畫面上（例如兩個功能共用同一個列表頁），仍可能被誤留。這屬於「誤留」方向，與第 4 節 Layer 2b 的取捨一致——多帶一支無害請求進 recipe，遠優於誤刪。
2. **追加低成本防線**：Skill 要求 Agent dev 在步驟 9 匯報結束時呼叫 `nav-recorder capture-recent --discard`——純推進認領時間戳、不生成任何 recipe，把整個驗證期的操作排除在下次認領之外。顯性、零使用者負擔。

### 檔案結構：全部集中在 `.nav-recorder/`，整個資料夾不進 git

```
.nav-recorder/                     # 整個資料夾不進 git，純本機資產
  preconditions/
    checkout-flow-recipe.ts        # 已蒸餾的固定路徑配方（見第 2 節格式）
    admin-login-recipe.ts
  data-source-map.md               # 各畫面資料來源判斷結果，見第 2 節「資料來源對照表」
  param-constraints.md             # 各 API 參數唯一性判斷結果與依據，見第 2 節「資料唯一性問題」
  raw/
    ...                            # 滾動緩衝與各次認領的原始紀錄（蒸餾後仍保留，供失敗時回溯比對）
    auth-provenance.json           # 認證供應鏈映射（Layer 2b 用），同步落盤保護 Companion 睡醒週期
  sessions/                        # recipe 執行狀態暫存（session file），詳見第 2 節「執行」
  actors.json                      # 測試帳號憑證
  README.md                        # Agent dev 讀取的本地入口，列出現有 precondition 與對照表位置
```

```
# .gitignore（init finalize 自動補上，doctor 持續檢查）
.nav-recorder/
.playwright-mcp/
```

`.playwright-mcp/` 是 Playwright MCP server（`@playwright/mcp`）的預設輸出目錄，會建在 MCP 啟動時的工作目錄（通常就是專案根目錄）。裡面是 `browser_snapshot` 太大時落地的 `page-*.yml`（頁面無障礙樹，含畫面文字與 ref 編號）、`browser_console_messages` 的 `console-*.log`、截圖與 trace。Agent 只在當次任務讀它，是一次性中間產物，內容又可能帶頁面資料，所以和 `.nav-recorder/` 一樣一律不進 git。

### 為什麼改成「全部不進 git」，不是原本的「只有原始資料排除」

原本設計是分層處理：蒸餾完的 recipe、對照表進 git（給團隊共用、PR 審查），只有原始資料排除在外。重新檢視後推翻這個設計，理由：

1. **precondition 目前的重複使用率不高**，「讓其他開發者透過 git 共用/審查」這個假設價值的前提本身還沒被驗證成立，不該為了一個還沒證實有價值的情境（跨開發者共用），投入分層管理的複雜度。
2. **累積價值仍然保留**：Recipe/對照表機制不變，本機的 Companion 持續累積、複用這些資料，達成「用越多、探查成本越低」的核心目標——累積的對象是「你自己這台機器」，不是「整個團隊透過 git 共用」，這個範圍縮小不影響核心價值。
3. **附帶好處**：因為所有資料都不出這台機器，第 3 小節原本針對「原始資料 vs. 蒸餾後資料」分別處理隱私（是否需要 faker 化以避免外洩）的必要性大幅降低——不會被推進遠端 repo、不會被其他開發者看到、不會永久留在 git 歷史裡，暴露面本身消失了，不需要再刻意區分「這個能進 git、那個不能」。**faker 化的機制本身仍然保留**，但目的收斂為單一：避免執行時撞唯一性約束（見第 2 節），不再兼任隱私保護角色。

**唯一仍值得留意的例外**：`actors.json` 存的是**可實際登入系統的憑證**，即使不進 git，也建議維持基本的檔案權限保護（例如只有你自己的作業系統帳號可讀），因為這不是一般測試資料，是真的能拿去登入系統做事的金鑰——但這只是基本衛生習慣，不需要為此建立額外的加密/vault 機制。

### 資訊入口：所有指標留在本機範圍內，不動 CLAUDE.md

因為 `.nav-recorder/` 整個不進 git，跟這個工具相關的資訊也應該全部留在本機範圍內，**不去動專案的 `CLAUDE.md`**（那份通常進 git 給團隊共用；把 nav-recorder 這種本機工具的路徑寫進去，對沒裝這個工具的隊友來說是無效噪音，也違反工具邊界原則）。

Agent dev 需要的入口資訊由兩個地方提供：

- **`skills/nav-recorder/SKILL.md`**：告訴 Agent dev 何時該呼叫 `capture-recent`（含如何推斷 `--target-url`、何時用 `--discard`）、如何查詢/執行既有 precondition、執行完如何交棒給測試階段。這是 Agent dev 讀入的主要行為指引。
- **`.nav-recorder/README.md`**（工具首次建立時自動產生）：條列目前這台機器上已有哪些 precondition、對照表位置、以及如何解讀 `constraintEvidence` 的 `source` 標記。Agent dev 需要時直接讀這份。

---

## 6. 資料怎麼傳給本地 AI

Companion 是**非常駐**程式，有兩種被啟動的方式：Chrome 開著時作為 native messaging host 接收錄製資料；Agent dev 呼叫 CLI 時作為單次命令執行。兩種模式共用同一份程式碼、共用同一份磁碟資料。

### 關於 Companion 的實際生命週期

`_「Chrome 開著時 Companion 就活著」是簡化說法_`——精確地說，Companion 跟 extension 的 **service worker 生命週期綁定**：

- 你活躍操作分頁 → service worker 活躍 → native messaging port 開啟 → Companion 活著
- 你切去做別的事一陣子沒動這個分頁 → Chrome 把 service worker 睡掉 → native messaging port 關閉 → **Companion 也隨之退出**
- 你之後又動這個分頁、觸發下一個請求 → service worker 被喚醒 → 開新的 native messaging port → Companion 重新啟動

看似脆弱，但**實務上不會導致資料遺失或狀態損毀**，靠兩層設計繞過：

1. **所有跨事件的狀態都同步寫在磁碟上，不留在 Companion 記憶體**：
   - 滾動緩衝每收到一筆事件就 append 到 `.nav-recorder/raw/` 對應檔案。
   - **認證供應鏈映射**（Layer 2b 用的 `Map<cookieName, sourceRequestId>` 與 `Map<tokenSubstring, sourceRequestId>`）也同步落盤到 `.nav-recorder/raw/auth-provenance.json`，每次事件更新後立即寫入，Companion 重啟時從磁碟重載。這一點特別重要，因為認證映射是「跨事件、跨時間」的累積資料，如果只留在記憶體，Companion 睡一次醒來 Layer 2b 就直接失效。
   - Recipe 執行狀態存在 `.nav-recorder/sessions/<sessionId>.json`（見第 2 節「執行」）。
2. **Companion 睡著的那段時間，本來就沒有資料需要處理**：service worker 睡著的前提是「頁面靜止、沒 fetch/XHR/navigation」，也就是說 Companion 睡著的那段時間本來就沒有事件會發生，不會錯過任何東西。這是被動架構的天然保護，不是刻意設計的巧合。

### 錄製資料流（Chrome 開著、service worker 活躍時）

```
瀏覽器分頁
  └─ interceptor.js (MAIN world) 攔截 fetch/XHR
       └─ postMessage
            └─ relay.js (ISOLATED world)
                 └─ chrome.runtime.sendMessage → background service worker
                      ├─ 檢查 pause 狀態（來自 Skill 的 pause/resume 指令，透過 Companion 反向通知）
                      │  └─ 暫停中 → 丟棄本次事件，不轉送
                      └─ Native Messaging
                           └─ Companion（此時作為 native messaging host 運行）
                                ├─ append 原始事件到滾動緩衝檔案（磁碟）
                                └─ 更新認證供應鏈映射並同步落盤（.nav-recorder/raw/auth-provenance.json）
```

Chrome 關閉，或 service worker 被 Chrome 睡掉，Companion 隨 native messaging port 關閉一起結束；磁碟上的緩衝、認證映射、session file 全部保留，下次 Companion 重啟時無縫接續。

### CLI 呼叫流（Agent dev 需要時）

```
Agent dev
  └─ 執行 `nav-recorder <command> [args]`
       └─ Companion（此時作為 CLI 短暫啟動）
            ├─ 讀取磁碟上的緩衝、認證映射、recipe、對照表、session file
            ├─ 執行請求的動作（讀取 recipe / 蒸餾 / execute-start / execute-next / execute-report 等）
            ├─ 必要時呼叫 Agent test（本地 LLM）做結構化萃取
            └─ 回傳結果，程式退出
```

主要 CLI 命令：
- `capture-recent "<description>" --target-url <url>`：Agent dev 任務開始時自動呼叫，隱式認領上次認領後到現在的紀錄並即時蒸餾成 recipe，回傳 `recipeName`（見第 5 節）；`--discard` 變體只推進時間戳、不生成 recipe
- `list` / `get-recipe <name>`：查詢已有 recipe
- `execute-start <recipe-name>` / `execute-next <sessionId>` / `execute-report <sessionId> ...`：三段式協調 recipe 執行（見第 2 節「執行」）
- `pause` / `resume`：控制 background 端錄製暫停（透過 Companion 反向通知 background service worker）

Native Messaging 需要一次性註冊 native messaging host manifest，指向本機 Companion 執行檔路徑；註冊後 Chrome 每次啟動自動能找到。

---

## 7. AI 怎麼利用資料

1. **認領當下即蒸餾**（參考流程步驟 4）：Agent test 讀取剛認領的原始紀錄，跑完第 4 節三層去噪，做結構化萃取生成 Precondition Recipe（判斷 faker/fixed/captured、依終點選擇原則決定 `finalNavigation` 與 `targetHint`），自動執行自我驗證（基本執行一次；若第二層唯一性推論觸發則連續執行兩次，見第 2 節），通過即存檔為正式資產並回傳 `recipeName`。原始紀錄保留，供日後失敗時回溯比對。
2. **Agent dev 使用時**（參考流程步驟 7，每輪測試迴圈都會用到）：
   - 直接 `execute-start <recipeName>`，零 LLM 成本、零探查，走 API + deep link 把狀態準備到上一站。
   - 依 `targetHint` 走完最後一跳，進入目標畫面。
   - 之後的一切（操控、驗證改動是否正常）：交給 Agent dev 自己的 Playwright/瀏覽器工具即時處理，不經過本工具，本工具不介入、不錄製、不留存這部分資料。

### 失效處理

Precondition 因**上游變更**（別人改的、偶發的）而失敗時，不需要監控機制——失敗是顯性的（腳本直接 throw），Agent dev 執行時自然會撞到，處理方式是重新錄製、直接覆蓋舊檔案。

**內生變更（Agent dev 自己改壞的）另當別論**：這種失效在步驟 6→9 的迴圈中每一輪都可能觸發，若也用「重新錄製」處理，等於要使用者反覆手動走一遍，成本完全不可接受。所以這一類不靠事後補救，而是靠第 2 節「終點選擇原則」在**設計上事先避免**——recipe 不碰正在改動的畫面，就沒有被自己改壞的表面積。若仍然失效，代表 recipe 違反了終點選擇原則，該修的是 recipe 的終點選在哪，而不是重錄一次同樣脆弱的路徑。

### 治理範圍的最終結論

- **導航層（本文件範圍）**：不需要人類審核 GUI。失敗會自我修正，錯誤代價低。
- **未來若要做更精準的失效機制**（例如綁定程式碼變更，只讓依賴變動檔案的節點失效）：屬於加分優化，非必要項；因為目前設計已改為全部本機保存、不進 git，這類機制若要做，需要額外設計「本機怎麼知道程式碼變了」（例如檔案 mtime 或 hash 比對，而非依賴 git diff），留待有實際需求時再評估。
- **測試/斷言層**：需要獨立設計治理機制（核准差異、留下審查紀錄），不在本文件範圍內。

---

## 8. 實踐架構：三個交付物（Extension、Companion、Skill）+ 一份安裝說明書

整個工具由三個實作單元組成，分工清楚不重疊；額外附一份安裝說明書。**Companion 是非常駐程式**，同時扮演兩種角色（見第 6 節）：Chrome 開著時作為 native messaging host 接收錄製資料，Agent dev 呼叫 CLI 時作為單次命令執行。這是同一支 Node.js 程式的兩種呼叫模式，不是兩個獨立元件。

| 交付物 | 角色 | 職責 |
|---|---|---|
| **1. MV3 Extension** | 錄製端 | 使用者真實 Chrome 裡背景常駐，攔截 localhost 的 mutating 網路請求與導航變化，透過 native messaging 傳給 Companion |
| **2. Companion**（Node.js 套件，兼具 native messaging host 與 CLI 兩種模式，非常駐） | 資料層與協調層 | 錄製資料的接收/去噪/蒸餾/儲存；recipe 執行時提供三段式協調 CLI（`execute-start`/`execute-next`/`execute-report`）給 Agent dev；管理 session file 與 constraint 累積 |
| **3. Skill 檔案**（放在跟其他 skill 分開的目錄，例如 `~/.claude/skills/nav-recorder/`） | Agent dev 的行為指引 | 教 Agent dev 何時呼叫哪個 Companion CLI 命令；如何從使用者的需求說明推斷 `--target-url`；步驟 3 定位元件時順手填 `data-source-map.md`；何時開新的 Playwright browser context 對應哪個 actor；如何依 Companion 回傳的 action 用 Playwright MCP 執行；三段式協調的循環邏輯；`done` 之後不關 browser、依 `targetHint` 交棒進測試；步驟 9 呼叫 `--discard`；pause/resume 備援機制 |
| **附：安裝說明書** | 給 Agent dev 讀入 | 涵蓋 Extension 側載步驟、native messaging host manifest 註冊、Companion 套件安裝、Skill 檔案放置位置、`actors.json` 建置指引、環境需求（Node.js 版本、Agent dev 需要有 Playwright MCP 能力） |

### Skill 目錄與其他 skill 分開

Skill 檔案要放在跟 Claude Code 內既有 skill **不同的資料夾**（例如 `~/.claude/skills/nav-recorder/` 而非跟其他 skill 混在同一層），因為職責跟其他 skill 不同（其他 skill 通常是「教 Agent dev 用某個工具」，本 skill 是「教 Agent dev 遵循一組協定跟本工具協作」），分開放讓 Agent dev 載入時不會誤把兩者的規則混用。

### Agent dev 執行 precondition 的協作循環（Skill 教的行為）

```
1. Agent dev 收到「先把畫面準備好」的任務（參考流程步驟 7）
2. 呼叫  `nav-recorder execute-start <recipe-name>`         → 拿到 sessionId
3. 循環:
   a. 呼叫 `nav-recorder execute-next <sessionId>`
   b. 收到 action 描述（含 contextName / actor / kind / 具體參數）
   c. 若該 contextName 對應的 BrowserContext 尚未建立:
      - 建立新的 Playwright BrowserContext
      - 讀 `.nav-recorder/actors.json` 取 actor 憑證，打登入 API 建立 session
   d. 用該 context 執行 action（fetch 或 UI 操作）
   e. 呼叫 `nav-recorder execute-report <sessionId> --status ok --captured ...`
      或 `--status error --message ...`
   f. 若回應是 `done` → 用 `finalContext` 對應的 context 跳轉 `finalNavigation`（上一站）
      → **不關閉 browser 與任何 context**，依 `targetHint` 自行走完最後一跳
      → 交棒進入測試（參考流程步驟 8），本工具的職責到此結束
   g. 若回應是 `halt` → 把 `reason` 回報給人類，停止
   h. 若回應是 `continue` → 回到 3a
```

步驟 f 的「不關閉」是刻意的：那些 context 已登入、已就位，正是步驟 8 要用的，也是步驟 6→9 迴圈後續幾輪可以重用的（詳見第 2 節「執行結束後的交棒」）。

多角色場景（例如「送出簽核」需要申請人建單 + 主管簽核）就是這個循環自然衍生的結果：Companion 回傳的 `contextName` 會在不同 step 之間切換，Agent dev 依此在 Playwright 裡維護多個獨立 context 並行運作，各自獨立 cookie jar，互不干擾。

### 為什麼是 Skill + Companion CLI，不是 MCP server

原本規劃的 MCP job 模式（`search_flows`、`run_flows` + polling）是為了「測試執行」這種偏長、偏模糊查詢的場景設計的。收斂到純導航之後，Agent dev 的需求其實只是「一組結構化的 CLI 命令 + Skill 教怎麼組合它們」：Companion 每次 CLI 呼叫短暫啟動、用完退出，本身就是一個「無需 daemon」的協定；也不需要非同步 job/polling 機制（三段式協調 CLI 天然支援長流程）。Skill + CLI 比維護一個 MCP server 輕量得多，符合本設計「盡量砍掉不必要複雜度」的方向。若未來真的需要做治理層/測試層（模糊查詢、非同步執行），屆時再評估加 MCP，現階段不需要。

### 主要 CLI 命令一覽

```
# 資料查詢
nav-recorder list                              # 列出目前有哪些 precondition
nav-recorder get-recipe <name>                 # 取得某個 recipe 的內容
nav-recorder get-actor <name>                  # 取得某個 actor 的憑證（給 Skill 教 Agent dev 讀取）

# 錄製認領
nav-recorder capture-recent "<description>" --target-url <url>
                                               # 任務開始時（步驟 4）自動呼叫，認領 + 即時蒸餾，回傳 recipeName
nav-recorder capture-recent --discard          # 任務結束時（步驟 9）呼叫，只推進時間戳、不生成 recipe

# 執行協調（三段式，見上方協作循環）
nav-recorder execute-start <recipe-name>
nav-recorder execute-next <sessionId>
nav-recorder execute-report <sessionId> --status ok|error [--captured ...] [--message ...]

# 錄製暫停（Skill 備援協定，見第 3.4 節）
nav-recorder pause
nav-recorder resume
```

`capture-recent` 不是使用者手動輸入的指令，而是寫進 `SKILL.md` 的行為準則：Agent dev 收到任務指示時（參考流程步驟 4），**先自動呼叫這個指令**，才開始正式工作；任務匯報結束時（步驟 9）再呼叫一次 `--discard` 版本清掉驗證期的雜訊。`--target-url` 由 Agent dev 從使用者的需求說明中推斷。使用者本身完全不用意識到這兩步存在。

### 具體技術選型清單

| 用途 | 工具 | 備註 |
|---|---|---|
| 網路請求攔截 | MAIN world content script，patch `window.fetch` / `XMLHttpRequest` | 見第 3.2 節，刻意不用 `chrome.debugger` |
| 導航路徑追蹤 | `chrome.webNavigation.onHistoryStateUpdated` | 涵蓋 SPA `pushState` 路由切換 |
| Extension ↔ Companion 通訊 | Native Messaging | 需一次性註冊 host manifest，指向 Companion 執行檔 |
| Companion | Node.js 套件，非常駐，同時作為 native messaging host 與 CLI | 錄製時被 Chrome 啟動；Agent dev 需要時被 bash 短暫啟動 |
| 固定 UI 腳本錄製（precondition 類型二，見第 2 節優先順序） | `npx playwright codegen`，可搭配 `--save-har` 同時存網路請求 | 僅在沒有對應 API 時使用 |
| Precondition 執行的實際瀏覽器操作 | Agent dev 自己的 Playwright MCP，在**獨立於使用者真實 Chrome 的新開瀏覽器**中執行 | Companion 不啟動任何瀏覽器；多角色場景由 Agent dev 在同一個 browser instance 底下開多個 `BrowserContext` 並行處理 |
| Precondition 執行時的登入身份 | 獨立測試帳號（存於 `.nav-recorder/actors.json`），Recipe 各步驟以 `actor` 欄位標記所需身份 | **不共用使用者當下真實瀏覽器的 session**（曾考慮過 CDP 接管真實分頁，因無法得知使用者當下操作狀態、且無法處理多角色情境而放棄）；各 actor 首次使用時由 Agent dev 打登入 API 建立 session，同一次執行內 context 復用 |
| 資料唯一性判斷 | 讀 EF Core migration/Fluent API（第一層，權威）；查無依據時連續執行兩次比對 error message（第二層，推論） | `@faker-js/faker` 動態生成，結果存 `.nav-recorder/param-constraints.md` 並標記 `source` |
| Precondition 儲存格式 | TypeScript 物件（`.ts`），非資料庫 | 人類可讀、可隨時直接開啟檢視；全部存於本機 `.nav-recorder/`，不進 git（見第 5 節） |
| 資料來源判斷 | 讀原始碼 grep hook 呼叫模式（`useQuery`/`useSelector`/`dispatch`），結果存成 `.nav-recorder/data-source-map.md` | 見第 2 節，判斷該用純 API 還是混合 UI 步驟 |
| Agent dev 消費介面 | Claude Code Skill + Companion CLI | 不用 MCP server，見上方說明 |

**註**：測試帳號機制的完整運作方式：Recipe 各步驟以 `actor` 欄位標記所需身份（見範例）；`.nav-recorder/actors.json` 存各角色帳密；執行時 Agent dev 依 Companion 每次回傳的 `contextName` 建立或復用 Playwright `BrowserContext`，每個 context 首次使用時打登入 API 建立 session，同一 recipe 執行內 context 復用不重登；若登入流程複雜（如 OTP），比照第 2 節「Playwright codegen 錄製的固定 UI 腳本」處理，且建議在建置測試帳號階段就跟後端協調讓自動化帳號跳過 OTP，而非在執行邏輯裡處理。

```typescript
steps: [
  { actor: "automation-employee", call: { method: "POST", url: "/api/applications" }, ... },
  { actor: "automation-manager", call: { method: "POST", url: "/api/applications/{id}/approve" }, ... },
]
```

---

## 9. 已知的競品/參考專案（調研結論）

| 專案 | 做的事 | 跟本設計的差異 |
|---|---|---|
| Stagehand | `observe`/`act` 快取，單次 session 內有效 | 沒有跨 session 持久化知識、沒有 GUI |
| site-memory (GitHub) | Skill 形式，站點記憶自動累積，WebVoyager 上省 67-94% 成本 | 無 GUI；服務對象是任意第三方網站，信任度天生較低 |
| Yad (al-yad) | Chrome extension + 本地 Companion，action-cache + recovery-store，控制使用者真實登入 Chrome | 有 dashboard 但是工作佇列 UI，非知識圖譜編輯器 |
| Meticulous | 錄製真實 session、確定性重播、PR 觸發比對 | 完全不同賽道（回歸測試，非導航效率），需要真實流量 |

**結論**：目前沒有專案同時做到「執行/快取 + 持久化知識 + 人類可視化編輯」，本設計的差異化價值在於明確聚焦「**在開發的當下**，把畫面狀態準備到目標畫面的上一站」這一件事；資料全數留在本機（不進 git），累積價值仍在（同一台機器上用越多、探查成本越低），但不強求跨開發者共用，範圍務實，同時在目前範圍內刻意不做治理、不處理開發中探索，降低複雜度。
