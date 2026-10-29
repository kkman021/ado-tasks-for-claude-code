# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-10-29

### Fixed

- The work item URL in the panel's detail view is a hyperlink to the full URL, so a click opens
  the work item even when a narrow pane cuts the shown text with an ellipsis.

## [0.1.0] - 2026-10-29

### Added

- `/ado-tasks` panel: work item tree with ancestors, owner and iteration filters, open/closed
  toggle, work item detail, active pull requests with AI review verdicts, pull request detail
  with findings.
- Two-step setup that writes `.claude/ado.json` and stores the PAT in
  `.claude/settings.local.json` after adding it to `.gitignore`.
- Tools: `list_tasks`, `get_task`, `update_task_state`, `add_task_comment`, `create_task`,
  `assign_task`, `update_task`, `list_members`, `list_pull_requests`, `get_pull_request`,
  `create_pull_request`, `update_pull_request`.
- Per-repository confirmation policy for every write action.
- Skills: `claude-go` (work item to code) and `claude-go-pr` (review findings to fixes).
