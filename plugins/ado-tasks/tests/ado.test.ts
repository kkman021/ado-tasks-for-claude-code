import { describe, expect, test } from 'claude-code/testing'

import {
  authenticatedPersonOf,
  buildTaskWiql,
  cardPeopleOf,
  draftTaskFields,
  draftTitle,
  identityBaseUrl,
  identityBatches,
  identityLevelOf,
  mentionHtml,
  memberCacheText,
  mergeMembers,
  parseMemberCache,
  resolveMentions,
  toMembers,
  withMentions,
  iterationPathOf,
  missingParentIds,
  parseProjectUrl,
  parseRepoConfig,
  repoConfigText,
  requests,
  stripHtml,
  toIterationOptions,
  toTaskDetail,
} from '../hooks/ado'
import { buildTree } from '../hooks/tree'
import type { Person, TaskRow } from '../types'

function row(id: number, type: string, parentId?: number): TaskRow {
  return { id, title: `T${id}`, state: 'New', type, assignedTo: '', changed: '', url: '', ...(parentId ? { parentId } : {}) }
}

describe('parseRepoConfig confirm', () => {
  const base = { projectUrl: 'https://fabrikam.visualstudio.com/Demo', patEnv: 'ADO_PAT_DEMO' }

  test('asks before every write when the file has no confirm block', () => {
    expect(parseRepoConfig(JSON.stringify(base), '/repo').confirm).toEqual({
      comment: true,
      assign: true,
      state: true,
      create: true,
      update: true,
      pullRequest: true,
    })
  })

  test('turns off only the actions set to false', () => {
    const confirm = parseRepoConfig(JSON.stringify({ ...base, confirm: { comment: false, assign: false } }), '/repo').confirm
    expect(confirm).toEqual({ comment: false, assign: false, state: true, create: true, update: true, pullRequest: true })
  })

  test('refuses a value that is not a boolean, or a block that is not an object', () => {
    expect(() => parseRepoConfig(JSON.stringify({ ...base, confirm: { state: 'no' } }), '/repo')).toThrow(
      /confirm\.state must be true or false/,
    )
    expect(() => parseRepoConfig(JSON.stringify({ ...base, confirm: false }), '/repo')).toThrow(/confirm must be an object/)
  })

  test('repoConfigText keeps the confirm block of the file it replaces', () => {
    const previous = JSON.stringify({ ...base, confirm: { comment: false } })
    expect(JSON.parse(repoConfigText('https://dev.azure.com/org/Other', 'ADO_PAT_OTHER', previous))).toEqual({
      projectUrl: 'https://dev.azure.com/org/Other',
      patEnv: 'ADO_PAT_OTHER',
      confirm: { comment: false },
    })
    expect(JSON.parse(repoConfigText('https://dev.azure.com/org/Other', 'ADO_PAT_OTHER', 'not json'))).toEqual({
      projectUrl: 'https://dev.azure.com/org/Other',
      patEnv: 'ADO_PAT_OTHER',
    })
  })
})

describe('parseProjectUrl', () => {
  test('keeps the legacy visualstudio.com host as the collection base', () => {
    expect(parseProjectUrl('https://fabrikam.visualstudio.com/Bug-Tracker')).toEqual({
      collectionUrl: 'https://fabrikam.visualstudio.com',
      projectPath: 'Bug-Tracker',
      projectName: 'Bug-Tracker',
    })
  })

  test('takes the organization segment on dev.azure.com and decodes the project once', () => {
    expect(parseProjectUrl('https://dev.azure.com/contoso/Web%20Portal')).toEqual({
      collectionUrl: 'https://dev.azure.com/contoso',
      projectPath: 'Web%20Portal',
      projectName: 'Web Portal',
    })
  })

  test('cuts a pasted board route, query and trailing slash', () => {
    expect(parseProjectUrl('https://dev.azure.com/org/My Project/_workitems/edit/12/?a=b#x')).toEqual({
      collectionUrl: 'https://dev.azure.com/org',
      projectPath: 'My%20Project',
      projectName: 'My Project',
    })
  })

  test('keeps an on-premises collection path', () => {
    expect(parseProjectUrl('https://tfs.local/tfs/DefaultCollection/Proj/').collectionUrl).toBe(
      'https://tfs.local/tfs/DefaultCollection',
    )
  })

  test('refuses dev.azure.com without an organization', () => {
    expect(() => parseProjectUrl('https://dev.azure.com/OnlyOne')).toThrow()
  })
})

