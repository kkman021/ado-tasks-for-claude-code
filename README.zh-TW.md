# ado-tasks for Claude Code

[English](README.md) | **繁體中文**

`ado-tasks` 是一個 Claude Code mod，把 Azure DevOps 帶進 Claude Code session：

- **側邊面板**：以 Epic / Feature / Story / Task 樹狀列出你的 work item，並列出專案中 active 的 pull request 與其 AI review 結果；
- **12 個 MCP tools**：讓 Claude 讀取與修改 work item 和 pull request，每次寫入前都會跳出確認；
- **兩個 skill**：`claude-go` 與 `claude-go-pr`，分別把一張 work item 或一個 pull request 的 review 結果，從分析一路帶到推送 commit。

每個 repository 透過 `.claude/ado.json` 綁定一個 Azure DevOps project。Personal Access Token（PAT）不會寫進任何會被 commit 的檔案。

> **Early access。** 本 mod 建構在 Claude Code plugin hooks API 之上，該 API 被 Claude Code 標示為 early access，可能在版本間不經通知變更。

## 目錄

- [需求](#需求)
- [安裝](#安裝)
- [設定](#設定)
- [Personal Access Token](#personal-access-token)
- [面板](#面板)
- [Tools](#tools)
- [Skills](#skills)
- [設定檔參考](#設定檔參考)
- [Mod 會寫入的檔案](#mod-會寫入的檔案)
- [疑難排解](#疑難排解)
- [開發](#開發)
- [授權](#授權)

## 需求

| 項目 | 說明 |
|---|---|
| Claude Code 2.1.312 以上 | 本 mod 建置與測試所用的版本。 |
| Azure DevOps Services project | `https://dev.azure.com/{organization}/{project}` 或舊式 `https://{organization}.visualstudio.com/{project}`。 |
| 該 organization 的 PAT | scope 見 [Personal Access Token](#personal-access-token)。 |
| [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | 僅 `claude-go` 與 `claude-go-pr` 需要，它們會啟動其 `executor` 與 `analyst` agent。面板與 tools 不需要。 |
| git repository | `claude-go` 在 git worktree 中作業並推送 branch；設定流程會在 `.gitignore` 加入一筆項目。 |

## 安裝

將本 repository 加為 plugin marketplace，再從中安裝 plugin：

```bash
claude plugin marketplace add https://github.com/kkman021/ado-tasks-for-claude-code.git
claude plugin install ado-tasks@ado-tasks-for-claude-code
```

安裝後重新啟動 Claude Code。日後更新：

```bash
claude plugin marketplace update ado-tasks-for-claude-code
claude plugin update ado-tasks@ado-tasks-for-claude-code
```

## 設定

在屬於某個 Azure DevOps project 的 repository 中執行：

```
/ado-tasks
```

第一次執行時，面板會引導兩個步驟：

1. **Project URL**：貼上 project URL，例如 `https://dev.azure.com/contoso/Web%20Portal`。`/_workitems/edit/12` 之類多餘的路徑會被忽略。Mod 會寫入 `.claude/ado.json`：

   ```json
   {
     "projectUrl": "https://dev.azure.com/contoso/Web%20Portal",
     "patEnv": "ADO_PAT_WEB_PORTAL"
   }
   ```

   `patEnv` 是存放 PAT 的變數名稱，由 project 名稱推導（`ADO_PAT_<PROJECT>`），因此不同 project 的 repository 不會共用同一把 token。

2. **PAT**：貼上 token。Mod 會先確認 `.gitignore` 已忽略 `.claude/settings.local.json`，再把 token 寫入該檔的 `env` 區塊：

   ```json
   {
     "env": {
       "ADO_PAT_WEB_PORTAL": "<your PAT>"
     }
   }
   ```

   該檔既有的其他設定會保留。若檔案不是合法 JSON，則不寫入任何內容，並請你手動修正。

`.claude/ado.json` 不含機敏資訊，請 commit 它，讓同一個 repository 的所有人使用相同 project；每個人各自加入自己的 PAT。

若要手動設定，自行建立上述兩個檔案後，在面板按 **Retry**。

## Personal Access Token

在 Azure DevOps 的 **User settings → Personal access tokens → New Token** 建立 token。選擇擁有該 project 的 organization、設定到期日，scope 選 **Custom defined**。

### Scopes

| Scope | 用途 |
|---|---|
| **Work Items (Read & write)** | 必要。列出、讀取、建立、指派、留言與修改 work item；將 work item 連結到 pull request。只瀏覽時 Read 即可。 |
| **Code (Read)** | 面板的 pull request 區塊、`list_pull_requests`、`get_pull_request`、`claude-go-pr` skill。 |
| **Code (Read & write)** | `create_pull_request`、`update_pull_request`。 |
| **Project and Team (Read)** | `list_members`，以及留言 `@mention` 與 `assign_task` 的人員解析。 |
| **Identity (Read)** | 將 project 的 **Contributors** 群組加入成員清單。缺少時清單只含 team 成員，`list_members` 會在 `contributorsError` 說明原因。 |

只授予實際會用到的 scope。Azure DevOps 拒絕請求時，mod 的錯誤訊息會指出缺少的 scope。

### Token 存放位置

- Token 從 repository 的 `.claude/settings.local.json` 的 `env` 區塊讀取，找不到時改讀 Claude Code 的 local settings。
- **不會**從 shell 環境變數讀取，因此為其他工具 export 的 token 不會被誤用。
- Token 只會以 HTTP Basic authentication 送往 `.claude/ado.json` 中的 collection URL（以及查詢 identity 用的 `vssps.dev.azure.com`）。
- `claude-go-pr` 執行 pull request 的 build 與 test 時，會從環境中移除 PAT 變數，因為那是別人寫的程式碼。

### 更換或撤銷

刪除 `.claude/settings.local.json` 中的 `ADO_PAT_*` 項目後重新執行 `/ado-tasks` 貼上新 token，或直接修改其值。不再使用的 token 請在 Azure DevOps 撤銷。

## 面板

`/ado-tasks [owner | @Me]` 會在對話旁開啟 **Azure DevOps Work Items** 面板。

**Work item 清單**

- 你未關閉的 work item，以樹狀呈現，上層（最多三層）以淡色顯示作為脈絡。
- 專案中 active 的 pull request，依 repository 分組，顯示 AI review 結論與各嚴重度數量。
- 按鈕：**Refresh**（`r`）、**Include closed / Open only**（`c`）、**Owner**（`o`）切換指派對象（自己、所有人、清單中任一人，或輸入名稱或 email）、**Iteration**（`i`）依 sprint 篩選。
- 點 `#id` 開啟 work item，點 `!id` 開啟 pull request。
- `/clear` 後與 session 恢復時，會還原最後一次的清單。

**Work item 詳細**：state、type、指派對象、iteration、tags、description、acceptance criteria、repro steps 與最新留言。**Claude Go**（`g`）會在 prompt 填入該項目的 `claude-go` 請求；**Reload**（`r`）；**Back**（`b`）。

**Pull request 詳細**：repository、branch、作者、連結的 work item、review 摘要與每一則 finding thread（嚴重度、狀態、檔案與行號），已修正的 finding 列在最後。**Claude Go**（`g`）會在 prompt 填入 `claude-go-pr` 請求；**PR**（`p`）與 **Build**（`u`）會在瀏覽器開啟 pull request 與 review build。

## Tools

Mod 以 `mcp__ado-tasks__` 為前綴註冊以下 tools。直接用自然語言要求即可，例如「列出我在 Sprint 12 的 bug」或「在 #212 留言並 mention PM」。

| Tool | 功能 | 確認（`confirm` key） |
|---|---|---|
| `list_tasks` | 列出指派給某人（`@Me`、`*` 代表所有人，或名稱/email）的 work item，可依 type、iteration、state 篩選；最多 200 筆，並附上層項目。 | — |
| `get_task` | 讀取單一 work item：description、acceptance criteria、repro steps、area、iteration、tags、parent 與 children、指派者與建立者、最新 20 則留言。 | — |
| `update_task_state` | 修改 `System.State`。 | `state` |
| `add_task_comment` | 發表留言，可附 `@mention`，依 project 成員解析（`@me`、`@assignee`、`@creator`，或名稱/email）。名稱找不到或對應多人時整則留言會被拒絕。 | `comment` |
| `create_task` | 在 parent work item 下建立 Task，標題加上 `[AI Draft]`、標記 `AI Draft` tag，沿用 parent 的 area 與 iteration。 | `create` |
| `assign_task` | 修改 Assigned To，人員解析方式同 mention。 | `assign` |
| `update_task` | 修改標題及／或 description；`[AI Draft]` 標題會保留前綴。 | `update` |
| `list_members` | Team 成員與 Contributors 群組（展開巢狀群組），快取於 `.claude/ado-members.json`。 | — |
| `list_pull_requests` | 所有 repository 的 active pull request，附 review 結論與各嚴重度數量。 | — |
| `get_pull_request` | 單一 pull request 與其 review：結論、是否過期、摘要與每一則 finding thread。 | — |
| `create_pull_request` | 從已推送的 branch 建立 pull request，並連結 work item。 | `pullRequest` |
| `update_pull_request` | 修改標題、description 或狀態（abandon / reactivate），連結或解除連結 work item。 | `pullRequest` |

每次寫入前都會顯示確認對話框，列出確切的變更內容。可在 `.claude/ado.json` 針對個別 repository 關閉確認（見下方）。

## Skills

### `claude-go`：work item 到程式碼

說「Claude Go #212」，或在 work item 詳細頁按 **Claude Go**。

1. 讀取 work item、其 parent、siblings 與 children，以及 repository 的 `CLAUDE.md` / `AGENTS.md` 規則。
2. 在獨立的 **git worktree** 中啟動一個 agent，對照程式碼分析該項目。
3. 依結果：
   - **明確的 Task 或 Bug**：agent 在新 branch（除非 repository 另有規則，否則為 `bugfix/<id>-<slug>` 或 `feature/<id>-<slug>`）實作並 commit。Bug 只有在 agent 對修正的信心評分達 7/10 以上才會實作；低於此分數時會貼出分析並交由人工處理。
   - **卡片資訊不足**：在卡片上發表澄清留言。
   - **受阻**：回報缺少什麼。
4. 主 session 驗證 commit、推送 branch，並發表 mention 你的結果留言。

**User Story** 只分析、不實作：skill 判斷 story 與 acceptance criteria 是否足夠明確、子 Task 是否涵蓋完整，缺少的 Task 以 `[AI Draft]` 建立，修改既有 Task 前會先與你確認。

### `claude-go-pr`：review finding 到修正

說「Claude Go !22」，或在 pull request 詳細頁按 **Claude Go**。

1. 讀取 pull request、其 review 與連結的 work item；遇到 fork、不安全的 branch 名稱、review 尚在執行、或目前 checkout 不是該 pull request 的 repository 時拒絕執行。
2. 啟動一個 agent，在 worktree 中 checkout source branch，**不執行程式碼**，判斷哪些未解決的 finding 現在可以修正。
3. 由你選擇要修正哪些 finding；都不選則不做任何變更。
4. Agent 修正後，在**移除 PAT 的環境**中 build 與 test，然後 commit；主 session 驗證後以 fast-forward 推送。

全程將 pull request 的程式碼、標題、branch 名稱與 finding 內容視為不可信資料。

### Review 整合

Review 欄位與 `claude-go-pr` 讀取 Azure Pipelines review job 的輸出，該 job 需發布：

- 一個 pull request **status**，genre 為 `ai-review`、name 為 `claude-code-review`，description 格式為 `<verdict> - <counts>`，例如 `block - Critical 1 / Warning 2 / Suggestion 2`；
- 帶有 `ClaudeReview.Kind`（`summary` 或 `finding`）、`ClaudeReview.Severity` 與 `ClaudeReview.RuleKey` 屬性的留言 **thread**。

沒有此 pipeline 時，面板顯示 `no review`，其餘功能照常運作。

## 設定檔參考

`.claude/ado.json`：

| Key | 型別 | 說明 |
|---|---|---|
| `projectUrl` | string | 必要。Azure DevOps project URL。 |
| `patEnv` | string | 必要。`.claude/settings.local.json` 的 `env` 中存放 PAT 的變數名稱。 |
| `confirm` | object | 選用。各動作的確認設定，預設全為 `true`。Key：`comment`、`assign`、`state`、`create`、`update`、`pullRequest`。未知的 key 或非 boolean 值會報錯，避免拼錯時默默關掉確認。 |

允許留言與指派不經確認的範例：

```json
{
  "projectUrl": "https://dev.azure.com/contoso/Web%20Portal",
  "patEnv": "ADO_PAT_WEB_PORTAL",
  "confirm": { "comment": false, "assign": false }
}
```

## Mod 會寫入的檔案

路徑皆相對於 repository 根目錄。

| 檔案 | 內容 | 是否 commit |
|---|---|---|
| `.claude/ado.json` | Project URL、PAT 變數名稱、確認設定。 | 是 |
| `.claude/settings.local.json` | PAT，存於 `env`。 | **否**：mod 寫入 token 前會先加入 `.gitignore`。 |
| `.claude/ado-members.json` | 供 mention 使用的成員名稱與 email 快取。 | 否：請加入 `.gitignore`，內含他人 email。 |
| `.gitignore` | 若缺少，加入一筆 `.claude/settings.local.json`。 | 是 |

## 疑難排解

| 訊息 | 原因與處理 |
|---|---|
| `.claude/ado.json ... has no projectUrl` / `is not JSON` | 執行 `/ado-tasks` 完成設定，或修正該檔。 |
| `ADO_PAT_... is empty in the env block of .claude/settings.local.json` | 缺少 PAT，完成設定步驟 2。 |
| `Azure DevOps rejected the PAT in ADO_PAT_... (HTTP 401/203)` | Token 錯誤、過期、屬於其他 organization，或缺少訊息所指的 scope。請重新建立。 |
| Pull request 區塊顯示錯誤 | PAT 缺少 **Code (Read)**。 |
| `list_members` 回傳 `contributorsError` | PAT 缺少 **Identity (Read)**；mention 仍會依 team 成員解析。 |
| Iteration 選單為空 | 先按 **Refresh**；PAT 可能無法讀取 iteration。 |
| `claude-go` 回報未知的 agent type | 安裝 oh-my-claudecode。 |

## 開發

見 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
claude plugin validate plugins/ado-tasks
claude plugin test plugins/ado-tasks
```

## 安全性

Token 的處理方式與漏洞回報流程見 [SECURITY.md](SECURITY.md)。

## 授權

[Apache License 2.0](LICENSE)。另見 [NOTICE](NOTICE)。

Azure DevOps 是 Microsoft Corporation 的商標。Claude 與 Claude Code 是 Anthropic, PBC 的商標。本專案與上述公司無隸屬關係，亦未獲其背書。
