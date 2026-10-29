import type {
  ConfigGap,
  IterationOption,
  Person,
  PullRequestDetail,
  PullRequestRow,
  ReviewFinding,
  ReviewResult,
  TaskDetail,
  TaskRow,
} from '../types'

/*
 * Pure Azure DevOps logic: URLs, request shapes and response parsing. Every call on `$`
 * stays in register.tsx, because the engine follows `$` only into functions of the same file.
 */

/**
 * Where a project lives, split from the URL the repository configures.
 *
 * The collection base is kept as written (`https://{org}.visualstudio.com`,
 * `https://dev.azure.com/{org}`, `https://server/tfs/{collection}`) instead of
 * being rewritten to one host form: every REST call is `{base}/{project}/_apis/...`
 * on all of them, and a rewrite rule is one more place to send a PAT to the wrong host.
 */
export type ProjectRef = {
  collectionUrl: string
  /** Percent-encoded, for URL paths. */
  projectPath: string
  /** Decoded, for WIQL and display. */
  projectName: string
}

/** The writes a repository can let through without asking, keyed as `.claude/ado.json`'s `confirm` block names them. */
export const WRITE_ACTIONS = ['comment', 'assign', 'state', 'create', 'update', 'pullRequest'] as const

export type WriteAction = (typeof WRITE_ACTIONS)[number]

/** Whether each write asks the user first; an action the file leaves out asks. */
export type ConfirmPolicy = Record<WriteAction, boolean>

export type RepoConfig = ProjectRef & { patEnv: string; confirm: ConfirmPolicy }

export type AdoConfig = RepoConfig & { pat: string }

export type AdoRequest = {
  method: string
  url: string
  body?: string
  contentType?: string
  /** The PAT scope the request needs, named when Azure DevOps rejects the PAT; WORK_ITEMS_SCOPE when absent. */
  scope?: string
}

export const WORK_ITEMS_SCOPE = 'Work Items'
export const CODE_SCOPE = 'Code (Read)'
export const CODE_WRITE_SCOPE = 'Code (Read & Write)'

/** What create_pull_request opens: branches as typed (`bugfix/x`) or as refs (`refs/heads/bugfix/x`). */
export type NewPullRequest = {
  source: string
  target: string
  title: string
  description: string
  workItemIds: readonly number[]
}

export type AdoResponse = { status: number; ok: boolean; text: string }

export type ListOptions = {
  owner: string
  /** One type, or ALL_TYPES for every type. */
  workItemType: string
  includeClosed: boolean
  /** Matched with UNDER, so a parent iteration takes its children's items; '' for every iteration. */
  iterationPath?: string
}

export const ALL_TYPES = 'All'
/** The owner meaning everyone: no System.AssignedTo clause. */
export const ANY_OWNER = '*'
/** Epic → Feature → User Story → Task is the deepest Agile chain above a row. */
export const MAX_ANCESTOR_LEVELS = 3

/** Every Task create_task writes starts with this, so a person tells a draft from a reviewed Task. */
export const AI_DRAFT_PREFIX = '[AI Draft]'
/** The tag create_task sets, so the drafts can be queried. */
export const AI_DRAFT_TAG = 'AI Draft'
export const TASK_TYPE = 'Task'

export const CONFIG_PATH = '.claude/ado.json'
export const LOCAL_SETTINGS_PATH = '.claude/settings.local.json'
const API = 'api-version=7.1'
/** Work item comments exist only as a preview version in 7.1. */
const COMMENTS_API = 'api-version=7.1-preview.4'
const CLOSED_STATES = ['Closed', 'Removed', 'Done']
export const MAX_TASKS = 200
const MAX_TEAMS = 100
const MAX_MEMBERS = 500
const LIST_FIELDS = [
  'System.Id',
  'System.Title',
  'System.State',
  'System.WorkItemType',
  'System.AssignedTo',
  'System.ChangedDate',
  'System.Parent',
]

export const GITIGNORE_PATH = '.gitignore'
const SETUP_HINT = 'run /ado-tasks to set it up'

/** `gap` says which setup step the pane offers for this failure. */
export class AdoError extends Error {
  constructor(
    message: string,
    readonly gap?: ConfigGap,
  ) {
    super(message)
  }
}

export function parseProjectUrl(raw: string): ProjectRef {
  const withoutQuery = raw.trim().split(/[?#]/)[0] ?? ''
  const match = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(withoutQuery)
  const host = match?.[1]
  if (!match || host === undefined) throw new AdoError(`projectUrl is not an http(s) URL: ${raw}`)

  let path = match[2] ?? ''
  // A pasted board or work item URL carries `/_boards/...`, `/_workitems/...` after the project.
  const routeStart = path.indexOf('/_')
  if (routeStart >= 0) path = path.slice(0, routeStart)
  const segments = path.split('/').filter(Boolean)
  const last = segments.pop()
  if (last === undefined) throw new AdoError(`projectUrl names no project: ${raw}`)
  if (/^https?:\/\/dev\.azure\.com$/i.test(host) && segments.length === 0) {
    throw new AdoError(`projectUrl on dev.azure.com needs /{organization}/{project}: ${raw}`)
  }

  // Decode then encode once, so both "Web Portal" and "Web%20Portal" end as one path.
  const projectName = decodeURIComponent(last)
  return {
    collectionUrl: [host, ...segments].join('/'),
    projectPath: encodeURIComponent(projectName),
    projectName,
  }
}

export function joinPath(cwd: string, relative: string): string {
  return `${cwd.replace(/[\\/]+$/, '')}/${relative}`
}

export function missingConfig(cwd: string): AdoError {
  return new AdoError(`${CONFIG_PATH} is missing under ${cwd}; ${SETUP_HINT}`, 'config')
}

export function missingPat(patEnv: string): AdoError {
  return new AdoError(`${patEnv} is empty in the env block of ${LOCAL_SETTINGS_PATH}; ${SETUP_HINT}`, 'pat')
}

/**
 * Reads the optional `confirm` block. A key outside WRITE_ACTIONS or a value that is not a
 * boolean is refused rather than ignored, so a misspelt key never looks like it took effect.
 */
function parseConfirmPolicy(raw: unknown): ConfirmPolicy {
  const policy = Object.fromEntries(WRITE_ACTIONS.map(action => [action, true])) as ConfirmPolicy
  if (raw === undefined) return policy
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AdoError(`${CONFIG_PATH} confirm must be an object of ${WRITE_ACTIONS.join(', ')}`, 'config')
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(WRITE_ACTIONS as readonly string[]).includes(key)) {
      throw new AdoError(`${CONFIG_PATH} confirm.${key} is not one of ${WRITE_ACTIONS.join(', ')}`, 'config')
    }
    if (typeof value !== 'boolean') throw new AdoError(`${CONFIG_PATH} confirm.${key} must be true or false`, 'config')
    policy[key as WriteAction] = value
  }

  return policy
}