describe('buildTaskWiql', () => {
  test('defaults to @Me and excludes closed states', () => {
    expect(buildTaskWiql({ owner: '', workItemType: 'Task', includeClosed: false })).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Task' AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Removed', 'Done') ORDER BY [System.ChangedDate] DESC",
    )
  })

  test('quotes a named owner and escapes single quotes', () => {
    expect(buildTaskWiql({ owner: "O'Brien", workItemType: 'Bug', includeClosed: true })).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Bug' AND [System.AssignedTo] = 'O''Brien' ORDER BY [System.ChangedDate] DESC",
    )
  })
})

describe('every type and iteration', () => {
  test('All drops the type clause and an iteration adds UNDER', () => {
    expect(
      buildTaskWiql({ owner: '@Me', workItemType: 'All', includeClosed: true, iterationPath: "Demo\\Sprint 1" }),
    ).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me AND [System.IterationPath] UNDER 'Demo\\Sprint 1' ORDER BY [System.ChangedDate] DESC",
    )
  })

  test('iteration node paths lose the Iteration segment and today marks the current one', () => {
    expect(iterationPathOf('\\Demo\\Iteration\\Sprint 1')).toBe('Demo\\Sprint 1')
    const root = {
      path: '\\Demo\\Iteration',
      children: [
        {
          name: 'Release 1',
          path: '\\Demo\\Iteration\\Release 1',
          children: [
            {
              name: 'Sprint 1',
              path: '\\Demo\\Iteration\\Release 1\\Sprint 1',
              attributes: { startDate: '2026-10-05T00:00:00Z', finishDate: '2026-10-16T00:00:00Z' },
            },
          ],
        },
      ],
    }
    expect(toIterationOptions(root, '2026-10-14')).toEqual([
      { path: 'Demo\\Release 1', label: 'Release 1', isCurrent: false },
      { path: 'Demo\\Release 1\\Sprint 1', label: '  Sprint 1', isCurrent: true },
    ])
  })

  test('missingParentIds names parents not yet known, once', () => {
    expect(missingParentIds([row(1, 'Task', 9), row(2, 'Task', 9), row(3, 'Bug', 1)], [row(1, 'Task', 9)])).toEqual([9])
  })
})

describe('buildTree', () => {
  test('nests children under parents, ancestors as context, roots in list order', () => {
    const tasks = [row(30, 'Bug'), row(11, 'Task', 10), row(12, 'Task', 10)]
    const ancestors = [row(10, 'User Story', 1), row(1, 'Epic')]
    expect(buildTree(tasks, ancestors).map(line => `${line.prefix}${line.row.id}${line.isContext ? '*' : ''}`)).toEqual([
      '30',
      '1*',
      '└─ 10*',
      '   ├─ 11',
      '   └─ 12',
    ])
  })

  test('a parent cycle is drawn as roots instead of looping', () => {
    expect(buildTree([row(1, 'Task', 2), row(2, 'Task', 1)], []).map(line => line.row.id)).toEqual([1, 2])
  })
})

test('stripHtml turns markup into plain lines', () => {
  expect(stripHtml('<div>a &amp; b</div><div>c<br>d</div>')).toBe('a & b\nc\nd')
})

describe('work item hierarchy', () => {
  const ref = parseProjectUrl('https://fabrikam.visualstudio.com/Demo')
  const link = (rel: string, id: number) => ({ rel, url: `https://fabrikam.visualstudio.com/abc/_apis/wit/workItems/${id}` })

  test('the single item request asks for the relations', () => {
    expect(requests.item(ref, 211).url).toContain('$expand=relations')
  })

  test('parent and children come from the hierarchy links when System.Parent is absent', () => {
    const item = {
      id: 207,
      fields: { 'System.Title': 'Story' },
      relations: [
        link('System.LinkTypes.Hierarchy-Reverse', 200),
        link('System.LinkTypes.Hierarchy-Forward', 208),
        link('System.LinkTypes.Related', 99),
        link('System.LinkTypes.Hierarchy-Forward', 209),
        { rel: 'AttachedFile', url: 'https://x/_apis/wit/attachments/abc' },
      ],
    }
    const detail = toTaskDetail(ref, 207, item, { comments: [] })
    expect(detail.parentId).toBe(200)
    expect(detail.childIds).toEqual([208, 209])
  })

  test('a card with no links has no parent and no children', () => {
    const detail = toTaskDetail(ref, 1, { id: 1, fields: {} }, { comments: [] })
    expect(detail.parentId).toBeUndefined()
    expect(detail.childIds).toEqual([])
  })
})

