import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  DetailState,
  IterationOption,
  PanelSnapshot,
  PanelState,
  Person,
  PickerKind,
  PullRequestDetail,
  PullRequestDetailState,
  PullRequestRow,
  TaskDetail,
  TaskRow,
} from '../types'
import {
  AI_DRAFT_PREFIX,
  ALL_TYPES,
  ANY_OWNER,
  AdoError,
  CONFIG_PATH,
  TASK_TYPE,
  draftTaskFields,
  draftTitle,
  idOf,
  titleOf,
  typeOf,
  GITIGNORE_PATH,
  LOCAL_SETTINGS_PATH,
  MAX_ANCESTOR_LEVELS,
  assigneesOf,
  authorization,
  authenticatedPersonOf,
  cardPeopleOf,
  filterMembers,
  isCardRole,
  mentionRoleOf,
  resolveMentions,
  teamIdsOf,
  toMembers,
  withMentions,
  CONTRIBUTORS_GROUP,
  MAX_GROUP_DEPTH,
  identityBatches,
  identityLevelOf,
  mergeMembers,
  MEMBERS_PATH,
  findsMember,
  memberCacheText,
  parseMemberCache,
  defaultPatEnv,
  envValue,
  hasGitignoreEntry,
  isAllTypes,
  isAnyOwner,
  isMe,
  joinPath,
  missingConfig,
  missingParentIds,
  missingPat,
  parseProjectUrl,
  parseRepoConfig,
  parseResponse,
  repoConfigText,
  withGitignoreEntry,
  withLocalPat,
  requests,
  stateOf,
  toIterationOptions,
  toTaskDetail,
  toTaskRows,
  wiqlIds,
  workItemUrl,
  isReviewStale,
  FIXED_STATUS,
  MAX_PULL_REQUESTS,
  reviewOf,
  summaryLead,
  toPullRequestDetail,
  toPullRequestRows,
  branchName,
  createdPullRequestOf,
  linksArtifact,
  artifactLinkIndexes,
  revOf,
  PULL_REQUEST_STATUSES,
  pullRequestRefOf,
  pullRequestUrl,
  repositoryOf,
} from './ado'
import type { AdoConfig, AdoRequest, FieldValues, ListOptions, PullRequestFields, PullRequestStatus, WriteAction } from './ado'
import { buildPullRequestLines, buildTree } from './tree'

const PLUGIN = 'ado-tasks'
const PANE = 'ado-tasks'
const TOOL_PREFIX = `mcp__${PLUGIN}__`
const CONFIRM_YES = 'Yes'
const CONFIRM_NO = 'No'

/** Raw colors, not theme keys: the person asked for these hues whatever the theme. */
const TYPE_COLORS: Record<string, string> = {
  Bug: '#e5534b',
  'User Story': '#4f8fe6',
  Task: '#bfa54a',
  Epic: '#c46a1b',
}

const panel = atom({ plugin: 'ado-tasks', key: 'panel' } as const, {
  status: 'idle',
  owner: '@Me',
  includeClosed: false,
  iteration: '',
  iterations: [],
  tasks: [],
  ancestors: [],
  pullRequests: [],
} as PanelState)

type WorkItemList = { tasks: TaskRow[]; ancestors: TaskRow[] }

/**
 * The stored value with every field the current version reads: `$.state` outlives a
 * reload, so a value an earlier version wrote lacks the fields added since.
 */
function withDefaults(state: PanelState): PanelState {
  return {
    ...state,
    owner: state.owner ?? '@Me',
    includeClosed: state.includeClosed ?? false,
    iteration: state.iteration ?? '',
    iterations: state.iterations ?? [],
    tasks: state.tasks ?? [],
    ancestors: state.ancestors ?? [],
    pullRequests: state.pullRequests ?? [],
  }
}

async function readPanel($: EngineInterface): Promise<PanelState> {
  return withDefaults(await read($, panel))
}

function updatePanel($: EngineInterface, change: (state: PanelState) => PanelState) {
  return update($, panel, (state): PanelState => change(withDefaults(state)))
}

/** One snapshot per repository, so another repository's list is never restored. */
function snapshotKey(cwd: string): string {
  return `snapshot:${cwd}`
}

function snapshotOf(state: PanelState): PanelSnapshot {
  return {
    project: state.project,
    owner: state.owner,
    includeClosed: state.includeClosed,
    iteration: state.iteration,
    iterations: state.iterations,
    tasks: state.tasks,
    ancestors: state.ancestors,
    fetchedAt: state.fetchedAt,
    pullRequests: state.pullRequests,
  }
}

/** Best effort: a store that cannot be written costs the next /clear its list, never this one. */
async function saveSnapshot($: EngineInterface) {
  try {
    const state = await readPanel($)
    if (state.status !== 'ok') return
    await $.store.set(snapshotKey(await $.session.cwd()), snapshotOf(state))
  } catch {
    // The list on screen stands.
  }
}

async function dropSnapshot($: EngineInterface) {
  try {
    await $.store.delete(snapshotKey(await $.session.cwd()))
  } catch {
    // Nothing stored to drop.
  }
}

function isSnapshot(value: unknown): value is PanelSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const snapshot = value as Partial<PanelSnapshot>
  return typeof snapshot.owner === 'string' && Array.isArray(snapshot.tasks)
}

/** Puts the repository's last list back into a session that has loaded none yet (a /clear, a restart). */
async function restoreSnapshot($: EngineInterface) {
  let stored: unknown
  try {
    stored = await $.store.get(snapshotKey(await $.session.cwd()))
  } catch {
    stored = undefined
  }
  if (!isSnapshot(stored)) return
  await updatePanel($, (state): PanelState =>
    state.status === 'idle' ? withDefaults({ ...state, ...stored, status: 'ok' }) : state,
  )
}

/** Set while a resume is scheduled or running, so the redraws it causes do not schedule another. */
let isResuming = false

/**
 * A drawn pane whose session has loaded nothing (after a /clear, a restart) shows the last
 * list at once and loads the current one behind it. Scheduled on the clock: a render hook
 * may not write `$.state`, and a timer's callback runs outside the draw.
 */
function scheduleResume($: EngineInterface) {
  if (isResuming) return
  isResuming = true
  $.clock.after(0, () => {
    void (async () => {
      try {
        if ((await readPanel($)).status !== 'idle') return
        await restoreSnapshot($)
        await refresh($)
      } finally {
        isResuming = false
      }
    })()
  })
}

function typeColor(type: string): string | undefined {
  return TYPE_COLORS[type]
}

/** A short type label, so the title keeps the row's width. */
function typeTag(type: string): string {
  return type === 'User Story' ? 'Story' : type || '?'
}

type Choice = { value: string; label: string }

/** Every iteration plus "all" ('' as its value); a selected path the project no longer lists stays pickable. */
function iterationChoices(iterations: readonly IterationOption[], selected: string): Choice[] {
  const choices = [
    { value: '', label: 'All iterations' },
    ...iterations.map(option => ({ value: option.path, label: option.isCurrent ? `${option.label} (current)` : option.label })),
  ]
  if (selected !== '' && !iterations.some(option => option.path === selected)) choices.push({ value: selected, label: selected })

  return choices
}

/** Me, everyone, then each assignee the loaded rows name; a named owner not among them stays pickable. */
function ownerChoices(rows: readonly TaskRow[], selected: string): Choice[] {
  const choices = [
    { value: '@Me', label: 'Me (@Me)' },
    { value: ANY_OWNER, label: 'Everyone' },
    ...assigneesOf(rows).map(name => ({ value: name, label: name })),
  ]
  if (!choices.some(choice => sameOwner(choice.value, selected))) choices.push({ value: selected, label: selected })

  return choices
}

