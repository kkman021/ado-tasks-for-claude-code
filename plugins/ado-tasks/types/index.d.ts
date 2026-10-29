export type TaskRow = {
  id: number
  title: string
  state: string
  type: string
  assignedTo: string
  changed: string
  url: string
  /** System.Parent; absent on a work item without a parent. */
  parentId?: number
}

/** One row of the drawn hierarchy, in drawing order. */
export type TreeLine = {
  row: TaskRow
  /** `├─ `, `└─ ` and `│  ` guides; empty on a root. */
  prefix: string
  /** An ancestor fetched only to place its children; it does not match the filter. */
  isContext: boolean
}

/** One iteration the picker offers. */
export type IterationOption = {
  /** The WIQL System.IterationPath, `Project\Sprint 1`. */
  path: string
  /** The node name, indented by depth. */
  label: string
  isCurrent: boolean
}

/** A user identity: what a comment mention names. */
export type Person = {
  /** The identity id (GUID) the mention markup carries. */
  id: string
  name: string
  /** The unique name, an email for most users; '' when absent. */
  email: string
}

export type TaskDetail = TaskRow & {
  description: string
  acceptanceCriteria: string
  reproSteps: string
  areaPath: string
  iterationPath: string
  tags: string
  /** The work items this one parents (hierarchy links), in link order. */
  childIds: number[]
  /** System.AssignedTo with its id; absent when unassigned. */
  assignee?: Person
  /** System.CreatedBy with its id. */
  creator?: Person
  comments: { by: string; date: string; text: string }[]
}

export type DetailState = {
  id: number
  status: 'loading' | 'ok' | 'error'
  message?: string
  detail?: TaskDetail
}

/** The verdict the Claude Code Review pipeline posts as the PR's `ai-review/claude-code-review` status. */
export type ReviewResult = {
  /** The status state: `pending` while the review runs, `succeeded` or `failed` once posted. */
  state: string
  /** The verdict word the status description starts with, such as `block`; `reviewing` while pending. */
  verdict: string
  /** The severity counts, such as `Critical 1 / Warning 2 / Suggestion 2`; '' when absent. */
  counts: string
  /** The PR iteration the review ran on. */
  iterationId?: number
  /** The pipeline run holding the full report. */
  reportUrl?: string
}

export type PullRequestRow = {
  repoId: string
  repo: string
  id: number
  title: string
  /** Branch names without `refs/heads/`. */
  source: string
  target: string
  isDraft: boolean
  createdBy: string
  url: string
  /** Absent when the review pipeline has posted no status on the PR, or the statuses did not load. */
  review?: ReviewResult
  /** Why the statuses did not load; the pane shows `?` instead of `no review`. */
  reviewError?: string
}

/** One finding the review posted as its own thread on the PR. */
export type ReviewFinding = {
  threadId: number
  /** `Critical`, `Warning`, `Suggestion`; '' when the thread names none. */
  severity: string
  rule: string
  /** The finding's first line, without the `[Severity]` tag. */
  title: string
  body: string
  /** Repository path with a leading `/`; absent on a PR-level thread. */
  filePath?: string
  line?: number
  /** The thread status: `active`, `fixed`, `closed`, `wontFix`, ... */
  status: string
  url: string
}

export type PullRequestDetail = PullRequestRow & {
  description: string
  /** The PR head commit the merge was last computed from; '' before Azure DevOps computed one. */
  sourceCommit: string
  /** The source branch lives in a fork, so this repository's remote does not hold it. */
  isFromFork: boolean
  /** Both branch names pass isSafeBranchName, so they can be put on a command line. */
  hasSafeBranchNames: boolean
  /** The newest iteration the PR has; a review on an older one is stale. */
  latestIterationId?: number
  /** The review's summary thread, markup comments removed; '' when absent. */
  summary: string
  findings: ReviewFinding[]
  /** Work items linked to the PR. */
  workItemIds: number[]
}

export type PullRequestDetailState = {
  id: number
  status: 'loading' | 'ok' | 'error'
  message?: string
  detail?: PullRequestDetail
}

export type PanelState = {
  status: 'idle' | 'loading' | 'ok' | 'error'
  message?: string
  project?: string
  /** '@Me', ANY_OWNER for everyone, or a display name or email. */
  owner: string
  includeClosed: boolean
  /** The iteration path the list is under; '' for every iteration. */
  iteration: string
  iterations: IterationOption[]
  /** Work items of every type matching the filter. */
  tasks: TaskRow[]
  /** Parents outside the filter, fetched so the hierarchy reaches its root. */
  ancestors: TaskRow[]
  fetchedAt?: string
  /** The task whose details the pane shows in place of the list. */
  selected?: DetailState
  /** What the repository still lacks; the pane shows its setup step instead of the list. */
  needs?: ConfigGap
  /** What the last setup step wrote. */
  notice?: string
  /** The filter whose choices the pane shows in place of the list. */
  picker?: PickerKind
  /** The project's active pull requests, loaded beside the work items; a failure here leaves the work items shown. */
  pullRequests: PullRequestRow[]
  /** Why the pull requests did not load, such as a PAT without the Code (Read) scope. */
  pullRequestError?: string
  /** The pull request whose review the pane shows in place of the list. */
  selectedPullRequest?: PullRequestDetailState
}

/**
 * The last loaded list of one repository, kept in `$.store`: `$.state` is the session's,
 * so a /clear (a new session id) would otherwise leave the pane empty.
 */
export type PanelSnapshot = Pick<
  PanelState,
  'project' | 'owner' | 'includeClosed' | 'iteration' | 'iterations' | 'tasks' | 'ancestors' | 'fetchedAt' | 'pullRequests'
>

export type PickerKind = 'owner' | 'iteration'

export type ConfigGap = 'config' | 'pat'

declare module 'claude-code' {
  interface PluginState {
    'ado-tasks': { panel: PanelState }
  }
}