export function parseRepoConfig(fileText: string, cwd: string): RepoConfig {
  let file: { projectUrl?: unknown; patEnv?: unknown; confirm?: unknown }
  try {
    file = JSON.parse(fileText) as typeof file
  } catch {
    throw new AdoError(`${CONFIG_PATH} under ${cwd} is not JSON; ${SETUP_HINT}`, 'config')
  }
  if (typeof file.projectUrl !== 'string') throw new AdoError(`${CONFIG_PATH} has no projectUrl; ${SETUP_HINT}`, 'config')
  if (typeof file.patEnv !== 'string' || file.patEnv === '') {
    throw new AdoError(`${CONFIG_PATH} has no patEnv; ${SETUP_HINT}`, 'config')
  }
  let ref: ProjectRef
  try {
    ref = parseProjectUrl(file.projectUrl)
  } catch (error) {
    throw new AdoError(`${(error as Error).message}; ${SETUP_HINT}`, 'config')
  }

  return { ...ref, patEnv: file.patEnv, confirm: parseConfirmPolicy(file.confirm) }
}

/** `ADO_PAT_<PROJECT>`, so two repositories of different projects never share a variable. */
export function defaultPatEnv(ref: ProjectRef): string {
  const name = ref.projectName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `ADO_PAT_${name === '' ? 'PROJECT' : name}`
}

/** `previous` is the file being replaced, if any: its other keys (such as `confirm`) are kept. */
export function repoConfigText(projectUrl: string, patEnv: string, previous?: string): string {
  let kept: Record<string, unknown> = {}
  try {
    const parsed: unknown = previous === undefined ? undefined : JSON.parse(previous)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) kept = parsed as Record<string, unknown>
  } catch {
    kept = {}
  }

  return `${JSON.stringify({ ...kept, projectUrl: projectUrl.trim(), patEnv }, null, 2)}\n`
}

/**
 * The local settings file with `env[name]` set to `pat`, every other key kept.
 *
 * A file that is not a JSON object is refused rather than replaced: it may hold the
 * person's permissions and other secrets.
 */
export function withLocalPat(settingsText: string | undefined, name: string, pat: string): string {
  let settings: Record<string, unknown> = {}
  if (settingsText !== undefined && settingsText.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(settingsText)
    } catch {
      throw new AdoError(`${LOCAL_SETTINGS_PATH} is not JSON; fix it by hand, nothing was written`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AdoError(`${LOCAL_SETTINGS_PATH} is not a JSON object; fix it by hand, nothing was written`)
    }
    settings = parsed as Record<string, unknown>
  }
  const env = typeof settings.env === 'object' && settings.env !== null ? (settings.env as Record<string, unknown>) : {}

  return `${JSON.stringify({ ...settings, env: { ...env, [name]: pat } }, null, 2)}\n`
}

const IGNORING_LINES = new Set([
  '.claude/settings.local.json',
  '/.claude/settings.local.json',
  '**/.claude/settings.local.json',
  '.claude/',
  '/.claude/',
  '.claude',
  '/.claude',
])

export function hasGitignoreEntry(text: string): boolean {
  return text.split(/\r?\n/).some(line => IGNORING_LINES.has(line.trim()))
}

export function withGitignoreEntry(text: string): string {
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`

  return `${base}${base === '' ? '' : '\n'}# Claude Code local settings (holds the Azure DevOps PAT)\n${LOCAL_SETTINGS_PATH}\n`
}

