import { expect, test } from 'claude-code/testing'
import { CWD } from './repo'

function answer(url: string): string {
  if (url.includes('/wiql')) return JSON.stringify({ workItems: [{ id: 7 }] })
  if (url.includes('/comments')) {
    return JSON.stringify({
      comments: [{ createdBy: { displayName: 'Ann' }, createdDate: '2026-10-01T00:00:00Z', text: '<p>Looks good</p>' }],
    })
  }
  if (url.includes('/workitems/7?')) {
    return JSON.stringify({
      id: 7,
      fields: { 'System.Title': 'Fix login', 'System.State': 'Active', 'System.Description': '<div>Token expires early</div>' },
    })
  }

  return JSON.stringify({ value: [{ id: 7, fields: { 'System.Title': 'Fix login', 'System.State': 'Active' } }] })
}

test('a panel value saved by the previous version (no iteration, iterations, ancestors) still draws and refreshes', async ($, on) => {
  on('session.cwd', () => ({ value: CWD }))
  on('settings.read', () => ({ value: { env: { ADO_PAT_TEST: 'secret' } } }))
  on('fs.read', () => ({ value: JSON.stringify({ projectUrl: 'https://fabrikam.visualstudio.com/Demo', patEnv: 'ADO_PAT_TEST' }) }))
  on('http.fetch', (_$, e) => ({ value: { status: 200, ok: true, headers: {}, text: answer(e.url) } }))
  const old = {
    status: 'ok',
    owner: '@Me',
    includeClosed: false,
    tasks: [{ id: 7, title: 'Fix login', state: 'Active', type: 'Task', assignedTo: '', changed: '', url: '' }],
  }
  // The host's store, holding what the previous version wrote.
  let stored: unknown = old
  let version = 1
  on('state.get', { plugin: 'ado-tasks' }, () => ({ value: { value: stored as never, version } }))
  on('state.set', { plugin: 'ado-tasks' }, (_$, e) => {
    stored = e.value
    version += 1
    return { value: { isSet: true as const, version } }
  })

  const ui = await $.ui.mount({
    plugin: 'ado-tasks',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'ado-tasks',
    props: {
      title: 'Azure DevOps Work Items',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  expect(await ui.find({ key: 'open-7' })).toBeDefined()
  expect(await ui.find({ key: 'iteration' })).toBeDefined()
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'open-7' })).toBeDefined()
  await ui.unmount()
})