describe('identity requests', () => {
  test('Azure DevOps Services hosts map to the vssps host, a server keeps its collection', () => {
    expect(identityBaseUrl(parseProjectUrl('https://fabrikam.visualstudio.com/Demo'))).toBe('https://vssps.dev.azure.com/fabrikam')
    expect(identityBaseUrl(parseProjectUrl('https://dev.azure.com/contoso/Web%20Portal'))).toBe(
      'https://vssps.dev.azure.com/contoso',
    )
    expect(identityBaseUrl(parseProjectUrl('https://tfs.corp.local/tfs/DefaultCollection/Demo'))).toBe(
      'https://tfs.corp.local/tfs/DefaultCollection',
    )
  })

  test('the project group is looked up by its [Project]\\Group name, the members by id', () => {
    const ref = parseProjectUrl('https://dev.azure.com/contoso/Web%20Portal')
    expect(requests.projectGroup(ref, 'Contributors').url).toBe(
      'https://vssps.dev.azure.com/contoso/_apis/identities?searchFilter=General' +
        '&filterValue=%5BWeb%20Portal%5D%5CContributors&queryMembership=Direct&api-version=7.1',
    )
    expect(requests.identities(ref, ['a', 'b']).url).toBe(
      'https://vssps.dev.azure.com/contoso/_apis/identities?identityIds=a,b&queryMembership=Direct&api-version=7.1',
    )
  })
})

describe('mentions', () => {
  const amy: Person = { id: 'g-amy', name: 'Amy Lin', email: 'amy@corp.com' }
  const amyChen: Person = { id: 'g-amy2', name: 'Amy Chen', email: 'achen@corp.com' }
  const bob: Person = { id: 'g-bob', name: 'Bob', email: 'bob@corp.com' }
  const members = [amy, amyChen, bob]

  test('team member lists become people once each, groups and id-less identities left out', () => {
    const lists = [
      { value: [{ identity: { id: 'g-bob', displayName: 'Bob', uniqueName: 'bob@corp.com' } }] },
      {
        value: [
          { identity: { id: 'g-bob', displayName: 'Bob', uniqueName: 'bob@corp.com' } },
          { identity: { id: 'g-team', displayName: 'Demo Team', isContainer: true } },
          { identity: { displayName: 'No Id' } },
          { identity: { id: 'g-amy', displayName: 'Amy Lin', uniqueName: 'amy@corp.com' } },
        ],
      },
    ]
    expect(toMembers(lists)).toEqual([amy, bob])
  })

  test("an Identities answer gives its active people and its groups' member ids", () => {
    const answer = {
      value: [
        { id: 'g-team', providerDisplayName: '[Demo]\\Demo Team', isContainer: true, memberIds: ['g-amy', 'g-bob'] },
        {
          id: 'g-amy',
          providerDisplayName: 'Lin Amy',
          customDisplayName: 'Amy Lin',
          isActive: true,
          properties: { Mail: { $value: 'amy@corp.com' }, Account: { $value: 'amy-account' } },
        },
        { id: 'g-bob', providerDisplayName: 'Bob', isActive: true, properties: { Account: { $value: 'bob@corp.com' } } },
        { id: 'g-gone', providerDisplayName: 'Gone', isActive: false },
      ],
    }
    expect(identityLevelOf(answer)).toEqual({ people: [amy, bob], groupIds: ['g-team'], memberIds: ['g-amy', 'g-bob'] })
    expect(identityLevelOf({})).toEqual({ people: [], groupIds: [], memberIds: [] })
  })

  test('merged member lists keep the first entry of a person and sort by name', () => {
    const renamed: Person = { ...amy, name: 'Renamed' }
    expect(mergeMembers([[bob, amy], [renamed, amyChen]])).toEqual([amyChen, amy, bob])
  })

  test('the member cache round-trips, and is refused for another project or broken text', () => {
    const cache = { project: 'Demo', fetchedAt: '2026-10-14T00:00:00.000Z', members: [amy] }
    expect(parseMemberCache(memberCacheText(cache), 'Demo')).toEqual(cache)
    expect(parseMemberCache(memberCacheText(cache), 'Other')).toBeUndefined()
    expect(parseMemberCache('not json', 'Demo')).toBeUndefined()
    expect(parseMemberCache(JSON.stringify({ project: 'Demo', members: [amy, { id: 1 }] }), 'Demo')?.members).toEqual([amy])
  })

  test('identity ids are requested 50 at a time', () => {
    const ids = Array.from({ length: 120 }, (_, index) => `g-${index}`)
    expect(identityBatches(ids).map(batch => batch.length)).toEqual([50, 50, 20])
    expect(identityBatches([])).toEqual([])
  })

  test('the card gives @assignee and @creator with their ids', () => {
    const item = {
      fields: {
        'System.AssignedTo': { id: 'g-bob', displayName: 'Bob', uniqueName: 'bob@corp.com' },
        'System.CreatedBy': { id: 'g-amy', displayName: 'Amy Lin', uniqueName: 'amy@corp.com' },
      },
    }
    expect(cardPeopleOf(item)).toEqual({ assignee: bob, creator: amy })
    expect(cardPeopleOf({ fields: {} })).toEqual({})
  })

  test('a role, an exact name, an email or a unique part each resolve to one person, once', () => {
    const card = { assignee: bob, creator: amy }
    expect(resolveMentions(['@creator', 'bob@corp.com', 'Chen', '@Assignee'], members, card)).toEqual([amy, bob, amyChen])
  })

  test('an exact name wins over the members it is also part of', () => {
    const bobby: Person = { id: 'g-bobby', name: 'Bobby', email: 'bobby@corp.com' }
    expect(resolveMentions(['bob'], [bob, bobby], {})).toEqual([bob])
  })

  test('no match, several matches or a missing role refuse, naming the candidates', () => {
    expect(() => resolveMentions(['Carol'], members, {})).toThrow(/no project member matches/)
    expect(() => resolveMentions(['Amy'], members, {})).toThrow(/matches 2 members.*Amy Lin <amy@corp.com>.*Amy Chen/)
    expect(() => resolveMentions(['@assignee'], members, {})).toThrow(/no assignee/)
    expect(() => resolveMentions(['@me'], members, {})).toThrow(/identity of the PAT is unknown/)
  })

  test('@me resolves to the PAT identity, once with a role naming the same person', () => {
    expect(resolveMentions(['@Me', '@creator'], [], { creator: amy, me: amy })).toEqual([amy])
  })

  test('connectionData gives the authenticated person, custom display name first', () => {
    const result = {
      authenticatedUser: {
        id: 'g-amy',
        providerDisplayName: 'Amy L.',
        customDisplayName: 'Amy Lin',
        properties: { Account: { $type: 'System.String', $value: 'amy@corp.com' } },
      },
    }
    expect(authenticatedPersonOf(result)).toEqual(amy)
    expect(authenticatedPersonOf({ authenticatedUser: { id: 'g-x', providerDisplayName: 'X' } })).toEqual({
      id: 'g-x',
      name: 'X',
      email: '',
    })
    expect(authenticatedPersonOf({})).toBeUndefined()
  })

  test('the markup is what Azure DevOps reads as a mention, escaped, in front of the text', () => {
    const odd: Person = { id: 'g-1', name: 'A <B> & "C"', email: '' }
    expect(mentionHtml(odd)).toBe('<a href="#" data-vss-mention="version:2.0,g-1">@A &lt;B&gt; &amp; &quot;C&quot;</a>')
    expect(withMentions('please check', [bob])).toBe(
      '<a href="#" data-vss-mention="version:2.0,g-bob">@Bob</a> please check',
    )
    expect(withMentions('no one', [])).toBe('no one')
  })
})

