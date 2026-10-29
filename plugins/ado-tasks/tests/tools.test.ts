import { expect, test } from 'claude-code/testing'
import type { HttpInit, On } from 'claude-code'
import { CWD, repoPath } from './repo'

type Sent = { url: string; init?: HttpInit }

const MEMBERS_FILE = `${CWD}/.claude/ado-members.json`

/** `files` holds the other files of the repository, by full path; the mod's writes land in it. */
function seatRepo(
  on: On,
  sent: Sent[],
  answer: (url: string) => { status: number; text: string },
  files: Record<string, string> = {},
) {
  on('session.cwd', () => ({ value: CWD }))
  on('settings.read', () => ({ value: {} }))
  on('fs.read', (_$, e) => {
    const path = repoPath(e.path)
    if (path === `${CWD}/.claude/ado.json` && files[path] === undefined) {
      return { value: JSON.stringify({ projectUrl: 'https://fabrikam.visualstudio.com/Bug-Tracker', patEnv: 'ADO_PAT_TEST' }) }
    }
    if (path === `${CWD}/.claude/settings.local.json`) return { value: JSON.stringify({ env: { ADO_PAT_TEST: 'secret' } }) }
    const file = files[path]
    if (file !== undefined) return { value: file }
    throw new Error(`unexpected read ${e.path}`)
  })
  on('fs.write', (_$, e) => {
    files[repoPath(e.path)] = e.text
    return { value: undefined }
  })
  on('http.fetch', (_$, e) => {
    sent.push({ url: e.url, init: e.init })
    const { status, text } = answer(e.url)
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text } }
  })
}

test('list_tasks queries WIQL then the batch on the configured host with the PAT', async ($, on) => {
  const sent: Sent[] = []
  seatRepo(on, sent, url =>
    url.includes('/wiql')
      ? { status: 200, text: JSON.stringify({ workItems: [{ id: 7 }, { id: 3 }] }) }
      : {
          status: 200,
          text: JSON.stringify({
            value: [
              { id: 3, fields: { 'System.Title': 'Older', 'System.State': 'New', 'System.WorkItemType': 'Task' } },
              {
                id: 7,
                fields: {
                  'System.Title': 'Newer',
                  'System.State': 'Active',
                  'System.WorkItemType': 'Task',
                  'System.AssignedTo': { displayName: 'Dana' },
                },
              },
            ],
          }),
        },
  )

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__list_tasks', owner: '@Me' })

  expect(ran.deny).toBeUndefined()
  const parsed = JSON.parse(String(ran.result)) as { count: number; tasks: { id: number; assignedTo: string; url: string }[] }
  expect(parsed.count).toBe(2)
  expect(parsed.tasks.map(task => task.id)).toEqual([7, 3])
  expect(parsed.tasks[0]?.assignedTo).toBe('Dana')
  expect(parsed.tasks[0]?.url).toBe('https://fabrikam.visualstudio.com/Bug-Tracker/_workitems/edit/7')
  expect(sent[0]?.url).toBe('https://fabrikam.visualstudio.com/Bug-Tracker/_apis/wit/wiql?$top=200&api-version=7.1')
  expect(sent[0]?.init?.headers?.Authorization).toBe(`Basic ${btoa(':secret')}`)
  expect(sent[1]?.url).toBe('https://fabrikam.visualstudio.com/Bug-Tracker/_apis/wit/workitemsbatch?api-version=7.1')
})

test('a rejected PAT (203 sign-in page) is answered as a deny naming the variable', async ($, on) => {
  const sent: Sent[] = []
  seatRepo(on, sent, () => ({ status: 203, text: '<html>sign in</html>' }))

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__list_tasks' })

  expect(ran.deny ?? ran.text ?? '').toMatch(/ADO_PAT_TEST/)
})

test('update_task_state sends nothing when the confirmation is refused', async ($, on) => {
  const sent: Sent[] = []
  seatRepo(on, sent, () => ({ status: 200, text: '{}' }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'dismissed' }))

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__update_task_state', id: 5, state: 'Closed' })

  expect(ran.deny ?? ran.text ?? '').toMatch(/not confirmed/)
  expect(sent.filter(one => one.init?.method === 'PATCH')).toEqual([])
})

