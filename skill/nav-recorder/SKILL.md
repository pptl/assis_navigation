---
name: nav-recorder
description: 開發網頁專案時，凡是收到「開始改動 XX 功能」「執行這個 plan」「幫我修 XX 畫面」這類開發任務、需要把瀏覽器狀態準備到某個功能畫面附近再測試、或在任務收尾匯報前，都必須使用此 skill。它教你如何與本機 nav-recorder Companion CLI 協作：任務開始時先查專案累積的知識庫（既有 recipe、route-catalogue 記載的畫面名稱與選單位置、data-source-map 與 config.navigation 記載的畫面進入方式是深連結還是走選單）再動手、用 routes recent 從剛才的錄製直接挑出目標畫面而不是翻 router 設定去猜、自動認領使用者剛才在 Chrome 裡的操作錄製並蒸餾成 precondition recipe（capture-recent）、依 recipe 的 shape（純導航／依賴既有資料／要先建資料）決定要處理哪些決策與驗證什麼、補完語意欄位並立刻自我驗證、測試前用三段式協定（execute-start / execute-next / execute-report）搭配 Playwright MCP 把畫面導到「目標畫面的上一站」、交棒後不關瀏覽器、任務結束呼叫 --discard 清掉驗證期雜訊。若專案根目錄有 .nav-recorder/ 資料夾，代表此協定已啟用。
---

# nav-recorder — Agent dev 協作協定

本 skill 只教「怎麼跟 Companion 協作」，不教怎麼實作 precondition 邏輯。所有判斷 faker / 追蹤 captured / 計算失敗次數的機械邏輯都在 Companion 裡；你負責：推斷 `--target-url`、補完語意欄位、用 Playwright MCP 執行 Companion 指派的動作、把結果回報回去。

## 前提

- 專案根目錄有 `.nav-recorder/`（含 `config.json`、`actors.json`、`README.md`）。沒有就先做步驟 0。
- `.nav-recorder/` 是這個專案**累積下來的知識庫**，不是一次性的設定檔：`README.md`（有哪些 recipe、各自是什麼 shape）、`route-catalogue.md`（使用者口中的畫面叫什麼、對應哪條 path、掛在哪個選單分頁底下）、`data-source-map.md`（畫面怎麼進去：`config.navigation` 是全站預設，表上的每一列是它的例外或個別驗證過的結果）、`param-constraints.md`（哪些參數有唯一性限制）。前一個 agent 踩過的坑都寫在這裡。**每次任務開始都要查**（步驟 1），不是 onboarding 讀過一次就算。
- 所有 `nav-recorder` 命令要在專案目錄內執行，或加 `--project <專案根目錄>`。
- 每個命令的 stdout 是**單行 JSON**；錯誤在 stderr 也是 JSON（`{error, code, details}`）且 exit code 1。加 `--pretty` 可換行輸出方便閱讀。
- Windows PowerShell 傳 JSON 參數容易被引號吃掉：大的 JSON（response、storage snapshot）一律先寫到 scratchpad 檔案，再用 `--response @<路徑>`、`--storage-snapshot @<路徑>` 傳入。
- 第一次使用或懷疑環境有問題時執行 `nav-recorder doctor --pretty`，全部 `ok: true` 才繼續。

## 參考流程對照

```
0.   第一次接這個專案                             ← 步驟 0：onboarding（只做一次）
1-2. 使用者在真實 Chrome 看系統、確認需求        ← extension 背景錄製中
3.   你在 code 裡找對應元件                        ← 步驟 2：補 data-source-map
4.   使用者說明要改什麼、你收到任務               ← 步驟 1：查知識庫（routes recent 找目標畫面）+ capture-recent；步驟 3-4：依 shape 分支補完草稿並自我驗證
5.   你實作
6.   你開始測試
7.   你用 recipe 把畫面準備到目標畫面的上一站     ← 步驟 5：執行迴圈；步驟 6：交棒
8.   你用 Playwright MCP 操控、測試改動           ← 本 skill 不介入
9.   匯報並結束                                   ← 步驟 7：--discard
```

## 步驟 0 — 接新專案（onboarding）

**觸發條件**：專案根目錄沒有 `.nav-recorder/config.json`（任何命令回 `E_NO_PROJECT`），或 `doctor` 的 `onboarding` 項目顯示未完成。做完一次之後，同一專案不需再做。

工具本身不認識任何專案；你要蒐集的是「這個專案怎麼跑、怎麼登入、API 長什麼樣」，Companion 只負責驗證答案並組出三個檔案：`config.json`、`actors.json`、煙霧 recipe `login-ready`。