/** The value `name` holds in a settings object's `env` block, or undefined. */
export function envValue(settings: unknown, name: string): string | undefined {
  const env = (settings as { env?: unknown } | undefined)?.env
  if (typeof env !== 'object' || env === null) return undefined
  const value = (env as Record<string, unknown>)[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function wiqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function isMe(owner: string): boolean {
  const trimmed = owner.trim()
  return trimmed === '' || /^@me$/i.test(trimmed)
}

/** `*` or `All`, any case. */
export function isAnyOwner(owner: string): boolean {
  const trimmed = owner.trim().toLowerCase()
  return trimmed === ANY_OWNER || trimmed === 'all'
}

/** The distinct assignees of the rows, in first-seen order: the people the owner picker offers. */
export function assigneesOf(rows: readonly TaskRow[]): string[] {
  return [...new Set(rows.map(row => row.assignedTo).filter(name => name !== ''))]
}

export function isAllTypes(workItemType: string): boolean {
  const trimmed = workItemType.trim()
  return trimmed === '' || trimmed.toLowerCase() === ALL_TYPES.toLowerCase()
}

export function buildTaskWiql(options: ListOptions): string {
  const owner = isMe(options.owner) ? '@Me' : wiqlString(options.owner.trim())
  const clauses = ['[System.TeamProject] = @project']
  if (!isAllTypes(options.workItemType)) clauses.push(`[System.WorkItemType] = ${wiqlString(options.workItemType)}`)
  if (!isAnyOwner(options.owner)) clauses.push(`[System.AssignedTo] = ${owner}`)
  const iterationPath = options.iterationPath?.trim() ?? ''
  if (iterationPath !== '') clauses.push(`[System.IterationPath] UNDER ${wiqlString(iterationPath)}`)
  if (!options.includeClosed) {
    clauses.push(`[System.State] NOT IN (${CLOSED_STATES.map(wiqlString).join(', ')})`)
  }

  return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.ChangedDate] DESC`
}

export function workItemUrl(ref: ProjectRef, id: number): string {
  return `${ref.collectionUrl}/${ref.projectPath}/_workitems/edit/${id}`
}

function apiUrl(ref: ProjectRef, path: string): string {
  return `${ref.collectionUrl}/${ref.projectPath}/_apis/${path}`
}

/** The Core area's project routes sit under the collection, not under the project. */
function projectsApiUrl(ref: ProjectRef, path: string): string {
  return `${ref.collectionUrl}/_apis/projects/${ref.projectPath}/${path}`
}

/**
 * Where the Identities API lives. Azure DevOps Services serves it from the organization's
 * vssps host only (the organization host answers 404); Azure DevOps Server serves it from
 * the collection itself. Only the two Microsoft host forms are mapped, so the PAT never
 * leaves Microsoft's hosts or the configured server.
 */
export function identityBaseUrl(ref: ProjectRef): string {
  const legacy = /^https:\/\/([^./]+)\.visualstudio\.com$/i.exec(ref.collectionUrl)
  if (legacy) return `https://vssps.dev.azure.com/${legacy[1]}`
  const modern = /^https:\/\/dev\.azure\.com\/([^/]+)$/i.exec(ref.collectionUrl)
  if (modern) return `https://vssps.dev.azure.com/${modern[1]}`
  return ref.collectionUrl
}

/** The project security group whose members, beside the teams', a comment can mention. */
export const CONTRIBUTORS_GROUP = 'Contributors'
/** Identity ids per Identities request, so the query string stays short. */
export const IDENTITY_BATCH = 50
/** Nested groups followed below Contributors. */
export const MAX_GROUP_DEPTH = 5

function json(method: string, url: string, body: unknown, contentType = 'application/json'): AdoRequest {
  return { method, url, body: JSON.stringify(body), contentType }
}

const JSON_PATCH = 'application/json-patch+json'

/** Field reference names, such as `System.Title`, with the values to write. */
export type FieldValues = Record<string, string>

function fieldOps(fields: FieldValues) {
  return Object.entries(fields).map(([name, value]) => ({ op: 'add', path: `/fields/${name}`, value }))
}

/** The URL a hierarchy link names its target by. */
function workItemApiUrl(ref: ProjectRef, id: number): string {
  return `${ref.collectionUrl}/_apis/wit/workItems/${id}`
}

function patchFields(ref: ProjectRef, id: number, fields: FieldValues): AdoRequest {
  return json('PATCH', apiUrl(ref, `wit/workitems/${id}?${API}`), fieldOps(fields), JSON_PATCH)
}

export const requests = {
  wiql: (ref: ProjectRef, options: ListOptions): AdoRequest =>
    json('POST', apiUrl(ref, `wit/wiql?$top=${MAX_TASKS}&${API}`), { query: buildTaskWiql(options) }),
  batch: (ref: ProjectRef, ids: number[]): AdoRequest =>
    json('POST', apiUrl(ref, `wit/workitemsbatch?${API}`), { ids, fields: LIST_FIELDS }),
  // A single GET returns no System.Parent; the hierarchy links carry the parent and the children.
  item: (ref: ProjectRef, id: number): AdoRequest => ({
    method: 'GET',
    url: apiUrl(ref, `wit/workitems/${id}?$expand=relations&${API}`),
  }),
  iterations: (ref: ProjectRef): AdoRequest => ({
    method: 'GET',
    url: apiUrl(ref, `wit/classificationnodes/Iterations?$depth=10&${API}`),
  }),
  comments: (ref: ProjectRef, id: number): AdoRequest => ({
    method: 'GET',
    url: apiUrl(ref, `wit/workItems/${id}/comments?$top=20&${COMMENTS_API}`),
  }),
  updateState: (ref: ProjectRef, id: number, state: string): AdoRequest =>
    patchFields(ref, id, { 'System.State': state }),
  updateFields: patchFields,
  // Azure DevOps resolves an identity field from the unique name (email) or the display name.
  assign: (ref: ProjectRef, id: number, person: Person): AdoRequest =>
    patchFields(ref, id, { 'System.AssignedTo': person.email === '' ? person.name : person.email }),
  // `$<type>` names the type to create; the reverse hierarchy link makes `parentId` its parent.
  createChild: (ref: ProjectRef, type: string, parentId: number, fields: FieldValues): AdoRequest =>
    json(
      'POST',
      apiUrl(ref, `wit/workitems/$${encodeURIComponent(type)}?${API}`),
      [
        ...fieldOps(fields),
        { op: 'add', path: '/relations/-', value: { rel: PARENT_LINK, url: workItemApiUrl(ref, parentId) } },
      ],
      JSON_PATCH,
    ),
  addComment: (ref: ProjectRef, id: number, text: string): AdoRequest =>
    json('POST', apiUrl(ref, `wit/workItems/${id}/comments?${COMMENTS_API}`), { text }),
  teams: (ref: ProjectRef): AdoRequest => ({ method: 'GET', url: projectsApiUrl(ref, `teams?$top=${MAX_TEAMS}&${API}`) }),
  teamMembers: (ref: ProjectRef, teamId: string): AdoRequest => ({
    method: 'GET',
    url: projectsApiUrl(ref, `teams/${encodeURIComponent(teamId)}/members?$top=${MAX_MEMBERS}&${API}`),
  }),
  // Identities need the PAT's Identity (Read) scope; Direct membership, nested groups are expanded by the caller.
  projectGroup: (ref: ProjectRef, group: string): AdoRequest => ({
    method: 'GET',
    url: `${identityBaseUrl(ref)}/_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(
      `[${ref.projectName}]\\${group}`,
    )}&queryMembership=Direct&${API}`,
  }),
  identities: (ref: ProjectRef, ids: readonly string[]): AdoRequest => ({
    method: 'GET',
    url: `${identityBaseUrl(ref)}/_apis/identities?identityIds=${ids.map(encodeURIComponent).join(',')}&queryMembership=Direct&${API}`,
  }),
  // The identity the PAT authenticates as; connectionData exists only as a preview version.
  connectionData: (ref: ProjectRef): AdoRequest => ({
    method: 'GET',
    url: `${ref.collectionUrl}/_apis/connectionData?${API}-preview`,
  }),
  // Every repository's active PRs in one call; each answer names its repository.
  pullRequests: (ref: ProjectRef): AdoRequest => ({
    method: 'GET',
    url: apiUrl(ref, `git/pullrequests?searchCriteria.status=active&$top=${MAX_PULL_REQUESTS}&${API}`),
    scope: CODE_SCOPE,
  }),
  // PR ids are unique in the collection, so the project route finds one without its repository.
  pullRequest: (ref: ProjectRef, id: number): AdoRequest => ({
    method: 'GET',
    url: apiUrl(ref, `git/pullrequests/${id}?${API}`),
    scope: CODE_SCOPE,
  }),
  pullRequestStatuses: (ref: ProjectRef, repoId: string, id: number): AdoRequest => ({
    method: 'GET',
    url: apiUrl(ref, `git/repositories/${encodeURIComponent(repoId)}/pullRequests/${id}/statuses?${API}`),
    scope: CODE_SCOPE,
  }),
  pullRequestThreads: (ref: ProjectRef, repoId: string, id: number): AdoRequest => ({
    method: 'GET',
    url: apiUrl(ref, `git/repositories/${encodeURIComponent(repoId)}/pullRequests/${id}/threads?${API}`),
    scope: CODE_SCOPE,
  }),
  pullRequestIterations: (ref: ProjectRef, repoId: string, id: number): AdoRequest => ({
    method: 'GET',
    url: apiUrl(ref, `git/repositories/${encodeURIComponent(repoId)}/pullRequests/${id}/iterations?${API}`),
    scope: CODE_SCOPE,
  }),
  pullRequestWorkItems: (ref: ProjectRef, repoId: string, id: number): AdoRequest => ({
    method: 'GET',
    url: apiUrl(ref, `git/repositories/${encodeURIComponent(repoId)}/pullRequests/${id}/workitems?${API}`),
    scope: CODE_SCOPE,
  }),
  // The route takes the repository's name or id; the answer carries its id, web URL and default branch.
  repository: (ref: ProjectRef, repo: string): AdoRequest => ({
    method: 'GET',
    url: apiUrl(ref, `git/repositories/${encodeURIComponent(repo)}?${API}`),
    scope: CODE_SCOPE,
  }),
  createPullRequest: (ref: ProjectRef, repoId: string, pr: NewPullRequest): AdoRequest => ({
    ...json('POST', apiUrl(ref, `git/repositories/${encodeURIComponent(repoId)}/pullrequests?${API}`), {
      sourceRefName: branchRef(pr.source),
      targetRefName: branchRef(pr.target),
      title: pr.title,
      description: pr.description,
      workItemRefs: pr.workItemIds.map(id => ({ id: String(id), url: workItemApiUrl(ref, id) })),
    }),
    scope: CODE_WRITE_SCOPE,
  }),
  updatePullRequest: (ref: ProjectRef, repoId: string, id: number, fields: PullRequestFields): AdoRequest => ({
    ...json('PATCH', apiUrl(ref, `git/repositories/${encodeURIComponent(repoId)}/pullrequests/${id}?${API}`), fields),
    scope: CODE_WRITE_SCOPE,
  }),
  // A PR's workItemRefs leave the work item without a link; the work item's own ArtifactLink makes it show the PR.
  linkPullRequest: (ref: ProjectRef, workItemId: number, artifactId: string): AdoRequest =>
    json(
      'PATCH',
      apiUrl(ref, `wit/workitems/${workItemId}?${API}`),
      [{ op: 'add', path: '/relations/-', value: { rel: ARTIFACT_LINK, url: artifactId, attributes: { name: PULL_REQUEST_LINK } } }],
      JSON_PATCH,
    ),
  // Removed highest index first, so the indexes still to remove stay valid; the rev test refuses a stale read.
  unlinkPullRequest: (ref: ProjectRef, workItemId: number, rev: number, indexes: readonly number[]): AdoRequest =>
    json(
      'PATCH',
      apiUrl(ref, `wit/workitems/${workItemId}?${API}`),
      [
        { op: 'test', path: '/rev', value: rev },
        ...[...indexes].sort((a, b) => b - a).map(index => ({ op: 'remove', path: `/relations/${index}` })),
      ],
      JSON_PATCH,
    ),
}

const ARTIFACT_LINK = 'ArtifactLink'
const PULL_REQUEST_LINK = 'Pull Request'

export const PULL_REQUEST_STATUSES = ['active', 'abandoned'] as const
export type PullRequestStatus = (typeof PULL_REQUEST_STATUSES)[number]

export type PullRequestFields = { title?: string; description?: string; status?: PullRequestStatus }

/** The positions of a work item's links to this PR artifact (`vstfs:///Git/PullRequestId/...`). */
export function artifactLinkIndexes(item: unknown, artifactId: string): number[] {
  const relations = (item as { relations?: WorkItemRelation[] } | undefined)?.relations ?? []
  const wanted = decodeURIComponent(artifactId).toLowerCase()

  return relations.flatMap((relation, index) =>
    relation.rel === ARTIFACT_LINK && decodeURIComponent(text(relation.url)).toLowerCase() === wanted ? [index] : [],
  )
}

/** Whether a work item already carries a link to this PR artifact. */
export function linksArtifact(item: unknown, artifactId: string): boolean {
  return artifactLinkIndexes(item, artifactId).length > 0
}

export function revOf(item: unknown): number {
  const rev = Number((item as { rev?: unknown } | undefined)?.rev)
  if (!Number.isInteger(rev)) throw new AdoError('the work item answer names no rev')
  return rev
}

/** What a PR answer names to link and patch it: its id, repository and artifact id. */
export function pullRequestRefOf(value: unknown): { id: number; repoId: string; repo: string; artifactId: string } {
  const pr = value as { pullRequestId?: unknown; artifactId?: unknown; repository?: { id?: unknown; name?: unknown } } | undefined
  const id = Number(pr?.pullRequestId)
  const repoId = text(pr?.repository?.id)
  const artifactId = text(pr?.artifactId)
  if (!Number.isInteger(id) || id <= 0 || repoId === '' || artifactId === '') {
    throw new AdoError('the pull request answer names no pullRequestId, repository or artifactId')
  }

  return { id, repoId, repo: text(pr?.repository?.name), artifactId }
}

/** A branch as the Git API names it: `bugfix/x` becomes `refs/heads/bugfix/x`; a full ref is kept. */
export function branchRef(branch: string): string {
  const name = branch.trim()
  return name.startsWith('refs/') ? name : `refs/heads/${name}`
}

export type RepositoryInfo = { id: string; name: string; defaultBranch: string }

export function repositoryOf(value: unknown): RepositoryInfo {
  const repo = value as { id?: unknown; name?: unknown; defaultBranch?: unknown } | undefined
  const id = text(repo?.id)
  const name = text(repo?.name)
  if (id === '' || name === '') throw new AdoError('the repository answer names no id or name')

  return { id, name, defaultBranch: text(repo?.defaultBranch) }
}

/** The created PR's id, artifact id and page. */
export function createdPullRequestOf(
  ref: ProjectRef,
  repo: RepositoryInfo,
  value: unknown,
): { id: number; artifactId: string; url: string } {
  const { id, artifactId } = pullRequestRefOf({ repository: { id: repo.id }, ...(value as object) })

  return { id, artifactId, url: pullRequestUrl(ref, repo.name, id) }
}

export const MAX_PULL_REQUESTS = 100

/** The status context the Claude Code Review pipeline posts its verdict under (statusGenre / statusName). */
export const REVIEW_STATUS = { genre: 'ai-review', name: 'claude-code-review' } as const

type GitPullRequest = {
  pullRequestId?: unknown
  title?: unknown
  description?: unknown
  sourceRefName?: unknown
  targetRefName?: unknown
  isDraft?: unknown
  createdBy?: IdentityRef
  repository?: { id?: unknown; name?: unknown }
  lastMergeSourceCommit?: { commitId?: unknown }
  /** Present when the source branch lives in a fork, not in the target repository. */
  forkSource?: { repository?: { name?: unknown } }
}

/** A ref shown as a branch name: `refs/heads/main` becomes `main`. */
export function branchName(ref: unknown): string {
  return text(ref).replace(/^refs\/heads\//, '')
}

/**
 * Whether a branch name is safe to put on a command line: letters, digits and `._/-`, no
 * leading `-` (an option), no `..`. Git allows `$`, `;`, backticks and more in a ref name, and
 * the name comes from whoever opened the PR.
 */
export function isSafeBranchName(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('-') && !name.includes('..')
}

export function pullRequestUrl(ref: ProjectRef, repo: string, id: number): string {
  return `${ref.collectionUrl}/${ref.projectPath}/_git/${encodeURIComponent(repo)}/pullrequest/${id}`
}

function toPullRequestRow(ref: ProjectRef, pr: GitPullRequest): PullRequestRow | undefined {
  const id = pr.pullRequestId
  const repoId = text(pr.repository?.id)
  const repo = text(pr.repository?.name)
  if (typeof id !== 'number' || repoId === '' || repo === '') return undefined

  return {
    repoId,
    repo,
    id,
    title: text(pr.title),
    source: branchName(pr.sourceRefName),
    target: branchName(pr.targetRefName),
    isDraft: pr.isDraft === true,
    createdBy: identityName(pr.createdBy),
    url: pullRequestUrl(ref, repo, id),
  }
}

/** The active PRs, by repository name, newest first within one. */
export function toPullRequestRows(ref: ProjectRef, result: unknown): PullRequestRow[] {
  const list = (result as { value?: GitPullRequest[] } | undefined)?.value ?? []

  return list
    .flatMap(pr => {
      const row = toPullRequestRow(ref, pr)
      return row ? [row] : []
    })
    .sort((a, b) => a.repo.localeCompare(b.repo) || b.id - a.id)
}

type GitStatus = {
  id?: unknown
  state?: unknown
  description?: unknown
  targetUrl?: unknown
  iterationId?: unknown
  context?: { name?: unknown; genre?: unknown }
}

/**
 * The review's latest status on the PR; undefined when the pipeline posted none.
 * The description reads `<verdict> - <counts>`, such as `block - Critical 1 / Warning 2 / Suggestion 2`;
 * the verdict may hold spaces, as `fix first`.
 */
export function reviewOf(statuses: unknown): ReviewResult | undefined {
  const list = (statuses as { value?: GitStatus[] } | undefined)?.value ?? []
  const latest = list
    .filter(status => status.context?.genre === REVIEW_STATUS.genre && status.context?.name === REVIEW_STATUS.name)
    .reduce<GitStatus | undefined>((last, status) => (last === undefined || Number(status.id) > Number(last.id) ? status : last), undefined)
  if (latest === undefined) return undefined

  const state = text(latest.state)
  const description = text(latest.description).trim()
  const match = /^(.+?)\s+-\s+(.*)$/.exec(description)
  const reportUrl = text(latest.targetUrl)

  return {
    state,
    verdict: state === 'pending' ? 'reviewing' : (match?.[1] ?? description),
    counts: state === 'pending' ? '' : (match?.[2] ?? ''),
    ...(typeof latest.iterationId === 'number' ? { iterationId: latest.iterationId } : {}),
    ...(reportUrl === '' ? {} : { reportUrl }),
  }
}

type ThreadProperty = { $value?: unknown }

type GitThread = {
  id?: unknown
  status?: unknown
  isDeleted?: unknown
  threadContext?: { filePath?: unknown; rightFileStart?: { line?: unknown } } | null
  properties?: Record<string, ThreadProperty>
  comments?: { content?: unknown }[]
}

function threadProperty(thread: GitThread, name: string): string {
  return text(thread.properties?.[`ClaudeReview.${name}`]?.$value)
}

/** Markup comments (the review's fingerprints) removed, ends trimmed. */
function withoutMarkupComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '').trim()
}