const TEAMS_URL = 'https://fabrikam.visualstudio.com/_apis/projects/Bug-Tracker/teams?$top=100&api-version=7.1'

function teamAnswer(url: string): { status: number; text: string } {
  if (url === TEAMS_URL) return { status: 200, text: JSON.stringify({ value: [{ id: 't1', name: 'Team' }] }) }
  if (url.includes('/teams/t1/members')) {
    return {
      status: 200,
      text: JSON.stringify({
        value: [
          { identity: { id: 'g-amy', displayName: 'Amy Lin', uniqueName: 'amy@corp.com' } },
          { identity: { id: 'g-amy2', displayName: 'Amy Chen', uniqueName: 'achen@corp.com' } },
        ],
      }),
    }
  }
  if (url.includes('/wit/workitems/5?')) {
    return {
      status: 200,
      text: JSON.stringify({
        id: 5,
        fields: { 'System.CreatedBy': { id: 'g-amy', displayName: 'Amy Lin', uniqueName: 'amy@corp.com' } },
      }),
    }
  }
  return { status: 200, text: '{}' }
}

test('list_members lists the members of the project teams, filtered by the query', async ($, on) => {
  const sent: Sent[] = []
  seatRepo(on, sent, teamAnswer)

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__list_members', query: 'chen' })

  expect(ran.deny).toBeUndefined()
  const parsed = JSON.parse(String(ran.result)) as { count: number; members: { id: string }[] }
  expect(parsed.members.map(member => member.id)).toEqual(['g-amy2'])
  expect(sent[0]?.url).toBe(TEAMS_URL)
})

const IDENTITIES = 'https://vssps.dev.azure.com/fabrikam/_apis/identities?'

function contributorsAnswer(url: string): { status: number; text: string } {
  if (url.startsWith(`${IDENTITIES}searchFilter=General&filterValue=%5BBug-Tracker%5D%5CContributors`)) {
    return {
      status: 200,
      text: JSON.stringify({ value: [{ id: 'g-contrib', isContainer: true, memberIds: ['g-team', 'g-dana'] }] }),
    }
  }
  if (url.startsWith(`${IDENTITIES}identityIds=g-team,g-dana&`)) {
    return {
      status: 200,
      text: JSON.stringify({
        value: [
          { id: 'g-team', isContainer: true, memberIds: ['g-amy', 'g-contrib'] },
          { id: 'g-dana', providerDisplayName: 'dana.wu@corp.com', isActive: true, properties: { Mail: { $value: 'dana.wu@corp.com' } } },
        ],
      }),
    }
  }
  if (url.startsWith(`${IDENTITIES}identityIds=g-amy&`)) {
    return {
      status: 200,
      text: JSON.stringify({ value: [{ id: 'g-amy', customDisplayName: 'Amy L.', isActive: true }] }),
    }
  }
  return teamAnswer(url)
}

test('list_members adds the Contributors group, nested groups followed once, team entries kept', async ($, on) => {
  const sent: Sent[] = []
  seatRepo(on, sent, contributorsAnswer)

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__list_members' })

  expect(ran.deny).toBeUndefined()
  const parsed = JSON.parse(String(ran.result)) as { members: { id: string; name: string }[]; contributorsError?: string }
  expect(parsed.members.map(member => member.id)).toEqual(['g-amy2', 'g-amy', 'g-dana'])
  expect(parsed.members.find(member => member.id === 'g-amy')?.name).toBe('Amy Lin')
  expect(parsed.contributorsError).toBeUndefined()
  expect(sent.filter(one => one.url.startsWith(IDENTITIES))).toHaveLength(3)
})

test('list_members keeps the team members and says why when Contributors cannot be read', async ($, on) => {
  const sent: Sent[] = []
  seatRepo(on, sent, url => (url.startsWith(IDENTITIES) ? { status: 401, text: '' } : teamAnswer(url)))

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__list_members' })

  expect(ran.deny).toBeUndefined()
  const parsed = JSON.parse(String(ran.result)) as { members: { id: string }[]; contributorsError?: string }
  expect(parsed.members.map(member => member.id)).toEqual(['g-amy2', 'g-amy'])
  expect(parsed.contributorsError).toMatch(/Identity \(Read\)/)
})