1. `nav-recorder init --project <專案根目錄> --pretty`。回傳問卷：`missingRequired`（必填且未回答）、`optionalMissing`、`unconfirmed`（Companion 依 package.json / 檔案掃描機械預填的推論）。每個欄位附 `hint`（去哪找證據）、`verify`（怎麼用 Playwright 對活站台驗證）、`question`（推不出來時問使用者的原話）。`nav-recorder init catalogue` 可看完整目錄。
2. 逐欄位從專案原始碼找證據，找到就回答並附出處：
   ```
   nav-recorder init answer <field> --value '<json 或字串>' --source code --evidence "<檔案:行 或 依據>"
   ```
   值是 JSON 時用單引號包住整段（PowerShell 下建議寫進檔案再 `--value-file <path>`）。多個欄位可寫成一個 JSON（`{"<field>": {"value": …, "source": "…", "evidence": "…"}}`）用 `init answer --from-file <path>` 一次填。
   四個最容易答錯的欄位，各有一道檢查，**不要略過**：
   - `navigation`：**唯一一個不准從程式碼推的欄位**。它問的是「直接用網址進得去嗎」，那是行為，不是架構——是不是單頁應用不決定答案。做法：登入後在同一個乾淨 session 直接 `browser_navigate` 到一條**不是登入落地頁**的功能頁路徑（從使用者提到的畫面挑一條），`browser_snapshot` 看主內容區有沒有真的渲染、側欄有沒有停在對的分類。正常 → `{"entry":"deeplink"}`；空白或選單停在別的分類 → `{"entry":"menu"}`。一律 `--source verified`（真的沒帳號才 `--source user` 問使用者）。答成 `code` 或留在 `unknown` 都會出 warning，`doctor` 也會紅。
   - `apiBases`：回答後看輸出的 `resolvedPreview`。它必須是「主機 + 路徑前綴」（例如 `https://host/app-name/`）；若只是 `https://host/`，代表 `append` 漏了前綴，去組 URL 的函式或設定檔把前綴找出來重答。`warnings` 會標出 bare origin。
   - `readOnlyPatterns`：先跑 `nav-recorder init suggest-readonly --files "<service/adapter 層 glob>" --pretty` 拿到結尾動詞直方圖。**每個 count ≥ 2 的動詞都要歸類**（讀取 → 放進 pattern；寫入 → 不放；`unclassified` → 開一個範例端點的呼叫處判斷），回答後 `warnings` 若列出未涵蓋的動詞就是還沒做完。回報使用者時附上你的分類表。
   - `dataSourceRules`：這是必填。套件預填為空時更要自己寫，至少一條「掛載時抓資料的慣例」（`verdict: api`）與一條「依賴上一頁狀態」（`verdict: ui`）；真的沒有就回答 `[]` 並在 `--evidence` 說明理由。
3. **能用 Playwright 驗證的一定要驗**（`verify` 有寫的欄位）：`browser_navigate` 開站台確認 `appOrigins`；開登入頁 `browser_snapshot` 確認 `login.fields` 與 `submit` 三個 selector 各自唯一對上；登入後 `browser_evaluate` 讀 storage 確認 `auth.tokenSource`；`browser_network_requests` 看真實請求確認 `apiBases`；開落地頁確認 `smoke.landingPath` 與 `smoke.verify`。驗過的重新 `answer` 並改 `--source verified`。沒有帳密時只能驗到登入頁，其餘留 `code` 並在回報中說明。
4. **推不出來的欄位集中一次問使用者**：把所有還缺的必填欄位的 `question` 原話整理成一輪 AskUserQuestion（不要一個一個問），回答後 `answer … --source user --evidence "使用者提供"`。
5. **帳號與密碼的硬規則**：`actors` 一律向使用者問角色與帳號名稱，不從程式碼、其他 repo、e2e 設定裡翻；密碼不進對話，finalize 會在 `actors.json` 留 `CHANGE_ME`，請使用者自己填檔。
6. `nav-recorder init status` 確認 `complete: true` 且 `warnings` 為空（每一條 warning 都要處理：重答加 `--force`，或在回報裡逐條說明為何可接受）。`inferred` 狀態可以 finalize，但要在回報裡列給使用者。然後：
   ```
   nav-recorder init finalize --pretty
   ```
   產生 `config.json`、`actors.json`、`preconditions/login-ready.json`、README，並把去掉密碼的範本回寫到工具 repo 的 `examples/<專案名>/`（下次別台機器可 `init --template <專案名>`）。**埠不需要登記**：所有 loopback 頁面都照錄，事件算哪個專案由 Companion 從佔用該埠的 process 推出來，所以 dev server 換埠不影響任何事（`nav-recorder ports` 可查）。只有非 loopback 的站台（前端掛在遠端測試站台）才會被註冊。
7. **處理 `.gitignore`**：finalize 會把兩個目錄加進最近的 git 根目錄 `.gitignore`：`.nav-recorder/`（測試帳密與原始流量）和 `.playwright-mcp/`（Playwright MCP server 在專案目錄下落地的頁面快照 `page-*.yml`、console log、截圖，內含畫面內容與 ref 編號，是一次性中間產物）。兩者都絕對不能進 git。輸出的 `gitignore` 欄位說明結果：`added` → 看 `added` 陣列知道這次補了哪幾行（`present` 陣列是本來就有的），`.gitignore` 可能在專案上層，這是使用者 repo 裡被追蹤的檔案，回報時明確告訴他改了哪個檔案；`present` → 兩個都已存在，不用動；`no-git-root` → 找不到 git 根目錄，你要自己在專案會被版本控制的位置加上 `patterns` 列出的每一行並告知使用者。`doctor` 的 `gitignore` 項目會持續檢查這兩個目錄；舊專案只缺 `.playwright-mcp/` 時，直接補進同一個 `.gitignore` 即可。
8. 收尾：請使用者填 `actors.json` 的密碼（extension 已載入就不必重啟 Chrome——loopback 一律錄，沒有要同步的白名單）→ `nav-recorder doctor` 全綠 → 用步驟 5 的迴圈執行 `nav-recorder execute-start login-ready`，跑到 `done` 且畫面停在落地頁，代表登入 selector、auth、storageReset、落地頁全部正確。回報時附上 `unconfirmed` 清單（哪些答案是推論、依據是什麼）。