describe('AI Draft tasks', () => {
  const ref = parseProjectUrl('https://fabrikam.visualstudio.com/Demo')

  test('draftTitle puts the prefix in front once, normalizing one already there', () => {
    expect(draftTitle('Add sort API')).toBe('[AI Draft] Add sort API')
    expect(draftTitle('  [ai draft]Add sort API ')).toBe('[AI Draft] Add sort API')
    expect(() => draftTitle('[AI Draft]  ')).toThrow(/title is required/)
  })

  test("a draft takes the parent's area and iteration and the AI Draft tag", () => {
    const parent = { id: 9, fields: { 'System.AreaPath': 'Demo\\Web', 'System.IterationPath': 'Demo\\Sprint 2' } }

    expect(draftTaskFields(parent, 'Add sort API', '<p>x</p>')).toEqual({
      'System.Title': '[AI Draft] Add sort API',
      'System.Description': '<p>x</p>',
      'System.Tags': 'AI Draft',
      'System.AreaPath': 'Demo\\Web',
      'System.IterationPath': 'Demo\\Sprint 2',
    })
  })

  test('createChild posts a JSON patch of the fields and a parent link', () => {
    const request = requests.createChild(ref, 'Task', 9, { 'System.Title': '[AI Draft] a' })

    expect(request.method).toBe('POST')
    expect(request.url).toBe('https://fabrikam.visualstudio.com/Demo/_apis/wit/workitems/$Task?api-version=7.1')
    expect(request.contentType).toBe('application/json-patch+json')
    expect(JSON.parse(request.body ?? '')).toEqual([
      { op: 'add', path: '/fields/System.Title', value: '[AI Draft] a' },
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Hierarchy-Reverse',
          url: 'https://fabrikam.visualstudio.com/_apis/wit/workItems/9',
        },
      },
    ])
  })

  test('updateState still patches System.State alone', () => {
    expect(JSON.parse(requests.updateState(ref, 5, 'Closed').body ?? '')).toEqual([
      { op: 'add', path: '/fields/System.State', value: 'Closed' },
    ])
  })
})