function memberFile(project: string, members: { id: string; name: string; email: string }[]): string {
  return JSON.stringify({ project, fetchedAt: '2026-10-01T00:00:00.000Z', members })
}

test('list_members writes its first answer to the repository and answers from it afterwards', async ($, on) => {
  const sent: Sent[] = []
  const files: Record<string, string> = {}
  seatRepo(on, sent, teamAnswer, files)

  const first = JSON.parse(String((await $.tool.call({ tool: 'mcp__ado-tasks__list_members' })).result)) as { source: string }
  const calls = sent.length
  const second = JSON.parse(String((await $.tool.call({ tool: 'mcp__ado-tasks__list_members', query: 'lin' })).result)) as {
    source: string
    members: { id: string }[]
  }

  expect(first.source).toBe('api')
  expect(JSON.parse(files[MEMBERS_FILE] ?? '{}').project).toBe('Bug-Tracker')
  expect(second.source).toBe('cache')
  expect(second.members.map(member => member.id)).toEqual(['g-amy'])
  expect(sent.length).toBe(calls)
})

test('a query the cached members do not hold calls the API again and rewrites the file', async ($, on) => {
  const sent: Sent[] = []
  const files = { [MEMBERS_FILE]: memberFile('Bug-Tracker', [{ id: 'g-old', name: 'Old', email: 'old@corp.com' }]) }
  seatRepo(on, sent, teamAnswer, files)

  const ran = JSON.parse(String((await $.tool.call({ tool: 'mcp__ado-tasks__list_members', query: 'chen' })).result)) as {
    source: string
    members: { id: string }[]
  }

  expect(ran.source).toBe('api')
  expect(ran.members.map(member => member.id)).toEqual(['g-amy2'])
  expect(files[MEMBERS_FILE]).toContain('g-amy2')
  expect(files[MEMBERS_FILE]).not.toContain('g-old')
})

test('a cache of another project is not used', async ($, on) => {
  const sent: Sent[] = []
  const files = { [MEMBERS_FILE]: memberFile('Other', [{ id: 'g-x', name: 'X', email: 'x@corp.com' }]) }
  seatRepo(on, sent, teamAnswer, files)

  const ran = JSON.parse(String((await $.tool.call({ tool: 'mcp__ado-tasks__list_members' })).result)) as { source: string }

  expect(ran.source).toBe('api')
  expect(sent[0]?.url).toBe(TEAMS_URL)
})

test('a mention the cache resolves sends no member request', async ($, on) => {
  const sent: Sent[] = []
  const files = { [MEMBERS_FILE]: memberFile('Bug-Tracker', [{ id: 'g-dana', name: 'Dana', email: 'dana.wu@corp.com' }]) }
  seatRepo(on, sent, teamAnswer, files)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'dismissed' }))

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__add_task_comment', id: 5, text: 'yours', mentions: ['dana.wu'] })

  expect(ran.deny ?? ran.text ?? '').toMatch(/not confirmed/)
  expect(sent).toEqual([])
})

test('a Contributors member who is in no team can be mentioned', async ($, on) => {
  const sent: Sent[] = []
  const asked: string[] = []
  seatRepo(on, sent, contributorsAnswer)
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked.push(JSON.stringify(e))
    return { deny: 'dismissed' }
  })

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__add_task_comment', id: 5, text: 'yours', mentions: ['dana.wu'] })

  expect(ran.deny ?? ran.text ?? '').toMatch(/not confirmed/)
  expect(asked.join('')).toMatch(/Mentions \(notified\): dana\.wu@corp\.com/)
})

function confirmConfig(confirm: unknown): Record<string, string> {
  return {
    [`${CWD}/.claude/ado.json`]: JSON.stringify({
      projectUrl: 'https://fabrikam.visualstudio.com/Bug-Tracker',
      patEnv: 'ADO_PAT_TEST',
      confirm,
    }),
  }
}