各欄位去哪找證據、怎麼驗證、找不到問什麼，以 `init catalogue` 的輸出為準；`docs/CONFIG.md` 的「怎麼蒐集」欄與它同步。

## 步驟 1 — 任務開始：查知識庫、認領錄製並取得 recipe

在開始讀程式碼或動手之前先做，不要等到要測試才做。

1. 找出 `--target-url`。**不要自己去翻專案的 router 檔、選單設定或 permission 設定**——那是最貴、最容易推錯的做法，而且推完不會留下任何東西。照這個順序：
   ```
   nav-recorder routes recent --pretty
   ```
   這會列出使用者剛才的錄製**實際走過**的每一條 route，最近造訪的排最前，並附上 `enteredBy`（進來之前點了什麼，包含上方分頁的切換）與目錄裡已知的 `names` / `placements`。**目標畫面九成在這份清單裡**——使用者就是站在那個畫面上跟你講需求的。挑一條，只取 path，不要 query string。
   - 清單裡沒有明顯對得上的 → `nav-recorder routes find "<使用者說的詞>"`，對畫面名稱、路徑、選單位置做子字串比對。回多筆是正常的（同一個名稱常對到不只一條 route），靠 `placements` 的選單位置分辨，不要只看名稱就選。
   - 完全不確定是哪一條 → 直接呼叫 `nav-recorder capture-recent "<描述>"` **不帶** `--target-url`，它會回同一份候選清單而且不會認領任何東西，挑好再帶著 `--target-url` 呼叫第二次。
   - 兩種查法都查不到，才可以去讀專案原始碼。**而且一旦找到，當下就要寫回去**：`nav-recorder routes set <route> --name "<畫面名稱>" --chain "<上方分頁> > <側欄群組>" --evidence "<依據>"`。沒寫回去，下一個 agent 會把你剛才吃的苦再吃一遍。
2. **在你導航到任何畫面之前**，查這個專案的畫面進入方式：
   ```
   nav-recorder data-source get <route> --pretty
   ```
   看 `effective`：`entry` 是 `deeplink`（可以直接 `browser_navigate`）還是 `menu`（必須走應用程式自己的選單），`from` 說明這個答案哪來的——`route` 是這條 route 自己驗過的紀錄，`site-default` 是 `config.navigation` 的全站預設。**查不到（`found: false`）不是沒有答案**，它就是繼承全站預設，`effective` 照樣會給你結論。你不需要再從別條 route 的 evidence 文字去推全站通則。
   - `data-source list --pretty` 看全貌：`siteDefault` 加上所有例外。全站是 `menu` 時，表上的 `api` 列就是可以省下選單操作的深連結捷徑；全站是 `deeplink` 時，`ui` 列就是會撞空白畫面的陷阱。
   - `effective.entry` 是 `unknown` → 這個專案還沒確認過（`config.navigation` 沒填）。你要在第一次導航時當場觀察結果，立刻 `data-source set` 回寫，並提醒使用者補上 `config.navigation`。
3. 找有沒有現成 recipe：
   ```
   nav-recorder list --target-url <上一步推斷的 path>
   ```
   每筆結果附 `matched`：`exact`（同一個畫面）、`prefix`、`section`（同一個 controller 底下的鄰居，常共用前置流程，值得看一眼）。`total` 是專案裡的 recipe 總數，`recipes` 是過濾後的，兩者不同代表有東西被濾掉了。沒有結果就再試 `nav-recorder list --match <關鍵字>`，或不帶參數看全部。
   有一筆的 `targetUrl` / `description` 就是這次的目標畫面 → 直接沿用其 `name`，跳到步驟 3 檢查 `draft` 是否為 false。
4. 呼叫：
   ```
   nav-recorder capture-recent "<一句話描述這次任務>" --target-url <path> --pretty
   ```
   - 多角色專案可加 `--actor <actors.json 裡的預設角色>`。
   - 回傳 `recipeName`（之後餵給 `execute-start`）、`recipeFile`、`shape`（見步驟 3，決定你接下來怎麼做）、`existingDataRefs`、`finalNavigationEntry`（上一站要怎麼進去）、`evidence`（留下哪些請求、為什麼；丟掉哪些）、`pendingDecisions`、`probeRecommended`、`finalNavigationGuess`、`path`。
   - `claimedRange` 是認領指標移過的範圍（上次認領到現在，全部），`scope.fromSeq` / `scope.events` 才是真的拿去蒸餾的部分。兩者不同時看第 6 點。
   - `path` 是從導航與錄到的點擊機械拼出來的走法：`pages` 是折掉繞路後的頁面序列，`hops[i]` 是「從 pages[i] 到 pages[i+1] 之間點了什麼」，每個 click 有 `text`、`role`、`href`、`selectors`（aria 名稱優先，再 data-testid、id、css、text）、`assertedNavigation`（這一下真的換了頁）。`weak: true` 代表點的是沒有語意的 div/span，可能是雜訊也可能是 MUI 選單項，自己判斷。最後一跳已預填進 `targetHint.note` 與 `targetHint.clicks`。
   - `path.hops` 全部 `clicks` 為空、但 raw 明明有操作 → extension 沒重新載入（`nav-recorder doctor` 的 `interactions recorded` 會紅），請使用者到 chrome://extensions 重新載入後再操作一次。
