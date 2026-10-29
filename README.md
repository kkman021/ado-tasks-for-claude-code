# ado-tasks for Claude Code

**English** | [繁體中文](README.zh-TW.md)

`ado-tasks` is a Claude Code mod that brings Azure DevOps into the session:

- a **side panel** that lists your work items as an Epic / Feature / Story / Task tree and the project's active pull requests with their AI review verdicts;
- **12 MCP tools** Claude can call to read and change work items and pull requests, with a confirmation prompt before every write;
- **two skills**, `claude-go` and `claude-go-pr`, that take one work item or one pull request review from analysis to a pushed commit.

Each repository is bound to one Azure DevOps project through `.claude/ado.json`. The Personal Access Token (PAT) never goes into a committed file.

> **Early access.** The mod is built on the Claude Code plugin hooks API, which Claude Code marks as early access and may change between releases without notice.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Setup](#setup)
- [Personal Access Token](#personal-access-token)
- [The panel](#the-panel)
- [Tools](#tools)
- [Skills](#skills)
- [Configuration reference](#configuration-reference)
- [Files the mod writes](#files-the-mod-writes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Requirements

| Requirement | Notes |
|---|---|
| Claude Code 2.1.312 or later | The version the mod is built and tested against. |
| An Azure DevOps Services project | `https://dev.azure.com/{organization}/{project}` or the legacy `https://{organization}.visualstudio.com/{project}`. |
| A PAT for that organization | See [Personal Access Token](#personal-access-token) for the scopes. |
| [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | Only for the `claude-go` and `claude-go-pr` skills, which spawn its `executor` and `analyst` agents. The panel and the tools work without it. |
| A git repository | `claude-go` works in a git worktree and pushes a branch; setup adds an entry to `.gitignore`. |

## Install

Add this repository as a plugin marketplace, then install the plugin from it:

```bash
claude plugin marketplace add https://github.com/kkman021/ado-tasks-for-claude-code.git
claude plugin install ado-tasks@ado-tasks-for-claude-code
```

Restart Claude Code after installing. To update later:

```bash
claude plugin marketplace update ado-tasks-for-claude-code
claude plugin update ado-tasks@ado-tasks-for-claude-code
```

## Setup

Run the command in a repository that belongs to an Azure DevOps project:

```
/ado-tasks
```

The first time, the panel walks you through two steps:

1. **Project URL** — paste the project URL, for example `https://dev.azure.com/contoso/Web%20Portal`. Extra path segments such as `/_workitems/edit/12` are ignored. The mod writes `.claude/ado.json`:

   ```json
   {
     "projectUrl": "https://dev.azure.com/contoso/Web%20Portal",
     "patEnv": "ADO_PAT_WEB_PORTAL"
   }
   ```

   `patEnv` is the name of the variable that will hold the PAT. It is derived from the project name (`ADO_PAT_<PROJECT>`), so repositories of different projects never share a token.

2. **PAT** — paste the token. The mod first makes sure `.gitignore` ignores `.claude/settings.local.json`, then writes the token into that file's `env` block:

   ```json
   {
     "env": {
       "ADO_PAT_WEB_PORTAL": "<your PAT>"
     }
   }
   ```

   Other keys already in that file are kept. If the file is not valid JSON, nothing is written and you are asked to fix it by hand.

`.claude/ado.json` holds no secret; commit it so everyone on the repository uses the same project. Each person adds their own PAT.

To set up by hand instead, create both files yourself and press **Retry** in the panel.

## Personal Access Token

Create the token in Azure DevOps under **User settings → Personal access tokens → New Token**. Pick the organization that owns the project, set an expiry, and choose **Custom defined** scopes.

### Scopes

| Scope | Needed for |
|---|---|
| **Work Items (Read & write)** | Required. Listing, reading, creating, assigning, commenting on and changing work items; linking work items to pull requests. Read-only is enough if you only browse. |
| **Code (Read)** | The pull request section of the panel, `list_pull_requests`, `get_pull_request`, the `claude-go-pr` skill. |
| **Code (Read & write)** | `create_pull_request`, `update_pull_request`. |
| **Project and Team (Read)** | `list_members`, and resolving people for `@mentions` in comments and for `assign_task`. |
| **Identity (Read)** | Adding the project's **Contributors** group to the member list. Without it the list holds team members only, and `list_members` reports why in `contributorsError`. |

Grant only what you use. The mod names the missing scope in its error when Azure DevOps rejects a request.

### Where the token lives

- The token is read from the `env` block of `.claude/settings.local.json` in the repository, falling back to Claude Code's local settings.
- It is **not** read from your shell environment, so a token exported for another tool is never picked up by mistake.
- It is sent only to the collection URL in `.claude/ado.json` (and `vssps.dev.azure.com` for identities), as HTTP Basic authentication.
- `claude-go-pr` runs the build and tests of a pull request with the PAT variable removed from the environment, because that code was written by someone else.

### Rotating or revoking

Paste a new token by deleting the `ADO_PAT_*` entry from `.claude/settings.local.json` and running `/ado-tasks` again, or edit the value directly. Revoke tokens you no longer use in Azure DevOps.

## The panel

`/ado-tasks [owner | @Me]` opens the **Azure DevOps Work Items** panel beside the conversation.

**Work item list**

- Your open work items, drawn as a tree with their parents (up to three levels) dimmed for context.
- The project's active pull requests, grouped by repository, with the AI review verdict and severity counts.
- Buttons: **Refresh** (`r`), **Include closed / Open only** (`c`), **Owner** (`o`) to switch assignee (yourself, everyone, anyone listed, or a typed name or email), **Iteration** (`i`) to filter by sprint.
- Click `#id` to open a work item, `!id` to open a pull request.
- The last list is restored after `/clear` and when the session resumes.

**Work item detail** — state, type, assignee, iteration, tags, description, acceptance criteria, repro steps and the latest comments. **Claude Go** (`g`) fills the prompt with a `claude-go` request for that item; **Reload** (`r`); **Back** (`b`).

**Pull request detail** — repository, branches, author, linked work items, the review summary and every finding thread (severity, status, file and line), with fixed findings listed last. **Claude Go** (`g`) fills the prompt with a `claude-go-pr` request; **PR** (`p`) and **Build** (`u`) open the pull request and the review build in the browser.

## Tools

The mod registers these tools under the `mcp__ado-tasks__` prefix. Claude uses them when you ask in plain language, for example *"list my bugs in Sprint 12"* or *"comment on #212 and mention the PM"*.

| Tool | What it does | Confirms (`confirm` key) |
|---|---|---|
| `list_tasks` | Work items assigned to an owner (`@Me`, `*` for everyone, or a name/email), filtered by type, iteration and state; up to 200, with their ancestors. | — |
| `get_task` | One work item: description, acceptance criteria, repro steps, area, iteration, tags, parent and children, assignee and creator, latest 20 comments. | — |
| `update_task_state` | Changes `System.State`. | `state` |
| `add_task_comment` | Posts a comment, optionally with `@mentions` resolved against project members (`@me`, `@assignee`, `@creator`, or a name/email). An unknown or ambiguous name refuses the whole comment. | `comment` |
| `create_task` | Creates a Task under a parent work item, titled with `[AI Draft]` and tagged `AI Draft`, inheriting the parent's area and iteration. | `create` |
| `assign_task` | Changes Assigned To, resolving the person like a mention. | `assign` |
| `update_task` | Changes title and/or description; an `[AI Draft]` title keeps its prefix. | `update` |
| `list_members` | Team members and the Contributors group (nested groups followed), cached in `.claude/ado-members.json`. | — |
| `list_pull_requests` | Active pull requests of every repository, with the review verdict and severity counts. | — |
| `get_pull_request` | One pull request with its review: verdict, staleness, summary and every finding thread. | — |
| `create_pull_request` | Opens a pull request from a pushed branch, linked to work items. | `pullRequest` |
| `update_pull_request` | Changes title, description or status (abandon / reactivate), links or unlinks work items. | `pullRequest` |

Every write shows a confirmation dialog with the exact change before anything is sent. Turn a confirmation off per repository in `.claude/ado.json` (see below).

## Skills

### `claude-go` — work item to code

Say *"Claude Go #212"*, or press **Claude Go** in the work item detail.

1. Reads the work item, its parent, siblings and children, and the repository's `CLAUDE.md` / `AGENTS.md` rules.
2. Spawns one agent in an isolated **git worktree** to analyze the item against the codebase.
3. Depending on the result:
   - **Clear Task or Bug** — the agent implements the change on a new branch (`bugfix/<id>-<slug>` or `feature/<id>-<slug>` unless the repository names a rule) and commits. A Bug is implemented only when the agent rates its confidence in the fix 7/10 or higher; below that it posts its analysis and hands the bug to a person.
   - **Card incomplete** — posts a clarification comment on the card.
   - **Blocked** — reports what is missing.
4. The main session verifies the commit, pushes the branch and posts a result comment mentioning you.

A **User Story** is analyzed, never implemented: the skill judges whether the story and its acceptance criteria are clear and whether its child Tasks cover it, creates missing Tasks as `[AI Draft]`, and agrees changes to existing Tasks with you first.

### `claude-go-pr` — review findings to fixes

Say *"Claude Go !22"*, or press **Claude Go** in the pull request detail.

1. Reads the pull request, its review and linked work items; refuses forks, unsafe branch names, pending reviews, and a checkout that is not the pull request's repository.
2. Spawns one agent that checks out the source branch in a worktree and judges, **without running the code**, which open findings can be fixed now.
3. You pick which findings to fix. Nothing changes if you pick none.
4. The agent fixes them, builds and tests **with the PAT removed from the environment**, and commits; the main session verifies and pushes with fast-forward only.

The pull request's code, title, branch names and finding texts are treated as untrusted data throughout.

### Review integration

The review columns and `claude-go-pr` read the output of an Azure Pipelines review job that posts:

- a pull request **status** with genre `ai-review` and name `claude-code-review`, whose description reads `<verdict> - <counts>`, for example `block - Critical 1 / Warning 2 / Suggestion 2`;
- comment **threads** carrying the properties `ClaudeReview.Kind` (`summary` or `finding`), `ClaudeReview.Severity` and `ClaudeReview.RuleKey`.

Without such a pipeline the panel shows `no review` and the rest of the mod works as usual.

## Configuration reference

`.claude/ado.json`:

| Key | Type | Description |
|---|---|---|
| `projectUrl` | string | Required. The Azure DevOps project URL. |
| `patEnv` | string | Required. The variable in `.claude/settings.local.json` `env` that holds the PAT. |
| `confirm` | object | Optional. Per-action confirmation; every action defaults to `true`. Keys: `comment`, `assign`, `state`, `create`, `update`, `pullRequest`. An unknown key or a non-boolean value is an error, so a typo never silently disables a prompt. |

Example that lets comments and assignments go through without asking:

```json
{
  "projectUrl": "https://dev.azure.com/contoso/Web%20Portal",
  "patEnv": "ADO_PAT_WEB_PORTAL",
  "confirm": { "comment": false, "assign": false }
}
```

## Files the mod writes

All paths are relative to the repository root.

| File | Content | Commit it? |
|---|---|---|
| `.claude/ado.json` | Project URL, PAT variable name, confirmation policy. | Yes |
| `.claude/settings.local.json` | The PAT, in `env`. | **No** — the mod adds it to `.gitignore` before writing the token. |
| `.claude/ado-members.json` | Cached member names and emails for mentions. | No — add it to `.gitignore`; it holds people's email addresses. |
| `.gitignore` | One entry for `.claude/settings.local.json`, added if missing. | Yes |

## Troubleshooting

| Message | Cause and fix |
|---|---|
| `.claude/ado.json ... has no projectUrl` / `is not JSON` | Run `/ado-tasks` and complete setup, or fix the file. |
| `ADO_PAT_... is empty in the env block of .claude/settings.local.json` | The PAT is missing; complete setup step 2. |
| `Azure DevOps rejected the PAT in ADO_PAT_... (HTTP 401/203)` | The token is wrong, expired, for another organization, or missing the named scope. Create a new one. |
| Pull request section shows an error | The PAT lacks **Code (Read)**. |
| `list_members` returns `contributorsError` | The PAT lacks **Identity (Read)**; mentions still resolve against team members. |
| Iteration picker is empty | Press **Refresh** first; the PAT may not be able to read iterations. |
| `claude-go` reports an unknown agent type | Install oh-my-claudecode. |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
claude plugin validate plugins/ado-tasks
claude plugin test plugins/ado-tasks
```

## Security

See [SECURITY.md](SECURITY.md) for how the token is handled and how to report a vulnerability.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

Azure DevOps is a trademark of Microsoft Corporation. Claude and Claude Code are trademarks of Anthropic, PBC. This project is not affiliated with or endorsed by either company.