test('confirm.comment false posts the comment without asking; other writes still ask', async ($, on) => {
  const sent: Sent[] = []
  const asked: string[] = []
  seatRepo(on, sent, teamAnswer, confirmConfig({ comment: false }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked.push(JSON.stringify(e))
    return { deny: 'dismissed' }
  })

  const posted = await $.tool.call({ tool: 'mcp__ado-tasks__add_task_comment', id: 5, text: 'hi' })
  const assigned = await $.tool.call({ tool: 'mcp__ado-tasks__assign_task', id: 5, assignee: 'achen@corp.com' })

  expect(posted.deny).toBeUndefined()
  const posts = sent.filter(one => one.init?.method === 'POST')
  expect(posts.length).toBe(1)
  expect(posts[0]?.url).toMatch(/\/Bug-Tracker\/_apis\/wit\/workItems\/5\/comments\?/)
  expect(assigned.deny ?? '').toMatch(/not confirmed/)
  expect(asked.join('')).toMatch(/Assign Bug-Tracker #5/)
  expect(asked.join('')).not.toMatch(/Post this comment/)
  expect(sent.filter(one => one.init?.method === 'PATCH')).toEqual([])
})

test('a confirm key outside the write actions refuses the write before anything is sent', async ($, on) => {
  const sent: Sent[] = []
  seatRepo(on, sent, teamAnswer, confirmConfig({ comments: false }))

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__add_task_comment', id: 5, text: 'hi' })

  expect(ran.deny ?? '').toMatch(/confirm\.comments is not one of comment, assign, state, create, update/)
  expect(sent).toEqual([])
})

test('an ambiguous mention refuses the comment before asking or posting', async ($, on) => {
  const sent: Sent[] = []
  const asked: unknown[] = []
  seatRepo(on, sent, teamAnswer)
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked.push(e)
    return { deny: 'dismissed' }
  })

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__add_task_comment', id: 5, text: 'hi', mentions: ['Amy'] })

  expect(ran.deny ?? ran.text ?? '').toMatch(/matches 2 members/)
  expect(asked).toEqual([])
  expect(sent.filter(one => one.init?.method === 'POST')).toEqual([])
})

test('resolved mentions are named in the confirmation, and nothing is posted when it is refused', async ($, on) => {
  const sent: Sent[] = []
  const asked: string[] = []
  seatRepo(on, sent, teamAnswer)
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked.push(JSON.stringify(e))
    return { deny: 'dismissed' }
  })

  const ran = await $.tool.call({
    tool: 'mcp__ado-tasks__add_task_comment',
    id: 5,
    text: 'please fill in the acceptance criteria',
    mentions: ['@creator', 'achen@corp.com'],
  })

  expect(ran.deny ?? ran.text ?? '').toMatch(/not confirmed/)
  expect(asked.join('')).toMatch(/Mentions \(notified\): Amy Lin, Amy Chen/)
  expect(sent.filter(one => one.init?.method === 'POST')).toEqual([])
})

test('@me is resolved from connectionData alone, without the card or the team members', async ($, on) => {
  const sent: Sent[] = []
  const asked: string[] = []
  seatRepo(on, sent, url =>
    url.includes('/_apis/connectionData')
      ? {
          status: 200,
          text: JSON.stringify({
            authenticatedUser: { id: 'g-dana', customDisplayName: 'Dana', properties: { Account: { $value: 'dana@corp.com' } } },
          }),
        }
      : teamAnswer(url),
  )
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked.push(JSON.stringify(e))
    return { deny: 'dismissed' }
  })

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__add_task_comment', id: 5, text: 'fixed', mentions: ['@me'] })

  expect(ran.deny ?? ran.text ?? '').toMatch(/not confirmed/)
  expect(asked.join('')).toMatch(/Mentions \(notified\): Dana/)
  expect(sent.map(one => one.url)).toEqual(['https://fabrikam.visualstudio.com/_apis/connectionData?api-version=7.1-preview'])
})

const STORY = {
  id: 9,
  fields: {
    'System.Title': 'Sort rooms',
    'System.WorkItemType': 'User Story',
    'System.AreaPath': 'Bug-Tracker',
    'System.IterationPath': 'Bug-Tracker\\Sprint 1',
  },
}