5. 錯誤處理：
   - `E_NO_ANCHOR`：錄製裡沒有導航到你給的 path。看 `details.routes`（與 `routes recent` 同一份清單，附中文名與選單位置），挑正確的 path 重呼叫；都不像就問使用者「你剛才是在哪個畫面確認需求的？」。
   - `E_NO_EVENTS`：沒有任何錄製。**先看 `details`**（就是 `nav-recorder ports` 的內容）：
     - `unrouted` 有東西 → 使用者的操作被收進暫存區了（那個 dev server 的命令列看不出屬於哪個專案）。確認那個埠就是本專案的站台後 `nav-recorder activate --port <n> --adopt`，再重跑一次本步驟。
     - `mine` 是空的 → 沒有任何在監聽的埠被判給這個專案，多半是 dev server 沒起來。
     - 兩者都正常 → 使用者可能真的還沒操作，或分頁不是作用中的那個（只錄 focus 的分頁）；也可能 extension 沒載入（`nav-recorder doctor`）。
     都排除不了就在沒有 recipe 的情況下繼續任務（步驟 7 改為自己用 Playwright 探查）。
   - `E_NO_PROJECT`：先確認 `--project` 指對；專案真的沒有 `.nav-recorder/` 就先做步驟 0。
6. 看 `scope`、`segments` 與 `warnings`：認領範圍是「上次認領到現在」。一天做好幾個任務時（小任務常常根本沒走這個 skill、也沒認領），它會橫跨好幾段不相干的瀏覽，前一個任務的請求會因為共用同一個使用者、同一批主檔資料，被值流分析串進來。所以 Companion 會把認領範圍機械切成「瀏覽段落」（閒置超過 `recording.sessionGapMinutes`、新分頁首次載入、回到登入頁），**預設只蒸餾到達目標畫面的那一段**；同一分頁內回到登入頁的邊界會往前併（視為同一任務內換角色或登入逾時）。更早的段落照樣被認領，但不蒸餾，列在 `scope.excludedSegments`。
   - `pendingDecisions` 有 `excludedSteps` → 被排除的段落裡有「整段蒸餾會留下」的步驟，`options` 逐條列出。判斷它們是不是這次任務的前置：是（在另一個分頁建立了目標畫面要看的那筆資料、在另一個分頁換角色簽核）→ 照 message 用 `--from-seq` 重跑（明確指定範圍就整段蒸餾），並刪掉這份草稿；不是（前一個任務留下的）→ 刪掉這個 decision 即可。它常和 `existingData` 一起出現，兩者講的是同一件事，擇一處理。
   - 還沒認領、想整段蒸餾 → `--all`；只想從某一段開始 → `--from-seq <該段的 fromSeq - 1>`。這兩種都不會自動縮範圍。
   - `scope.mode` 是 `session`、`excludedSegments` 為空，但 `warnings` 仍提到多個段落 → 邊界都是同分頁回到登入頁，已經整段保留，不用處理。
7. 先看 `pendingDecisions` 有沒有 `newActor`：有就先問使用者那些帳號是什麼角色（見步驟 3 的表），不要等到補草稿才處理。
8. 把 `evidence.dropped.readOnly` 以外的 dropped 清單掃一眼：若有明顯該留的寫入請求被判 `unreachable`，代表 `readOnlyPatterns` 誤殺或錨點選錯，回報使用者，不要自己硬改 config。`dropped.authRefresh` 是 Companion 判定為 token refresh 的認證呼叫（已登入、body 沒帶任何參數、只是換一顆新 token，例如 `auth/check`），登入後 `ensureContext` 就會涵蓋，不需要進 recipe；只有當裡面混進「切換公司／租戶」這類參數只在 path 上的 context 切換呼叫時，才手動加回為 api 步驟。

## 步驟 2 — 補 data-source-map（查在步驟 1，這裡只管寫）

表在步驟 1 已經整份讀過了，這一步是**寫**：你在參考流程步驟 3 本來就要打開目標畫面的元件檔，順手把還沒記錄的 route 補上。

1. 步驟 1 的全表裡已經有這條 route 就不用再寫——除非你實際跑過發現記錄的行為跟現況不符，那要更新它。
2. 沒有 → `nav-recorder data-source scan <route> --file <元件檔路徑> --apply`。它只是機械套用 `config.dataSourceRules`，看 `suggestions` 合不合理。
3. 規則沒命中 → 你自己判斷：畫面掛載時會不會自己抓資料？會 → `api`；只靠上一頁塞進 store / sessionStorage 的資料 → `ui`。然後 `nav-recorder data-source set <route> --verdict api|ui --evidence "<依據>" --file <元件檔>`。
4. 這張表決定：recipe 裡若必須「經過」某個中繼畫面，該畫面是 `ui` 就得用 `kind: "ui"` 步驟真實點進去，不能只靠 API + deep link。
5. 沒有要改 code 的任務（純測試、只做驗證）不會經過這一步，但只要你在瀏覽器上觀察到某個畫面的進入方式，一樣要照「注意事項」的規則當場寫回去。