function sameOwner(a: string, b: string): boolean {
  if (isMe(a) || isMe(b)) return isMe(a) && isMe(b)
  if (isAnyOwner(a) || isAnyOwner(b)) return isAnyOwner(a) && isAnyOwner(b)
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function ownerLabel(owner: string): string {
  if (isMe(owner)) return 'Me'
  return isAnyOwner(owner) ? 'Everyone' : owner
}

function iterationLabel(iteration: string): string {
  return iteration === '' ? 'All iterations' : (iteration.split('\\').pop() ?? iteration)
}

function setPicker($: EngineInterface, picker: PickerKind | undefined) {
  return updatePanel($, (state): PanelState => ({ ...state, picker }))
}

/** Closes the picker and loads the list for the pick. */
async function pick($: EngineInterface, change: Partial<Pick<PanelState, 'owner' | 'iteration'>>) {
  await setPicker($, undefined)
  await refresh($, change)
}

type Args = Record<string, unknown>

function messageOf(error: unknown): string {
  if (error instanceof AdoError) return error.message
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function stringArg(args: Args, name: string, fallback?: string): string {
  const value = args[name]
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (fallback !== undefined) return fallback
  throw new AdoError(`${name} is required`)
}

function positiveId(value: unknown, name: string): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new AdoError(`${name} must be a positive work item id`)
  return id
}

function idArg(args: Args): number {
  return positiveId(args.id, 'id')
}

function workItemIdsArg(args: Args, name = 'workItemIds'): number[] {
  const value = args[name]
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new AdoError(`${name} must be a list of positive work item ids`)
  return [...new Set(value.map(id => positiveId(id, name)))]
}

function statusArg(args: Args): PullRequestStatus | undefined {
  const value = args.status
  if (value === undefined) return undefined
  if (!(PULL_REQUEST_STATUSES as readonly unknown[]).includes(value)) {
    throw new AdoError(`status must be one of ${PULL_REQUEST_STATUSES.join(', ')}`)
  }
  return value as PullRequestStatus
}

/**
 * Reads the repository's `.claude/ado.json` and the PAT it names.
 *
 * The PAT is looked up by name in the `env` block of `.claude/settings.local.json`, not
 * through `$.env.get`: the engine accepts only a string literal there, and this name
 * comes from the repository's file.
 */
async function loadConfig($: EngineInterface): Promise<AdoConfig> {
  const cwd = await $.session.cwd()
  let fileText: string
  try {
    fileText = String(await $.fs.read(joinPath(cwd, CONFIG_PATH)))
  } catch {
    throw missingConfig(cwd)
  }
  const repo = parseRepoConfig(fileText, cwd)

  // The repository's own file first: the engine's local source is the directory the session
  // started in, which after a /cd (or a PAT the pane just wrote) is not the one meant.
  let pat: string | undefined
  try {
    pat = envValue(JSON.parse(String(await $.fs.read(joinPath(cwd, LOCAL_SETTINGS_PATH)))), repo.patEnv)
  } catch {
    pat = undefined
  }
  pat ??= envValue(await $.settings.read({ source: 'local' }), repo.patEnv)
  if (pat === undefined) throw missingPat(repo.patEnv)

  return { ...repo, pat }
}

async function send($: EngineInterface, config: AdoConfig, request: AdoRequest): Promise<unknown> {
  const response = await $.http.fetch(request.url, {
    method: request.method,
    headers: {
      Authorization: authorization(config.pat),
      Accept: 'application/json',
      ...(request.contentType === undefined ? {} : { 'Content-Type': request.contentType }),
    },
    body: request.body,
  })

  return parseResponse(config, request, response)
}

/** The matching work items, and the parents outside the filter up to the hierarchy's root. */
async function listTasks($: EngineInterface, config: AdoConfig, options: ListOptions): Promise<WorkItemList> {
  const ids = wiqlIds(await send($, config, requests.wiql(config, options)))
  if (ids.length === 0) return { tasks: [], ancestors: [] }
  const tasks = toTaskRows(config, ids, await send($, config, requests.batch(config, ids)))

  const ancestors: TaskRow[] = []
  let level = tasks
  for (let depth = 0; depth < MAX_ANCESTOR_LEVELS; depth++) {
    const parentIds = missingParentIds(level, [...tasks, ...ancestors])
    if (parentIds.length === 0) break
    level = toTaskRows(config, parentIds, await send($, config, requests.batch(config, parentIds)))
    ancestors.push(...level)
  }

  return { tasks, ancestors }
}

/** The project's iterations; an empty list when the PAT may not read them, so the list still loads. */
async function listIterations($: EngineInterface, config: AdoConfig): Promise<IterationOption[]> {
  try {
    return toIterationOptions(await send($, config, requests.iterations(config)), new Date().toISOString().slice(0, 10))
  } catch {
    return []
  }
}

async function getTask($: EngineInterface, config: AdoConfig, id: number): Promise<TaskDetail> {
  const item = await send($, config, requests.item(config, id))
  const comments = await send($, config, requests.comments(config, id))

  return toTaskDetail(config, id, item, comments)
}

/** Status requests in flight at once, so a project with many PRs is not throttled (HTTP 429). */
const STATUS_CONCURRENCY = 6

/** The project's active PRs, each with its review verdict; a PR whose statuses fail to load carries the error. */
async function listPullRequests($: EngineInterface, config: AdoConfig): Promise<PullRequestRow[]> {
  const rows = toPullRequestRows(config, await send($, config, requests.pullRequests(config)))
  const reviewed: PullRequestRow[] = []
  for (let start = 0; start < rows.length; start += STATUS_CONCURRENCY) {
    const chunk = rows.slice(start, start + STATUS_CONCURRENCY)
    reviewed.push(
      ...(await Promise.all(
        chunk.map(async (row): Promise<PullRequestRow> => {
          try {
            const review = reviewOf(await send($, config, requests.pullRequestStatuses(config, row.repoId, row.id)))
            return review === undefined ? row : { ...row, review }
          } catch (error) {
            return { ...row, reviewError: messageOf(error) }
          }
        }),
      )),
    )
  }

  return reviewed
}

/** One PR with the review's verdict, summary and findings, its newest iteration and linked work items. */
/** Links each work item to the PR artifact, skipping one already linked; answers the ids it linked. */
async function linkWorkItems(
  $: EngineInterface,
  config: AdoConfig,
  workItemIds: readonly number[],
  artifactId: string,
): Promise<number[]> {
  const linked: number[] = []
  for (const id of workItemIds) {
    if (linksArtifact(await send($, config, requests.item(config, id)), artifactId)) continue
    await send($, config, requests.linkPullRequest(config, id, artifactId))
    linked.push(id)
  }

  return linked
}

/** Removes each work item's links to the PR artifact; answers the ids that had one. */
async function unlinkWorkItems(
  $: EngineInterface,
  config: AdoConfig,
  workItemIds: readonly number[],
  artifactId: string,
): Promise<number[]> {
  const unlinked: number[] = []
  for (const id of workItemIds) {
    const item = await send($, config, requests.item(config, id))
    const indexes = artifactLinkIndexes(item, artifactId)
    if (indexes.length === 0) continue
    await send($, config, requests.unlinkPullRequest(config, id, revOf(item), indexes))
    unlinked.push(id)
  }

  return unlinked
}

async function getPullRequest($: EngineInterface, config: AdoConfig, id: number): Promise<PullRequestDetail> {
  const pr = await send($, config, requests.pullRequest(config, id))
  const repoId = String((pr as { repository?: { id?: unknown } } | undefined)?.repository?.id ?? '')
  if (repoId === '') throw new AdoError(`pull request ${id} names no repository`)
  const [statuses, threads, iterations, workItems] = await Promise.all([
    send($, config, requests.pullRequestStatuses(config, repoId, id)),
    send($, config, requests.pullRequestThreads(config, repoId, id)),
    send($, config, requests.pullRequestIterations(config, repoId, id)),
    send($, config, requests.pullRequestWorkItems(config, repoId, id)),
  ])

  return toPullRequestDetail(config, { pr, statuses, threads, iterations, workItems })
}

/** The members of every team in the project, once each. */
async function listTeamMembers($: EngineInterface, config: AdoConfig): Promise<Person[]> {
  const teamIds = teamIdsOf(await send($, config, requests.teams(config)))
  const lists = await Promise.all(teamIds.map(teamId => send($, config, requests.teamMembers(config, teamId))))

  return toMembers(lists)
}

/** The active people of the project's Contributors group, nested groups followed. */
async function listContributors($: EngineInterface, config: AdoConfig): Promise<Person[]> {
  const people: Person[] = []
  const seen = new Set<string>()
  let level = identityLevelOf(await send($, config, requests.projectGroup(config, CONTRIBUTORS_GROUP)))
  for (let depth = 0; ; depth++) {
    people.push(...level.people)
    for (const id of [...level.groupIds, ...level.people.map(person => person.id)]) seen.add(id)
    const next = [...new Set(level.memberIds)].filter(id => !seen.has(id))
    if (next.length === 0 || depth >= MAX_GROUP_DEPTH) break
    for (const id of next) seen.add(id)
    const answers = await Promise.all(identityBatches(next).map(ids => send($, config, requests.identities(config, ids))))
    const levels = answers.map(identityLevelOf)
    level = {
      people: levels.flatMap(one => one.people),
      groupIds: levels.flatMap(one => one.groupIds),
      memberIds: levels.flatMap(one => one.memberIds),
    }
  }

  return mergeMembers([people])
}

type MemberList = { members: Person[]; contributorsError?: string }

/**
 * Who a comment can mention: the teams' members and the Contributors group's.
 * Contributors needs the PAT's Identity (Read) scope; without it the teams' members still answer.
 */
async function fetchMembers($: EngineInterface, config: AdoConfig): Promise<MemberList> {
  const [team, contributors] = await Promise.all([
    listTeamMembers($, config),
    listContributors($, config).then(
      people => ({ people }),
      (error: unknown) => ({ people: [] as Person[], error: messageOf(error) }),
    ),
  ])
  const members = mergeMembers([team, contributors.people])

  return 'error' in contributors
    ? { members, contributorsError: `${CONTRIBUTORS_GROUP} not read (needs the Identity (Read) PAT scope): ${contributors.error}` }
    : { members }
}

type CachedMembers = MemberList & { source: 'cache' | 'api'; fetchedAt: string }

/**
 * The members kept in the repository's MEMBERS_PATH; the API is called, and the file rewritten,
 * only when the file is missing, names another project, or `covers` says it lacks someone.
 * A file that cannot be written leaves the answer as it is: the next call fetches again.
 */
async function cachedMembers(
  $: EngineInterface,
  config: AdoConfig,
  covers: (members: readonly Person[]) => boolean,
): Promise<CachedMembers> {
  const path = joinPath(await $.session.cwd(), MEMBERS_PATH)
  const cache = await $.fs.read(path).then(
    text => parseMemberCache(String(text), config.projectName),
    () => undefined,
  )
  if (cache && covers(cache.members)) {
    return {
      source: 'cache',
      fetchedAt: cache.fetchedAt,
      members: cache.members,
      ...(cache.contributorsError === undefined ? {} : { contributorsError: cache.contributorsError }),
    }
  }

  const fetched = await fetchMembers($, config)
  const fetchedAt = new Date().toISOString()
  await $.fs.write(path, memberCacheText({ project: config.projectName, fetchedAt, ...fetched })).catch(() => undefined)

  return { source: 'api', fetchedAt, ...fetched }
}

function mentionsArg(args: Args): string[] {
  const value = args.mentions
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new AdoError('mentions must be a list of non-empty names, emails, @assignee, @creator or @me')
  }
  return value as string[]
}