test('create_task asks with the prefixed title, then posts the draft under the parent', async ($, on) => {
  const sent: Sent[] = []
  const asked: string[] = []
  seatRepo(on, sent, url =>
    url.includes('/wit/workitems/$Task')
      ? { status: 200, text: JSON.stringify({ id: 31, fields: { 'System.Title': '[AI Draft] Add sort API' } }) }
      : { status: 200, text: JSON.stringify(STORY) },
  )
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked.push(JSON.stringify(e))
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
    return { result: { questions: [], answers: { [question]: 'Yes' } } } as never
  })

  const ran = await $.tool.call({
    tool: 'mcp__ado-tasks__create_task',
    parentId: 9,
    title: 'Add sort API',
    description: '<p>goal</p>',
  })

  expect(asked.join('')).toMatch(/\[AI Draft\] Add sort API/)
  const posted = sent.find(one => one.init?.method === 'POST')
  expect(posted?.url).toBe('https://fabrikam.visualstudio.com/Bug-Tracker/_apis/wit/workitems/$Task?api-version=7.1')
  expect(JSON.parse(String(posted?.init?.body))).toContainEqual({
    op: 'add',
    path: '/fields/System.IterationPath',
    value: 'Bug-Tracker\\Sprint 1',
  })
  expect(ran.deny).toBeUndefined()
  expect(JSON.parse(String(ran.result))).toEqual({
    id: 31,
    parentId: 9,
    title: '[AI Draft] Add sort API',
    url: 'https://fabrikam.visualstudio.com/Bug-Tracker/_workitems/edit/31',
  })
})

test('create_task posts nothing when the confirmation is refused', async ($, on) => {
  const sent: Sent[] = []
  seatRepo(on, sent, () => ({ status: 200, text: JSON.stringify(STORY) }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'dismissed' }))

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__create_task', parentId: 9, title: 'a', description: 'b' })

  expect(ran.deny ?? ran.text ?? '').toMatch(/not confirmed/)
  expect(sent.filter(one => one.init?.method === 'POST')).toEqual([])
})

test('update_task keeps the AI Draft prefix of a draft and needs a change', async ($, on) => {
  const sent: Sent[] = []
  const asked: string[] = []
  seatRepo(on, sent, () => ({ status: 200, text: JSON.stringify({ id: 31, fields: { 'System.Title': '[AI Draft] Old' } }) }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked.push(JSON.stringify(e))
    return { deny: 'dismissed' }
  })

  const empty = await $.tool.call({ tool: 'mcp__ado-tasks__update_task', id: 31 })
  expect(empty.deny ?? empty.text ?? '').toMatch(/title, a description, or both/)

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__update_task', id: 31, title: 'New' })
  expect(ran.deny ?? ran.text ?? '').toMatch(/not confirmed/)
  expect(asked.join('')).toMatch(/→ \\"\[AI Draft\] New\\"/)
  expect(sent.filter(one => one.init?.method === 'PATCH')).toEqual([])
})

test('assign_task resolves the assignee from the members, asks, then patches System.AssignedTo with the email', async ($, on) => {
  const sent: Sent[] = []
  const asked: string[] = []
  const files = { [MEMBERS_FILE]: memberFile('Bug-Tracker', [{ id: 'g-dana', name: 'Dana', email: 'dana.wu@corp.com' }]) }
  seatRepo(
    on,
    sent,
    url =>
      url.includes('/wit/workitems/5?api-version')
        ? {
            status: 200,
            text: JSON.stringify({
              id: 5,
              fields: { 'System.AssignedTo': { id: 'g-dana', displayName: 'Dana', uniqueName: 'dana.wu@corp.com' } },
            }),
          }
        : teamAnswer(url),
    files,
  )
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked.push(JSON.stringify(e))
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
    return { result: { questions: [], answers: { [question]: 'Yes' } } } as never
  })

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__assign_task', id: 5, assignee: 'dana.wu' })

  expect(ran.deny).toBeUndefined()
  expect(JSON.parse(String(ran.result))).toEqual({
    id: 5,
    assignedTo: 'Dana',
    url: 'https://fabrikam.visualstudio.com/Bug-Tracker/_workitems/edit/5',
  })
  expect(asked.join('')).toMatch(/Assign Bug-Tracker #5 to Dana <dana.wu@corp.com>/)
  const patch = sent.find(one => one.init?.method === 'PATCH')
  expect(patch?.url).toBe('https://fabrikam.visualstudio.com/Bug-Tracker/_apis/wit/workitems/5?api-version=7.1')
  expect(JSON.parse(String(patch?.init?.body))).toEqual([
    { op: 'add', path: '/fields/System.AssignedTo', value: 'dana.wu@corp.com' },
  ])
})