## 步驟 3 — 補完草稿 recipe 的語意欄位

**先看 `shape`。** 它由 Companion 機械判定（有沒有留下 api 步驟、目標畫面有沒有依賴某筆既有資料），決定這份 recipe 哪裡會壞、因此該花力氣驗什麼。不要自己事前猜，也不要因為「看起來很簡單」就跳過驗證：

| shape | 意思 | 要處理的 pendingDecisions | probe | 步驟 4 要驗什麼 |
|---|---|---|---|---|
| `navigation` | 純導航，什麼都不用建 | `confirmFinalNavigation`、`confirmTargetHint` | **不跑**（沒有參數可探） | 跑到 `done` 之後，**在同一個瀏覽器照 `targetHint.clicks` 實際走一遍**，確認網址到達 `targetHint.url` 且畫面有內容。`verify` 必須補到非空——那是這類 recipe 唯一驗得到的東西 |
| `navigation-existing-data` | 也不用建，但目標畫面依賴一筆**沒有任何步驟會建立**的資料 | 同上 ＋ `existingData` | 不跑 | 同上，而且最後一跳要真的看到那筆資料 |
| `data` | 有 api 步驟會建立狀態 | 現行全部 | 依 `probeRecommended` | 現行流程 |

`existingData` 的處置只有兩條路，選一條並說清楚：**接受這個假設**（保留 `existingDataRefs`，在 `description` 寫明「這份 recipe 需要測試庫裡已有 X」）；或**補一個 api 步驟把它建起來**（存檔時 `shape` 會自動變成 `data`）。不處理就是留一個換台機器會靜默失敗的 recipe。

`capture-recent` 產生的 recipe 是 `draft: true`，存於 `.nav-recorder/preconditions/<name>.json`。用 `nav-recorder get-recipe <name> --pretty` 讀出，逐條處理 `pendingDecisions`，直接編輯該 JSON 檔：

| kind | 你要做的事 |
|---|---|
| `confirmFinalNavigation` | 確認 `finalNavigation` 是**本次改動不會碰到的穩定畫面**（列表頁、入口頁、上一層選單）。絕不可以是目標畫面本身。每個 `options` 都標了 `entry`：**優先選 `deeplink` 的**，交棒時一行 `browser_navigate` 就到；選了 `entry: "menu"` 的畫面，就要把走選單那幾跳寫進 `targetHint`。 |
| `existingData` | 目標畫面用到一筆沒有步驟會建立的資料（`options` 列出是哪些值、誰用了、哪來的）。照上面的兩條路擇一處理。 |
| `excludedSteps` | 只蒸餾了到達目標畫面的那段瀏覽，但更早的段落裡有整段蒸餾會留下的步驟（`options`）。是這次任務的前置 → 照 message 用 `--from-seq` 重跑、刪掉這份草稿；是別的任務留下的 → 刪掉這個 decision。見步驟 1 第 6 點。 |
| `confirmTargetHint` | `targetHint.note` / `targetHint.clicks` 若已由錄到的點擊預填，檢查它描述的是不是從 `finalNavigation` 進目標畫面的最後一跳：不需要的 `weak` 點擊刪掉，順序不對就調，只有錯了才重寫。沒預填（錄製沒有點擊）才自己寫清楚點哪一列、哪個按鈕。可用 `{capturedName}` 引用 captured 值。 |
| `typeGuess` | 同一支 API 錄到不同值 → 把該參數改成 `suggestion` 給的 faker 規格。 |
| `duplicate` | 同一支 API 出現多次。每次結果都被後面用到就全留；只有部分被用到就把多餘步驟標 `"disabled": true`；若每一次的結果都沒被後面用到（純 auth/check、心跳、輪詢），全部標 `disabled` 或直接刪掉，不要 keep-last 留一個沒意義的步驟。 |
| `actor` | 多角色流程逐步填正確的 `actor`（要存在於 `actors.json`）。 |
| `newActor` | 錄製裡出現 `actors.json` 沒有的登入帳號（`options` 列出帳號）。**立刻問使用者**這些帳號各是什麼角色，請他把角色與密碼加進 `actors.json`，再把對應步驟的 `actor` 改成該角色。這是使用者要求的長期規則：開發中一旦出現新角色就要提醒他。 |
| `external` | 打到 `apiBases` 以外的 URL：確認是否該留；該留就把 base 加進 config（告知使用者）。 |
| `missingSchema` | 查無 schema 依據，交給 probe。 |

其他原則：

- 參數預設 `fixed`（誤判成 faker 會靜默造垃圾資料，風險更高）。只有「有唯一性證據」或「錄製裡值會變」才改 `faker`；受限於合法值集合時用 `{"type":"faker","fn":"helpers.arrayElement","args":[["A","B"]]}`。
- `constraintEvidence.source` 為 `code` 的判斷可信任；`none` 代表要靠 probe；`runtime-probe` 是推論，出問題時優先重看。
- `verify` 填上一站的關鍵元素（selector 或畫面文字），**避開本次會改動的元素**。
- 每個 `kind: "api"` 步驟都要有 `actor`；`finalContext` 填交棒時要用的 context（通常是主要 actor）。
- 需要真實 UI 進入中繼畫面時，插入 `{"id":"…","actor":"…","kind":"ui","action":{"type":"click","gotoUrl":"/list","selector":"…"}}`；selector 用穩定屬性，避開會改動的元素。
- 處理完：把 `draft` 改成 `false`、刪除 `pendingDecisions`，執行 `nav-recorder save-recipe <檔案路徑>` 做結構驗證。