/**
 * Resolves the mentions, fetching only what they need: the card for `@assignee` / `@creator`,
 * the PAT's identity for `@me`, the members for a name.
 */
async function mentionedPeople($: EngineInterface, config: AdoConfig, id: number, mentions: readonly string[]) {
  if (mentions.length === 0) return []
  const roles = mentions.map(mentionRoleOf)
  const card = roles.some(isCardRole) ? cardPeopleOf(await send($, config, requests.item(config, id))) : {}
  const me = roles.includes('me') ? authenticatedPersonOf(await send($, config, requests.connectionData(config))) : undefined
  const names = mentions.filter((_, index) => roles[index] === undefined)
  const members =
    names.length === 0
      ? []
      : (await cachedMembers($, config, known => names.every(name => findsMember(known, name)))).members

  return resolveMentions(mentions, members, { ...card, ...(me === undefined ? {} : { me }) })
}

/** Asks before a write, unless the repository's `confirm` block turns that action's question off. */
async function confirm($: EngineInterface, config: AdoConfig, action: WriteAction, question: string): Promise<void> {
  if (!config.confirm[action]) return
  let answer: string
  try {
    answer = await $.ui.ask(question, { header: 'ADO write', options: [CONFIRM_YES, CONFIRM_NO] })
  } catch {
    throw new AdoError('the write was not confirmed (dialog dismissed or no one to ask)')
  }
  if (answer !== CONFIRM_YES) throw new AdoError(`the user declined: ${answer}`)
}

async function refresh(
  $: EngineInterface,
  change: Partial<Pick<PanelState, 'owner' | 'includeClosed' | 'iteration'>> = {},
) {
  const current = await readPanel($)
  const owner = change.owner ?? current.owner
  const includeClosed = change.includeClosed ?? current.includeClosed
  const iteration = change.iteration ?? current.iteration
  await updatePanel($, (state): PanelState => ({
    ...state,
    owner,
    includeClosed,
    iteration,
    status: 'loading',
    message: undefined,
  }))
  try {
    const config = await loadConfig($)
    // The PRs depend on no work item filter, so only a plain refresh (no filter change) reloads them.
    const isFilterChange = Object.keys(change).length > 0
    const [list, iterations, pullRequests] = await Promise.all([
      listTasks($, config, { owner, workItemType: ALL_TYPES, includeClosed, iterationPath: iteration }),
      listIterations($, config),
      isFilterChange
        ? Promise.resolve({ rows: current.pullRequests, error: current.pullRequestError })
        : // A PAT without the Code scope still lists the work items.
          listPullRequests($, config).then(
            rows => ({ rows, error: undefined }),
            (error: unknown) => ({ rows: [] as PullRequestRow[], error: messageOf(error) }),
          ),
    ])
    await updatePanel($, (state): PanelState => ({
      ...state,
      status: 'ok',
      project: config.projectName,
      tasks: list.tasks,
      ancestors: list.ancestors,
      iterations,
      pullRequests: pullRequests.rows,
      pullRequestError: pullRequests.error,
      fetchedAt: new Date().toISOString(),
      needs: undefined,
      notice: undefined,
    }))
    await saveSnapshot($)
  } catch (error) {
    const needs = error instanceof AdoError ? error.gap : undefined
    await updatePanel($, (state): PanelState => ({
      ...state,
      status: 'error',
      message: messageOf(error),
      needs,
      // A repository without a config shows no other repository's list.
      ...(needs === 'config'
        ? {
            tasks: [],
            ancestors: [],
            iterations: [],
            iteration: '',
            project: undefined,
            selected: undefined,
            pullRequests: [],
            pullRequestError: undefined,
            selectedPullRequest: undefined,
          }
        : {}),
    }))
    if (needs === 'config') await dropSnapshot($)
  }
}

/** Adds the local settings file to the repository's .gitignore; says what it did. */
async function ensureGitignore($: EngineInterface, cwd: string): Promise<string> {
  const path = joinPath(cwd, GITIGNORE_PATH)
  let text: string | undefined
  try {
    text = String(await $.fs.read(path))
  } catch {
    text = undefined
  }
  if (text === undefined) {
    const isRepository = await $.fs.stat(joinPath(cwd, '.git')).then(
      () => true,
      () => false,
    )
    if (!isRepository) return 'not a git repository, so no .gitignore was written'
    text = ''
  }
  if (hasGitignoreEntry(text)) return `${GITIGNORE_PATH} already ignores ${LOCAL_SETTINGS_PATH}`
  await $.fs.write(path, withGitignoreEntry(text))

  return `added ${LOCAL_SETTINGS_PATH} to ${GITIGNORE_PATH}`
}

/** A written step is also a toast: the pane leaves setup, and its notice, once the list loads. */
async function setNotice($: EngineInterface, notice: string | undefined, message?: string) {
  if (notice !== undefined) $.ui.toast(notice)
  await updatePanel($, (state): PanelState => ({ ...state, notice, ...(message === undefined ? {} : { message }) }))
}