function toFinding(prUrl: string, thread: GitThread): ReviewFinding | undefined {
  if (typeof thread.id !== 'number') return undefined
  const content = withoutMarkupComments(text(thread.comments?.[0]?.content))
  const [first = '', ...rest] = content.split(/\r?\n/)
  const severity = threadProperty(thread, 'Severity') || (/^\[(\w+)\]/.exec(first)?.[1] ?? '')
  const filePath = text(thread.threadContext?.filePath)
  const line = thread.threadContext?.rightFileStart?.line

  return {
    threadId: thread.id,
    severity,
    rule: threadProperty(thread, 'RuleKey'),
    title: first.replace(/^\[\w+\]\s*/, ''),
    body: rest.join('\n').trim(),
    ...(filePath === '' ? {} : { filePath }),
    ...(typeof line === 'number' ? { line } : {}),
    status: text(thread.status),
    url: `${prUrl}?discussionId=${thread.id}`,
  }
}

const SEVERITY_ORDER = ['Critical', 'Warning', 'Suggestion']

function severityRank(severity: string): number {
  const index = SEVERITY_ORDER.indexOf(severity)
  return index < 0 ? SEVERITY_ORDER.length : index
}

/** The CommentThreadStatus of a thread marked Fixed. */
export const FIXED_STATUS = 'fixed'