## 步驟 4 — 立刻自我驗證（在實作之前）

現在系統還沒被你改動，此時驗證通過代表 recipe 本身是對的。

1. `shape` 是 `data` 且 `probeRecommended: true` → `nav-recorder execute-start <name> --probe`；否則不加 `--probe`（純導航的 recipe 沒有參數可探，硬加只會被 `execute-start` 出 warning）。
2. 依步驟 5 跑完整個迴圈。probe 模式下每個含 `fixed` 參數的 API 步驟會被要求執行兩次（`probeRound: 2` 用完全相同的值）；第二次失敗是**預期中的探測**，照實回報即可，不算失敗。
3. **`done` 之後不要就這樣算過**：依 `finalNavigationEntry` 導到上一站（見步驟 6 第 1 點），然後**照 `targetHint.clicks` 把最後一跳實際走一遍**，確認網址到達 `targetHint.url` 且畫面有內容。純導航的 recipe 只有這一段會壞，不走這一遍等於什麼都沒驗。`navigation-existing-data` 還要確認那筆資料真的出現在畫面上。
4. `shape: data` 時另外看 `probeReport` 與 `.nav-recorder/param-constraints.md`：`unique: yes` 的參數改成 faker；然後不加 `--probe` 再跑一次確認能走到 `done`。
5. `halt` → 把 `reason` 與完整錯誤原文回報使用者，等指示。**不要自己重試超過 Companion 的限制**。
6. 這一趟觀察到的進入方式（哪條 route 硬導覽可以、哪條不行）當場 `data-source set` 回寫，見「注意事項」。
7. 驗證用的瀏覽器可以關掉（這不是交棒）。把「recipe 已驗證可用」與 `shape` 寫進你給使用者的回覆。

## 步驟 5 — 執行迴圈（參考流程步驟 7）

```
execute-start <name>                → sessionId
loop:
  execute-next <sessionId>          → 指令（見下）
  依序處理 ensureContext → switchTab → action
  execute-report <sessionId> ...    → continue | halt | done
```

**網址一律用 Companion 給的**，不要拿 `config.appOrigins` 自己拼：dev server 每次拿到的埠可能不同，Companion 會依實際在監聽的埠拼好（輸出的 `appOrigin` 就是這一趟用的）。`execute-start` / `execute-next` 回 `E_NO_DEV_SERVER` 代表沒有任何監聽中的埠屬於這個專案——先把 dev server 起起來（或看 `details.listening` 確認狀況）再重跑，不要自己猜一個網址去導航。

### 指令欄位

- `contextName` / `actor`：一個 context = 一個瀏覽器 tab。自己維護「contextName → tab index」對照。
- `ensureContext`（首次用到此 context 才會出現）：先登入，再 `storageReset`，再回報 storage snapshot。
- `switchTab`：切到該 context 的 tab；有 `reseedLocalStorage` 時先把那些 key 寫回 localStorage 再重新整理頁面（同 origin 的 tab 共用 localStorage，換身份必須重灌）。`relogin: true`（cookie 型 auth）時照 `ensureContext` 重新登入。
- `action.type`：`fetch` | `navigate` | `click` | `fill` | `waitFor`。
- `captureSpec`：Companion 會自己從 `--response` 抓值，你只要把完整 response 傳回。
- `warnings`：非空時讀一下，有些是 cookie 模式的限制提醒。

### 各動作對應的 Playwright MCP 用法

**login-ui**
1. 首個 context 可用現有 tab；之後的 context 用 `browser_tabs` `{action:"new", url:<login.url>}`。
2. `browser_navigate` 到 `login.url`，`browser_snapshot` 找到 `fields.username` / `fields.password` 對應的欄位，`browser_fill_form` 填 `credentials`，`browser_click` `submit`。
3. `browser_wait_for`：`successCheck.urlNot` → 等到網址不再包含它；`successCheck.selector` → 等該元素出現；`urlIncludes` → 等網址包含。
4. 執行 storageReset（下方 snippet）。
5. 取 storage snapshot（下方 snippet）存成檔案，回報時帶 `--storage-snapshot @<檔案>`。

**login-api**
1. 先 `browser_navigate` 到 `appUrl`（要在應用程式的 origin 底下才能寫 storage）。
2. `browser_evaluate` 用 `fetch(url, {method, headers:{"content-type":"application/json"}, body: JSON.stringify(body)})` 取得 JSON。
3. 依 `storageSeed` 把 response 的值寫入 `localStorage` / `sessionStorage`（值是 JSON path，例如 `$.data.token`）。
4. `browser_navigate` 到 `appUrl` 重新載入，然後 storageReset、snapshot，同上。