test('assign_task sends nothing when the assignee is ambiguous or the confirmation is refused', async ($, on) => {
  const sent: Sent[] = []
  seatRepo(on, sent, teamAnswer)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'dismissed' }))

  const ambiguous = await $.tool.call({ tool: 'mcp__ado-tasks__assign_task', id: 5, assignee: 'Amy' })
  const refused = await $.tool.call({ tool: 'mcp__ado-tasks__assign_task', id: 5, assignee: 'achen@corp.com' })

  expect(ambiguous.deny ?? '').toMatch(/matches 2 members/)
  expect(refused.deny ?? '').toMatch(/not confirmed/)
  expect(sent.filter(one => one.init?.method === 'PATCH')).toEqual([])
})

const ARTIFACT_41 = 'vstfs:///Git/PullRequestId/p-1%2fr-1%2f41'

const REPO = {
  id: 'r-1',
  name: 'Demo',
  defaultBranch: 'refs/heads/main',
}

test('create_pull_request resolves the repository, asks, then posts the PR with refs and work item links', async ($, on) => {
  const sent: Sent[] = []
  const asked: string[] = []
  seatRepo(on, sent, url =>
    url.includes('/pullrequests')
      ? { status: 201, text: JSON.stringify({ pullRequestId: 41, artifactId: ARTIFACT_41 }) }
      : url.includes('/wit/workitems/')
        ? { status: 200, text: JSON.stringify({ id: 212, relations: [] }) }
        : { status: 200, text: JSON.stringify(REPO) },
  )
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked.push(JSON.stringify(e))
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
    return { result: { questions: [], answers: { [question]: 'Yes' } } } as never
  })

  const ran = await $.tool.call({
    tool: 'mcp__ado-tasks__create_pull_request',
    repo: 'Demo',
    sourceBranch: 'bugfix/212-x',
    title: 'Fix filter',
    description: 'body',
    workItemIds: [212, 212],
  })

  expect(ran.deny).toBeUndefined()
  expect(sent[0]?.url).toBe('https://fabrikam.visualstudio.com/Bug-Tracker/_apis/git/repositories/Demo?api-version=7.1')
  expect(asked.join('')).toMatch(/bugfix\/212-x → main/)
  const posted = sent.find(one => one.init?.method === 'POST')
  expect(posted?.url).toBe(
    'https://fabrikam.visualstudio.com/Bug-Tracker/_apis/git/repositories/r-1/pullrequests?api-version=7.1',
  )
  expect(JSON.parse(String(posted?.init?.body))).toEqual({
    sourceRefName: 'refs/heads/bugfix/212-x',
    targetRefName: 'refs/heads/main',
    title: 'Fix filter',
    description: 'body',
    workItemRefs: [{ id: '212', url: 'https://fabrikam.visualstudio.com/_apis/wit/workItems/212' }],
  })
  const link = sent.find(one => one.init?.method === 'PATCH')
  expect(link?.url).toBe('https://fabrikam.visualstudio.com/Bug-Tracker/_apis/wit/workitems/212?api-version=7.1')
  expect(JSON.parse(String(link?.init?.body))).toEqual([
    { op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url: ARTIFACT_41, attributes: { name: 'Pull Request' } } },
  ])
  expect(JSON.parse(String(ran.result))).toEqual({
    id: 41,
    repo: 'Demo',
    sourceBranch: 'bugfix/212-x',
    targetBranch: 'main',
    title: 'Fix filter',
    workItemIds: [212],
    url: 'https://fabrikam.visualstudio.com/Bug-Tracker/_git/Demo/pullrequest/41',
  })
})