/** A fixed thread sorts after every other one. */
function fixedRank(status: string): number {
  return status === FIXED_STATUS ? 1 : 0
}

/** The review's findings, fixed ones last, then most severe first, and its summary; other people's threads are left out. */
export function reviewThreadsOf(prUrl: string, threads: unknown): { summary: string; findings: ReviewFinding[] } {
  const list = ((threads as { value?: GitThread[] } | undefined)?.value ?? []).filter(thread => thread.isDeleted !== true)
  const summaries = list.filter(thread => threadProperty(thread, 'Kind') === 'summary')
  // The newest summary is the one for the latest review run.
  const summary = summaries.reduce<GitThread | undefined>(
    (last, thread) => (last === undefined || Number(thread.id) > Number(last.id) ? thread : last),
    undefined,
  )
  const findings = list
    .filter(thread => threadProperty(thread, 'Kind') === 'finding')
    .flatMap(thread => {
      const finding = toFinding(prUrl, thread)
      return finding ? [finding] : []
    })
    .sort(
      (a, b) =>
        fixedRank(a.status) - fixedRank(b.status) ||
        severityRank(a.severity) - severityRank(b.severity) ||
        a.threadId - b.threadId,
    )

  return { summary: withoutMarkupComments(text(summary?.comments?.[0]?.content)), findings }
}