**storageReset snippet**（`browser_evaluate`，把 `<RESET>` 換成指令裡的 `storageReset` JSON）
```js
async () => { const cfg = <RESET>;
  for (const { db, stores } of cfg.indexedDB) {
    await new Promise((res, rej) => { const r = indexedDB.open(db);
      r.onerror = () => rej(r.error);
      r.onsuccess = () => { const d = r.result; const names = stores.filter(s => d.objectStoreNames.contains(s));
        if (!names.length) { d.close(); return res(); }
        const tx = d.transaction(names, "readwrite"); for (const s of names) tx.objectStore(s).clear();
        tx.oncomplete = () => { d.close(); res(); }; tx.onerror = () => rej(tx.error); }; });
  }
  for (const k of cfg.localStorage) localStorage.removeItem(k);
  for (const k of cfg.sessionStorage) sessionStorage.removeItem(k);
  return "ok"; }
```

**storage snapshot snippet**（`browser_evaluate`，結果寫成檔案）
```js
() => JSON.stringify({
  localStorage: Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])),
  sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])) })
```

**switchTab 的 reseed snippet**
```js
() => { const seed = <reseedLocalStorage>; for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v); return "ok"; }
```
之後 `browser_navigate` 到目前網址讓應用程式重新讀 storage。

**fetch**（在該 context 的 tab 上 `browser_evaluate`；依 `auth.kind` 選 header）
```js
async () => {
  const headers = <action.headers>;
  // auth.kind === "bearer": 從 auth.tokenSource 讀 token
  const token = (<auth.tokenSource.area> === "localStorage" ? localStorage : sessionStorage).getItem(<auth.tokenSource.key>);
  if (token) headers[<auth.header>] = "Bearer " + token;
  const r = await fetch(<action.url>, { method: <action.method>, headers, body: <action.body> === undefined ? undefined : JSON.stringify(<action.body>), credentials: "include" });
  const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
  return JSON.stringify({ status: r.status, body }); }
```
- `auth.kind === "cookie"`：不加 Authorization，靠 `credentials: "include"`。`none`：什麼都不加。
- 把回傳的 `body` 寫成檔案，回報 `--status ok --http-status <status> --response @<檔案>`。fetch 本身丟例外 → `--status error --message "<例外訊息>"`。
- 非 2xx 也用 `--status ok --http-status <n> --response @…` 回報，Companion 會依 `expect` 判定；這樣錯誤原文才會被記錄下來。

**navigate**：`browser_navigate action.url`。
**click**：有 `gotoUrl` 先 `browser_navigate`；`browser_snapshot` 後用 `browser_click`（優先用 snapshot 的 ref，找不到再用 selector）。
**fill**：`browser_fill_form`，`fields` 是 selector → value。
**waitFor**：`browser_wait_for`（`text` / `selector` / `urlIncludes`，`timeoutMs`）。
UI 動作成功 → `--status ok`；失敗 → `--status error --message "<發生了什麼>"`。

### 回報後的分支

- `{next:"continue", retry:false}` → 下一步。
- `{next:"continue", retry:true, attempt:n}` → 同一步會被重新指派（faker 值會重抽）。連續失敗達到 `config.execute.maxConsecutiveFailures`（預設 3）就會變 `halt`。
- `{next:"halt", reason}` → 停止，把 `reason`、`lastError` 原文回報使用者，等指示。
- `{next:"done", …}` → 步驟 6。
- 中途要放棄（使用者改變主意、瀏覽器掛了）→ `nav-recorder execute-cancel <sessionId>`，不留下懸空的 session。

## 步驟 6 — 交棒：不關瀏覽器，走最後一跳

1. **導航之前先看 `done` 回傳的 `finalNavigationEntry`**——不用自己查表、也不用從別條 route 的文字推：
   - `entry: "deeplink"` → 直接 `browser_navigate` 到 `finalNavigation`。
   - `entry: "menu"` → **不要硬導覽**。從登入落地頁開始，照 route-catalogue 的 `placements` 與 `enteredBy` 走選單（見第 2 點）。
   - `entry: "unknown"` → 這個專案沒人確認過。先 `browser_navigate` 試一次，**不論成敗都當場把結果寫回**（`data-source set <route> --verdict api|ui --evidence "<你看到什麼>"`），並在回報時請使用者補 `config.navigation`。
   - 最後一跳會經過的中繼畫面同理，用 `data-source get <route>` 各查一次 `effective`。
   - 硬導覽之後主畫面空白、或側欄分類停在別的地方 → **這是 `menu` 型的典型症狀，不是權限問題**。除非有 API 回 401/403 佐證，否則不可以下「這個帳號沒權限」這類結論；改走選單，並照「注意事項」把這條 route 寫回表裡。
2. **同時查 route-catalogue 的選單位置**：`nav-recorder routes get <目標 route>`。`placements[].chain[0]` 是這個畫面所屬的上方分頁。若它跟你現在所在畫面的分頁不同，**先點那個分頁**再走側欄——側欄的選單內容是跟著上方分頁狀態走的，分頁不對時側欄根本不會有你要找的項目。`enteredBy` 記的是前幾次真的被點進去時點了什麼，照著走就對了。目錄裡查不到這條 route 時就照 1 的 evidence 判斷。
3. `browser_tabs` 切到 `finalContext` 的 tab，`browser_navigate` 到 `finalNavigation`（已是絕對網址）。
4. 用 `browser_snapshot` 檢查 `verify.selectors` / `verify.textIncludes`；不符合就當 halt 處理（回報使用者）。
5. **不要關 browser，不要關任何 tab。** 這些 tab 已登入、已就位，正是接下來測試要用的；多角色的其他 tab 也保留給步驟 8 換身份驗證用。
6. 依 `targetHint.clicks` 逐一走最後一跳：每一下先 `browser_snapshot`，用 `text`／`role`（對應 `aria/...` selector）在 snapshot 裡找到元素再 `browser_click`；找不到再試 `selectors` 裡其餘的候選。`weak` 的點擊若畫面上已經是展開狀態可以跳過。沒有 `clicks` 時照 `targetHint.note` 的文字描述走。觀察後再操作，因為目標畫面可能剛被你改過。
7. 進入參考流程步驟 8，本 skill 到此結束。之後的測試迴圈（6→9）只要 browser 還活著就直接重用這些 tab；只有資料狀態需要重置時才重跑一次 recipe。