test('create_pull_request posts nothing when the confirmation is refused or a work item id is invalid', async ($, on) => {
  const sent: Sent[] = []
  seatRepo(on, sent, () => ({ status: 200, text: JSON.stringify(REPO) }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'dismissed' }))
  const base = { tool: 'mcp__ado-tasks__create_pull_request', repo: 'Demo', sourceBranch: 'b', title: 't', description: 'd' } as const

  const refused = await $.tool.call(base)
  const invalid = await $.tool.call({ ...base, workItemIds: [0] })

  expect(refused.deny ?? refused.text ?? '').toMatch(/not confirmed/)
  expect(invalid.deny ?? invalid.text ?? '').toMatch(/workItemIds must be a positive work item id/)
  expect(sent.filter(one => one.init?.method === 'POST')).toEqual([])
})

test('update_pull_request patches the description and links only the work items not yet linked', async ($, on) => {
  const sent: Sent[] = []
  seatRepo(on, sent, url => {
    if (url.includes('/git/pullrequests/41')) {
      return { status: 200, text: JSON.stringify({ pullRequestId: 41, artifactId: ARTIFACT_41, repository: { id: 'r-1', name: 'Demo' } }) }
    }
    if (url.includes('/wit/workitems/212')) {
      return {
        status: 200,
        text: JSON.stringify({ id: 212, relations: [{ rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/p-1%2Fr-1%2F41' }] }),
      }
    }
    return { status: 200, text: JSON.stringify({ id: 214, relations: [] }) }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
    return { result: { questions: [], answers: { [question]: 'Yes' } } } as never
  })

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__update_pull_request', id: 41, description: 'new body', workItemIds: [212, 214] })

  expect(ran.deny).toBeUndefined()
  const patches = sent.filter(one => one.init?.method === 'PATCH')
  expect(patches.map(one => one.url)).toEqual([
    'https://fabrikam.visualstudio.com/Bug-Tracker/_apis/git/repositories/r-1/pullrequests/41?api-version=7.1',
    'https://fabrikam.visualstudio.com/Bug-Tracker/_apis/wit/workitems/214?api-version=7.1',
  ])
  expect(JSON.parse(String(patches[0]?.init?.body))).toEqual({ description: 'new body' })
  expect(JSON.parse(String(ran.result))).toEqual({
    id: 41,
    repo: 'Demo',
    updated: ['description'],
    linked: [214],
    unlinked: [],
    url: 'https://fabrikam.visualstudio.com/Bug-Tracker/_git/Demo/pullrequest/41',
  })
})

test('update_pull_request removes the PR links at their indexes against the read rev, then abandons the PR', async ($, on) => {
  const sent: Sent[] = []
  seatRepo(on, sent, url => {
    if (url.includes('/git/pullrequests/41')) {
      return { status: 200, text: JSON.stringify({ pullRequestId: 41, artifactId: ARTIFACT_41, repository: { id: 'r-1', name: 'Demo' } }) }
    }
    return {
      status: 200,
      text: JSON.stringify({
        id: 212,
        rev: 12,
        relations: [
          { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/p-1%2Fr-1%2F41' },
          { rel: 'ArtifactLink', url: 'vstfs:///Git/Commit/p-1%2Fr-1%2Fabc' },
          { rel: 'ArtifactLink', url: ARTIFACT_41 },
        ],
      }),
    }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
    return { result: { questions: [], answers: { [question]: 'Yes' } } } as never
  })

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__update_pull_request', id: 41, status: 'abandoned', unlinkWorkItemIds: [212] })

  expect(ran.deny).toBeUndefined()
  const patches = sent.filter(one => one.init?.method === 'PATCH')
  expect(JSON.parse(String(patches[0]?.init?.body))).toEqual([
    { op: 'test', path: '/rev', value: 12 },
    { op: 'remove', path: '/relations/2' },
    { op: 'remove', path: '/relations/0' },
  ])
  expect(JSON.parse(String(patches[1]?.init?.body))).toEqual({ status: 'abandoned' })
  expect(JSON.parse(String(ran.result))).toMatchObject({ updated: ['status'], linked: [], unlinked: [212] })
})

test('update_pull_request refuses an unknown status before sending anything', async ($, on) => {
  const sent: Sent[] = []
  seatRepo(on, sent, () => ({ status: 200, text: '{}' }))

  const ran = await $.tool.call({ tool: 'mcp__ado-tasks__update_pull_request', id: 41, status: 'completed' })

  expect(ran.deny ?? ran.text ?? '').toMatch(/status must be one of active, abandoned/)
  expect(sent).toEqual([])
})