async function saveProjectUrl($: EngineInterface, raw: string) {
  try {
    const ref = parseProjectUrl(raw)
    const cwd = await $.session.cwd()
    const patEnv = defaultPatEnv(ref)
    const path = joinPath(cwd, CONFIG_PATH)
    const previous = await $.fs.read(path).then(String, () => undefined)
    await $.fs.write(path, repoConfigText(raw, patEnv, previous))
    const ignored = await ensureGitignore($, cwd)
    await setNotice($, `Wrote ${CONFIG_PATH} (${ref.projectName}, PAT variable ${patEnv}); ${ignored}.`)
    await refresh($)
  } catch (error) {
    await setNotice($, undefined, messageOf(error))
  }
}

async function savePat($: EngineInterface, raw: string) {
  const pat = raw.trim()
  if (pat === '') return setNotice($, undefined, 'The PAT is empty.')
  try {
    const cwd = await $.session.cwd()
    const repo = parseRepoConfig(String(await $.fs.read(joinPath(cwd, CONFIG_PATH))), cwd)
    const path = joinPath(cwd, LOCAL_SETTINGS_PATH)
    let current: string | undefined
    try {
      current = String(await $.fs.read(path))
    } catch {
      current = undefined
    }
    // Ignore first, so the PAT never sits in a file git would pick up.
    const ignored = await ensureGitignore($, cwd)
    await $.fs.write(path, withLocalPat(current, repo.patEnv, pat))
    await setNotice($, `Saved ${repo.patEnv} to ${LOCAL_SETTINGS_PATH}; ${ignored}.`)
    await refresh($)
  } catch (error) {
    await setNotice($, undefined, messageOf(error))
  }
}

/** Writes a detail result only while that task is still the one selected (a later click wins). */
function settleDetail($: EngineInterface, id: number, selected: DetailState) {
  return updatePanel($, (state): PanelState => (state.selected?.id === id ? { ...state, selected } : state))
}

async function openDetail($: EngineInterface, id: number) {
  await updatePanel($, (state): PanelState => ({ ...state, selected: { id, status: 'loading' }, selectedPullRequest: undefined }))
  try {
    const config = await loadConfig($)
    await settleDetail($, id, { id, status: 'ok', detail: await getTask($, config, id) })
  } catch (error) {
    await settleDetail($, id, { id, status: 'error', message: messageOf(error) })
  }
}

function closeDetail($: EngineInterface) {
  return updatePanel($, (state): PanelState => ({ ...state, selected: undefined }))
}

/** The prompt only points at the packaged skill; the analysis and development steps live there. */
function fillGoPrompt($: EngineInterface, task: TaskRow) {
  return $.prompt.fill({
    text: `使用 ado-tasks:claude-go skill 處理 Azure DevOps ${task.type || 'Work Item'} #${task.id}「${task.title}」(${task.url})`,
    mode: 'replace',
  })
}

/** Writes a PR result only while that PR is still the one selected (a later click wins). */
function settlePullRequest($: EngineInterface, id: number, selectedPullRequest: PullRequestDetailState) {
  return updatePanel($, (state): PanelState =>
    state.selectedPullRequest?.id === id ? { ...state, selectedPullRequest } : state,
  )
}

async function openPullRequest($: EngineInterface, id: number) {
  await updatePanel($, (state): PanelState => ({ ...state, selectedPullRequest: { id, status: 'loading' }, selected: undefined }))
  try {
    const config = await loadConfig($)
    await settlePullRequest($, id, { id, status: 'ok', detail: await getPullRequest($, config, id) })
  } catch (error) {
    await settlePullRequest($, id, { id, status: 'error', message: messageOf(error) })
  }
}

function closePullRequest($: EngineInterface) {
  return updatePanel($, (state): PanelState => ({ ...state, selectedPullRequest: undefined }))
}

/** As for a work item, the prompt only points at the packaged skill. */
function fillPullRequestGoPrompt($: EngineInterface, pr: PullRequestRow) {
  return $.prompt.fill({
    text: `使用 ado-tasks:claude-go-pr skill 處理 Azure DevOps Pull Request !${pr.id}「${pr.title}」(repo ${pr.repo}, ${pr.source} → ${pr.target}, ${pr.url})`,
    mode: 'replace',
  })
}

/** The host's URL openers, by argument vector (no shell, so `&` in a query string stays in the URL). */
const WINDOWS_OPENER = ['rundll32', 'url.dll,FileProtocolHandler']
const UNIX_OPENERS = [['open'], ['xdg-open']]

/** Opens an https URL in the host's browser; anything else, or no opener that starts, is toasted. */
async function openUrl($: EngineInterface, url: string) {
  if (!/^https:\/\//i.test(url)) {
    $.ui.toast(`Not an https URL: ${url}`)
    return
  }
  const openers = (await $.env.get('OS')) === 'Windows_NT' ? [WINDOWS_OPENER] : UNIX_OPENERS
  for (const opener of openers) {
    try {
      if ((await $.process.run([...opener, url])).exitCode === 0) return
    } catch {
      // This opener is not on the host; try the next.
    }
  }
  $.ui.toast(`Could not open ${url}`)
}

/** Theme keys for a review state; a verdict without a status (summary only) draws plain. */
function reviewColor(state: string | undefined): string | undefined {
  if (state === 'failed' || state === 'error') return 'error'
  if (state === 'succeeded') return 'success'
  return state === 'pending' ? 'warning' : undefined
}

/** Verdicts drawn as the severity they stand for. */
const VERDICT_LABELS: Record<string, string> = { 'fix first': 'Warning' }

function reviewLabel(row: PullRequestRow): string {
  if (row.review !== undefined) {
    const verdict = row.review.verdict || row.review.state
    return VERDICT_LABELS[verdict] ?? verdict
  }
  return row.reviewError === undefined ? 'no review' : '?'
}

/** `Critical 0 / Warning 2 / Suggestion 0` drawn as `Warning 2`: severities without findings left out. */
function nonZeroCounts(counts: string): string {
  return counts
    .split('/')
    .map(part => part.trim())
    .filter(part => part !== '' && !/\s0$/.test(part))
    .join(' / ')
}

const SEVERITY_COLORS: Record<string, string> = { Critical: 'error', Warning: 'warning' }

/** Drawn above the fixed findings, which reviewThreadsOf puts last. */
const FIXED_RULE = '='.repeat(24)

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