## 步驟 7 — 任務結束

匯報完成（參考流程步驟 9）的同時執行：
```
nav-recorder capture-recent --discard
```
只推進認領時間戳，把使用者在測試期間到真實 Chrome「看一眼」的操作排除在下次認領之外。任務中途放棄也要呼叫。`nav-recorder discard` 是同一件事的別名；使用者自己想「丟掉剛才的操作重錄一次」時也可以直接跑它——日檔不會馬上刪，只是認領點往前移；之後過了保留時數、且整檔都已被認領的日檔才會被清掉（`capture-recent`、`discard`、`routes recent` 執行時會順手清），沒被認領的最多留 `recording.unclaimedKeepDays` 天。

## 備援 — pause / resume

只有在你打算**直接操控使用者的真實 Chrome**（例如 Claude in Chrome 一類工具）而不是自己開的 Playwright 瀏覽器時：操作前 `nav-recorder pause`，結束後 `nav-recorder resume`。用 Playwright MCP 開的獨立瀏覽器 extension 本來就看不到，不需要 pause。

## 注意事項

- **終點選擇原則是硬性約束**：recipe 的任何步驟都不得依賴本次要改動的畫面的 DOM；`finalNavigation` 必須是本次改動不會碰到的穩定畫面。若 recipe 在改動後失效，該修的是終點選在哪，不是重錄。
- **確認了畫面名稱 ↔ 路徑 ↔ 選單位置就要落盤**：不論是使用者告訴你的、你從選單點進去看到的、還是最後不得已翻程式碼翻出來的，當下就執行 `nav-recorder routes set <route> --name "<畫面名稱>" --chain "<上方分頁> > <側欄群組>" --evidence "<依據>"`。這張表就是這樣一次一條長出來的——`capture-recent` 只能機械地記下「哪些 route 被走過」，**替畫面命名、判斷它掛在哪裡是你的工作**。跳過這一步，下一個 agent 就得從頭再推一次。
- **觀察到的導航限制當下就要落盤**：任何時候發現「網址直接進去不行／必須走選單」，立刻執行 `nav-recorder data-source set <route> --verdict ui --evidence "<你觀察到什麼>"`（`--file` 選填，純瀏覽器觀察不需要元件檔）。反過來，驗證過某條 route 硬導覽沒問題也要寫 `--verdict api`——**全站預設是 `menu` 時這件事一樣要做**，每多一條 `api` 就是之後每次交棒都能省下的一整串選單操作。**不可以只寫在給使用者的回報裡**——回報是一次性的，只有這張表下一個 agent 讀得到。同一個坑被踩第二次，就是這條沒做到。
- **全站通則歸 `config.navigation`，個別畫面歸 `data-source-map`**：如果你發現的是「整個站都這樣」（例如外殼渲染依賴選單狀態，所有畫面冷啟動都進不去），那要提醒使用者改 `config.navigation.entry`，不是一條一條 route 去寫。表是用來記例外與已驗證結果的。
- 錄到的登入請求只用來確認登入 API 長相，**憑證一律來自 `actors.json`**（`nav-recorder get-actor <name>`）。錄到的帳密、OTP 不可拿來重播。
- 一個 Playwright MCP 瀏覽器只有一個 profile：同 origin 的 tab 共用 localStorage，換身份要靠 `switchTab.reseedLocalStorage`；cookie 型 auth 無法同時持有兩個身份，Companion 會要求重新登入。
- `source: "runtime-probe"` 的唯一性判斷可能只驗到某個條件下的限制（例如「同一人同一天不能兩張」），遇到相關錯誤先回頭看 `param-constraints.md` 的 `observedError`。
- 不要為了讓 recipe 通過而修改 `config.json` 的 `readOnlyPatterns` 或 `apiBases`；需要改就告訴使用者原因。
- `.nav-recorder/` 整個不進 git，也不要把它的路徑或內容寫進專案的 CLAUDE.md。
- **角色只增不猜**：onboarding 時使用者可能只給一個角色；之後任何時候發現流程需要別的身份（錄製裡有陌生登入帳號、使用者描述提到「主管簽核」、recipe 步驟需要另一個 actor），都要主動提醒使用者新增角色，不可拿既有帳號硬跑。
- `apiBases` 若是 `{derive: "json", …}` 推導物件，代表主機值寫在專案的某個設定檔且會更換；Companion 每次載入都會重新查，不要把它改成寫死的字串。
- 專案還沒有 `.nav-recorder/` 時走步驟 0 由你 onboarding；不要跳過問卷直接手寫 `config.json`，否則沒有出處紀錄、也不會產生煙霧 recipe 與範本。