/** The verdict a summary heading names, as in `### Claude Code Review 阻擋合併（block）`. */
export function verdictOfSummary(summary: string): string | undefined {
  const heading = summary.split(/\r?\n/)[0] ?? ''
  return /[（(]\s*([A-Za-z-]+)\s*[)）]\s*$/.exec(heading)?.[1]
}

/**
 * The summary's prose: the heading and paragraphs before its findings table, markdown
 * emphasis removed, for a pane that draws plain text.
 */
export function summaryLead(summary: string): string {
  const lines: string[] = []
  for (const line of summary.split(/\r?\n/)) {
    if (line.trim().startsWith('|')) break
    lines.push(line.replace(/^#+\s*/, '').replace(/\*\*/g, ''))
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function latestIterationOf(iterations: unknown): number | undefined {
  const ids = ((iterations as { value?: { id?: unknown }[] } | undefined)?.value ?? [])
    .map(iteration => iteration.id)
    .filter((id): id is number => typeof id === 'number')

  return ids.length === 0 ? undefined : Math.max(...ids)
}

function workItemIdsOf(refs: unknown): number[] {
  return ((refs as { value?: { id?: unknown }[] } | undefined)?.value ?? []).flatMap(item => {
    const id = Number(item.id)
    return Number.isInteger(id) && id > 0 ? [id] : []
  })
}

export type PullRequestAnswers = {
  pr: unknown
  statuses: unknown
  threads: unknown
  iterations: unknown
  workItems: unknown
}

export function toPullRequestDetail(ref: ProjectRef, answers: PullRequestAnswers): PullRequestDetail {
  const pr = (answers.pr ?? {}) as GitPullRequest
  const row = toPullRequestRow(ref, pr)
  if (row === undefined) throw new AdoError('the pull request answer names no id or repository')
  const { summary, findings } = reviewThreadsOf(row.url, answers.threads)
  const statusReview = reviewOf(answers.statuses)
  const summaryVerdict = verdictOfSummary(summary)
  // A summary without a status (postPrStatus off) still gives the verdict.
  const review = statusReview ?? (summaryVerdict === undefined ? undefined : { state: '', verdict: summaryVerdict, counts: '' })
  const latestIterationId = latestIterationOf(answers.iterations)

  return {
    ...row,
    ...(review === undefined ? {} : { review }),
    description: text(pr.description),
    sourceCommit: text(pr.lastMergeSourceCommit?.commitId),
    isFromFork: pr.forkSource !== undefined && pr.forkSource !== null,
    hasSafeBranchNames: isSafeBranchName(row.source) && isSafeBranchName(row.target),
    ...(latestIterationId === undefined ? {} : { latestIterationId }),
    summary,
    findings,
    workItemIds: workItemIdsOf(answers.workItems),
  }
}

/** Whether the review ran on an older iteration than the PR's newest: pushes since then are unreviewed. */
export function isReviewStale(detail: Pick<PullRequestDetail, 'review' | 'latestIterationId'>): boolean {
  const reviewed = detail.review?.iterationId
  return reviewed !== undefined && detail.latestIterationId !== undefined && reviewed < detail.latestIterationId
}

export function authorization(pat: string): string {
  return `Basic ${btoa(`:${pat}`)}`
}

export function parseResponse(config: AdoConfig, request: AdoRequest, response: AdoResponse): unknown {
  // A rejected PAT is answered 203 with the HTML sign-in page, not 401.
  if (response.status === 203 || response.status === 401) {
    throw new AdoError(
      `Azure DevOps rejected the PAT in ${config.patEnv} (HTTP ${response.status}): wrong, expired or missing the ${request.scope ?? WORK_ITEMS_SCOPE} scope`,
    )
  }
  let parsed: unknown
  try {
    parsed = response.text === '' ? undefined : JSON.parse(response.text)
  } catch {
    throw new AdoError(`HTTP ${response.status} from ${request.method} ${request.url} is not JSON`)
  }
  if (!response.ok) {
    const message = (parsed as { message?: unknown } | undefined)?.message
    const detail = typeof message === 'string' ? message : response.text.slice(0, 300)
    throw new AdoError(`HTTP ${response.status} from ${request.method} ${request.url}: ${detail}`)
  }

  return parsed
}

type IdentityRef = { id?: string; displayName?: string; uniqueName?: string; isContainer?: boolean }
type WorkItem = { id: number; fields: Record<string, unknown>; relations?: WorkItemRelation[] }

type WorkItemRelation = { rel?: string; url?: string }

const PARENT_LINK = 'System.LinkTypes.Hierarchy-Reverse'
const CHILD_LINK = 'System.LinkTypes.Hierarchy-Forward'

/** The ids a work item's hierarchy links of one kind point at, read from each link's `.../workItems/<id>` URL. */
function linkedIds(relations: readonly WorkItemRelation[], rel: string): number[] {
  return relations.flatMap(relation => {
    if (relation.rel !== rel) return []
    const id = Number(/\/workItems\/(\d+)$/i.exec(relation.url ?? '')?.[1])
    return Number.isInteger(id) && id > 0 ? [id] : []
  })
}

function identityName(value: unknown): string {
  if (typeof value === 'string') return value
  const identity = value as IdentityRef | undefined
  return identity?.displayName ?? identity?.uniqueName ?? ''
}

/** A user identity with the id a mention needs; a group, or one without an id, is no person. */
function personOf(value: unknown): Person | undefined {
  const identity = value as IdentityRef | undefined
  if (typeof identity !== 'object' || identity === null || identity.isContainer === true) return undefined
  if (typeof identity.id !== 'string' || identity.id === '') return undefined

  return { id: identity.id, name: identity.displayName ?? identity.uniqueName ?? '', email: identity.uniqueName ?? '' }
}

export function teamIdsOf(result: unknown): string[] {
  const teams = (result as { value?: { id?: unknown }[] } | undefined)?.value ?? []
  return teams.flatMap(team => (typeof team.id === 'string' ? [team.id] : []))
}

/** Every person of the teams' member lists, once each, by name. */
export function toMembers(memberLists: readonly unknown[]): Person[] {
  return mergeMembers(
    memberLists.map(list =>
      ((list as { value?: { identity?: unknown }[] } | undefined)?.value ?? []).flatMap(member => {
        const person = personOf(member.identity)
        return person ? [person] : []
      }),
    ),
  )
}

/** The people of several lists, once each by id (the first list's entry kept), by name. */
export function mergeMembers(lists: readonly (readonly Person[])[]): Person[] {
  const byId = new Map<string, Person>()
  for (const list of lists) {
    for (const person of list) if (!byId.has(person.id)) byId.set(person.id, person)
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

type Identity = {
  id?: unknown
  providerDisplayName?: unknown
  customDisplayName?: unknown
  isContainer?: unknown
  isActive?: unknown
  memberIds?: unknown
  properties?: { Mail?: { $value?: unknown }; Account?: { $value?: unknown } }
}

function identitiesOf(result: unknown): Identity[] {
  return (result as { value?: Identity[] } | undefined)?.value ?? []
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []
}

function firstText(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && value !== '') ?? ''
}

/** One level of an Identities answer: its active people, its groups' ids, and their member ids to read next. */
export type IdentityLevel = { people: Person[]; groupIds: string[]; memberIds: string[] }

export function identityLevelOf(result: unknown): IdentityLevel {
  const people: Person[] = []
  const groupIds: string[] = []
  const memberIds: string[] = []
  for (const identity of identitiesOf(result)) {
    if (identity.isContainer === true) {
      if (typeof identity.id === 'string' && identity.id !== '') groupIds.push(identity.id)
      memberIds.push(...stringsOf(identity.memberIds))
      continue
    }
    if (typeof identity.id !== 'string' || identity.id === '' || identity.isActive === false) continue
    people.push({
      id: identity.id,
      name: firstText(identity.customDisplayName, identity.providerDisplayName),
      email: firstText(identity.properties?.Mail?.$value, identity.properties?.Account?.$value),
    })
  }

  return { people, groupIds, memberIds }
}

/** `ids` in Identities-request sized chunks. */
export function identityBatches(ids: readonly string[]): string[][] {
  const batches: string[][] = []
  for (let start = 0; start < ids.length; start += IDENTITY_BATCH) batches.push(ids.slice(start, start + IDENTITY_BATCH))
  return batches
}

/** Where list_members keeps its last answer, per repository: the API is called again only when it lacks someone. */
export const MEMBERS_PATH = '.claude/ado-members.json'

export type MemberCache = { project: string; fetchedAt: string; members: Person[]; contributorsError?: string }

export function memberCacheText(cache: MemberCache): string {
  return `${JSON.stringify(cache, null, 2)}\n`
}

/** The cache file's members for `projectName`; undefined when it is unreadable or names another project. */
export function parseMemberCache(text: string, projectName: string): MemberCache | undefined {
  let parsed: Partial<MemberCache>
  try {
    parsed = JSON.parse(text) as Partial<MemberCache>
  } catch {
    return undefined
  }
  if (parsed.project !== projectName || !Array.isArray(parsed.members)) return undefined
  const members = parsed.members.filter(
    (person): person is Person =>
      typeof person?.id === 'string' && person.id !== '' && typeof person.name === 'string' && typeof person.email === 'string',
  )

  return {
    project: projectName,
    fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : '',
    members,
    ...(typeof parsed.contributorsError === 'string' ? { contributorsError: parsed.contributorsError } : {}),
  }
}

/** Whether a name or email request finds anyone, as resolveMentions looks: exactly, else as a part. */
export function findsMember(members: readonly Person[], request: string): boolean {
  return filterMembers(members, request).length > 0
}

/** The members whose name or email holds `query`, ignoring case; every member for an empty query. */
export function filterMembers(members: readonly Person[], query: string): Person[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...members]
  return members.filter(person => person.name.toLowerCase().includes(needle) || person.email.toLowerCase().includes(needle))
}

export const MENTION_ROLES = { assignee: '@assignee', creator: '@creator', me: '@me' } as const

export type MentionRole = keyof typeof MENTION_ROLES

export type CardPeople = { assignee?: Person; creator?: Person }

/** The people a role mention names: the card's assignee and creator, and `me`, the PAT's own identity. */
export type RolePeople = CardPeople & { me?: Person }

/** The role a request names, any case; undefined for a name or email. */
export function mentionRoleOf(request: string): MentionRole | undefined {
  const key = request.trim().toLowerCase()
  return (Object.keys(MENTION_ROLES) as MentionRole[]).find(role => MENTION_ROLES[role] === key)
}

/** Whether a role is read from the work item itself. */
export function isCardRole(role: MentionRole | undefined): boolean {
  return role === 'assignee' || role === 'creator'
}

function personLabel(person: Person): string {
  return person.email === '' ? person.name : `${person.name} <${person.email}>`
}

/**
 * The people a comment mentions, each request resolved to exactly one: a role from the card,
 * else an exact name or email, else the single member whose name or email holds it.
 * A request that finds nobody, or several, refuses the whole comment: a wrong mention
 * notifies the wrong person.
 */
export function resolveMentions(requests: readonly string[], members: readonly Person[], roles: RolePeople): Person[] {
  const resolved = new Map<string, Person>()
  for (const raw of requests) {
    const request = raw.trim()
    const key = request.toLowerCase()
    const role = mentionRoleOf(request)
    if (role !== undefined) {
      const person = roles[role]
      if (!person) {
        throw new AdoError(
          role === 'me'
            ? `mention ${request}: the identity of the PAT is unknown`
            : `mention ${request}: the work item has no ${role}`,
        )
      }
      resolved.set(person.id, person)
      continue
    }
    const exact = members.filter(person => person.name.toLowerCase() === key || person.email.toLowerCase() === key)
    const found = exact.length > 0 ? exact : filterMembers(members, request)
    if (found.length === 0) {
      throw new AdoError(`mention "${request}": no project member matches; list_members shows who can be mentioned`)
    }
    if (found.length > 1) {
      throw new AdoError(`mention "${request}" matches ${found.length} members, name one of: ${found.map(personLabel).join('; ')}`)
    }
    const [person] = found as [Person]
    resolved.set(person.id, person)
  }

  return [...resolved.values()]
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The markup Azure DevOps reads as an @mention, the person notified on posting. */
export function mentionHtml(person: Person): string {
  return `<a href="#" data-vss-mention="version:2.0,${escapeHtml(person.id)}">@${escapeHtml(person.name)}</a>`
}

/** The comment with its mentions in front; the text unchanged when there are none. */
export function withMentions(comment: string, people: readonly Person[]): string {
  return people.length === 0 ? comment : `${people.map(mentionHtml).join(' ')} ${comment}`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function wiqlIds(result: unknown): number[] {
  const items = (result as { workItems?: { id: number }[] } | undefined)?.workItems ?? []
  return items.map(item => item.id).slice(0, MAX_TASKS)
}

function toRow(ref: ProjectRef, id: number, fields: Record<string, unknown>): TaskRow {
  const parent = fields['System.Parent']

  return {
    id,
    title: text(fields['System.Title']),
    state: text(fields['System.State']),
    type: text(fields['System.WorkItemType']),
    assignedTo: identityName(fields['System.AssignedTo']),
    changed: text(fields['System.ChangedDate']),
    url: workItemUrl(ref, id),
    ...(typeof parent === 'number' && parent > 0 ? { parentId: parent } : {}),
  }
}

/** Parent ids the rows name that none of `known` holds: the next level of ancestors to fetch. */
export function missingParentIds(rows: readonly TaskRow[], known: readonly TaskRow[]): number[] {
  const have = new Set(known.map(row => row.id))
  const missing = new Set<number>()
  for (const row of rows) {
    if (row.parentId !== undefined && !have.has(row.parentId)) missing.add(row.parentId)
  }

  return [...missing].slice(0, MAX_TASKS)
}

type IterationNode = {
  name?: string
  path?: string
  attributes?: { startDate?: string; finishDate?: string }
  children?: IterationNode[]
}

/**
 * `\Project\Iteration\Sprint 1`, the classification node path, as WIQL's
 * System.IterationPath spells it: `Project\Sprint 1`.
 */
export function iterationPathOf(nodePath: string): string {
  const segments = nodePath.split('\\').filter(Boolean)
  if (segments[1] === 'Iteration') segments.splice(1, 1)
  return segments.join('\\')
}

/** Every iteration under the project's root, depth first, the current one by today's date. */
export function toIterationOptions(root: unknown, today: string): IterationOption[] {
  const options: IterationOption[] = []
  const walk = (nodes: readonly IterationNode[], depth: number) => {
    for (const node of nodes) {
      if (typeof node.path !== 'string') continue
      const start = node.attributes?.startDate?.slice(0, 10)
      const finish = node.attributes?.finishDate?.slice(0, 10)
      options.push({
        path: iterationPathOf(node.path),
        label: `${'  '.repeat(depth)}${node.name ?? node.path}`,
        isCurrent: start !== undefined && finish !== undefined && start <= today && today <= finish,
      })
      walk(node.children ?? [], depth + 1)
    }
  }
  walk((root as IterationNode | undefined)?.children ?? [], 0)

  return options
}

/** Rows in the WIQL order: the batch does not promise it, the query's ORDER BY does. */
export function toTaskRows(ref: ProjectRef, ids: number[], batch: unknown): TaskRow[] {
  const items = (batch as { value?: WorkItem[] } | undefined)?.value ?? []
  const byId = new Map(items.map(item => [item.id, item]))

  return ids.flatMap(id => {
    const item = byId.get(id)
    return item ? [toRow(ref, id, item.fields)] : []
  })
}

/** The card's assignee and creator, as `@assignee` and `@creator` mention them. */
export function cardPeopleOf(item: unknown): CardPeople {
  const fields = (item as WorkItem | undefined)?.fields ?? {}
  const assignee = personOf(fields['System.AssignedTo'])
  const creator = personOf(fields['System.CreatedBy'])

  return { ...(assignee === undefined ? {} : { assignee }), ...(creator === undefined ? {} : { creator }) }
}

type ConnectionData = {
  authenticatedUser?: {
    id?: unknown
    customDisplayName?: unknown
    providerDisplayName?: unknown
    properties?: { Account?: { $value?: unknown } }
  }
}

/** The person the PAT authenticates as, as `@me` mentions them; undefined when connectionData names no one. */
export function authenticatedPersonOf(result: unknown): Person | undefined {
  const user = (result as ConnectionData | undefined)?.authenticatedUser
  if (typeof user?.id !== 'string' || user.id === '') return undefined
  const name = [user.customDisplayName, user.providerDisplayName].find(
    (value): value is string => typeof value === 'string' && value !== '',
  )
  const email = user.properties?.Account?.$value

  return { id: user.id, name: name ?? '', email: typeof email === 'string' ? email : '' }
}

export function toTaskDetail(ref: ProjectRef, id: number, item: unknown, comments: unknown): TaskDetail {
  const fields = (item as WorkItem | undefined)?.fields ?? {}
  const relations = (item as WorkItem | undefined)?.relations ?? []
  const list = (comments as { comments?: { createdBy?: IdentityRef; createdDate?: string; text?: string }[] } | undefined)
    ?.comments ?? []
  const row = toRow(ref, id, fields)
  const parentId = row.parentId ?? linkedIds(relations, PARENT_LINK)[0]

  const { assignee, creator } = cardPeopleOf(item)

  return {
    ...row,
    ...(parentId === undefined ? {} : { parentId }),
    childIds: linkedIds(relations, CHILD_LINK),
    ...(assignee === undefined ? {} : { assignee }),
    ...(creator === undefined ? {} : { creator }),
    description: stripHtml(text(fields['System.Description'])),
    acceptanceCriteria: stripHtml(text(fields['Microsoft.VSTS.Common.AcceptanceCriteria'])),
    reproSteps: stripHtml(text(fields['Microsoft.VSTS.TCM.ReproSteps'])),
    areaPath: text(fields['System.AreaPath']),
    iterationPath: text(fields['System.IterationPath']),
    tags: text(fields['System.Tags']),
    comments: list.map(comment => ({
      by: identityName(comment.createdBy),
      date: text(comment.createdDate),
      text: stripHtml(text(comment.text)),
    })),
  }
}

export function stateOf(item: unknown): string {
  return text((item as WorkItem | undefined)?.fields?.['System.State'])
}

export function titleOf(item: unknown): string {
  return text((item as WorkItem | undefined)?.fields?.['System.Title'])
}

export function typeOf(item: unknown): string {
  return text((item as WorkItem | undefined)?.fields?.['System.WorkItemType'])
}

export function idOf(item: unknown): number {
  const id = (item as WorkItem | undefined)?.id
  return typeof id === 'number' ? id : 0
}

/** The title with the AI Draft prefix in front, spelled once; a prefix already there in any case is normalized. */
export function draftTitle(title: string): string {
  const rest = title.trim().replace(/^\[ai draft\]\s*/i, '')
  if (rest === '') throw new AdoError('title is required after the [AI Draft] prefix')

  return `${AI_DRAFT_PREFIX} ${rest}`
}

/**
 * The fields of a new draft Task: its title and description, and the parent's area and
 * iteration, so the draft shows on the same board and sprint as the parent.
 */
export function draftTaskFields(parent: unknown, title: string, description: string): FieldValues {
  const fields = (parent as WorkItem | undefined)?.fields ?? {}
  const areaPath = text(fields['System.AreaPath'])
  const iterationPath = text(fields['System.IterationPath'])

  return {
    'System.Title': draftTitle(title),
    'System.Description': description,
    'System.Tags': AI_DRAFT_TAG,
    ...(areaPath === '' ? {} : { 'System.AreaPath': areaPath }),
    ...(iterationPath === '' ? {} : { 'System.IterationPath': iterationPath }),
  }
}