test('the pane draws every type as a tree, fetches the missing parent, and filters by the picked iteration', async ($, on) => {
  const wiql: string[] = []
  on('session.cwd', () => ({ value: CWD }))
  on('settings.read', () => ({ value: { env: { ADO_PAT_TEST: 'secret' } } }))
  on('fs.read', () => ({ value: JSON.stringify({ projectUrl: 'https://fabrikam.visualstudio.com/Demo', patEnv: 'ADO_PAT_TEST' }) }))
  on('http.fetch', (_$, e) => {
    const body = (text: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(text) } })
    if (e.url.includes('/classificationnodes/')) {
      return body({ path: '\\Demo\\Iteration', children: [{ name: 'Sprint 1', path: '\\Demo\\Iteration\\Sprint 1' }] })
    }
    if (e.url.includes('/wiql')) {
      wiql.push(String(e.init?.body))
      return body({ workItems: [{ id: 21 }, { id: 5 }] })
    }
    const ids = (JSON.parse(String(e.init?.body)) as { ids: number[] }).ids
    const all: Record<number, Record<string, unknown>> = {
      21: { 'System.Title': 'Write API', 'System.State': 'Active', 'System.WorkItemType': 'Task', 'System.Parent': 20, 'System.AssignedTo': { displayName: 'Ann' } },
      5: { 'System.Title': 'Crash on save', 'System.State': 'New', 'System.WorkItemType': 'Bug' },
      20: { 'System.Title': 'Booking story', 'System.State': 'Active', 'System.WorkItemType': 'User Story' },
    }
    return body({ value: ids.map(id => ({ id, fields: all[id] })) })
  })

  const ui = await $.ui.mount({
    plugin: 'ado-tasks',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'ado-tasks',
    props: {
      title: 'Azure DevOps Work Items',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  await ui.press({ key: 'refresh' })

  expect(wiql[0]).not.toMatch(/WorkItemType/)
  expect(await ui.find({ key: 'open-20' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Story' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Bug' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '└─ ' })).toBeDefined()

  expect(wiql[0]).toMatch(/\[System\.AssignedTo\] = @Me/)
  expect((await ui.find({ key: 'owner' }))?.text).toMatch(/Owner: Me/)

  // Iteration: a button opens the choices in place of the list; a choice loads and closes them.
  await ui.press({ key: 'iteration' })
  expect((await ui.find({ key: 'pick-0' }))?.text).toMatch(/● All iterations/)
  expect((await ui.find({ key: 'pick-1' }))?.text).toMatch(/Sprint 1/)
  await ui.press({ key: 'pick-1' })
  expect(wiql[1]).toMatch(/\[System\.IterationPath\] UNDER 'Demo\\\\Sprint 1'/)
  expect(await ui.find({ key: 'pick-1' })).toBeUndefined()
  expect((await ui.find({ key: 'iteration' }))?.text).toMatch(/Iteration: Sprint 1/)

  // Owner: everyone drops the AssignedTo clause; the assignees seen are offered; Other takes a name.
  await ui.press({ key: 'owner' })
  expect((await ui.find({ key: 'pick-0' }))?.text).toMatch(/● Me/)
  expect((await ui.find({ key: 'pick-2' }))?.text).toMatch(/Ann/)
  await ui.press({ key: 'pick-1' })
  expect(wiql[2]).not.toMatch(/AssignedTo/)
  expect((await ui.find({ key: 'owner' }))?.text).toMatch(/Owner: Everyone/)

  await ui.press({ key: 'owner' })
  await ui.input({ key: 'owner-other', text: "O'Brien" })
  expect(wiql[3]).toMatch(/\[System\.AssignedTo\] = 'O''Brien'/)

  await ui.press({ key: 'owner' })
  await ui.press({ key: 'pick-cancel' })
  expect(wiql.length).toBe(4)
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  await ui.unmount()
})

test('the pane lists tasks on Refresh and opens one in place on a click', async ($, on) => {
  on('session.cwd', () => ({ value: CWD }))
  on('settings.read', () => ({ value: { env: { ADO_PAT_TEST: 'secret' } } }))
  on('fs.read', () => ({
    value: JSON.stringify({ projectUrl: 'https://fabrikam.visualstudio.com/Bug-Tracker', patEnv: 'ADO_PAT_TEST' }),
  }))
  on('http.fetch', (_$, e) => ({ value: { status: 200, ok: true, headers: {}, text: answer(e.url) } }))
  const filled: string[] = []
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'ado-tasks',
      surface,
      component: 'Pane',
      requestId: 'ado-tasks',
      props: {
        title: 'Azure DevOps Tasks',
        isFocused: true,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ key: 'open-7' }))?.text).toBe('#7')
    expect(await ui.find({ type: 'Text', text: 'Fix login' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Bug-Tracker/ })).toBeDefined()

    await ui.press({ key: 'open-7' })
    expect(await ui.find({ type: 'Text', text: 'Token expires early' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Looks good' })).toBeDefined()
    expect((await ui.find({ key: 'go' }))?.text).toBe('Claude Go')
    await ui.press({ key: 'go' })
    expect(filled.at(-1)).toBe(
      '使用 ado-tasks:claude-go skill 處理 Azure DevOps Work Item #7「Fix login」(https://fabrikam.visualstudio.com/Bug-Tracker/_workitems/edit/7)',
    )

    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'open-7' })).toBeDefined()
    await ui.unmount()
  }
})