async function patchRow($: EngineInterface, id: number, patch: Partial<TaskRow>) {
  const patched = (rows: TaskRow[]) => rows.map(task => (task.id === id ? { ...task, ...patch } : task))

  await updatePanel($, (state): PanelState => ({
    ...state,
    tasks: patched(state.tasks),
    ancestors: patched(state.ancestors),
  }))
  await saveSnapshot($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ado-tasks',
      description: 'Open the Azure DevOps work item panel for this repository',
      argumentHint: '[owner | @Me]',
    })
    await $.tool.register({
      name: 'list_tasks',
      description:
        "List Azure DevOps work items assigned to an owner in this repository's project (.claude/ado.json). " +
        'Returns id, title, state, type, assignee, parentId and URL, newest change first, at most 200, ' +
        'plus the ancestors (parents outside the filter) that place them in the Epic/Feature/Story hierarchy.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: `'@Me' (default), '${ANY_OWNER}' or 'All' for every assignee, or the assignee's display name or email`,
          },
          workItemType: {
            type: 'string',
            description: `Work item type such as 'Task', 'Bug', 'User Story', 'Epic'; default '${ALL_TYPES}' (every type)`,
          },
          includeClosed: { type: 'boolean', description: 'Include Closed, Removed and Done items; default false' },
          iteration: {
            type: 'string',
            description: "Iteration path such as 'Project\\Sprint 1', matched with UNDER; default every iteration",
          },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'get_task',
      description:
        'Read one Azure DevOps work item: description, acceptance criteria, repro steps, area, iteration, tags, ' +
        'parentId and childIds (hierarchy links), assignee and creator (with identity ids), and the latest 20 comments.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer', description: 'Work item id' } },
        required: ['id'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'update_task_state',
      description:
        "Change an Azure DevOps work item's System.State (for example 'Active', 'Resolved', 'Closed'). " +
        'The user confirms each call unless .claude/ado.json sets confirm.state to false; a state the process does not allow is answered with the server error.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Work item id' },
          state: { type: 'string', description: 'Target state name exactly as the process defines it' },
        },
        required: ['id', 'state'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'add_task_comment',
      description:
        'Post a comment on an Azure DevOps work item. The user confirms each call unless .claude/ado.json sets confirm.comment to false. ' +
        'To @mention people, pass `mentions`; never write mention markup in `text` yourself. ' +
        'A mention that matches no project member (list_members), or several, refuses the whole comment and names the candidates.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Work item id' },
          text: { type: 'string', description: 'Comment text (HTML or plain text)' },
          mentions: {
            type: 'array',
            items: { type: 'string' },
            description:
              "People to @mention, put in front of the text: '@assignee' or '@creator' of this work item, " +
              "'@me' for the person the PAT belongs to, " +
              'or a project member by display name or email (a unique part of either is enough)',
          },
        },
        required: ['id', 'text'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'create_task',
      description:
        `Create a Task under a parent work item (usually a User Story). The title always starts with "${AI_DRAFT_PREFIX}" ` +
        '(added when absent), the Task is tagged "AI Draft", and it takes the parent\'s area and iteration. ' +
        'The user confirms each call unless .claude/ado.json sets confirm.create to false.',
      inputSchema: {
        type: 'object',
        properties: {
          parentId: { type: 'integer', description: 'Id of the parent work item' },
          title: { type: 'string', description: `Task title; "${AI_DRAFT_PREFIX} " is put in front when absent` },
          description: { type: 'string', description: 'Task description (HTML or plain text)' },
        },
        required: ['parentId', 'title', 'description'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'assign_task',
      description:
        "Change an Azure DevOps work item's Assigned To. The assignee is resolved like a mention: " +
        "'@me', '@creator', or a project member (list_members) by display name or email; " +
        'nobody or several matching refuses the call. The user confirms each call unless .claude/ado.json sets confirm.assign to false.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Work item id' },
          assignee: {
            type: 'string',
            description: "'@me', '@creator', or a project member's display name or email (a unique part of either is enough)",
          },
        },
        required: ['id', 'assignee'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'update_task',
      description:
        "Change a work item's title and/or description. A title that starts with " +
        `"${AI_DRAFT_PREFIX}" keeps that prefix. The user confirms each call unless .claude/ado.json sets confirm.update to false.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Work item id' },
          title: { type: 'string', description: 'New title; omit to keep it' },
          description: { type: 'string', description: 'New description (HTML or plain text), replacing the old one; omit to keep it' },
        },
        required: ['id'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'list_members',
      description:
        "List the members of every team in this repository's Azure DevOps project, and of its Contributors group " +
        '(nested groups followed): name, email and identity id. These are the people add_task_comment can @mention. ' +
        'contributorsError says why Contributors was left out, such as a PAT without the Identity (Read) scope. ' +
        `The list is kept in ${MEMBERS_PATH}; the API is called again only when that file is missing or holds no match ` +
        '(source says which answered).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keep members whose name or email holds this text, ignoring case' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'list_pull_requests',
      description:
        "List the active pull requests of every repository in this repository's Azure DevOps project, by repository, " +
        'each with the Claude Code Review verdict from its ai-review/claude-code-review status (verdict, state, severity counts). ' +
        'Needs the PAT\'s Code (Read) scope.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Keep only this repository (name, ignoring case); default every repository' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'get_pull_request',
      description:
        'Read one Azure DevOps pull request with its Claude Code Review result: repository, source and target branch, ' +
        'head commit, linked work item ids, the verdict, whether the review is stale (newer iterations than the reviewed one), ' +
        'the summary thread, and every finding thread (severity, rule, file and line, status, text). Needs the Code (Read) scope.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer', description: 'Pull request id' } },
        required: ['id'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'create_pull_request',
      description:
        "Open a pull request in a repository of this repository's Azure DevOps project, linked to work items. " +
        'The source branch must already be pushed. Needs the PAT\'s Code (Read & Write) scope. ' +
        'The user confirms each call unless .claude/ado.json sets confirm.pullRequest to false.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository name or id' },
          sourceBranch: { type: 'string', description: "Source branch, such as 'bugfix/212-x' or 'refs/heads/bugfix/212-x'" },
          targetBranch: { type: 'string', description: "Target branch; default the repository's default branch" },
          title: { type: 'string', description: 'Pull request title' },
          description: { type: 'string', description: 'Pull request description (Markdown)' },
          workItemIds: { type: 'array', items: { type: 'integer' }, description: 'Work item ids to link' },
        },
        required: ['repo', 'sourceBranch', 'title', 'description'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'update_pull_request',
      description:
        "Change an Azure DevOps pull request's title, description or status (abandon / reactivate), and link or unlink work items " +
        '(each work item gets or loses its Pull Request link; one already in that state is skipped). ' +
        "Needs the PAT's Code (Read & Write) and Work Items (Read & Write) scopes. " +
        'The user confirms each call unless .claude/ado.json sets confirm.pullRequest to false.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Pull request id' },
          title: { type: 'string', description: 'New title; omit to keep it' },
          description: { type: 'string', description: 'New description (Markdown), replacing the old one; omit to keep it' },
          workItemIds: { type: 'array', items: { type: 'integer' }, description: 'Work item ids to link' },
          unlinkWorkItemIds: { type: 'array', items: { type: 'integer' }, description: 'Work item ids whose link to this PR is removed' },
          status: { type: 'string', enum: [...PULL_REQUEST_STATUSES], description: "'abandoned' to abandon, 'active' to reactivate; omit to keep it" },
        },
        required: ['id'],
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('command.run', { command: 'ado-tasks' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Azure DevOps Work Items' })
    const owner = e.args.trim()
    void restoreSnapshot($).then(() => refresh($, owner === '' ? {} : { owner }))

    return { text: `Azure DevOps work item panel opened${owner === '' ? '' : ` for ${owner}`}.` }
  })

  on('tool.call', { tool: `${TOOL_PREFIX}list_tasks` }, async ($, e) => {
    const args = e as unknown as Args
    try {
      const owner = stringArg(args, 'owner', '@Me')
      const workItemType = stringArg(args, 'workItemType', ALL_TYPES)
      const includeClosed = args.includeClosed === true
      const iteration = stringArg(args, 'iteration', '')
      const config = await loadConfig($)
      const { tasks, ancestors } = await listTasks($, config, {
        owner,
        workItemType,
        includeClosed,
        iterationPath: iteration,
      })
      // The pane lists every type, so only an every-type answer is the pane's list.
      if (isAllTypes(workItemType)) {
        await updatePanel($, (state): PanelState => ({
          ...state,
          status: 'ok',
          message: undefined,
          owner,
          includeClosed,
          iteration,
          project: config.projectName,
          tasks,
          ancestors,
          fetchedAt: new Date().toISOString(),
        }))
      }

      return {
        result: JSON.stringify(
          { project: config.projectName, owner, iteration, count: tasks.length, tasks, ancestors },
          null,
          2,
        ),
      }
    } catch (error) {
      return { deny: `${PLUGIN}: ${messageOf(error)}` }
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: list_tasks failed inside the mod` },
  )

  on('tool.call', { tool: `${TOOL_PREFIX}get_task` }, async ($, e) => {
    try {
      const config = await loadConfig($)
      const id = idArg(e as unknown as Args)
      const task = await getTask($, config, id)
      await updatePanel($, (state): PanelState => ({
        ...state,
        selected: { id, status: 'ok', detail: task },
        selectedPullRequest: undefined,
      }))

      return { result: JSON.stringify(task, null, 2) }
    } catch (error) {
      return { deny: `${PLUGIN}: ${messageOf(error)}` }
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: get_task failed inside the mod` },
  )

  on('tool.call', { tool: `${TOOL_PREFIX}assign_task` }, async ($, e) => {
    const args = e as unknown as Args
    try {
      const id = idArg(args)
      const assignee = stringArg(args, 'assignee')
      const config = await loadConfig($)
      const [person] = (await mentionedPeople($, config, id, [assignee])) as [Person]
      await confirm($, config, 'assign', `Assign ${config.projectName} #${id} to ${person.name}${person.email === '' ? '' : ` <${person.email}>`}?`)
      const item = await send($, config, requests.assign(config, id, person))
      const assignedTo = cardPeopleOf(item).assignee?.name ?? person.name
      await patchRow($, id, { assignedTo })

      return { result: JSON.stringify({ id, assignedTo, url: workItemUrl(config, id) }) }
    } catch (error) {
      return { deny: `${PLUGIN}: ${messageOf(error)}` }
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: assign_task failed inside the mod` },
  )

  on('tool.call', { tool: `${TOOL_PREFIX}update_task_state` }, async ($, e) => {
    const args = e as unknown as Args
    try {
      const id = idArg(args)
      const state = stringArg(args, 'state')
      const config = await loadConfig($)
      await confirm($, config, 'state', `Set ${config.projectName} #${id} to state "${state}"?`)
      const item = await send($, config, requests.updateState(config, id, state))
      const updated = { id, state: stateOf(item), url: workItemUrl(config, id) }
      await patchRow($, id, { state: updated.state })

      return { result: JSON.stringify(updated) }
    } catch (error) {
      return { deny: `${PLUGIN}: ${messageOf(error)}` }
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: update_task_state failed inside the mod` },
  )

  on('tool.call', { tool: `${TOOL_PREFIX}add_task_comment` }, async ($, e) => {
    const args = e as unknown as Args
    try {
      const id = idArg(args)
      const comment = stringArg(args, 'text')
      const mentions = mentionsArg(args)
      const config = await loadConfig($)
      const people = await mentionedPeople($, config, id, mentions)
      const preview = comment.length > 200 ? `${comment.slice(0, 200)}...` : comment
      const notified = people.length === 0 ? '' : ` Mentions (notified): ${people.map(person => person.name).join(', ')}.`
      await confirm($, config, 'comment', `Post this comment on ${config.projectName} #${id}? "${preview}"${notified}`)
      const created = (await send($, config, requests.addComment(config, id, withMentions(comment, people)))) as
        | { id?: number }
        | undefined

      return {
        result: JSON.stringify({
          id,
          commentId: created?.id ?? 0,
          url: workItemUrl(config, id),
          mentioned: people,
        }),
      }
    } catch (error) {
      return { deny: `${PLUGIN}: ${messageOf(error)}` }
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: add_task_comment failed inside the mod` },
  )

  on('tool.call', { tool: `${TOOL_PREFIX}create_task` }, async ($, e) => {
    const args = e as unknown as Args
    try {
      const parentId = positiveId(args.parentId, 'parentId')
      const title = draftTitle(stringArg(args, 'title'))
      const description = stringArg(args, 'description')
      const config = await loadConfig($)
      const parent = await send($, config, requests.item(config, parentId))
      const fields = draftTaskFields(parent, title, description)
      await confirm(
        $,
        config,
        'create',
        `Create a ${TASK_TYPE} under ${config.projectName} #${parentId} (${typeOf(parent)} "${titleOf(parent)}")? ` +
          `"${title}" — ${clip(description, 200)}`,
      )
      const created = await send($, config, requests.createChild(config, TASK_TYPE, parentId, fields))
      const id = idOf(created)

      return { result: JSON.stringify({ id, parentId, title: titleOf(created), url: workItemUrl(config, id) }) }
    } catch (error) {
      return { deny: `${PLUGIN}: ${messageOf(error)}` }
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: create_task failed inside the mod` },
  )

  on('tool.call', { tool: `${TOOL_PREFIX}update_task` }, async ($, e) => {
    const args = e as unknown as Args
    try {
      const id = idArg(args)
      const title = stringArg(args, 'title', '')
      const description = stringArg(args, 'description', '')
      if (title === '' && description === '') throw new AdoError('give a title, a description, or both')
      const config = await loadConfig($)
      const current = titleOf(await send($, config, requests.item(config, id)))
      // A draft stays recognizable as one until a person removes the prefix by hand.
      const nextTitle = title === '' ? '' : current.startsWith(AI_DRAFT_PREFIX) ? draftTitle(title) : title
      const fields: FieldValues = {
        ...(nextTitle === '' ? {} : { 'System.Title': nextTitle }),
        ...(description === '' ? {} : { 'System.Description': description }),
      }
      const changes = [
        nextTitle === '' ? '' : `title "${current}" → "${nextTitle}"`,
        description === '' ? '' : `description → ${clip(description, 200)}`,
      ].filter(change => change !== '')
      await confirm($, config, 'update', `Update ${config.projectName} #${id}: ${changes.join('; ')}?`)
      const updated = titleOf(await send($, config, requests.updateFields(config, id, fields)))
      await patchRow($, id, { title: updated })

      return { result: JSON.stringify({ id, title: updated, url: workItemUrl(config, id) }) }
    } catch (error) {
      return { deny: `${PLUGIN}: ${messageOf(error)}` }
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: update_task failed inside the mod` },
  )

  on('tool.call', { tool: `${TOOL_PREFIX}list_members` }, async ($, e) => {
    try {
      const query = stringArg(e as unknown as Args, 'query', '')
      const config = await loadConfig($)
      const { members: all, contributorsError, source, fetchedAt } = await cachedMembers($, config, known =>
        findsMember(known, query),
      )
      const members = filterMembers(all, query)

      return {
        result: JSON.stringify(
          {
            project: config.projectName,
            query,
            source,
            fetchedAt,
            count: members.length,
            members,
            ...(contributorsError ? { contributorsError } : {}),
          },
          null,
          2,
        ),
      }
    } catch (error) {
      return { deny: `${PLUGIN}: ${messageOf(error)}` }
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: list_members failed inside the mod` },
  )

  on('tool.call', { tool: `${TOOL_PREFIX}list_pull_requests` }, async ($, e) => {
    try {
      const repo = stringArg(e as unknown as Args, 'repo', '').toLowerCase()
      const config = await loadConfig($)
      const all = await listPullRequests($, config)
      // Only the unfiltered answer is the pane's list.
      if (repo === '') await updatePanel($, (state): PanelState => ({ ...state, pullRequests: all, pullRequestError: undefined }))
      const pullRequests = repo === '' ? all : all.filter(row => row.repo.toLowerCase() === repo)

      return {
        result: JSON.stringify({ project: config.projectName, count: pullRequests.length, pullRequests }, null, 2),
      }
    } catch (error) {
      return { deny: `${PLUGIN}: ${messageOf(error)}` }
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: list_pull_requests failed inside the mod` },
  )

  on('tool.call', { tool: `${TOOL_PREFIX}get_pull_request` }, async ($, e) => {
    try {
      const id = idArg(e as unknown as Args)
      const config = await loadConfig($)
      const detail = await getPullRequest($, config, id)
      await updatePanel($, (state): PanelState => ({
        ...state,
        selected: undefined,
        selectedPullRequest: { id, status: 'ok', detail },
      }))

      return { result: JSON.stringify({ ...detail, isReviewStale: isReviewStale(detail) }, null, 2) }
    } catch (error) {
      return { deny: `${PLUGIN}: ${messageOf(error)}` }
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: get_pull_request failed inside the mod` },
  )

  on('tool.call', { tool: `${TOOL_PREFIX}create_pull_request` }, async ($, e) => {
    const args = e as unknown as Args
    try {
      const repoArg = stringArg(args, 'repo')
      const source = stringArg(args, 'sourceBranch')
      const title = stringArg(args, 'title')
      const description = stringArg(args, 'description')
      const workItemIds = workItemIdsArg(args)
      const config = await loadConfig($)
      const repo = repositoryOf(await send($, config, requests.repository(config, repoArg)))
      const target = stringArg(args, 'targetBranch', repo.defaultBranch)
      if (target === '') throw new AdoError(`targetBranch is required: repository ${repo.name} names no default branch`)
      const linked = workItemIds.length === 0 ? '' : ` Work items: ${workItemIds.map(id => `#${id}`).join(', ')}.`
      await confirm(
        $,
        config,
        'pullRequest',
        `Open a pull request in ${repo.name}: ${branchName(source)} → ${branchName(target)}? ` +
          `"${title}" — ${clip(description, 200)}${linked}`,
      )
      const created = createdPullRequestOf(
        config,
        repo,
        await send($, config, requests.createPullRequest(config, repo.id, { source, target, title, description, workItemIds })),
      )
      await linkWorkItems($, config, workItemIds, created.artifactId)

      return {
        result: JSON.stringify({
          id: created.id,
          repo: repo.name,
          sourceBranch: branchName(source),
          targetBranch: branchName(target),
          title,
          workItemIds,
          url: created.url,
        }),
      }
    } catch (error) {
      return { deny: `${PLUGIN}: ${messageOf(error)}` }
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: create_pull_request failed inside the mod` },
  )

  on('tool.call', { tool: `${TOOL_PREFIX}update_pull_request` }, async ($, e) => {
    const args = e as unknown as Args
    try {
      const id = idArg(args)
      const title = stringArg(args, 'title', '')
      const description = stringArg(args, 'description', '')
      const workItemIds = workItemIdsArg(args)
      const unlinkIds = workItemIdsArg(args, 'unlinkWorkItemIds')
      const status = statusArg(args)
      if (title === '' && description === '' && status === undefined && workItemIds.length === 0 && unlinkIds.length === 0) {
        throw new AdoError('give a title, a description, a status, work item ids to link or unlink, or several')
      }
      const config = await loadConfig($)
      const pr = pullRequestRefOf(await send($, config, requests.pullRequest(config, id)))
      const fields: PullRequestFields = {
        ...(title === '' ? {} : { title }),
        ...(description === '' ? {} : { description }),
        ...(status === undefined ? {} : { status }),
      }
      const changes = [
        title === '' ? '' : `title → "${title}"`,
        description === '' ? '' : `description → ${clip(description, 200)}`,
        status === undefined ? '' : `status → ${status}`,
        workItemIds.length === 0 ? '' : `link work items ${workItemIds.map(item => `#${item}`).join(', ')}`,
        unlinkIds.length === 0 ? '' : `unlink work items ${unlinkIds.map(item => `#${item}`).join(', ')}`,
      ].filter(change => change !== '')
      await confirm($, config, 'pullRequest', `Update pull request !${id} in ${pr.repo}: ${changes.join('; ')}?`)
      const unlinked = await unlinkWorkItems($, config, unlinkIds, pr.artifactId)
      if (Object.keys(fields).length > 0) await send($, config, requests.updatePullRequest(config, pr.repoId, id, fields))
      const linked = await linkWorkItems($, config, workItemIds, pr.artifactId)

      return {
        result: JSON.stringify({
          id,
          repo: pr.repo,
          updated: Object.keys(fields),
          linked,
          unlinked,
          url: pullRequestUrl(config, pr.repo, id),
        }),
      }
    } catch (error) {
      return { deny: `${PLUGIN}: ${messageOf(error)}` }
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: update_pull_request failed inside the mod` },
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const state = await readPanel($)
    // `/clear` moves the process to a new session id, whose `$.state` starts over.
    if (state.status === 'idle') scheduleResume($)

    if (state.needs !== undefined) {
      const isConfig = state.needs === 'config'

      return (
        <Box flexDirection="column">
          <Text bold>Azure DevOps setup · step {isConfig ? '1' : '2'} of 2</Text>
          {isConfig ? (
            <Text>
              Enter this repository's project URL, for example https://dev.azure.com/org/Project or
              https://org.visualstudio.com/Project. It is written to {CONFIG_PATH}.
            </Text>
          ) : (
            <Text>
              Paste a PAT with the {'Work Items (Read & write)'} scope. It is written to {LOCAL_SETTINGS_PATH}, which is
              added to .gitignore first. The field shows what you type.
            </Text>
          )}
          {Input ? (
            isConfig ? (
              <Input
                key="setup-url"
                label="Project URL"
                placeholder="https://dev.azure.com/{organization}/{project}"
                submitLabel="Save"
                autoFocus
                onSubmit={value => void saveProjectUrl($, value)}
              />
            ) : (
              <Input key="setup-pat" label="PAT" submitLabel="Save" autoFocus onSubmit={value => void savePat($, value)} />
            )
          ) : (
            <Text dimColor>This surface has no text field; edit the file named above by hand, then press Retry.</Text>
          )}
          {state.notice && <Text color="success">{state.notice}</Text>}
          {state.message && <Text dimColor>{state.message}</Text>}
          <Button key="retry" label="Retry" onPress={() => void refresh($)} />
        </Box>
      )
    }

    const selectedPullRequest = state.selectedPullRequest

    if (selectedPullRequest !== undefined) {
      const detail = selectedPullRequest.detail
      const row = detail ?? state.pullRequests.find(pr => pr.id === selectedPullRequest.id)
      const review = row?.review
      const lead = detail ? summaryLead(detail.summary) : ''

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="pr-back" label="Back" hotkey="b" role="dismiss" onPress={() => void closePullRequest($)} />
            {row && (
              <Button
                key="pr-go"
                label="Claude Go"
                hotkey="g"
                variant="primary"
                onPress={() => void fillPullRequestGoPrompt($, row)}
              />
            )}
            <Button key="pr-reload" label="Reload" hotkey="r" onPress={() => void openPullRequest($, selectedPullRequest.id)} />
            {row?.url && <Button key="pr-web" label="PR" hotkey="p" onPress={() => void openUrl($, row.url)} />}
            {review?.reportUrl && (
              <Button key="pr-build" label="Build" hotkey="u" onPress={() => void openUrl($, review.reportUrl ?? '')} />
            )}
          </Box>
          <Text bold wrap="truncate-end">
            !{selectedPullRequest.id} {row?.title ?? ''}
          </Text>
          {selectedPullRequest.status === 'loading' && <Text dimColor>Loading...</Text>}
          {selectedPullRequest.status === 'error' && <Text color="error">{selectedPullRequest.message}</Text>}
          {row && (
            <Text dimColor wrap="truncate-end">
              {row.repo} · {row.source} → {row.target} · {row.createdBy}
              {row.isDraft ? ' · draft' : ''}
            </Text>
          )}
          {row && (
            <Text bold color={reviewColor(review?.state)}>
              Review: {reviewLabel(row)}
              {review?.counts && nonZeroCounts(review.counts) ? ` · ${nonZeroCounts(review.counts)}` : ''}
              {detail && isReviewStale(detail) ? ` · stale (iteration ${review?.iterationId} of ${detail.latestIterationId})` : ''}
            </Text>
          )}
          {detail && (
            <Box flexDirection="column">
              {detail.workItemIds.length > 0 && (
                <Text dimColor>Work items: {detail.workItemIds.map(id => `#${id}`).join(' ')}</Text>
              )}
              {lead !== '' && (
                <Box flexDirection="column" marginTop={1}>
                  <Text>{clip(lead, 1200)}</Text>
                </Box>
              )}
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Findings ({detail.findings.length})</Text>
                {detail.findings.length === 0 && <Text dimColor>No finding threads.</Text>}
                {detail.findings.map((finding, index) => (
                  <Box key={`finding-${finding.threadId}`} flexDirection="column" marginTop={1}>
                    {finding.status === FIXED_STATUS && detail.findings[index - 1]?.status !== FIXED_STATUS && (
                      <Text dimColor wrap="truncate-end">
                        {`${FIXED_RULE} Fixed (${detail.findings.filter(f => f.status === FIXED_STATUS).length}) ${FIXED_RULE}`}
                      </Text>
                    )}
                    <Box flexDirection="row" columnGap={1}>
                      <Text bold color={SEVERITY_COLORS[finding.severity]}>
                        [{finding.severity || '?'}]
                      </Text>
                      <Text dimColor={finding.status !== 'active'}>{finding.status}</Text>
                      <Text dimColor wrap="truncate-end">
                        {finding.filePath ?? 'PR'}
                        {finding.line === undefined ? '' : `:${finding.line}`}
                        {finding.rule ? ` · ${finding.rule}` : ''}
                      </Text>
                    </Box>
                    <Text>{finding.title}</Text>
                    <Text dimColor>{clip(finding.body, 500)}</Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    const selected = state.selected

    if (selected !== undefined) {
      const detail = selected.detail
      const row = detail ?? [...state.tasks, ...state.ancestors].find(task => task.id === selected.id)
      const sections: [string, string][] = detail
        ? [
            ['Description', detail.description],
            ['Acceptance criteria', detail.acceptanceCriteria],
            ['Repro steps', detail.reproSteps],
          ]
        : []

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="back" label="Back" hotkey="b" role="dismiss" onPress={() => void closeDetail($)} />
            {row && (
              <Button key="go" label="Claude Go" hotkey="g" variant="primary" onPress={() => void fillGoPrompt($, row)} />
            )}
            <Button key="reload" label="Reload" hotkey="r" onPress={() => void openDetail($, selected.id)} />
          </Box>
          <Text bold color={row ? typeColor(row.type) : undefined}>
            #{selected.id} {row?.title ?? ''}
          </Text>
          {selected.status === 'loading' && <Text dimColor>Loading...</Text>}
          {selected.status === 'error' && <Text color="error">{selected.message}</Text>}
          {detail && (
            <Box flexDirection="column">
              <Text>
                {detail.state} · {detail.type} · {detail.assignedTo || 'unassigned'}
              </Text>
              <Text dimColor wrap="truncate-end">
                {detail.iterationPath}
                {detail.tags ? ` · ${detail.tags}` : ''}
              </Text>
              <Text dimColor wrap="truncate-end">
                <Link href={detail.url} />
              </Text>
              {sections
                .filter(([, body]) => body !== '')
                .map(([label, body]) => (
                  <Box key={`section-${label}`} flexDirection="column" marginTop={1}>
                    <Text bold>{label}</Text>
                    <Text>{clip(body, 2000)}</Text>
                  </Box>
                ))}
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Comments ({detail.comments.length})</Text>
                {detail.comments.length === 0 && <Text dimColor>No comments.</Text>}
                {detail.comments.slice(0, 5).map((comment, index) => (
                  <Box key={`comment-${index}`} flexDirection="column">
                    <Text dimColor>
                      {comment.by} · {comment.date.slice(0, 10)}
                    </Text>
                    <Text>{clip(comment.text, 400)}</Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    const header = (
      <Text bold wrap="truncate-end">
        {state.project ?? 'Azure DevOps'} · {ownerLabel(state.owner)} · {iterationLabel(state.iteration)} ·{' '}
        {state.includeClosed ? 'all states' : 'open only'}
      </Text>
    )

    if (state.picker !== undefined) {
      const isOwner = state.picker === 'owner'
      const choices = isOwner
        ? ownerChoices([...state.tasks, ...state.ancestors], state.owner)
        : iterationChoices(state.iterations, state.iteration)
      const isSelected = (value: string) => (isOwner ? sameOwner(value, state.owner) : value === state.iteration)

      return (
        <Box flexDirection="column">
          {header}
          <Box flexDirection="row" gap={1}>
            <Text bold>{isOwner ? 'Owner' : 'Iteration'}</Text>
            <Button key="pick-cancel" label="Cancel" hotkey="b" role="dismiss" onPress={() => void setPicker($, undefined)} />
          </Box>
          {choices.map((choice, index) => (
            <Button
              key={`pick-${index}`}
              label={`${isSelected(choice.value) ? '● ' : '  '}${choice.label}`}
              plain
              hotkey={index < 9 ? String(index + 1) : undefined}
              onPress={() => void pick($, isOwner ? { owner: choice.value } : { iteration: choice.value })}
            />
          ))}
          {isOwner && Input && (
            <Input
              key="owner-other"
              label="Other"
              placeholder="display name or email"
              submitLabel="Load"
              onSubmit={value => void (value.trim() === '' ? undefined : pick($, { owner: value.trim() }))}
            />
          )}
          {!isOwner && state.iterations.length === 0 && (
            <Text dimColor>No iterations loaded; press Refresh first, or the PAT cannot read them.</Text>
          )}
        </Box>
      )
    }

    const lines = buildTree(state.tasks, state.ancestors)
    const prLines = buildPullRequestLines(state.pullRequests)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 8)
    // The PR section keeps a third of the room (its heading and notes included); the work items take the rest.
    const prRoom = prLines.length === 0 ? 0 : Math.min(prLines.length, Math.max(2, Math.floor(room / 3)))
    const shown = lines.slice(0, Math.max(1, room - prRoom - 2))
    const prShown = prLines.slice(0, prRoom)

    return (
      <Box flexDirection="column">
        {header}
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" label="Refresh" hotkey="r" variant="primary" onPress={() => void refresh($)} />
          <Button
            key="closed"
            label={state.includeClosed ? 'Open only' : 'Include closed'}
            hotkey="c"
            onPress={() => void refresh($, { includeClosed: !state.includeClosed })}
          />
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="owner" label={`Owner: ${ownerLabel(state.owner)}`} hotkey="o" onPress={() => void setPicker($, 'owner')} />
          <Button
            key="iteration"
            label={`Iteration: ${iterationLabel(state.iteration)}`}
            hotkey="i"
            onPress={() => void setPicker($, 'iteration')}
          />
        </Box>
        {state.status === 'idle' && <Text dimColor>Press Refresh to load work items.</Text>}
        {state.status === 'loading' && <Text dimColor>Loading...</Text>}
        {state.status === 'error' && <Text color="error">{state.message}</Text>}
        {state.status === 'ok' && state.tasks.length === 0 && <Text dimColor>No work items.</Text>}
        {shown.map(({ row, prefix, isContext }) => (
          <Box key={`task-${row.id}`} flexDirection="row">
            {prefix !== '' && <Text dimColor>{prefix}</Text>}
            <Box flexDirection="row" columnGap={1}>
              <Button
                key={`open-${row.id}`}
                label={`#${row.id}`}
                plain
                dimColor={isContext}
                onPress={() => void openDetail($, row.id)}
              />
              <Text color={typeColor(row.type)} dimColor={isContext} bold={!isContext}>
                {typeTag(row.type)}
              </Text>
              <Text color={row.state === 'Active' ? 'warning' : undefined} dimColor={isContext}>
                {row.state}
              </Text>
              <Text color={typeColor(row.type)} dimColor={isContext} wrap="truncate-end">
                {row.title}
              </Text>
            </Box>
          </Box>
        ))}
        {lines.length > shown.length && (
          <Text dimColor>+{lines.length - shown.length} more (ask in the conversation to see all)</Text>
        )}
        {state.status !== 'idle' && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              Pull requests ({state.pullRequests.length}
              {state.pullRequests.length >= MAX_PULL_REQUESTS ? '+' : ''} active)
            </Text>
            {state.pullRequestError !== undefined && <Text color="error">{state.pullRequestError}</Text>}
            {state.pullRequestError === undefined && state.pullRequests.length === 0 && (
              <Text dimColor>No active pull requests.</Text>
            )}
            {prShown.map(line =>
              line.kind === 'repo' ? (
                <Text key={`repo-${line.repo}`} bold>
                  {line.repo} ({line.count})
                </Text>
              ) : (
                <Box key={`pr-${line.row.id}`} flexDirection="row">
                  <Text dimColor>{line.prefix}</Text>
                  <Box flexDirection="row" columnGap={1}>
                    <Button
                      key={`open-pr-${line.row.id}`}
                      label={`!${line.row.id}`}
                      plain
                      onPress={() => void openPullRequest($, line.row.id)}
                    />
                    <Text color={reviewColor(line.row.review?.state)} bold dimColor={line.row.review === undefined}>
                      {reviewLabel(line.row)}
                    </Text>
                    <Text dimColor={line.row.isDraft} wrap="truncate-end">
                      {line.row.title}
                    </Text>
                  </Box>
                </Box>
              ),
            )}
            {prLines.length > prShown.length && (
              <Text dimColor>+{prLines.length - prShown.length} more (ask in the conversation to see all)</Text>
            )}
          </Box>
        )}
        {state.fetchedAt && <Text dimColor>Updated {state.fetchedAt.slice(11, 19)} UTC · #id opens the details · !id opens the review</Text>}
      </Box>
    )
  })
}
